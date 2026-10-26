import xoigacService from '@/src/services/xoigac.service';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Method Not Allowed' });
  try {
    const { tab = 'live', sport = 'all' } = req.query;
    const result = await xoigacService.getAllMatchesByTab(tab, sport);
    return res.status(200).json({
      success: true,
      data: result.matches,
      meta: { source: 'xoigac', tab, total: result.totalCount, hasMore: false }
    });
  } catch (error) {
    console.error('[API /xoigac/live]', error.message);
    return res.status(500).json({ success: false, message: 'Không thể lấy dữ liệu từ Xôi Gấc', error: error.message });
  }
}

// Mỗi trận live gọi thêm trang BLV để lấy link — nới trần thời gian chạy.
export const config = { maxDuration: 60 };
