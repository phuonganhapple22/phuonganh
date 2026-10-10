import { getMatches } from '@/src/services/playlistCache.service';
import { buildM3uPlaylist, matchesToPlaylistEntries } from '@/src/utils/m3uPlaylist';
import { filterBySportTab, filterBySource, getSourceShortLabel } from '@/src/utils/playerGet';

// FIX "web hiện live khác playlist dù cùng 1 nguồn dữ liệu": trước đây route
// này tự gọi getMatches() (playlistCache.service.js) — TÁCH BIỆT hoàn toàn
// với cache mà /api/matches (web) đang dùng, vì mỗi route API là 1
// serverless function riêng trên Vercel, không chia sẻ globalThis. Giờ gọi
// THẲNG vào /api/matches?raw=1 (cùng domain, HTTP nội bộ) để lấy đúng 100%
// dữ liệu mà web đang thấy — chỉ còn đúng 1 cache canonical duy nhất trên
// toàn hệ thống, loại bỏ khả năng 2 route lệch nhau.
//
// Giới hạn thời gian chờ RIÊNG cho lệnh gọi nội bộ này (thấp hơn hẳn
// maxDuration=60s của chính route này bên dưới) — /api/matches có thể tự
// đợi tới 50s nếu cache của NÓ đang cold-start (AWAIT_REFRESH_TIMEOUT_MS
// trong playlistCache.service.js). FIX "playlist bị abort/lỗi liên tục":
// trước đây mốc này đặt 45s — THẤP HƠN mức 50s mà /api/matches có thể tự
// đợi -> mọi lần cold-start (deploy mới, hoặc lâu không ai gọi khiến
// container bị thu hồi) route này CHẮC CHẮN bị hủy giữa chừng trước khi
// /api/matches kịp trả lời, luôn thấy "This operation was aborted". Nâng
// lên 55s (dưới sát trần 60s) — vẫn phải có 1 giới hạn (để không treo vô
// thời hạn nếu /api/matches thật sự bị kẹt), nhưng đủ cao để không tự huỷ
// sớm hơn chính giới hạn của cái mình đang đợi.
const INTERNAL_FETCH_TIMEOUT_MS = 55000;

async function fetchRawMatches(baseUrl, forceRefresh) {
  if (!baseUrl) {
    // Cực hiếm khi thiếu cả 2 header host/x-forwarded-host — không dựng
    // được URL tuyệt đối để tự gọi chính mình. Rơi về gọi thẳng cache
    // (như code cũ) còn hơn báo lỗi toàn bộ route.
    return getMatches({ forceRefresh });
  }
  const params = new URLSearchParams({ raw: '1' });
  if (forceRefresh) params.set('refresh', '1');
  const url = `${baseUrl}/api/matches?${params.toString()}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), INTERNAL_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'internal-playlist-route' }, signal: controller.signal });
    if (!res.ok) throw new Error(`Gọi nội bộ /api/matches thất bại: HTTP ${res.status}`);
    const json = await res.json();
    if (!json.success) throw new Error(json.message || 'Gọi nội bộ /api/matches thất bại');
    return json;
  } finally {
    clearTimeout(timer);
  }
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, message: 'Method Not Allowed' });
  }

  try {
    const sportTab = String(req.query.sport || 'all');
    // ?source=phaohoa|giovang — playlist RIÊNG cho 1 nguồn,
    // để dán vào VLC/app IPTV chỉ theo dõi 1 nguồn thay vì gộp tất cả.
    // Bỏ trống hoặc 'all' thì giữ hành vi cũ (gộp mọi nguồn).
    const sourceKey = String(req.query.source || req.query.nguon || 'all');
    const download = req.query.download === '1' || req.query.download === 'true';
    // ?refresh=1 — ép quét lại ngay (bỏ qua cache 15 phút), dùng khi cần dữ liệu mới nhất gấp.
    const forceRefresh = req.query.refresh === '1' || req.query.refresh === 'true';

    // Trận sắp đá cần 1 URL resolver TUYỆT ĐỐI (có domain) trong file .m3u —
    // trình phát mở file từ máy khác, không thể dùng URL tương đối. Tự suy
    // ra từ chính request đang phục vụ (đúng domain thật đang chạy, kể cả
    // preview deploy trên Vercel) — không cần cấu hình thêm biến môi trường.
    const proto = req.headers['x-forwarded-proto'] || 'https';
    const host = req.headers['x-forwarded-host'] || req.headers.host || '';
    const baseUrl = host ? `${proto}://${host}` : '';

    const { matches, generatedAt, nextRefreshAt, refreshIntervalMs } = await fetchRawMatches(baseUrl, forceRefresh);

    const bySport = filterBySportTab(matches, sportTab);
    const playable = filterBySource(bySport, sourceKey);
    const entries = await matchesToPlaylistEntries(playable, { baseUrl });
    // ?format=app — xem chú thích trong buildM3uPlaylist(): dùng cho app
    // IPTV Android (ExoPlayer) thay vì VLC.
    const format = String(req.query.format || 'vlc') === 'app' ? 'app' : 'vlc';
    const playlist = buildM3uPlaylist(entries, { format });

    const ageSec = generatedAt ? Math.max(0, Math.round((Date.now() - generatedAt) / 1000)) : 0;
    // Tên file phản ánh cả nguồn lẫn môn thể thao khi có lọc, ví dụ
    // "live-phaohoa-football.m3u" — giúp phân biệt khi tải nhiều playlist
    // khác nhau về cùng 1 máy/app IPTV.
    const fileSlug = (sourceKey === 'all' ? sportTab : `${sourceKey}-${sportTab}`) + (format === 'app' ? '-app' : '');

    res.setHeader('Content-Type', 'audio/x-mpegurl');
    res.setHeader(
      'Content-Disposition',
      `${download ? 'attachment' : 'inline'}; filename="live-${fileSlug}.m3u"`
    );
    // s-maxage NGẮN (60s, không phải 120s như bug cũ) + stale-while-revalidate
    // NGẮN (90s) — vừa đủ để bấm refresh trên app luôn được CDN trả NGAY LẬP
    // TỨC (không phải đợi server quét lại từ đầu → hết cảnh "quay tít" khi
    // container Vercel nguội/cold-start), vừa không bị cache dai như bug cũ
    // (khi đó là 120+300=420s ~7 phút, khiến bấm refresh mãi không thấy gì
    // mới). Tệ nhất dữ liệu cũ đi ~2.5 phút — chấp nhận được vì bản thân dữ
    // liệu nguồn cũng chỉ tự làm mới mỗi 15 phút (xem playlistCache.service.js).
    res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=60, stale-while-revalidate=90');
    if (generatedAt) res.setHeader('Last-Modified', new Date(generatedAt).toUTCString());
    res.setHeader('X-Playlist-Generated-At', generatedAt ? new Date(generatedAt).toISOString() : '');
    res.setHeader('X-Playlist-Age-Seconds', String(ageSec));
    res.setHeader('X-Playlist-Refresh-Interval-Seconds', String(refreshIntervalMs / 1000));
    res.setHeader('X-Playlist-Next-Refresh-At', nextRefreshAt ? new Date(nextRefreshAt).toISOString() : '');
    // FIX (lỗi luôn tái hiện với MỌI request có ?source=... hoặc ?nguon=...):
    // getSourceShortLabel() trả về nhãn tiếng Việt có dấu (vd "Xôi Lạc",
    // "Gà Vàng") — HTTP header chỉ chấp nhận ký tự Latin-1 (ISO-8859-1),
    // Node ném "TypeError: Invalid character in header content" ngay khi
    // setHeader() với chuỗi có dấu tiếng Việt. Lỗi này bị try/catch bên
    // dưới bắt lại rồi in ra dưới dạng "#EXTM3U\n# Error: ..." — tức là
    // toàn bộ playlist theo nguồn riêng (?source=phaohoa/
    // giovang) bị hỏng 100% các lần gọi, không phụ thuộc mạng/dữ liệu.
    // encodeURIComponent() giữ header luôn là ASCII hợp lệ; phía client
    // muốn hiển thị tên có dấu thì decodeURIComponent() lại.
    res.setHeader(
      'X-Playlist-Source',
      sourceKey === 'all' ? 'all' : encodeURIComponent(getSourceShortLabel(sourceKey))
    );

    return res.status(200).send(playlist);
  } catch (error) {
    // In cả stack trace ra log Vercel (không phải chỉ message) để lần sau
    // biết chính xác dòng nào gây lỗi, thay vì phải đoán qua thông báo
    // chung chung như "a.filter is not a function".
    console.error('[playlist] failed:', error?.stack || error);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.status(500).send('#EXTM3U\n# Error: ' + (error.message || 'Internal Server Error') + '\n');
  }
}

// Quét trận có thể gọi ~15-20 nguồn ngoài — nới trần thời gian chạy
// (mặc định 10s) lên mức tối đa Vercel Hobby cho phép (60s) để đủ chỗ
// cho các lần cold-start/refresh chậm trước khi bị nền tảng tự ngắt.
export const config = { maxDuration: 60 };
