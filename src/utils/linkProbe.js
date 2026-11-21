// Dò nhanh link HLS (.m3u8) và LOẠI link chắc chắn đã chết, để playlist không có kênh báo
// "HTTP 404 - link không còn tồn tại (CDN đã gỡ/đã đổi url)" trong trình phát.
//
// Quy tắc thận trọng (dò từ IP máy chủ CI nên dễ có "kết quả giả"):
//   - Chỉ coi là CHẾT khi CDN trả 404/410. Lỗi mạng, timeout, 403, 5xx, hoặc 200 nhưng không phải m3u8
//     -> "chưa rõ" -> GIỮ link (không bao giờ bỏ link vì lý do mơ hồ).
//   - CHỐT AN TOÀN: chỉ THẬT SỰ bỏ link 404 khi đã thấy ít nhất 1 link khác trên CÙNG CDN
//     (cùng nguồn) trả về m3u8 hợp lệ trong vòng TRUST_TTL_MS -> chứng tỏ từ CI nhìn thấy được CDN
//     và phân biệt được link sống/chết. Nếu CDN trả 404 cho MỌI link (vd CDN chặn IP CI bằng 404, hoặc
//     cả nguồn đều đổi cách phát) thì KHÔNG bỏ gì cả và chỉ in cảnh báo, tránh làm rỗng cả nguồn.
//   - Kết quả dò được nhớ 60 giây (playlist quét mỗi ~2 phút) và mỗi link chỉ dò 1 lần cho nhiều lần gọi đồng thời.
const DEFAULT_TIMEOUT_MS = 5000;
const VERDICT_TTL_MS = 60 * 1000;
const TRUST_TTL_MS = 3 * 60 * 60 * 1000;
const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const verdictCache = globalThis.__linkProbeVerdicts || new Map(); // `${source}|${referer}|${url}` -> { at, promise }
globalThis.__linkProbeVerdicts = verdictCache;
const trustedAt = globalThis.__linkProbeTrust || new Map(); // `${source}|${cdnKey}` -> thời điểm thấy link sống gần nhất
globalThis.__linkProbeTrust = trustedAt;
const warned = globalThis.__linkProbeWarned || new Set();
globalThis.__linkProbeWarned = warned;

function cdnKey(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (/^[\d.]+$/.test(host) || host.includes(':')) return host; // IP v4/v6: giữ nguyên
    return host.split('.').slice(-2).join('.'); // pzhgifbkllliv.vcdn.cloud -> vcdn.cloud
  } catch {
    return '';
  }
}

function warnOnce(key, message) {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(message);
}

/** 'alive' | 'dead' | 'unknown' cho 1 link. */
async function probeOnce(url, { referer, userAgent, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = { 'User-Agent': userAgent || DEFAULT_UA, Accept: '*/*' };
    if (referer) {
      headers.Referer = referer;
      try {
        headers.Origin = new URL(referer).origin;
      } catch {
        // referer không phải URL hợp lệ -> bỏ Origin
      }
    }
    const res = await fetch(url, { headers, signal: controller.signal });
    if (res.status === 404 || res.status === 410) {
      res.body?.cancel?.().catch(() => {});
      return 'dead';
    }
    if (res.status === 200 || res.status === 206) {
      const body = (await res.text()).slice(0, 400);
      return /#EXTM3U/.test(body) ? 'alive' : 'unknown';
    }
    res.body?.cancel?.().catch(() => {});
    return 'unknown'; // 401/403/5xx...: không kết luận được
  } catch {
    return 'unknown'; // lỗi mạng/timeout từ CI không có nghĩa link chết
  } finally {
    clearTimeout(timer);
  }
}

function getVerdict(source, url, opts) {
  const key = `${source}|${opts.referer || ''}|${url}`;
  const hit = verdictCache.get(key);
  if (hit && Date.now() - hit.at < VERDICT_TTL_MS) return hit.promise;
  const promise = probeOnce(url, opts);
  verdictCache.set(key, { at: Date.now(), promise });
  return promise;
}

/**
 * Lọc danh sách link của 1 trận.
 * @returns {{ alive: string[], dropped: string[], unconfirmed: string[], stats: object }}
 *   alive       — link được GIỮ (sống, chưa rõ, hoặc 404 nhưng chưa xác nhận được)
 *   dropped     — link bị BỎ vì chắc chắn chết
 *   unconfirmed — link 404 nhưng chưa có bằng chứng CDN nhìn thấy được từ CI -> vẫn giữ
 */
export async function filterDeadHlsLinks(urls, { source = 'src', referer = null, userAgent, enabled = true, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const list = Array.isArray(urls) ? urls : [];
  if (!enabled || !list.length) return { alive: list, dropped: [], unconfirmed: [], stats: { total: list.length } };

  const verdicts = await Promise.all(list.map((u) => getVerdict(source, u, { referer, userAgent, timeoutMs })));

  // Ghi nhận CDN "nhìn thấy được" trước khi xét link chết (link sống có thể nằm sau link chết trong danh sách)
  list.forEach((u, i) => {
    if (verdicts[i] === 'alive') trustedAt.set(`${source}|${cdnKey(u)}`, Date.now());
  });

  const alive = [];
  const dropped = [];
  const unconfirmed = [];
  list.forEach((u, i) => {
    if (verdicts[i] !== 'dead') {
      alive.push(u);
      return;
    }
    const lastOk = trustedAt.get(`${source}|${cdnKey(u)}`) || 0;
    if (Date.now() - lastOk < TRUST_TTL_MS) {
      dropped.push(u);
      warnOnce(`drop|${source}|${u}`, `[${source}] bỏ link chết (HTTP 404/410): ${u}`);
    } else {
      unconfirmed.push(u);
      alive.push(u);
      warnOnce(
        `unconfirmed|${source}|${cdnKey(u)}`,
        `[${source}] link 404 nhưng CHƯA bỏ: chưa thấy link nào trên CDN ${cdnKey(u)} trả m3u8 hợp lệ từ máy chủ CI `
          + `(có thể CDN chặn IP CI bằng 404, hoặc cả nguồn đổi cách phát) — ví dụ: ${u}`
      );
    }
  });

  const count = (v) => verdicts.filter((x) => x === v).length;
  return {
    alive,
    dropped,
    unconfirmed,
    stats: { total: list.length, alive: count('alive'), dead: count('dead'), unknown: count('unknown'), dropped: dropped.length, unconfirmed: unconfirmed.length },
  };
}
