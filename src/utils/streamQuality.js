// Chất lượng THẬT của 1 stream (FHD > HD > SD) — dùng chung để:
//  (1) gắn nhãn `quality` đúng thực tế (trước đây gán cứng 'HD' cho mọi link,
//      kể cả link SD -> người xem thấy nhãn "HD" mà hình mờ như SD);
//  (2) chọn link CHẤT LƯỢNG CAO NHẤT khi 1 trận có nhiều link (trước đây
//      playlist chỉ lấy link ĐẦU TIÊN, thường là bản thấp).
// Chỉ đọc nhãn trong TÊN/`quality` của chính stream, KHÔNG suy từ URL (vd. host
// "hdplaylink" chứa chữ "hd" nhưng là CDN của bản SD).

const RANK = { FHD: 4, HD: 3, '': 2, SD: 1 };

export function qualityFromText(text) {
  const t = String(text || '');
  if (/\bf\.?hd\b|full\s*-?\s*hd|1080/i.test(t)) return 'FHD';
  if (/\bhd\b|720/i.test(t)) return 'HD';
  if (/\bsd\b|480|360|\blow\b/i.test(t)) return 'SD';
  return '';
}

/** Điểm chất lượng: FHD 4 > HD 3 > chưa rõ 2 > SD 1. Nhãn trong tên được ưu tiên hơn field `quality`. */
export function qualityRank(stream) {
  const fromName = qualityFromText(stream?.name || stream?.streamerName);
  if (fromName) return RANK[fromName];
  const declared = String(stream?.quality || '').toUpperCase();
  return RANK[declared] ?? RANK[''];
}

/** Stream chất lượng cao nhất; bằng điểm thì giữ thứ tự gốc (không đổi hành vi với nguồn không có nhãn). */
export function pickBestStream(streams = []) {
  let best = null;
  let bestRank = -1;
  for (const s of streams) {
    const r = qualityRank(s);
    if (r > bestRank) { best = s; bestRank = r; }
  }
  return best;
}
