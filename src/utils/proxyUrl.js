/**
 * Bọc 1 link stream gốc (thường là .m3u8/.flv trỏ thẳng ra CDN nguồn như
 * luong.phaohoa.live) qua route /api/proxy/hls chạy trên server của chính
 * app này, để trình duyệt không còn gọi thẳng cross-origin sang CDN nguồn
 * nữa (né lỗi CORS "No 'Access-Control-Allow-Origin' header..." — xem chú
 * thích chi tiết trong pages/api/proxy/hls.js).
 *
 * Dùng ở component player (phía trình duyệt) — KHÔNG dùng cho link hiển thị
 * để copy sang VLC/app IPTV ngoài, vì các app đó chạy ngoài trình duyệt nên
 * không bị CORS chi phối, cứ dùng thẳng link gốc là phát được bình thường.
 */
export function buildProxyStreamUrl(url, source) {
  if (!url) return url;
  // Đã là link nội bộ (route tương đối của chính app, ví dụ đã được resolve
  // qua proxy từ trước) thì không bọc chồng thêm lần nữa.
  if (url.startsWith('/')) return url;
  const qs = new URLSearchParams({ url });
  if (source) qs.set('source', source);
  return `/api/proxy/hls?${qs.toString()}`;
}
