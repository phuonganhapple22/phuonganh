import { qualityFromText } from '@/src/utils/streamQuality';
import { createHttpClient } from '@/src/utils/httpClient';
import { slugifyVi } from '@/src/utils/slug';
import { fetchFirstRequestHeaders } from '@/src/utils/browserFetch';
const axios = require('axios');

// Chuối Chiên TV — domain chính chuoichientv.link, frontend thật chạy trên
// live05.chuoichientv.me. API nằm trên domain RIÊNG (api-v2.chuoichientv.net)
// — đã tự kiểm tra: gọi thẳng bằng HTTP thường (không cần trình duyệt
// headless), KHÔNG bị Cloudflare chặn, KHÔNG cần token cho các endpoint đọc
// trận đấu (endpoint /chat/history mới cần Bearer token, không liên quan).
// Nhờ vậy nguồn này đơn giản hơn hẳn Khán Đài (không cần
// browserFetch/puppeteer gì cả).
const CHUOICHIENTV_API_BASE = process.env.CHUOICHIENTV_API_BASE || 'https://api-v2.chuoichientv.net/v2';

const SPORT_INFO = {
  football: { name: 'BÓNG ĐÁ', icon: 'fa-futbol' },
  volleyball: { name: 'BÓNG CHUYỀN', icon: 'fa-volleyball' },
  basketball: { name: 'BÓNG RỔ', icon: 'fa-basketball' },
  tennis: { name: 'TENNIS', icon: 'fa-baseball-bat-ball' }
};

const NOT_STARTED_STATUSES = new Set(['scheduled', 'not_started', 'upcoming', 'pending', 'ns']);
const FINISHED_STATUSES = new Set(['finished', 'ended', 'ft', 'full_time', 'cancelled', 'canceled', 'postponed', 'abandoned']);

// ---- Tự dò Referer/Origin THẬT bằng trình duyệt headless -----------------
// FIX (25/09/2026 — áp dụng lại cách đã sửa cho Sao Kê, nguồn này dùng
// CHUNG 2 CDN hdplaylink.com/edgemaxcdn.org với Sao Kê nên cùng bệnh 403
// chống hotlink): thay vì tiếp tục đoán tay giữa 2 domain
// live05.chuoichientv.me/chuoichientv.link (xem REFERER_CANDIDATES_BY_SOURCE
// trong m3uPlaylist.js + hls.js — đã đoán qua đoán lại nhiều lần, vẫn có
// lúc sai), mở trang xem trực tiếp 1 trận ĐANG LIVE bằng Chromium headless
// thật (hạ tầng có sẵn, xem src/utils/browserFetch — nguồn này trước đây
// không cần dùng vì gọi API thẳng được, giờ dùng THÊM riêng cho bước dò
// Referer, không ảnh hưởng cách lấy danh sách trận), bắt ĐÚNG request
// .m3u8 mà trình duyệt tự gửi, đọc lại Referer nó dùng — hết phải đoán.
//
// LƯU Ý giống hệt Sao Kê: cache này chỉ có tác dụng trong CHÍNH tiến trình
// đang gọi getAllMatches()/getAllMatchesByTab() (route /api/matches hoặc
// /api/playlist) — KHÔNG chia sẻ được sang pages/api/proxy/hls.js (serverless
// function khác). Muốn hls.js hưởng lợi, xem cầu nối qua
// public/playlists/chuoichientv-referer.json trong scripts/generate-playlists.js
// + hls.js (giống hệt cơ chế đã làm cho Sao Kê).
const DETECT_REFERER_TIMEOUT_MS = 12000;
const DETECT_REFERER_TTL_MS = 2 * 60 * 60 * 1000; // 2 tiếng
const detectCache = globalThis.__chuoichientvRefererDetectCache || { value: null, detectedAt: 0, inFlight: null };
globalThis.__chuoichientvRefererDetectCache = detectCache;

async function detectPlayerReferer(sampleWatchUrls) {
  const urls = (Array.isArray(sampleWatchUrls) ? sampleWatchUrls : [sampleWatchUrls]).filter(Boolean);
  if (!urls.length) return detectCache.value;
  if (detectCache.value && Date.now() - detectCache.detectedAt < DETECT_REFERER_TTL_MS) {
    return detectCache.value;
  }
  if (detectCache.inFlight) return detectCache.inFlight;

  detectCache.inFlight = (async () => {
    try {
      // FIX (25/09/2026 — "mở trang xong nhưng không bắt được request
      // .m3u8 nào"): domain "sống" chưa chắc đang host ĐÚNG trận đó (xem
      // listAliveWatchDomains() bên dưới) -> thử LẦN LƯỢT từng URL cho tới
      // khi có 1 URL bắt được request thật, thay vì bỏ cuộc ở URL đầu.
      for (const watchUrl of urls) {
        const found = await fetchFirstRequestHeaders(watchUrl, /\.m3u8(\?|$)/i, {
          timeoutMs: DETECT_REFERER_TIMEOUT_MS
        });
        const referer = found?.headers?.referer || found?.headers?.Referer || null;
        if (referer) {
          detectCache.value = referer;
          detectCache.detectedAt = Date.now();
          console.log(`[chuoichientv] tự dò được Referer thật từ trình duyệt (${watchUrl}): ${referer}`);
          return detectCache.value;
        }
        console.error(`[chuoichientv] ${watchUrl}: mở trang xong nhưng không bắt được request .m3u8 nào, thử URL kế tiếp nếu còn`);
      }
      return detectCache.value;
    } catch (error) {
      console.error('[chuoichientv] dò Referer bằng trình duyệt headless thất bại (dùng fallback hardcode):', error.message);
      return detectCache.value;
    } finally {
      detectCache.inFlight = null;
    }
  })();

  return detectCache.inFlight;
}

// ---- Tự dò domain "liveNN.chuoichientv.me" đang hoạt động ---------------
// FIX (25/09/2026 — "domain chuyển sang domain mới rồi live07...", trước đó
// hardcode "live05"): domain trang xem trực tiếp KHÔNG cố định — người dùng
// vừa xác nhận nó đã đổi từ live05 sang live07. Hardcode 1 số cụ thể chắc
// chắn sẽ hỏng lại lần sau. KHÔNG có field nào trong API trả về domain này
// (đã kiểm tra normalizeMatch/raw response), nên không thể lấy "chuẩn" từ
// API — phải TỰ DÒ: thử lần lượt liveNN từ 01 tới 15 bằng 1 request HTTP
// GET rất nhẹ (không phải mở trình duyệt headless, chỉ cần biết domain nào
// CÒN SỐNG, không cần nội dung), domain đầu tiên phản hồi được (không lỗi
// kết nối/DNS) coi là đang hoạt động. Dùng domain đó để mở trang bằng
// headless browser (xem detectPlayerReferer/watchUrl bên dưới) — CHỈ ảnh
// hưởng tới bước TỰ DÒ Referer (self-healing), KHÔNG ảnh hưởng Referer
// CHUẨN đã xác nhận bằng DevTools thật (fhd-01.cctvsignal.xyz, cố định,
// xem REFERER_CANDIDATES_BY_SOURCE trong m3uPlaylist.js/hls.js) — 2 domain
// này ĐỘC LẬP nhau (live0N.chuoichientv.me là domain trang xem, còn
// fhd-01.cctvsignal.xyz là domain nhúng player/CDN referer).
//
// Đặt CHUOICHIENTV_WATCH_DOMAIN (vd: "https://live07.chuoichientv.me") nếu
// muốn ép cứng, bỏ qua dò — dò lại ngay nếu domain đang cache không còn
// phản hồi (không đợi hết TTL), giữ cache 30 phút khi vẫn sống.
const WATCH_DOMAIN_PROBE_MAX = 15;
const WATCH_DOMAIN_PROBE_TIMEOUT_MS = 2500;

async function probeDomainAlive(domain) {
  try {
    await axios.get(`${domain}/`, {
      timeout: WATCH_DOMAIN_PROBE_TIMEOUT_MS,
      validateStatus: () => true, // 404/403... vẫn tính là "domain sống", chỉ loại domain KHÔNG kết nối được
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    return true;
  } catch {
    return false;
  }
}

// FIX (25/09/2026 — "mở trang xong nhưng không bắt được request .m3u8 nào"):
// domain "sống" (trả lời HTTP) KHÔNG chắc là mirror ĐANG PHỤC VỤ đúng trận
// đó — các liveNN có thể là server RIÊNG BIỆT, chỉ 1 vài cái thật sự host
// trận đang xem. Vì vậy liệt kê NHIỀU domain sống (tối đa `limit`) để thử
// không đủ. Hàm này liệt kê NHIỀU domain sống (tối đa `limit`) để thử lần
// lượt bên detectRefererFromRaw() — domain nào KHÔNG bắt được request
// .m3u8 thì thử domain kế tiếp, thay vì bỏ cuộc ngay ở domain đầu tiên.
async function listAliveWatchDomains(limit = 4) {
  const forced = process.env.CHUOICHIENTV_WATCH_DOMAIN;
  if (forced) return [forced.replace(/\/+$/, '')];

  const found = [];
  for (let n = 1; n <= WATCH_DOMAIN_PROBE_MAX && found.length < limit; n++) {
    const domain = `https://live${String(n).padStart(2, '0')}.chuoichientv.me`;
    if (await probeDomainAlive(domain)) found.push(domain);
  }
  return found;
}

class ChuoiChienTvService {
  constructor() {
    this.client = createHttpClient({
      baseURL: CHUOICHIENTV_API_BASE,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Referer': 'https://live05.chuoichientv.me/'
      }
    });
    // FIX (17/09/2026 — "các trận đang live nguồn Chuối Chiên không xem
    // được"): findRawMatch() bên dưới gọi 1 endpoint chi tiết RIÊNG
    // (/matches/external/{id}) để lấy lại link stream cho 1 trận — nếu
    // endpoint đó lỗi/timeout/đổi schema thì trận live mất sạch nút ▶, dù
    // list `/matches?type=live` NGAY TRƯỚC ĐÓ đã trả sẵn đầy đủ BLV/link
    // rồi (xem normalizeMatch — commentators dựng thẳng từ m.blvs trong
    // response danh sách). Giữ 1 cache nhỏ trong bộ nhớ (raw match theo
    // externalId, ghi đè mỗi lần fetchList) làm phương án DỰ PHÒNG: nếu gọi
    // endpoint chi tiết thất bại, dùng lại đúng dữ liệu vừa quét được thay
    // vì trả về rỗng.
    this._rawMatchCache = new Map();
  }

  detectCdn(url) {
    const u = String(url || '').toLowerCase();
    if (u.includes('edgemaxcdn')) return 'EDGEMAX';
    if (u.includes('hdplaylink')) return 'HDPLAYLINK';
    if (u.includes('cloudflare')) return 'CLOUDFLARE';
    return 'HLS';
  }

  // FIX (17/09/2026) rồi HOÀN TÁC (26/09/2026 — "trước vẫn xem được trên
  // VLC mà giờ báo Chưa có link"): giả thuyết "link CDN edgemaxcdn.org/
  // hdplaylink.com không có query string = chắc chắn thiếu token, chắc
  // chắn lỗi" bị chính người dùng xác nhận SAI bằng thực tế — link trần
  // KHÔNG kèm token (BLV "Trốc Tru"/"Chuối Chao") vẫn phát bình thường trên
  // VLC khi Referer đúng. Hàm lọc này đang loại NHẦM link phát tốt ra khỏi
  // danh sách BLV (match rơi vào playlist ở dạng "chưa có link", dù thật ra
  // đã có link phát được) — KHÔNG dùng để lọc nữa, giữ lại hàm chỉ để tham
  // khảo/debug thủ công khi cần, không gọi trong normalizeMatch() nữa.
  hasLikelyPlayToken(url) {
    const cdn = this.detectCdn(url);
    if (cdn !== 'EDGEMAX' && cdn !== 'HDPLAYLINK') return true; // CDN khác không biết quy luật, không chặn mù
    try {
      return new URL(url).search.length > 1; // có ít nhất 1 query param
    } catch {
      return false; // URL không hợp lệ -> coi như thiếu token, loại luôn
    }
  }

  normalizeMatch(m, referer) {
    const rawStatus = String(m.status || '').toLowerCase();
    const isNotStarted = NOT_STARTED_STATUSES.has(rawStatus);
    const isFinished = FINISHED_STATUSES.has(rawStatus);
    const isLive = !!rawStatus && !isNotStarted && !isFinished;

    const sportInfo = SPORT_INFO[m.sport] || { name: String(m.sport || 'BÓNG ĐÁ').toUpperCase(), icon: 'fa-futbol' };

    const matchDate = m.matchTime ? new Date(m.matchTime) : new Date();
    const timeStr = matchDate.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Ho_Chi_Minh' });
    const dateStr = matchDate.toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });
    const dd = String(matchDate.getDate()).padStart(2, '0');
    const mm = String(matchDate.getMonth() + 1).padStart(2, '0');

    const homeName = m.teams?.home?.name || 'Home';
    const awayName = m.teams?.away?.name || 'Away';
    const externalId = m.externalId || m._id;
    const slug = m.slug || `${slugifyVi(homeName)}-vs-${slugifyVi(awayName)}`;

    // Mỗi BLV có thể có nhiều chất lượng (HD/FHD...) — tách thành từng lựa
    // chọn stream riêng, y hệt cách các nguồn khác liệt kê nhiều server.
    const commentators = (m.blvs || []).flatMap((b) => (b.streams || []).map((s) => ({
      id: `${b._id || b.username}_${s.label || ''}`,
      name: s.label ? `${b.name} (${s.label})` : b.name,
      avatar: b.avatar || '',
      streamUrl: s.url,
      isLive: true,
      cdn: this.detectCdn(s.url),
      // Referer THẬT tự dò được (nếu có) — xem detectPlayerReferer() ở
      // trên. null nếu chưa dò được/dò lỗi, m3uPlaylist.js/hls.js tự rơi
      // về danh sách ứng viên hardcode như cũ.
      referer: referer || null
    }))).filter((c) => c.streamUrl);

    return {
      matchId: `cct_${externalId}`,
      originalId: externalId,
      slug,
      source: 'chuoichientv',
      sport: m.sport || 'football',
      sportName: sportInfo.name,
      sportIcon: sportInfo.icon,
      competition: {
        name: m.league?.name || '',
        logo: m.league?.logo || '',
        icon: m.league?.logo || ''
      },
      homeTeam: { name: homeName, logo: m.teams?.home?.logo || '' },
      awayTeam: { name: awayName, logo: m.teams?.away?.logo || '' },
      score: {
        home: m.score?.home ?? 0,
        away: m.score?.away ?? 0
      },
      status: {
        isLive,
        isFinished,
        isHalfTime: false,
        isUpcoming: !isLive && !isFinished,
        name: isLive ? 'LIVE' : (isFinished ? 'FT' : 'Sắp diễn ra'),
        text: isLive ? 'LIVE' : (isFinished ? 'Kết thúc' : 'Sắp diễn ra'),
        elapsedTime: '',
        minutes: ''
      },
      stats: {
        halfTimeScore: `${m.score?.halftime?.home ?? 0}-${m.score?.halftime?.away ?? 0}`,
        corners: '0-0',
        yellowCards: '0-0'
      },
      matchTime: matchDate.getTime(),
      matchTimeTimestamp: matchDate.getTime(),
      timeFormatted: `${timeStr} - ${dd}/${mm}`,
      dateStr,
      timeStr,
      isHot: !!m.isHot,
      commentators,
      streamers: commentators,
      streamUrl: commentators[0]?.streamUrl || '',
      stream: {
        liveUrl: `https://live05.chuoichientv.me/live/${externalId}/${slug}`,
        streamerName: commentators[0]?.name || null,
        streamerAvatar: commentators[0]?.avatar || null
      },
      odds: null
    };
  }

  mapStreams(match) {
    return (match?.commentators || []).map((c) => {
      const isFlv = /\.flv(\?|$)/i.test(c.streamUrl);
      return {
        id: c.id,
        streamerId: c.id,
        name: c.name,
        streamerName: c.name,
        avatar: c.avatar,
        streamerAvatar: c.avatar,
        link: c.streamUrl,
        m3u8Url: c.streamUrl,
        playUrl: c.streamUrl,
        format: isFlv ? 'flv' : 'hls',
        cdn: c.cdn,
        // Nhãn THẬT theo label của nguồn (FHD/HD/SD); không có nhãn -> '' (chưa rõ), KHÔNG gán cứng 'HD'.
        quality: qualityFromText(c.name)
      };
    });
  }

  async fetchList(type, page = 1, limit = 500) {
    try {
      const { data } = await this.client.get('/matches', { params: { type, page, limit, _t: Date.now() } });
      const list = data?.matches || [];
      // Ghi lại từng trận thô vào cache dự phòng cho findRawMatch() — xem
      // chú thích FIX 17/09/2026 ở constructor.
      for (const m of list) {
        const key = m?.externalId || m?._id;
        if (key) this._rawMatchCache.set(String(key), m);
      }
      return list;
    } catch (error) {
      console.error(`Error fetching ChuoiChienTV list (type=${type}):`, error.message);
      return [];
    }
  }

  async getAllMatches() {
    const raw = await this.fetchList('live');
    const referer = await this.detectRefererFromRaw(raw);
    return raw.map((m) => this.normalizeMatch(m, referer));
  }

  // Chỉ cần dò 1 lần cho MỌI trận (cùng site -> cùng domain player), lấy
  // trận ĐANG LIVE đầu tiên có đủ externalId+slug để dựng URL trang xem.
  async detectRefererFromRaw(rawLiveList) {
    const sample = (rawLiveList || []).find((m) => (m.externalId || m._id) && (m.slug || m.teams?.home?.name));
    if (!sample) return detectCache.value;
    const externalId = sample.externalId || sample._id;
    const homeName = sample.teams?.home?.name || 'Home';
    const awayName = sample.teams?.away?.name || 'Away';
    const slug = sample.slug || `${slugifyVi(homeName)}-vs-${slugifyVi(awayName)}`;
    const domains = await listAliveWatchDomains(4);
    const watchUrls = domains.map((d) => `${d}/live/${externalId}/${slug}`);
    return detectPlayerReferer(watchUrls);
  }

  /** Interface giống các nguồn khác: gộp mọi type thành 1 danh sách, tự lọc theo tab ở code. */
  async getAllMatchesByTab(tab) {
    const [liveRaw, upcomingRaw] = await Promise.all([
      this.fetchList('live'),
      this.fetchList('upcoming')
    ]);
    const referer = await this.detectRefererFromRaw(liveRaw);

    const seen = new Set();
    const all = [];
    for (const m of [...liveRaw, ...upcomingRaw]) {
      const key = m.externalId || m._id;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      all.push(this.normalizeMatch(m, referer));
    }

    let matches = all;
    if (tab === 'live') matches = all.filter((m) => m.status.isLive);
    else if (tab === 'upcoming') matches = all.filter((m) => m.status.isUpcoming);

    return { matches, hasMore: false, totalCount: matches.length };
  }

  async findRawMatch(matchId) {
    const cleanId = String(matchId || '').replace(/^cct_/, '');
    if (!cleanId) return null;
    try {
      const { data } = await this.client.get(`/matches/external/${cleanId}`, { params: { _t: Date.now() } });
      const detail = data?.data || null;
      if (detail) return detail;
    } catch (error) {
      console.error('Error fetching ChuoiChienTV match detail:', error.message);
    }
    // FIX 17/09/2026: endpoint chi tiết lỗi/rỗng -> dùng lại bản ghi thô đã
    // có sẵn từ lần quét danh sách gần nhất (xem cache trong fetchList())
    // thay vì trả về null (mất nút ▶ dù dữ liệu cần thiết vốn đã có).
    return this._rawMatchCache.get(cleanId) || null;
  }

  async getStreamLinks(matchId) {
    const raw = await this.findRawMatch(matchId);
    if (!raw) return [];
    return this.mapStreams(this.normalizeMatch(raw, detectCache.value));
  }

  async getMatchDetail(matchId) {
    const raw = await this.findRawMatch(matchId);
    if (!raw) return null;
    const match = this.normalizeMatch(raw, detectCache.value);
    return { match, streams: this.mapStreams(match), matchId: match.matchId };
  }

  async getMatchLiveSnapshot(matchId) {
    const raw = await this.findRawMatch(matchId);
    return raw ? this.normalizeMatch(raw, detectCache.value) : null;
  }
}

const chuoichientvService = new ChuoiChienTvService();
export default chuoichientvService;
