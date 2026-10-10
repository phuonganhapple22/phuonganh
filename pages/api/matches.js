import { getMatches } from '@/src/services/playlistCache.service';
import { filterBySportTab, getSourceKey } from '@/src/utils/playerGet';

/**
 * GET /api/matches?sport=<tab>&refresh=1
 *
 * JSON version of the aggregated live-match list (same cache as
 * /api/playlist), used by the homepage to render match cards grouped by
 * source with per-source show/hide toggles.
 *
 * FIX (25/08/2026 — theo yêu cầu "chỉ giữ Pháo Hoa + Giờ Vàng"): đã bỏ hẳn
 * bộ lọc "requiresHlsOnly" (chỉ cần cho Gà Vàng/Xôi Lạc, đã xoá) — 2 nguồn
 * còn lại luôn trả sẵn .m3u8 hợp lệ, không cần lọc FLV.
 */
export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, message: 'Method Not Allowed' });
  }

  try {
    const sportTab = String(req.query.sport || 'all');
    const forceRefresh = req.query.refresh === '1' || req.query.refresh === 'true';
    // ?raw=1 — dùng NỘI BỘ bởi các route khác (vd /api/playlist, xem
    // pages/api/playlist.js) cần object trận ĐẦY ĐỦ (logo, streams gốc
    // dạng {m3u8Url,flvUrl,playUrl,streamerName,format}...) để build lại
    // .m3u — khác với JSON rút gọn phía dưới dành cho web hiển thị card.
    // Không lọc theo sportTab ở đây, để nguyên cho route gọi tự
    // filterBySportTab()/filterBySource() y hệt logic cũ.
    //
    // FIX "web/playlist hiện live không đồng nhất": /api/matches và
    // /api/playlist trước đây MỖI ROUTE tự gọi getMatches() RIÊNG — trên
    // Vercel mỗi route API là 1 serverless function tách biệt, KHÔNG chia
    // sẻ cache bộ nhớ (globalThis) với nhau (xem chú thích trong
    // playlistCache.service.js), nên 2 route có thể trả 2 kết quả khác
    // nhau tại cùng 1 thời điểm — dù đã bấm "Làm mới" ở web. Giờ
    // /api/matches là nguồn cache DUY NHẤT; mọi route khác gọi vào ĐÂY qua
    // HTTP nội bộ (xem raw=1) thay vì tự giữ cache riêng, đảm bảo mọi nơi
    // luôn thấy đúng 1 danh sách trận giống hệt nhau.
    const raw = req.query.raw === '1' || req.query.raw === 'true';

    const { matches, generatedAt, nextRefreshAt, refreshIntervalMs } = await getMatches({ forceRefresh });

    if (raw) {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ success: true, matches, generatedAt, nextRefreshAt, refreshIntervalMs });
    }

    const filtered = filterBySportTab(matches, sportTab);

    const data = filtered.map((m) => {
      const key = getSourceKey(m);
      const streams = (m.streams || []).map((s) => ({
        name: s.streamerName || s.name || 'Server',
        playUrl: s.playUrl || s.m3u8Url || s.flvUrl || '',
        format: s.format || ''
      })).filter((s) => s.playUrl);

      return {
        matchId: m.matchId,
        title: m.title || '',
        homeTeam: m.homeTeam || null,
        awayTeam: m.awayTeam || null,
        sport: m.sport,
        sportCategory: m.sportCategory,
        source: key,
        sourceLabel: m.sourceLabel || '',
        competition: m.competition || null,
        matchTimeTimestamp: m.matchTimeTimestamp,
        status: m.status || {},
        streams
      };
    });

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
      success: true,
      count: data.length,
      generatedAt: generatedAt ? new Date(generatedAt).toISOString() : null,
      nextRefreshAt: nextRefreshAt ? new Date(nextRefreshAt).toISOString() : null,
      refreshIntervalSeconds: refreshIntervalMs / 1000,
      matches: data
    });
  } catch (error) {
    console.error('[api/matches] failed:', error.message);
    return res.status(500).json({ success: false, message: error.message || 'Internal Server Error', matches: [] });
  }
}

// Quét trận có thể gọi vài nguồn ngoài — nới trần thời gian chạy (mặc định
// 10s) lên mức tối đa Vercel Hobby cho phép (60s) để đủ chỗ cho các lần
// cold-start/refresh chậm trước khi bị nền tảng tự ngắt.
export const config = { maxDuration: 60 };
