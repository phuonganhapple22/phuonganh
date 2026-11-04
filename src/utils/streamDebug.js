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
//   PLAYLIST_DEBUG=on|off            (mặc định on)  tắt hẳn: PLAYLIST_DEBUG=off
//   PLAYLIST_DEBUG_SOURCES=all|a,b   (mặc định all) chỉ bật cho vài nguồn, vd "xoilac,giovang"
//   PLAYLIST_DEBUG_TIMEOUT_MS=5000   timeout mỗi phép thử (tối thiểu 1500)
//   PLAYLIST_DEBUG_OK_TAG=on|off     (mặc định on) ghi ✅ cho kênh mở được; off = chỉ ghi khi có lỗi

const DEBUG_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export function isDebugEnabledFor(source) {
  const on = String(process.env.PLAYLIST_DEBUG ?? 'on').toLowerCase().trim();
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

/**
 * @returns {Promise<{ok:boolean, tag:string, detail:string, status:number, kind:string, ms:number}>}
 */
export async function probeStreamForDebug(url, { referer = '', userAgent = DEBUG_UA } = {}) {
  const u = String(url || '');
  if (!/^https?:\/\//i.test(u)) return { ok: false, tag: '⚠️link-lạ', detail: 'không phải link http(s)', status: 0, kind: 'none', ms: 0 };
  if (/\/api\/playlist\/resolve/.test(u)) return { ok: false, tag: '⏳chưa-có-link', detail: 'kênh chờ resolver — chưa có link thật', status: 0, kind: 'resolver', ms: 0 };

  const cacheKey = `${u}|${referer}`;
  const hit = probeCache.get(cacheKey);
  if (hit && Date.now() - hit.at < PROBE_TTL_MS) return hit.promise;

  const promise = (async () => {
    const timeoutMs = Math.max(1500, Number(process.env.PLAYLIST_DEBUG_TIMEOUT_MS) || 5000);
    const started = Date.now();
    const headers = { 'User-Agent': userAgent, Accept: '*/*' };
    if (referer) headers.Referer = referer;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    const exp = tokenExpiryMs(u);
    const expNote = exp ? (exp < Date.now() ? ' | TOKEN ĐÃ HẾT HẠN' : '') : '';
    try {
      const res = await fetch(u, { headers, redirect: 'follow', signal: ctl.signal });
      let head = Buffer.alloc(0);
      if (res.body) {
        const reader = res.body.getReader();
        const { value } = await reader.read(); // luồng FLV/HLS live: chỉ đọc chunk đầu rồi ngắt
        if (value) head = Buffer.from(value.slice(0, 64));
        await reader.cancel().catch(() => {});
      }
      const ms = Date.now() - started;
      const ct = res.headers.get('content-type') || '?';
      const kind = classify(res.status, ct, head);
      const base = `HTTP ${res.status} | ${ct.split(';')[0]} | ${kind} | ${ms}ms${expNote}`;
      if (res.status >= 200 && res.status < 300 && ['flv', 'hls', 'video'].includes(kind)) {
        return { ok: true, tag: '✅', detail: base, status: res.status, kind, ms };
      }
      if (res.status >= 200 && res.status < 300) {
        const why = kind === 'html' ? 'trả trang web/JSON thay vì video' : kind === 'empty' ? 'phản hồi rỗng' : 'định dạng lạ';
        return { ok: false, tag: exp && exp < Date.now() ? '⚠️token-hết-hạn(CI)' : '⚠️không-phải-video(CI)', detail: `${base} | ${why}`, status: res.status, kind, ms };
      }
      const tag = exp && exp < Date.now() ? '⚠️token-hết-hạn(CI)' : `⚠️${res.status}(CI)`;
      return { ok: false, tag, detail: base, status: res.status, kind, ms };
    } catch (e) {
      const ms = Date.now() - started;
      const code = e?.name === 'AbortError' ? 'timeout' : (e?.cause?.code || e?.code || 'lỗi-mạng');
      return { ok: false, tag: `⚠️${code}(CI)`, detail: `lỗi kết nối: ${code} | ${ms}ms${expNote}`, status: 0, kind: 'error', ms };
    } finally {
      clearTimeout(timer);
    }
  })();

  probeCache.set(cacheKey, { at: Date.now(), promise });
  if (probeCache.size > 1500) {
    const now = Date.now();
    for (const [k, v] of probeCache) if (now - v.at > PROBE_TTL_MS) probeCache.delete(k);
  }
  return promise;
}
