import giovangService from '@/src/services/giovang.service';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Method Not Allowed' });
  const id = String(req.query.id || req.query.url || '');
  if (!id) return res.status(400).json({ success: false, message: 'Thiếu id hoặc url trận đấu' });
  try {
    const detail = await giovangService.getMatchDetail(id);
    return res.status(200).json({ success: true, data: detail, meta: { source: 'giovang', streamCount: detail.streams.length } });
  } catch (error) {
    console.error('[API /giovang/stream]', error.message);
    return res.status(500).json({ success: false, message: 'Không thể lấy stream từ Giovang', error: error.message });
  }
}

// Trang chi tiết render bằng Vue phía client — cần mở bằng Chromium headless
// để đọc link m3u8 thật đã render, tốn vài giây nên nới trần thời gian chạy
// lên mức tối đa Vercel Hobby cho phép.
export const config = { maxDuration: 60 };
