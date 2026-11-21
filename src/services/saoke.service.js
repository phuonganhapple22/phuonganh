import { qualityFromText } from '@/src/utils/streamQuality';
import { createHttpClient } from '@/src/utils/httpClient';
import { fetchFirstRequestHeaders, captureJsonViaBrowser } from '@/src/utils/browserFetch';

// Domain trang xem (chỉ dùng để build link "trang chi tiết" hiển thị tạm
// khi chưa có link phát) — cũng thuộc dạng hay đổi domain mirror, override
// qua SAOKE_DOMAIN khi cần.
const SAOKE_SITE_URL = process.env.SAOKE_DOMAIN || process.env.SAOKE_BASE_URL || 'https://vip3.saoketv40.xyz';

// FIX (24/09/2026 — "thiếu nhiều trận so với trên web", rồi "chỉ quét được
// 4 trận"): bản đầu đọc payload Nuxt (__NUXT_DATA__) nhúng sẵn trong HTML
// trang chủ — nhưng payload đó CHỈ chứa 1 danh sách rút gọn (16 trận lúc
// lấy mẫu, có lúc chỉ còn 4), không phải toàn bộ lịch. Người dùng tự bắt
// được đúng API JSON THẬT mà chính trang web gọi để lấy danh sách đầy đủ:
// GET https://skapi.66887979.xyz/v2/saoke/home-data — trả về ĐẦY ĐỦ hơn
// nhiều (22 trận lúc kiểm tra, so với 16 của bản Nuxt payload), là JSON
// thuần, KHÔNG cần giải mã gì cả (khác hẳn __NUXT_DATA__ trước đây) — bỏ
// toàn bộ phần giải mã Nuxt phức tạp, gọi thẳng API này cho gọn và đủ hơn.
// Domain player (chỉ dùng làm Referer cho link SD trên hdplaylink). Lấy từ
// source domain (saoke-player=... -> SAOKE_PLAYER_DOMAIN), không hardcode cứng.
const SAOKE_PLAYER_URL = String(process.env.SAOKE_PLAYER_DOMAIN || 'https://sk.mediastation.live').replace(/\/+$/, '');

const SAOKE_API_BASE_URL = process.env.SAOKE_API_DOMAIN || 'https://skapi.66887979.xyz';

const client = createHttpClient(
  {
    baseURL: SAOKE_API_BASE_URL,
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'vi,en-US;q=0.9,en;q=0.8',
      Referer: `${SAOKE_SITE_URL}/`,
      // FIX (05/10/2026 — "0 trận Sao Kê, API trả 403"): API có thể kiểm tra cả Origin chứ không chỉ Referer.
      Origin: SAOKE_SITE_URL
    },
    timeout: 15000
  },
  { maxAttempts: 3, retryDelayMs: 1000 }
);

function detectCdn(url) {
  const u = String(url || '').toLowerCase();
  if (u.includes('hdplaylink')) return 'HDPLAYLINK';
  if (u.includes('edgemaxcdn')) return 'EDGEMAX';
  if (u.includes('cloudflare')) return 'CLOUDFLARE';
  return 'HLS';
}

// FIX (24/09/2026 — "Sao Kê các trận lỗi không xem được", CDN trả 403): API trả
// cho mỗi BLV 2 link: "SD" trên stream.hdplaylink.com và "HD" trên edgemaxcdn.org.
// Bản cũ ưu tiên link tên "HD" => luôn chọn edgemaxcdn — link này bị 403 (chống
// hotlink) tại thời điểm đó. Trình duyệt thật (bắt từ DevTools) lúc đó lại phát
// link hdplaylink (SD), nên đổi ưu tiên sang hdplaylink.
//
// FIX (27/09/2026 sáng — "toàn SD, xem mờ") RỒI HOÀN TÁC NGAY (27/09/2026
// chiều — "vẫn 2 Referer như Chuối Chiên, HD hay bị 403"): đã thử đổi mặc
// định sang ưu tiên HD (edgemaxcdn), nhưng người dùng xác nhận bằng DevTools
// thật: Referer/Origin ĐÚNG cho link hdplaylink (SD) là
// https://sk.mediastation.live/ — CHÍNH LÀ giá trị detectPlayerReferer() bên
// dưới tự dò được (vì trang tự phát SD mặc định) — nhưng HD (edgemaxcdn)
// dùng CDN khác hẳn, cần Referer RIÊNG mà ta CHƯA xác nhận được (giống hệt
// bài học Chuối Chiên: hdplaylink và edgemaxcdn là 2 CDN độc lập, Referer
// dò được cho cái này không tự nhiên đúng cho cái kia) — dùng chung Referer
// đã dò cho cả HD khiến HD hay bị 403. Quay lại ưu tiên SD làm mặc định
// (AN TOÀN, đã xác nhận chạy được) cho tới khi có ai bắt được DevTools của
// 1 trận đang phát HD thật (khác psac SD) để biết đúng Referer riêng cho
// edgemaxcdn. Đặt SAOKE_PREFER_HD=1 nếu vẫn muốn thử HD (chấp nhận rủi ro
// 403 vài trận).
function pickBestHls(hlsUrls) {
  if (!Array.isArray(hlsUrls) || !hlsUrls.length) return '';
  const valid = hlsUrls.filter((h) => h?.url);
  if (!valid.length) return '';
  const isHdplaylink = (h) => /hdplaylink/i.test(h.url);
  const isHdName = (h) => /hd/i.test(h?.name || '');
  const preferHd = /^(1|true)$/i.test(String(process.env.SAOKE_PREFER_HD || '')); // mặc định TẮT (ưu tiên SD/hdplaylink) — đặt SAOKE_PREFER_HD=1 để bật thử HD
  const pick =
    (preferHd && valid.find(isHdName)) ||
    valid.find(isHdplaylink) ||
    valid.find(isHdName) ||
    valid[0];
  return pick?.url || '';
}

// FIX (29/09/2026 — "Chuối Chiên/Sao Kê/Bông Lau ghi HD mà xem mờ như SD"):
// trước đây mỗi BLV chỉ xuất ĐÚNG 1 link (mặc định bản SD trên hdplaylink) mà
// vẫn gắn nhãn cứng quality:'HD' -> nhãn nói dối. Giờ xuất TẤT CẢ link của
// BLV (thường 2: HD trên edgemaxcdn.org + SD trên hdplaylink), gắn nhãn THẬT
// vào tên ("BLV (HD)" / "BLV (SD)") — playlist tự chọn bản chất lượng CAO NHẤT
// (xem utils/streamQuality.js + m3uPlaylist.js).
// RỦI RO ĐÃ BIẾT (27/09/2026): HD chạy trên CDN khác (edgemaxcdn.org), Referer
// dò được cho SD có thể bị CDN đó trả 403 ở vài trận. Ola TV tự đổi header khi
// gặp 403; nếu app khác báo 403 với HD, đặt SAOKE_PREFER_HD=0 để quay về ưu tiên
// SD (an toàn) — vẫn giữ nhãn đúng.
function normalizeQualityLabel(name, url) {
  const q = qualityFromText(name);
  if (q) return q;
  return /hdplaylink/i.test(url || '') ? 'SD' : '';
}

// FIX (03/10/2026 — "Sao Kê không xem được", CDN trả 403): test curl thật xác
// nhận edgemaxcdn.org (HD) và hdplaylink (SD) đều CHỈ chấp nhận Referer là
// domain PLAYER (saoke-player=..., mặc định https://sk.mediastation.live/);
// Referer là trang chi tiết trận hoặc domain site đều 403. Lỗi cũ: bước dò
// bằng Chromium headless trả về URL TRANG CHI TIẾT của 1 trận mẫu rồi áp cho
// mọi trận. Giờ chỉ nhận giá trị dò được nếu cùng origin với player, còn lại
// luôn dùng domain player lấy từ source domain.
function refererForLink(url, detectedReferer) {
  const playerRef = `${SAOKE_PLAYER_URL}/`;
  try {
    if (detectedReferer && new URL(detectedReferer).origin === new URL(SAOKE_PLAYER_URL).origin) {
      return detectedReferer;
    }
  } catch { /* referer dò được không hợp lệ -> dùng domain player */ }
  return playerRef;
}

function buildCommentators(blvs, referer) {
  const list = [];
  const preferHd = !/^(0|false)$/i.test(String(process.env.SAOKE_PREFER_HD || ''));
  const rankOf = (h) => {
    const q = normalizeQualityLabel(h?.name, h?.url);
    const score = q === 'FHD' ? 3 : q === 'HD' ? 2 : q === 'SD' ? 0 : 1;
    return preferHd ? -score : score; // sắp tăng dần; preferHd -> điểm cao lên trước
  };
  for (const b of Array.isArray(blvs) ? blvs : []) {
    const links = (Array.isArray(b?.hlsUrls) ? b.hlsUrls : [])
      .filter((h) => h?.url)
      .map((h, idx) => ({ h, idx }))
      .sort((a, c) => rankOf(a.h) - rankOf(c.h) || a.idx - c.idx)
      .map((x) => x.h);
    const seenUrl = new Set();
    for (const h of links) {
      if (seenUrl.has(h.url)) continue;
      seenUrl.add(h.url);
      const q = normalizeQualityLabel(h.name, h.url);
      const baseName = b?.name || 'BLV';
      list.push({
        id: `${b?.keyId || b?.name || `blv_${list.length}`}_${q || list.length}`,
        name: q ? `${baseName} (${q})` : baseName,
        avatar: null,
        streamUrl: h.url,
        isLive: true,
        cdn: detectCdn(h.url),
        // Referer THẬT tự dò được (nếu có) — xem detectPlayerReferer() bên
        // dưới. null nếu chưa dò được/dò lỗi, m3uPlaylist.js sẽ tự rơi về
        // danh sách ứng viên hardcode (REFERER_CANDIDATES_BY_SOURCE.saoke).
        referer: refererForLink(h.url, referer)
      });
    }
  }
  return list;
}

// ---- Tự dò Referer/Origin THẬT bằng trình duyệt headless -----------------
// FIX (25/09/2026 — "có cách nào bắt được link chuẩn từ sao kê không"): thay
// vì đoán tay domain player (đã từng đoán SAI 1 lần — nhầm sang domain
// trang chính thay vì domain player thật sk.mediastation.live, xem FIX
// 24/09/2026 phía trên), mở trang chi tiết 1 trận ĐANG LIVE bằng Chromium
// headless thật (hạ tầng đã có sẵn, đang dùng cho Giờ Vàng/Chuối Chiến —
// xem src/utils/browserFetch), bắt ĐÚNG request .m3u8 mà chính trình duyệt
// tự gửi, đọc lại Referer nó dùng — hết phải đoán.
//
// Chỉ cần dò 1 LẦN cho MỌI trận (cùng site -> cùng domain player), không
// phải dò riêng từng trận. Cache trong bộ nhớ của TIẾN TRÌNH NÀY (biến
// module-level) để khỏi mở Chromium lại mỗi request — nhưng LƯU Ý: route
// /api/matches và pages/api/proxy/hls.js là 2 serverless function RIÊNG
// trên Vercel, KHÔNG chia sẻ bộ nhớ này với nhau (xem cảnh báo tương tự
// trong playlistCache.service.js) — nên giá trị dò được ở đây chỉ có tác
// dụng cho chính output của service này (m3u tĩnh sinh ra qua /api/playlist,
// xem m3uPlaylist.js dùng field `referer` gắn ở buildCommentators() trên).
// Muốn hls.js (proxy sống) cũng hưởng lợi thì phải nhờ scripts/generate-
// playlists.js đọc lại đúng Referer đã nhúng sẵn trong .m3u tĩnh rồi ghi ra
// public/playlists/saoke-referer.json — hls.js đọc file tĩnh đó (được commit
// + deploy cùng repo, xem TODO/README nếu cần nối bước này).
const DETECT_REFERER_TIMEOUT_MS = 12000; // ngắn để không kéo dài tổng thời gian quét (xem AWAIT_REFRESH_TIMEOUT_MS trong playlistCache.service.js)
const DETECT_REFERER_TTL_MS = 2 * 60 * 60 * 1000; // 2 tiếng — domain player không đổi liên tục cỡ phút
const detectCache = globalThis.__saokeRefererDetectCache || { value: null, detectedAt: 0, inFlight: null };
globalThis.__saokeRefererDetectCache = detectCache;

async function detectPlayerReferer(sampleDetailUrl) {
  if (!sampleDetailUrl) return detectCache.value;
  if (detectCache.value && Date.now() - detectCache.detectedAt < DETECT_REFERER_TTL_MS) {
    return detectCache.value;
  }
  if (detectCache.inFlight) return detectCache.inFlight;

  detectCache.inFlight = (async () => {
    try {
      const found = await fetchFirstRequestHeaders(sampleDetailUrl, /\.m3u8(\?|$)/i, {
        timeoutMs: DETECT_REFERER_TIMEOUT_MS
      });
      const referer = found?.headers?.referer || found?.headers?.Referer || null;
      if (referer) {
        detectCache.value = referer;
        detectCache.detectedAt = Date.now();
        console.log(`[saoke] tự dò được Referer thật từ trình duyệt: ${referer}`);
      } else {
        console.error('[saoke] mở trang bằng trình duyệt xong nhưng không bắt được request .m3u8 nào (site có thể đã đổi cấu trúc)');
      }
      return detectCache.value;
    } catch (error) {
      // Chromium lỗi (thiếu binary trên môi trường dev, timeout, site chặn
      // bot dù đã stealth...) -> không throw, cứ trả cache cũ (có thể null)
      // để KHÔNG làm hỏng luồng lấy danh sách trận chính, chỉ mất phần
      // referer tự dò, vẫn còn danh sách ứng viên hardcode làm lưới đỡ.
      console.error('[saoke] dò Referer bằng trình duyệt headless thất bại (dùng fallback hardcode):', error.message);
      return detectCache.value;
    } finally {
      detectCache.inFlight = null;
    }
  })();

  return detectCache.inFlight;
}

function mapStreams(match) {
  const list = [];
  const seen = new Set();
  for (const c of match?.commentators || []) {
    const url = c.streamUrl || '';
    if (!url || seen.has(url)) continue;
    seen.add(url);
    list.push({
      id: c.id,
      streamerId: c.id,
      name: c.name,
      streamerName: c.name,
      avatar: c.avatar,
      streamerAvatar: c.avatar,
      link: url,
      m3u8Url: url,
      playUrl: url,
      format: 'hls',
      cdn: c.cdn,
      quality: qualityFromText(c.name),
      referer: c.referer || null // giữ Referer theo CDN cả khi lấy link qua getStreamLinks()
    });
  }
  return list;
}

function normalizeMatch(m, referer) {
  const matchDate = new Date(Number(m?.time) || Date.now());
  const isLive = m?.status === 'live';
  const isFinished = m?.status === 'finished' || m?.status === 'ft';
  const isUpcoming = !isLive && !isFinished;
  const slug = m?.slug || m?.nameNoUtf8 || m?._id || '';
  const detailUrl = slug ? `${SAOKE_SITE_URL}/${slug}.html` : '';
  const commentators = isLive ? buildCommentators(m?.blvs, referer) : [];

  const timeStr = matchDate.toLocaleTimeString('vi-VN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'Asia/Ho_Chi_Minh'
  });
  const dateStr = matchDate.toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });
  const dd = String(matchDate.getDate()).padStart(2, '0');
  const mm = String(matchDate.getMonth() + 1).padStart(2, '0');

  return {
    matchId: `sk_${m?._id || slug}`,
    originalId: m?._id || slug,
    slug,
    detailUrl,
    source: 'saoke',
    sport: 'football',
    sportName: 'BÓNG ĐÁ',
    sportIcon: 'fa-futbol',
    competition: { name: m?.league?.name || '', logo: m?.league?.picture || '', icon: m?.league?.picture || '' },
    homeTeam: { name: m?.teamA?.name || 'Home', logo: m?.teamA?.picture || '' },
    awayTeam: { name: m?.teamB?.name || 'Away', logo: m?.teamB?.picture || '' },
    // Nguồn này không trả tỉ số/số phút qua API — để mặc định, không suy diễn bừa.
    score: { home: 0, away: 0 },
    status: {
      isLive,
      isFinished,
      isHalfTime: false,
      isUpcoming,
      name: isLive ? 'LIVE' : isFinished ? 'FT' : 'Sắp diễn ra',
      text: isLive ? 'LIVE' : isFinished ? 'Kết thúc' : 'Sắp diễn ra',
      elapsedTime: '',
      minutes: ''
    },
    stats: { halfTimeScore: '0-0', corners: '0-0', yellowCards: '0-0' },
    matchTime: matchDate.getTime(),
    matchTimeTimestamp: matchDate.getTime(),
    timeFormatted: `${timeStr} - ${dd}/${mm}`,
    dateStr,
    timeStr,
    isHot: !!m?.isHot,
    commentators,
    streamers: commentators,
    streamUrl: commentators[0]?.streamUrl || '',
    stream: {
      // Trận chưa live/không có BLV -> vẫn khác rỗng (trỏ trang chi tiết),
      // xem FIX 23/09/2026 trong phalang.service.js — cùng lý do, cùng cách sửa.
      liveUrl: detailUrl || `${SAOKE_SITE_URL}/`,
      streamerName: commentators[0]?.name || null,
      streamerAvatar: commentators[0]?.avatar || null
    },
    odds: null
  };
}

// ---- Lấy danh sách trận: gọi API trực tiếp, 403/lỗi thì DỰ PHÒNG bằng trình duyệt -------------
// FIX (05/10/2026 — "chạy Generate ra 0 trận Sao Kê: Error fetching SaoKe tab live/upcoming: status 403"):
// API home-data (skapi...) chặn request thẳng từ IP máy chủ GitHub Actions (WAF/Cloudflare) HOẶC domain API
// đã đổi (domain 'saoke-api' không tự cập nhật được vì autoFix=false). Trước đây lỗi là trả 0 trận luôn.
// Giờ: (1) gọi trực tiếp như cũ (kèm Origin); (2) nếu lỗi -> mở TRANG SAO KÊ bằng Chromium headless và bắt
// chính response home-data mà trang tự gọi (trình duyệt thật + cookie/JS challenge nên qua được 403, và
// tự biết domain API ĐÚNG hiện tại — không cần khai báo saoke-api); (3) nhớ domain API thật dò được để lần
// sau gọi thẳng; (4) cache 45 giây để 2 tab live/upcoming + stream-links dùng chung 1 lần lấy (không mở
// Chromium nhiều lần); (5) nếu cả hai đều lỗi mà còn dữ liệu cũ dưới 10 phút thì dùng tạm thay vì 0 trận.
// Tắt dự phòng trình duyệt bằng biến môi trường SAOKE_BROWSER_FALLBACK=0.
const HOME_DATA_PATH = '/v2/saoke/home-data';
const HOME_CACHE_TTL_MS = 45 * 1000;
const HOME_STALE_MAX_MS = 10 * 60 * 1000;
const HOME_FAIL_TTL_MS = 60 * 1000;
const BROWSER_FALLBACK = !/^(0|false|no|off)$/i.test(String(process.env.SAOKE_BROWSER_FALLBACK ?? '1').trim() || '1');
const homeCache = globalThis.__saokeHomeCache || { lives: null, at: 0, inFlight: null, apiBase: '' };
globalThis.__saokeHomeCache = homeCache;

// Mô tả lỗi HTTP để biết AI chặn: server/cf-ray = Cloudflare; nội dung "Just a moment" = trang thử thách bot.
function describeHttpError(err) {
  const r = err?.response;
  if (!r) return err?.code || err?.message || 'không có phản hồi';
  const h = r.headers || {};
  let snippet = '';
  try { snippet = (typeof r.data === 'string' ? r.data : JSON.stringify(r.data) || '').replace(/\s+/g, ' ').slice(0, 120); } catch { /* bỏ qua */ }
  return `HTTP ${r.status}, server=${h.server || '?'}, cf-ray=${h['cf-ray'] ? 'có' : 'không'}, nội dung="${snippet}"`;
}
// SAOKE_BROWSER_FIRST=1: bỏ bước gọi thẳng (đã biết luôn bị 403 từ IP máy chủ), mở trình duyệt ngay; trình duyệt lỗi mới thử gọi thẳng.
const BROWSER_FIRST = /^(1|true|yes|on)$/i.test(String(process.env.SAOKE_BROWSER_FIRST ?? '').trim());

const livesOf = (body) => (Array.isArray(body?.data?.lives) ? body.data.lives : null);

async function fetchLivesDirect() {
  const base = String(homeCache.apiBase || SAOKE_API_BASE_URL).replace(/\/+$/, '');
  const { data } = await client.get(`${base}${HOME_DATA_PATH}`);
  const lives = livesOf(data);
  if (!lives) throw new Error('API trả dữ liệu sai định dạng (không có data.lives) — có thể là trang chặn bot');
  return lives;
}

async function fetchLivesViaBrowser() {
  // Gọi thử trong trang các URL API đã biết/đã khai báo phòng khi trang không tự gọi API lúc mở trang chủ.
  const pageFetchUrls = [...new Set([homeCache.apiBase, SAOKE_API_BASE_URL].filter(Boolean).map((b) => `${String(b).replace(/\/+$/, '')}${HOME_DATA_PATH}`))];
  const { found, seen, navStatus, title } = await captureJsonViaBrowser(`${SAOKE_SITE_URL}/`, (body) => !!livesOf(body), {
    timeoutMs: 40000,
    captureWaitMs: 12000,
    pageFetchUrls
  });
  if (!found) {
    // Ghi đủ thông tin để biết vì sao (bị Cloudflare chặn? trang đổi API?) — đây là log cần gửi lại khi còn lỗi.
    console.error(`[saoke] trình duyệt: HTTP trang ${navStatus || '?'}, tiêu đề "${title}", ${seen.length} request fetch/XHR:`);
    for (const line of seen.slice(0, 12)) console.error(`[saoke]   ${line}`);
    throw new Error(`không bắt được API danh sách trận (trang HTTP ${navStatus || '?'}, tiêu đề "${String(title).slice(0, 60)}", ${seen.length} request API)`);
  }
  try {
    const origin = new URL(found.url).origin;
    if (origin !== new URL(SAOKE_API_BASE_URL).origin) {
      console.warn(`[saoke] API THẬT là ${origin} (khác saoke-api đã khai báo ${SAOKE_API_BASE_URL}) — hãy cập nhật dòng saoke-api=${origin} trong SOURCE_DOMAINS`);
    }
    homeCache.apiBase = origin;
  } catch { /* không đọc được URL API — bỏ qua */ }
  return livesOf(found.body);
}

async function getHomeLives() {
  if (homeCache.lives && Date.now() - homeCache.at < HOME_CACHE_TTL_MS) return homeCache.lives;
  if (homeCache.inFlight) return homeCache.inFlight;
  // Vừa lỗi trong 60s trước -> không thử lại ngay (tab live rồi upcoming nối nhau sẽ mở Chromium 2 lần, mỗi lần tới ~50s).
  if (!homeCache.lives && homeCache.failMsg && Date.now() - homeCache.failedAt < HOME_FAIL_TTL_MS) throw new Error(homeCache.failMsg);
  homeCache.inFlight = (async () => {
    try {
      let lives;
      const viaBrowser = async (reason) => {
        console.warn(`[saoke] ${reason} -> dùng trình duyệt headless`);
        const l = await fetchLivesViaBrowser();
        console.log(`[saoke] lấy được ${l.length} trận qua trình duyệt headless`);
        return l;
      };
      if (BROWSER_FALLBACK && BROWSER_FIRST) {
        try {
          lives = await viaBrowser('SAOKE_BROWSER_FIRST=1');
        } catch (browserErr) {
          try {
            lives = await fetchLivesDirect();
          } catch (directErr) {
            throw new Error(`trình duyệt lỗi: ${browserErr.message}; gọi trực tiếp cũng lỗi: ${describeHttpError(directErr)}`);
          }
        }
      } else {
        try {
          lives = await fetchLivesDirect();
        } catch (directErr) {
          if (!BROWSER_FALLBACK) throw directErr;
          const why = describeHttpError(directErr);
          try {
            lives = await viaBrowser(`gọi API trực tiếp lỗi (${why})`);
          } catch (browserErr) {
            throw new Error(`${directErr.message} [${why}]; dự phòng trình duyệt cũng lỗi: ${browserErr.message}`);
          }
        }
      }
      homeCache.lives = lives;
      homeCache.at = Date.now();
      homeCache.failMsg = '';
      return lives;
    } catch (err) {
      if (homeCache.lives && Date.now() - homeCache.at < HOME_STALE_MAX_MS) {
        console.warn(`[saoke] lấy dữ liệu mới lỗi (${err.message}) -> dùng tạm dữ liệu cũ ${Math.round((Date.now() - homeCache.at) / 1000)}s trước`);
        return homeCache.lives;
      }
      homeCache.failMsg = err.message;
      homeCache.failedAt = Date.now();
      throw err;
    } finally {
      homeCache.inFlight = null;
    }
  })();
  return homeCache.inFlight;
}

class SaoKeService {
  async fetchHomeMatches() {
    const lives = await getHomeLives();

    // Tự dò Referer thật trước khi map (xem detectPlayerReferer() ở trên) —
    // chỉ cần 1 trận ĐANG LIVE bất kỳ có slug để mở trang chi tiết của nó.
    // Trận chưa live không có gì phát nên mở cũng vô ích.
    const sample = lives.find((m) => m?.status === 'live' && (m?.slug || m?.nameNoUtf8 || m?._id));
    const sampleSlug = sample?.slug || sample?.nameNoUtf8 || sample?._id;
    const sampleDetailUrl = sampleSlug ? `${SAOKE_SITE_URL}/${sampleSlug}.html` : '';
    const referer = sampleDetailUrl ? await detectPlayerReferer(sampleDetailUrl) : detectCache.value;

    return lives.map((m) => normalizeMatch(m, referer));
  }

  async getAllMatchesByTab(tab, sport = 'all') {
    try {
      const all = await this.fetchHomeMatches();
      let filtered = all;
      if (tab === 'live') filtered = all.filter((m) => m.status.isLive);
      else if (tab === 'upcoming') filtered = all.filter((m) => m.status.isUpcoming);
      if (sport !== 'all') filtered = filtered.filter((m) => m.sport === sport);

      // Theo yêu cầu trước đó (chỉ lấy trận có BLV) — trận live không BLV
      // nào có link thì bỏ hẳn, không hiện placeholder.
      filtered = filtered.filter((m) => !m.status.isLive || m.commentators.length > 0);

      return { matches: filtered, hasMore: false, totalCount: filtered.length };
    } catch (error) {
      console.error(`Error fetching SaoKe tab ${tab}:`, error.message);
      return { matches: [], hasMore: false, totalCount: 0 };
    }
  }

  async getStreamLinks(matchId) {
    try {
      const all = await this.fetchHomeMatches();
      const cleanId = String(matchId).replace(/^sk_/, '');
      const match = all.find((m) => m.originalId === cleanId || m.matchId === matchId || m.slug === matchId);
      if (!match) return [];
      return mapStreams(match);
    } catch (error) {
      console.error('Error fetching SaoKe stream links:', error.message);
      return [];
    }
  }
}

const saokeService = new SaoKeService();
export default saokeService;
