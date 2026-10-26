import xoilacService from '@/src/services/xoilac.service';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Method Not Allowed' });
  try {
    const { tab = 'live', sport = 'all' } = req.query;
    const result = await xoilacService.getAllMatchesByTab(tab, sport);
    return res.status(200).json({
      success: true,
      data: result.matches,
      meta: { source: 'xoilac', tab, total: result.totalCount, hasMore: false }
    });
  } catch (error) {
    console.error('[API /xoilac/live]', error.message);
    return res.status(500).json({ success: false, message: 'Không thể lấy dữ liệu từ Xôi Lạc', error: error.message });
  }
}

// Mỗi trận live gọi thêm trang BLV để lấy link — nới trần thời gian chạy.
export const config = { maxDuration: 60 };
