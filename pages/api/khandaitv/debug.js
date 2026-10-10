// ROUTE TẠM ĐỂ DÒ LỖI (10/09/2026) — gọi thẳng khandai3.link, KHÔNG nuốt lỗi
// như khandaitv.service.js (service chính luôn try/catch rồi trả mảng rỗng
// khi lỗi, nên không thấy được lý do thật qua API bình thường). Sau khi dò
// xong nguồn Khán Đài, có thể xoá file này (không ảnh hưởng gì tới các route
// khác).
//
// FIX (10/09/2026 — sau khi xác nhận /api/matches/ bị Cloudflare chặn bằng
// "Just a moment..." JS challenge, cf-mitigated: challenge): kiểm tra thêm
// xem trang HTML thường (không phải API JSON) có bị chặn tương tự không —
// nếu KHÔNG bị chặn thì hướng sửa đúng là đọc dữ liệu nhúng sẵn trong HTML
// (giống cách giovang.service.js đã làm) thay vì gọi thẳng /api/matches/.
import axios from 'axios';

async function tryFetch(url, referer) {
  const result = { triedUrl: url };
  try {
    const response = await axios.get(url, {
      timeout: 8000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/json,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Referer': referer
      }
    });
    result.ok = true;
    result.status = response.status;
    const data = response.data;
    result.dataSample = typeof data === 'string' ? data.slice(0, 1500) : data;
    result.isChallenge = typeof data === 'string' && data.includes('Just a moment');
    result.containsNuxtData = typeof data === 'string' && data.includes('__NUXT_DATA__');
  } catch (error) {
    result.ok = false;
    result.errorMessage = error.message;
    result.errorCode = error.code || null;
    result.httpStatus = error.response?.status ?? null;
    const body = error.response?.data;
    result.responseBodySample = typeof body === 'string' ? body.slice(0, 500) : body;
    result.isChallenge = typeof body === 'string' && body.includes('Just a moment');
  }
  return result;
}

export default async function handler(req, res) {
  const base = process.env.KHANDAITV_DOMAIN || process.env.KHANDAITV_BASE_URL || 'https://khandai3.link';

  const [apiResult, homepageResult, schedulePageResult] = await Promise.all([
    tryFetch(`${base}/api/matches/?ordering=smart&page_size=10&_t=${Date.now()}`, `${base}/`),
    tryFetch(`${base}/`, `${base}/`),
    tryFetch(`${base}/lich-thi-dau`, `${base}/`)
  ]);

  return res.status(200).json({
    baseUrlUsed: base,
    apiEndpoint: apiResult,
    homepage: homepageResult,
    schedulePage: schedulePageResult
  });
}

