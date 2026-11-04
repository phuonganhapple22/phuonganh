// DEBUG TRONG PLAYLIST (04/11/2026 — "không xem được gì thì playlist báo luôn lỗi", áp dụng cho TẤT CẢ nguồn).
//
// Lúc tạo playlist, với MỖI kênh có link thật, ta thử mở link đúng như file .m3u sẽ gửi (cùng Referer + User-Agent)
// rồi gắn kết quả vào TÊN KÊNH và 1 dòng chú thích "# [debug] ..." ngay trên kênh:
//     04/11 06:30 🟢 🎾 A vs B (HD 1) ⚠️403(CI)      <- link bị CDN từ chối (HTTP 403) khi thử từ máy chủ tạo playlist
//     04/11 07:00 🟢 ⚽ X vs Y (Giovang 1) ✅        <- mở được, đúng định dạng video (FLV/HLS)
// Mỗi nguồn còn có 1 kênh "🔧 DEBUG <nguồn>: ..." tóm tắt (số kênh ✅/⚠️, lỗi phổ biến, ghi chú từ service nguồn).
//
// LƯU Ý QUAN TRỌNG: phép thử chạy từ MÁY CHỦ TẠO PLAYLIST (GitHub Actions/Vercel), KHÔNG phải mạng của người xem.
// Nhiều CDN gắn token theo IP/khu vực: "⚠️403(CI)" có thể chỉ do CDN chặn IP máy chủ mà người xem vẫn xem được —
// nhưng nếu CẢ nguồn đều ⚠️ cùng 1 lỗi thì gần như chắc chắn lỗi nằm ở link/domain/Referer (xem chi tiết trong dòng debug).
//
// Biến môi trường:
//   PLAYLIST_DEBUG=on|off            (mặc định OFF từ 04/11/2026 — playlist sạch, không tag/dòng debug). Bật lại: PLAYLIST_DEBUG=on
//   PLAYLIST_DEBUG_SOURCES=all|a,b   (mặc định all) chỉ bật cho vài nguồn, vd "xoilac,giovang"
//   PLAYLIST_DEBUG_TIMEOUT_MS=5000   timeout mỗi phép thử (tối thiểu 1500)
//   PLAYLIST_DEBUG_OK_TAG=on|off     (mặc định on) ghi ✅ cho kênh mở được; off = chỉ ghi khi có lỗi
//   PLAYLIST_DEBUG_VARIANTS=on|off   (mặc định on) link 401/403 -> tự thử thêm kiểu header khác (xem probeVariants)
//   PLAYLIST_DEBUG_VARIANT_LINKS=3   số link/host được dò đủ biến thể (còn lại dùng kết luận mẫu)

const DEBUG_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export function isDebugEnabledFor(source) {
  const on = String(process.env.PLAYLIST_DEBUG ?? 'off').toLowerCase().trim();
  if (!['on', '1', 'true', 'all'].includes(on)) return false; // mặc định TẮT (04/11/2026): chỉ bật khi đặt PLAYLIST_DEBUG=on
  if (['off', '0', 'false', 'none'].includes(on)) return false;
  const only = String(process.env.PLAYLIST_DEBUG_SOURCES || 'all').toLowerCase().trim();
  if (!only || only === 'all' || only === '*') return true;
  return only.split(',').map((s) => s.trim()).filter(Boolean).includes(String(source || '').toLowerCase());
}

export const debugOkTagEnabled = () => !['off', '0', 'false'].includes(String(process.env.PLAYLIST_DEBUG_OK_TAG ?? 'on').toLowerCase().trim());

// ---------------------------------------------------------------------------------------------
// Ghi chú từ service nguồn (lỗi mở trang nhúng, domain đang dùng...) — dùng chung trong 1 tiến trình.
// ---------------------------------------------------------------------------------------------
const STORE_KEY = '__playlistDebugNotes';
function store() {
  if (!globalThis[STORE_KEY]) globalThis[STORE_KEY] = new Map();
  return globalThis[STORE_KEY];
}

/** Ghi 1 ghi chú/lỗi của nguồn (giữ tối đa 12 ghi chú khác nhau, đếm số lần lặp). */
export function debugNote(source, message) {
  try {
    const key = String(source || 'unknown').toLowerCase();
    const msg = String(message || '').replace(/\s+/g, ' ').trim().slice(0, 220);
    if (!msg) return;
    const m = store();
    if (!m.has(key)) m.set(key, new Map());
    const notes = m.get(key);
    if (notes.has(msg)) { notes.set(msg, notes.get(msg) + 1); return; }
    if (notes.size >= 12) return;
    notes.set(msg, 1);
  } catch { /* debug không được làm hỏng luồng chính */ }
}

export function getDebugNotes(source) {
  const notes = store().get(String(source || '').toLowerCase());
  return notes ? [...notes.entries()].map(([msg, count]) => (count > 1 ? `${msg} (x${count})` : msg)) : [];
}

/** Xoá ghi chú của chu kỳ trước (gọi đầu mỗi lần quét nếu cần). */
export function resetDebugNotes() { store().clear(); }

// ---------------------------------------------------------------------------------------------
// Hạn token trong link (wsABSTime / auth_key / e= / expires...).
// ---------------------------------------------------------------------------------------------
export function tokenExpiryMs(url) {
  try {
    const u = new URL(url);
    const p = u.searchParams;
    const nums = [p.get('wsABSTime'), p.get('expires'), p.get('expire'), p.get('e'), p.get('exp'), p.get('t')]
      .map(Number).filter((n) => Number.isFinite(n) && n > 1.5e9 && n < 4e9);
    const ak = (p.get('auth_key') || '').match(/^(\d{10})-/);
    if (ak) nums.push(Number(ak[1]));
    return nums.length ? nums[0] * 1000 : 0;
  } catch { return 0; }
}

// ---------------------------------------------------------------------------------------------
// Phép thử 1 link: HTTP status + loại nội dung + vài byte đầu.
// ---------------------------------------------------------------------------------------------
const probeCache = new Map();
const PROBE_TTL_MS = 90 * 1000;

function classify(status, contentType, head) {
  const ct = String(contentType || '').toLowerCase();
  const text = head.toString('utf8', 0, Math.min(head.length, 16));
  if (head.subarray(0, 3).toString() === 'FLV') return 'flv';
  if (text.startsWith('#EXTM3U')) return 'hls';
  if (/mpegurl/.test(ct)) return 'hls';
  if (/^video\//.test(ct) || /mp2t|octet-stream/.test(ct)) return head.length ? 'video' : 'empty';
  if (!head.length) return 'empty';
  if (/text\/html|application\/json|text\/plain/.test(ct)) return 'html';
  return 'other';
}

// ---------------------------------------------------------------------------------------------
// Một lần thử mở link với bộ header cho trước: trả { status, ct, kind, ms } hoặc { error, ms }.
// ---------------------------------------------------------------------------------------------
async function fetchHead(u, headers, timeoutMs) {
  const started = Date.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(u, { headers, redirect: 'follow', signal: ctl.signal });
    let head = Buffer.alloc(0);
    if (res.body) {
      const reader = res.body.getReader();
      const { value } = await reader.read(); // luồng FLV/HLS live: chỉ đọc chunk đầu rồi ngắt
      if (value) head = Buffer.from(value.slice(0, 64));
      await reader.cancel().catch(() => {});
    }
    const ct = res.headers.get('content-type') || '?';
    return { status: res.status, ct, kind: classify(res.status, ct, head), ms: Date.now() - started };
  } catch (e) {
    const error = e?.name === 'AbortError' ? 'timeout' : (e?.cause?.code || e?.code || 'lỗi-mạng');
    return { error, ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

const isPlayable = (r) => r && !r.error && r.status >= 200 && r.status < 300 && ['flv', 'hls', 'video'].includes(r.kind);

// ---------------------------------------------------------------------------------------------
// DÒ BIẾN THỂ HEADER khi link bị 401/403 (04/11/2026): thử vài kiểu header khác để biết lỗi do Referer/UA hay do IP.
//   - Nếu 1 kiểu mở được  -> lỗi nằm ở header (Referer/Origin/UA) -> ghi rõ kiểu nào mở được.
//   - Nếu MỌI kiểu đều 403 -> nhiều khả năng CDN chặn IP máy chủ/khu vực hoặc token đã bị thu hồi.
// Tốn request nên chỉ chạy cho vài link đầu của mỗi host (PLAYLIST_DEBUG_VARIANT_LINKS, mặc định 3);
// các link còn lại của cùng host dùng lại kết luận mẫu (đánh dấu "mẫu").
//   PLAYLIST_DEBUG_VARIANTS=on|off          (mặc định on)
//   PLAYLIST_DEBUG_VARIANT_LINKS=3          số link tối đa / host / 90s được dò đủ biến thể
// ---------------------------------------------------------------------------------------------
const VARIANT_UAS = {
  vlc: 'VLC/3.0.20 LibVLC/3.0.20',
  okhttp: 'okhttp/4.12.0',
  mobile: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
};
const variantsEnabled = () => !['off', '0', 'false'].includes(String(process.env.PLAYLIST_DEBUG_VARIANTS ?? 'on').toLowerCase().trim());
const hostSamples = new Map(); // host -> { at, used, counts: Map<label, số link mẫu mở được bằng kiểu đó> }

function originOf(x) {
  try { return new URL(x).origin; } catch { return ''; }
}

function buildVariants(u, referer, userAgent, extraReferers = []) {
  const list = [];
  const seen = new Set();
  const add = (label, h) => {
    const key = JSON.stringify(h);
    if (seen.has(key)) return;
    seen.add(key);
    list.push({ label, headers: { Accept: '*/*', ...h } });
  };
  const refOrigin = originOf(referer);
  add('bỏ-Referer', { 'User-Agent': userAgent });
  if (refOrigin) add('Referer+Origin', { 'User-Agent': userAgent, Referer: referer, Origin: refOrigin });
  const self = originOf(u);
  if (self) add('Referer=chính-CDN', { 'User-Agent': userAgent, Referer: `${self}/`, Origin: self });
  for (const r of extraReferers) {
    const o = originOf(r);
    if (o && o !== refOrigin) add(`Referer=${new URL(o).host}`, { 'User-Agent': userAgent, Referer: `${o}/`, Origin: o });
  }
  add('UA-VLC', { 'User-Agent': VARIANT_UAS.vlc, ...(referer ? { Referer: referer } : {}) });
  add('UA-okhttp', { 'User-Agent': VARIANT_UAS.okhttp, ...(referer ? { Referer: referer } : {}) });
  add('UA-điện-thoại', { 'User-Agent': VARIANT_UAS.mobile, ...(referer ? { Referer: referer } : {}) });
  return list.slice(0, 7);
}

/** @returns {Promise<{hint:string, worked:string[], sampled:boolean}|null>} null nếu không dò (tắt/hết hạn mức). */
async function probeVariants(u, { referer, userAgent, extraReferers, timeoutMs }) {
  if (!variantsEnabled()) return null;
  let host = '';
  try { host = new URL(u).host; } catch { return null; }
  const now = Date.now();
  let st = hostSamples.get(host);
  if (!st || now - st.at > PROBE_TTL_MS) { st = { at: now, used: 0, counts: new Map() }; hostSamples.set(host, st); }
  const limit = Math.max(1, Number(process.env.PLAYLIST_DEBUG_VARIANT_LINKS) || 3);
  if (st.used >= limit) {
    // Chỉ kết luận khi MỌI link mẫu của host cùng cho 1 kết quả; lẫn lộn -> nói rõ là chưa chắc.
    const all = [...st.counts.entries()].filter(([, c]) => c === st.used).map(([l]) => l);
    if (all.length) return { hint: `mẫu ${st.used}/${st.used} link: mở được nếu ${all.join('/')}`, worked: all, sampled: true };
    if (!st.counts.size) return { hint: `mẫu ${st.used}/${st.used} link: mọi kiểu header đều bị chặn -> nghi chặn IP/khu vực`, worked: [], sampled: true };
    return { hint: `mẫu lẫn lộn (${[...st.counts.entries()].map(([l, c]) => `${l}:${c}/${st.used}`).join(', ')}) -> chưa kết luận`, worked: [], sampled: true, mixed: true };
  }
  st.used += 1;
  const variants = buildVariants(u, referer, userAgent, extraReferers);
  const results = await Promise.all(variants.map(async (v) => ({ label: v.label, r: await fetchHead(u, v.headers, timeoutMs) })));
  const worked = results.filter((x) => isPlayable(x.r)).map((x) => x.label);
  worked.forEach((w) => st.counts.set(w, (st.counts.get(w) || 0) + 1));
  const summary = results.map((x) => `${x.label}=${x.r.error || x.r.status}`).join(', ');
  return worked.length
    ? { hint: `mở được nếu: ${worked.join('/')} | thử: ${summary}`, worked, sampled: false }
    : { hint: `mọi kiểu header đều bị chặn -> nghi chặn IP/khu vực | thử: ${summary}`, worked: [], sampled: false };
}

/**
 * @returns {Promise<{ok:boolean, tag:string, detail:string, status:number, kind:string, ms:number, variants?:object}>}
 * extraReferers: (tuỳ chọn) danh sách domain site để thử làm Referer khi link bị 401/403.
 */
export async function probeStreamForDebug(url, { referer = '', userAgent = DEBUG_UA, extraReferers = [] } = {}) {
  const u = String(url || '');
  if (!/^https?:\/\//i.test(u)) return { ok: false, tag: '⚠️link-lạ', detail: 'không phải link http(s)', status: 0, kind: 'none', ms: 0 };
  if (/\/api\/playlist\/resolve/.test(u)) return { ok: false, tag: '⏳chưa-có-link', detail: 'kênh chờ resolver — chưa có link thật', status: 0, kind: 'resolver', ms: 0 };

  const cacheKey = `${u}|${referer}`;
  const hit = probeCache.get(cacheKey);
  if (hit && Date.now() - hit.at < PROBE_TTL_MS) return hit.promise;

  const promise = (async () => {
    const timeoutMs = Math.max(1500, Number(process.env.PLAYLIST_DEBUG_TIMEOUT_MS) || 5000);
    const headers = { 'User-Agent': userAgent, Accept: '*/*' };
    if (referer) headers.Referer = referer;
    const exp = tokenExpiryMs(u);
    const expired = exp && exp < Date.now();
    const expNote = exp ? (expired ? ' | TOKEN ĐÃ HẾT HẠN' : '') : '';

    const r = await fetchHead(u, headers, timeoutMs);
    if (r.error) {
      return { ok: false, tag: `⚠️${r.error}(CI)`, detail: `lỗi kết nối: ${r.error} | ${r.ms}ms${expNote}`, status: 0, kind: 'error', ms: r.ms };
    }
    const base = `HTTP ${r.status} | ${r.ct.split(';')[0]} | ${r.kind} | ${r.ms}ms${expNote}`;
    if (isPlayable(r)) return { ok: true, tag: '✅', detail: base, status: r.status, kind: r.kind, ms: r.ms };
    if (r.status >= 200 && r.status < 300) {
      const why = r.kind === 'html' ? 'trả trang web/JSON thay vì video' : r.kind === 'empty' ? 'phản hồi rỗng' : 'định dạng lạ';
      return { ok: false, tag: expired ? '⚠️token-hết-hạn(CI)' : '⚠️không-phải-video(CI)', detail: `${base} | ${why}`, status: r.status, kind: r.kind, ms: r.ms };
    }
    let tag = expired ? '⚠️token-hết-hạn(CI)' : `⚠️${r.status}(CI)`;
    let detail = base;
    let variants;
    // Token đã hết hạn thì thử header cũng vô ích -> chỉ dò biến thể với 401/403 khi token còn hạn/không rõ hạn.
    if ((r.status === 401 || r.status === 403) && !expired) {
      try {
        variants = await probeVariants(u, { referer, userAgent, extraReferers, timeoutMs });
      } catch { variants = null; }
      if (variants) {
        detail = `${base} | ${variants.hint}`;
        tag += variants.mixed ? '·mẫu-lẫn-lộn' : variants.worked.length ? `·đổi-header-được(${variants.worked[0]})` : '·mọi-header-đều-chặn';
      }
    }
    return { ok: false, tag, detail, status: r.status, kind: r.kind, ms: r.ms, variants: variants || undefined };
  })();

  probeCache.set(cacheKey, { at: Date.now(), promise });
  if (probeCache.size > 1500) {
    const now = Date.now();
    for (const [k, v] of probeCache) if (now - v.at > PROBE_TTL_MS) probeCache.delete(k);
  }
  return promise;
}
