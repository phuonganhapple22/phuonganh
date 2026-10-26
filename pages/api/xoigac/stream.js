import xoigacService from '@/src/services/xoigac.service';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Method Not Allowed' });
  const id = String(req.query.id || '');
  if (!id) return res.status(400).json({ success: false, message: 'Thiếu id trận đấu' });
  try {
    const streams = await xoigacService.getStreamLinks(id);
    return res.status(200).json({ success: true, data: { streams }, meta: { source: 'xoigac', streamCount: streams.length } });
  } catch (error) {
    console.error('[API /xoigac/stream]', error.message);
    return res.status(500).json({ success: false, message: 'Không thể lấy stream từ Xôi Gấc', error: error.message });
  }
}

export const config = { maxDuration: 60 };
