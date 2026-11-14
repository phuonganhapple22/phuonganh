import reraceService from '@/src/services/rerace.service';

// GET /api/rerace/debug?id=<matchId>  (vd rr_1234 hoặc id ppv)
// Trả trace từng bước quét trang embed (HTTP status, số byte, m3u8 tìm được) để biết trang embed chặn Referer hay giấu link ở đâu.
// Chỉ nhận id trận (không nhận URL tùy ý) nên không bị lợi dụng làm proxy.
export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Method Not Allowed' });
  const id = String(req.query.id || '');
  if (!id) return res.status(400).json({ success: false, message: 'Thiếu id trận đấu (?id=rr_...)' });
  const debug = { trace: {}, match: null, links: [] };
  try {
    const streams = await reraceService.getStreamLinks(id, debug);
    return res.status(200).json({ success: true, streamCount: streams.length, ...debug });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message, ...debug });
  }
}

export const config = { maxDuration: 60 };
