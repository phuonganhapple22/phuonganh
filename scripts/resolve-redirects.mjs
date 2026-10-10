// Theo redirect của domain trang web nguồn: nếu domain đang khai báo (hoặc mặc định) chuyển hướng sang
// domain khác (vd giovang.city -> giovang.blog), dùng domain mới NGAY trong lần chạy này — không cần ai sửa biến.
// Dùng bởi scripts/expand-source-domains.mjs (bước đầu của workflow Generate Playlists).
//
// Chỉ TIN domain mới khi chắc đúng là nguồn đó, tránh bị chuyển sang trang lạ/rao bán:
//   - không phải trang đỗ tên miền / rao bán / hết hạn, VÀ
//   - (HTTP < 400 và [nội dung có tên nguồn HOẶC tên miền mới chứa "brand" của nguồn])
//     hoặc (bị Cloudflare chặn nhưng tên miền mới chứa "brand" — SPA/Cloudflare không đọc được chữ)

import { UA, PARKED_RE, CF_CHALLENGE_RE, stripSlash, normHost, hostOf, originOf, looksLikeGamblingPage } from './domain-utils.mjs';

export async function resolveRedirect(entry, currentUrl, { fetchImpl = globalThis.fetch, timeoutMs = 10000 } = {}) {
  const curHost = normHost(hostOf(currentUrl));
  let res;
  try {
    res = await fetchImpl(`${stripSlash(currentUrl)}/`, {
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'User-Agent': UA, Accept: 'text/html,*/*;q=0.8', 'Accept-Language': 'vi,en;q=0.8' }
    });
  } catch (err) {
    const code = err?.cause?.code || err?.code || (err?.name === 'TimeoutError' || err?.name === 'AbortError' ? 'ETIMEDOUT' : 'UNKNOWN');
    return { moved: false, reason: `không truy cập được (${code})` };
  }
  const finalHost = normHost(hostOf(res.url || ''));
  if (!finalHost || finalHost === curHost) return { moved: false };

  let body = '';
  try { body = String(await res.text()).slice(0, 300000); } catch { /* bỏ qua */ }
  const lower = body.toLowerCase();
  const h = (n) => (res.headers && typeof res.headers.get === 'function' ? res.headers.get(n) || '' : '');
  const newUrl = originOf(res.url);
  const brandHit = !!entry.brand && finalHost.includes(entry.brand);
  const keywordHit = (entry.keywords || []).some((k) => lower.includes(k.toLowerCase()));
  const cfBlocked = [401, 403, 429, 503].includes(res.status)
    && (h('cf-ray') || /cloudflare/i.test(h('server')) || h('cf-mitigated') || CF_CHALLENGE_RE.test(body));

  if (PARKED_RE.test(body)) return { moved: true, accepted: false, newUrl, reason: 'trang đích là trang đỗ tên miền / rao bán' };
  if (looksLikeGamblingPage(body)) return { moved: true, accepted: false, newUrl, reason: 'trang đích là trang cá cược/nhà cái, không phải trang xem bóng đá' };
  if (res.status < 400 && (keywordHit || brandHit)) return { moved: true, accepted: true, newUrl, reason: keywordHit ? 'nội dung trang đích đúng nguồn' : 'tên miền mới chứa tên nguồn' };
  if (cfBlocked && brandHit) return { moved: true, accepted: true, newUrl, reason: 'tên miền mới chứa tên nguồn (trang đích bị Cloudflare chặn nên không đọc được nội dung)' };
  return { moved: true, accepted: false, newUrl, reason: `trang đích không giống nguồn này (HTTP ${res.status})` };
}
