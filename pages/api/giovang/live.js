import giovangService from '@/src/services/giovang.service';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Method Not Allowed' });
  try {
    const { tab = 'live' } = req.query;
    const result = await giovangService.getMatchesByTab(tab);
    return res.status(200).json({
      success: true,
      data: result.matches,
      meta: { source: 'giovang', tab, total: result.totalCount, hasMore: false },
      // Chỉ trả debug khi rỗng, để biết ngay đang tắc ở bước nào mà không
      // cần vào log Vercel (giống cơ chế đã làm cho VSC9).
      ...(result.totalCount === 0 ? { debug: giovangService.lastDiagnostics } : {}),
    });
  } catch (error) {
    console.error('[API /giovang/live]', error.message);
    return res.status(500).json({ success: false, message: 'Không thể lấy dữ liệu từ Giovang', error: error.message });
  }
}
