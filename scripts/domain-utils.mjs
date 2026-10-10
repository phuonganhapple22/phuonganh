// Hàm/hằng số dùng chung cho các script kiểm tra domain (check-domains.mjs, resolve-redirects.mjs).

export const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// Trang đỗ tên miền / rao bán / hết hạn -> coi như CHẾT dù trả HTTP 200.
export const PARKED_RE =
  /(domain (is )?for sale|buy this domain|this domain (may be|is) (for sale|parked|available)|domain (name )?(has )?expired|parked (free|domain)|sedo\.com\/search|dan\.com\/buy|afternic|parkingcrew|hugedomains|bodis\.com|tên miền (này )?(đã )?hết hạn|domain registration|renew your domain)/i;
export const CF_CHALLENGE_RE = /(just a moment|attention required|cf-browser-verification|challenge-platform|enable javascript and cookies)/i;

export const stripSlash = (u) => String(u || '').trim().replace(/\/+$/, '');
export const normHost = (h) => String(h || '').toLowerCase().replace(/^www\./, '');

export function hostOf(url) {
  try { return new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).hostname; } catch { return ''; }
}
export function originOf(url) {
  try { return new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).origin; } catch { return ''; }
}

// FIX (08/10/2026 — khandai2.com là trang quảng cáo cá cược "Khandai2 – Cá Cược Trực Tuyến Uy Tín", không phải
// trang xem bóng đá nhưng lại có chữ "khandai" + nhắc "bóng đá/kèo" nên bị nhận nhầm là Khán Đài).
// FIX (08/10/2026, lần 2 — giovang.rent là trang XEM BÓNG ĐÁ thật bị báo nhầm là nhà cái): trang xem bóng đá
// cũng hay có quảng cáo nhà cái / chữ "kèo", "nạp tiền" nên KHÔNG thể chỉ đếm từ khoá cá cược. Quyết định dựa trên
// so sánh với từ khoá XEM TRỰC TIẾP: trang xem bóng đá thật nhắc "trực tiếp / xem bóng đá / lịch thi đấu / BLV"
// RẤT nhiều lần, trang quảng cáo nhà cái thì gần như không. Chỉ coi là trang cá cược khi:
//   - tiêu đề KHÔNG có "trực tiếp/xem bóng đá", VÀ
//   - (tiêu đề có từ khoá cá cược rõ ràng, hoặc nội dung có từ 4 từ khoá cá cược khác nhau trở lên), VÀ
//   - từ khoá xem trực tiếp xuất hiện ít (<= 3 lần trong toàn bộ chữ hiển thị).
const GAMBLING_TERMS = [
  'cá cược', 'ca cuoc', 'nhà cái', 'nha cai', 'casino', 'nổ hũ', 'no hu', 'bắn cá', 'ban ca', 'đá gà', 'da ga',
  'lô đề', 'lo de', 'xổ số', 'xo so', 'slots', 'tài xỉu', 'tai xiu', 'baccarat', 'nạp tiền', 'nap tien',
  'rút tiền', 'rut tien', 'khuyến mãi', 'khuyen mai', 'đăng ký tài khoản', 'dang ky tai khoan', 'hoàn trả'
];
const GAMBLING_TITLE_RE = /(cá cược|ca cuoc|nhà cái|nha cai|casino|nổ hũ|đá gà|lô đề|\bslots?\b)/i;
export const STREAM_TERMS_RE = /(trực tiếp|truc tiep|xem bóng|xem bong|lịch thi đấu|lich thi dau|bình luận viên|\bblv\b|livestream|live stream|link xem|kênh xem)/gi;
const STREAM_TITLE_RE = /(trực tiếp|truc tiep|xem bóng|xem bong|livestream|live stream)/i;

/** Số từ khoá xem-trực-tiếp trong 1 đoạn chữ. */
export function countStreamTerms(text) {
  return (String(text || '').match(STREAM_TERMS_RE) || []).length;
}

export function looksLikeGamblingPage(html) {
  const body = String(html || '');
  const title = (body.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '';
  if (STREAM_TITLE_RE.test(title)) return false; // tiêu đề nói về xem trực tiếp -> trang thể thao
  const text = body.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<[^>]+>/gi, ' ').toLowerCase();
  const streamMentions = countStreamTerms(text);
  if (streamMentions > 3) return false; // nhắc xem trực tiếp nhiều lần -> trang xem bóng đá (quảng cáo nhà cái chỉ là phụ)
  let hits = 0;
  for (const t of GAMBLING_TERMS) if (text.includes(t)) hits += 1;
  if (GAMBLING_TITLE_RE.test(title)) return hits >= 2; // tiêu đề cá cược NHƯNG nội dung cũng phải có >= 2 từ khoá cá cược
  return hits >= 4;
}
