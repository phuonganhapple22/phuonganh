import sportlinktvService from '@/src/services/sportlinktv.service';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Method Not Allowed' });
  const id = String(req.query.id || '');
  if (!id) return res.status(400).json({ success: false, message: 'Thiếu id trận đấu' });
  try {
    const streams = await sportlinktvService.getStreamLinks(id);
    return res.status(200).json({ success: true, data: { streams }, meta: { source: 'sportlinktv', streamCount: streams.length } });
  } catch (error) {
    console.error('[API /sportlinktv/stream]', error.message);
    return res.status(500).json({ success: false, message: 'Không thể lấy stream từ SportlinkTV', error: error.message });
  }
}

export const config = { maxDuration: 30 };
