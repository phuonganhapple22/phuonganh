import phaohoaService from '@/src/services/phaohoa.service';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, message: 'Method Not Allowed' });
  }
  try {
    const { sport, tab } = req.query;
    const resData = await phaohoaService.getAllMatchesByTab(tab || 'live', sport || 'all', 50);
    const matches = Array.isArray(resData) ? resData : (resData.matches || []);
    return res.status(200).json({
      success: true,
      count: matches.length,
      data: matches
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Internal Server Error'
    });
  }
}
