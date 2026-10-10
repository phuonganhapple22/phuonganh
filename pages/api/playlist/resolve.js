// FIX (20/09/2026 — loại bỏ Pháo Hoa, domain chết): không import
// phaohoaService ở route này nữa — không còn trận nào có source='phaohoa'
// được tạo ra từ playlistBuilder.service.js, nhánh xử lý bên dưới không
// bao giờ được gọi tới nữa.
import giovangService from '@/src/services/giovang.service';
import khandaitvService from '@/src/services/khandaitv.service';
import chuoichientvService from '@/src/services/chuoichientv.service';
import phalangService from '@/src/services/phalang.service';
import xoilacService from '@/src/services/xoilac.service';
import xoigacService from '@/src/services/xoigac.service';
import { normalizeStreamList, isFlvUrl } from '@/src/utils/playerGet';
import { preferHlsForIptv } from '@/src/utils/m3uPlaylist';
import { buildProxyStreamUrl } from '@/src/utils/proxyUrl';

/**
 * GET /api/playlist/resolve?source=<key>&matchId=<id>&url=<liveUrl>&sport=<sport>
 *
 * Trận "sắp đá" trong file .m3u KHÔNG có link stream cố định (vì chưa bóng
 * lăn, chưa có bình luận viên) — kênh của nó trong playlist trỏ vào đây
 * thay vì 1 URL cứng. Khi trình phát (VLC, TiviMate, Perfect Player...) mở
 * kênh này (bất kể lúc đó là trước hay sau giờ bóng lăn), route này MỚI đi
 * lấy link thật ngay tại thời điểm đó:
 *   - Có link → 302 redirect sang link .m3u8 thật, phát bình thường.
 *   - Chưa có (chưa tới giờ / nguồn chưa có blv) → trả lỗi ngắn, trình phát
 *     báo không mở được — người xem thử lại gần giờ bóng lăn.
 *
 * Không cache ở đây: mỗi lần mở kênh phải luôn kiểm tra lại trạng thái mới
 * nhất, tự nó không tốn tài nguyên vì chỉ chạy khi có người thật sự bấm play.
 *
 * FIX (25/08/2026 — theo yêu cầu "chỉ giữ Pháo Hoa + Giờ Vàng"): đã xoá hẳn
 * các nhánh Gà Vàng/Xôi Lạc/AFF Cup/90Phút/VSC9 — chỉ còn phaohoa/giovang.
 * FIX (09/09/2026 — theo yêu cầu): thêm nhánh khandaitv (cùng cách gọi như
 * phaohoa vì cùng schema/backend, xem khandaitv.service.js).
 * FIX (17/09/2026 — theo yêu cầu): thêm nhánh chuoichientv (API riêng, xem
 * chuoichientv.service.js — getStreamLinks chỉ cần matchId, không cần sport).
 */
export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, message: 'Method Not Allowed' });
  }

  res.setHeader('Cache-Control', 'no-store');

  const source = String(req.query.source || '');
  const matchId = String(req.query.matchId || '');
  const url = String(req.query.url || '');
  const sport = String(req.query.sport || 'football');
  const wantsJson = req.query.json === '1' || req.query.json === 'true';

  const notReadyYet = () => {
    if (wantsJson) {
      return res.status(503).json({ success: false, message: 'Trận chưa phát — thử lại gần giờ bóng lăn.' });
    }
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.status(503).send('Trận chưa phát — thử lại gần giờ bóng lăn.');
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function withDeadline(promise, ms) {
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve([]), ms);
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  try {
    let raw = [];
    const maxAttempts = 2;
    const attemptTimeoutMs = 8000; // Giờ Vàng/Khán Đài/Chuối Chiên/Phá Làng gọi thẳng 1 API, hiếm khi chậm

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        if (source === 'khandaitv') {
          if (!matchId) return notReadyYet();
          raw = await withDeadline(khandaitvService.getStreamLinks(matchId, sport), attemptTimeoutMs);
        } else if (source === 'chuoichientv') {
          if (!matchId) return notReadyYet();
          raw = await withDeadline(chuoichientvService.getStreamLinks(matchId), attemptTimeoutMs);
        } else if (source === 'phalang') {
          if (!matchId) return notReadyYet();
          raw = await withDeadline(phalangService.getStreamLinks(matchId), attemptTimeoutMs);
        } else if (source === 'xoilac') {
          // Link FLV có auth_key hết hạn nhanh -> luôn lấy mới lúc bấm xem.
          if (!matchId) return notReadyYet();
          raw = await withDeadline(xoilacService.getStreamLinks(matchId), 20000);
        } else if (source === 'xoigac') {
          // Trang chủ Xoigac có sẵn link HLS từng trận -> lấy mới lúc bấm xem cho chắc trạng thái BLV.
          if (!matchId) return notReadyYet();
          raw = await withDeadline(xoigacService.getStreamLinks(matchId), 15000);
        } else if (source === 'giovang') {
          const id = url || matchId;
          if (!id) return notReadyYet();
          const detail = await withDeadline(giovangService.getMatchDetail(id), attemptTimeoutMs);
          raw = detail?.streams || [];
        } else {
          return notReadyYet();
        }

        if (raw?.length) break;
      } catch (err) {
        if (attempt >= maxAttempts) throw err;
      }
      if (attempt < maxAttempts) await sleep(400 * attempt);
    }

    const list = normalizeStreamList(raw || []);
    const best = list.find((s) => s.m3u8Url) || list[0];

    const upgraded = await preferHlsForIptv(best || {});
    const playUrl = upgraded?.playUrl || upgraded?.m3u8Url || best?.playUrl || best?.m3u8Url || best?.flvUrl;
    const format = upgraded?.format || (isFlvUrl(playUrl || '') ? 'flv' : '');

    if (!playUrl) return notReadyYet();

    if (wantsJson) {
      // Nhánh JSON dùng bởi chính trang /watch (xem useResolvedStream trong
      // pages/watch.jsx) — trang đó TỰ bọc qua buildProxyStreamUrl() ở
      // VideoPlayer.jsx rồi, trả playUrl thô ở đây để không bọc trùng 2 lớp.
      return res.status(200).json({ success: true, playUrl, format });
    }

    // FIX (20/09/2026 — "sợ 1 số nguồn bị CDN chặn khi xem qua VLC/app
    // IPTV ngoài"): trước đây redirect THẲNG ra playUrl gốc (CDN nguồn) —
    // đúng với app dùng qua trình duyệt thì không sao vì VideoPlayer.jsx tự
    // bọc qua /api/proxy/hls (route đã tự gắn đúng Referer/Origin cho từng
    // nguồn, xem pages/api/proxy/hls.js), nhưng app IPTV ngoài (VLC,
    // TiviMate...) dùng THẲNG link redirect này lại KHÔNG đi qua proxy đó —
    // CDN nào yêu cầu đúng Referer (Chuối Chiên, Pháo Hoa, Giờ Vàng, Khán
    // Đài — xem REFERER_CANDIDATES_BY_SOURCE trong hls.js) sẽ chặn thẳng
    // app IPTV dù cùng lúc xem qua web vẫn bình thường. Giờ redirect qua
    // chính route proxy đó (dùng URL TUYỆT ĐỐI vì Location header của
    // redirect cần domain đầy đủ để app ngoài trình duyệt theo được, không
    // phải app nào cũng tự suy ra domain từ URL tương đối) — CDN nào chặn
    // theo IP máy chủ (như Phá Làng, xem phalang.service.js) thì vẫn chặn y
    // hệt (đổi đường redirect không giải quyết được kiểu chặn đó), nhưng
    // các CDN chặn theo Referer thì nay app IPTV cũng qua được như web.
    const proto = req.headers['x-forwarded-proto'] || 'https';
    const host = req.headers['x-forwarded-host'] || req.headers.host || '';
    const baseUrl = host ? `${proto}://${host}` : '';
    const proxiedUrl = baseUrl ? `${baseUrl}${buildProxyStreamUrl(playUrl, source)}` : playUrl;

    return res.redirect(302, proxiedUrl);
  } catch (err) {
    console.error('[API /playlist/resolve]', err.message);
    if (wantsJson) return res.status(500).json({ success: false, message: err.message || 'Lỗi không xác định' });
    return notReadyYet();
  }
}

export const config = { maxDuration: 60 };
