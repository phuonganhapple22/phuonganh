import { getMatches } from '@/src/services/playlistCache.service';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, message: 'Method Not Allowed' });
  }
  try {
    res.setHeader('Cache-Control', 'no-store');
    const { matches, generatedAt, nextRefreshAt, refreshIntervalMs } = await getMatches();
    return res.status(200).json({
      success: true,
      count: matches.length,
      generatedAt: generatedAt ? new Date(generatedAt).toISOString() : null,
      nextRefreshAt: nextRefreshAt ? new Date(nextRefreshAt).toISOString() : null,
      // Khoảng quét thực tế lúc này: 15' nếu đang có trận, giãn ra tới 2h nếu không có trận nào.
      refreshIntervalSeconds: refreshIntervalMs / 1000
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message || 'Internal Server Error' });
  }
}

// Quét trận có thể gọi ~15-20 nguồn ngoài — nới trần thời gian chạy
// (mặc định 10s) lên mức tối đa Vercel Hobby cho phép (60s) để đủ chỗ
// cho các lần cold-start/refresh chậm trước khi bị nền tảng tự ngắt.
export const config = { maxDuration: 60 };
