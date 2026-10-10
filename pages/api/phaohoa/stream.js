import phaohoaService from '@/src/services/phaohoa.service';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, message: 'Method Not Allowed' });
  }
  try {
    const matchId = req.query.id;
    if (!matchId) {
      return res.status(400).json({
        success: false,
        message: 'Parameter "id" (Match ID) is required.'
      });
    }

    const streams = await phaohoaService.getStreamLinks(matchId, req.query.sport || 'football');
    return res.status(200).json({
      success: true,
      matchId,
      count: streams.length,
      data: streams
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Internal Server Error'
    });
  }
}
