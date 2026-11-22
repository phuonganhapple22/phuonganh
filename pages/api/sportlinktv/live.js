import sportlinktvService from '@/src/services/sportlinktv.service';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Method Not Allowed' });
  try {
    const { tab = 'live', sport = 'football' } = req.query;
    const result = await sportlinktvService.getAllMatchesByTab(tab, sport);
    return res.status(200).json({
      success: true,
      data: result.matches,
      meta: { source: 'sportlinktv', tab, total: result.totalCount, hasMore: false }
    });
  } catch (error) {
    console.error('[API /sportlinktv/live]', error.message);
    return res.status(500).json({ success: false, message: 'Không thể lấy dữ liệu từ SportlinkTV', error: error.message });
  }
}

export const config = { maxDuration: 30 };
