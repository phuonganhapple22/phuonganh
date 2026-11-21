// ROUTE TẠM ĐỂ DÒ LỖI (18/09/2026) — gọi thẳng api.plapi202624081158.com,
// KHÔNG nuốt lỗi như phalang.service.js (service chính luôn try/catch rồi
// trả mảng rỗng khi lỗi, nên không thấy được lý do thật qua /api/matches
// bình thường). Nghi ngờ chính: bot-detection cùng loại đã thấy khi gọi thử
// từ máy chủ ngoài (không phải trình duyệt) — cần xem status/nội dung lỗi
// thật khi gọi TỪ chính Vercel (IP khác, có thể qua/không qua được).
// Sau khi dò xong, có thể xoá file này (không ảnh hưởng route khác).
import axios from 'axios';

async function tryFetch(url, referer, method = 'get', body = undefined) {
  const result = { triedUrl: url, method };
  try {
    const response = await axios.request({
      url,
      method,
      data: body,
      timeout: 8000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'application/json, text/plain, */*',
        'Content-Type': 'application/json',
        Referer: referer
      }
    });
    result.ok = true;
    result.status = response.status;
    const data = response.data;
    result.dataSample = typeof data === 'string' ? data.slice(0, 1500) : data;
  } catch (error) {
    result.ok = false;
    result.errorMessage = error.message;
    result.errorCode = error.code || null;
    result.httpStatus = error.response?.status ?? null;
    const respBody = error.response?.data;
    result.responseBodySample = typeof respBody === 'string' ? respBody.slice(0, 800) : respBody;
  }
  return result;
}

export default async function handler(req, res) {
  const base = process.env.PHALANG_API_BASE || 'https://api.plapi202624081158.com';
  const referer = 'https://phalang.tv/';

  // FIX (18/09/2026 — GET /matches/graph trả 405 Method Not Allowed): thử
  // luôn POST (không body và body rỗng {}) — endpoint tên "graph" nhiều khả
  // năng là kiểu GraphQL/RPC chỉ nhận POST.
  const [getAttempt, postNoBody, postEmptyBody] = await Promise.all([
    tryFetch(`${base}/matches/graph?_t=${Date.now()}`, referer, 'get'),
    tryFetch(`${base}/matches/graph?_t=${Date.now()}`, referer, 'post'),
    tryFetch(`${base}/matches/graph?_t=${Date.now()}`, referer, 'post', {})
  ]);

  const listResult = [getAttempt, postNoBody, postEmptyBody].find((r) => r.ok) || getAttempt;

  // Nếu lấy được danh sách, thử luôn API resolve link phát cho trận đầu tiên
  // (nếu có) để xem endpoint đó có bị chặn/cần method khác không.
  let liveResult = null;
  const firstId = listResult.ok && Array.isArray(listResult.dataSample?.data)
    ? listResult.dataSample.data[0]?.id
    : null;
  if (firstId) {
    const [liveGet, livePost, livePostEmpty] = await Promise.all([
      tryFetch(`${base}/match/${firstId}/live?_t=${Date.now()}`, referer, 'get'),
      tryFetch(`${base}/match/${firstId}/live?_t=${Date.now()}`, referer, 'post'),
      tryFetch(`${base}/match/${firstId}/live?_t=${Date.now()}`, referer, 'post', {})
    ]);
    liveResult = { get: liveGet, post: livePost, postEmptyBody: livePostEmpty };
  }

  return res.status(200).json({
    baseUrlUsed: base,
    matchesGraphAttempts: { get: getAttempt, postNoBody, postEmptyBody },
    matchLiveAttempts: liveResult
  });
}
