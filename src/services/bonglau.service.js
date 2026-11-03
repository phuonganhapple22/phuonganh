import { qualityFromText } from '@/src/utils/streamQuality';
import { createHttpClient } from '@/src/utils/httpClient';
import { slugifyVi } from '@/src/utils/slug';
import { fetchFirstRequestHeaders } from '@/src/utils/browserFetch';
const axios = require('axios');

// FIX (27/09/2026 — theo yêu cầu, thêm nguồn Bông Lau TV): domain xem
// bonglautv.pro/lau05.bonglautv1.pro (config nhúng sẵn trong HTML trang chủ
// đổi domain thường xuyên, đã thấy cả .pro lẫn .org). ĐÃ XÁC NHẬN qua config
// `apiBaseUrlV2` nhúng sẵn + link CDN thực tế người dùng bắt được
// (gckc0525.edgemaxcdn.org/live/chuoichao/...) rằng nguồn này dùng CHUNG
// API + CHUNG pool trận đấu + CHUNG CDN với Chuối Chiên
// (chuoichientv.service.js) — chỉ khác giao diện/domain hiển thị. Vẫn tách
// thành service/nguồn RIÊNG theo đúng yêu cầu (chấp nhận trùng lặp phần lớn
// nội dung với Chuối Chiên — đã báo trước, người dùng vẫn muốn tách riêng),
// nên COPY gần như nguyên cách gọi/parse của chuoichientv.service.js, chỉ
// đổi domain/label thương hiệu + danh sách domain dò Referer.
const BONGLAU_API_BASE = process.env.BONGLAU_API_BASE || 'https://api-v2.chuoichientv.net/v2';
const BONGLAU_SITE_URL = process.env.BONGLAU_DOMAIN || 'https://lau05.bonglautv1.pro';
// FIX (27/09/2026 — "Error fetching BongLau list: 403" ở CẢ live lẫn
// upcoming, tức là lỗi ngay ở bước gọi /matches, KHÔNG phải lỗi CDN
// .m3u8): API api-v2.chuoichientv.net kiểm tra Referer của CHÍNH request
// gọi API (khác với Referer của stream .m3u8 dò riêng ở dưới) — API này
// CHỈ chấp nhận Referer thuộc site chuoichientv (đã xác nhận qua
// chuoichientv.service.js gọi đúng API này với Referer
// 'https://live05.chuoichientv.me/' và KHÔNG bị 403). Trước đây bonglau
// dùng nhầm BONGLAU_SITE_URL (domain HIỂN THỊ lau0N.bonglautv1.pro, dùng
// để xem/hiển thị link, không phải domain API biết tới) làm Referer gọi
// API -> bị chặn 403 ngay từ bước lấy DANH SÁCH trận, trước cả khi tới
// bước dò Referer cho link CDN .m3u8. Sửa: gọi API bằng Referer CHUẨN của
// Chuối Chiên (cùng API, cùng pool, khác domain hiển thị) — Referer dò
// riêng cho stream .m3u8 (detectPlayerReferer bên dưới) không đổi, vẫn
// dùng domain lau0N.bonglautv1.* như cũ.
const BONGLAU_API_REFERER = process.env.BONGLAU_API_REFERER || 'https://live05.chuoichientv.me/';

const SPORT_INFO = {
  football: { name: 'BÓNG ĐÁ', icon: 'fa-futbol' },
  volleyball: { name: 'BÓNG CHUYỀN', icon: 'fa-volleyball' },
  basketball: { name: 'BÓNG RỔ', icon: 'fa-basketball' },
  tennis: { name: 'TENNIS', icon: 'fa-baseball-bat-ball' }
};

const NOT_STARTED_STATUSES = new Set(['scheduled', 'not_started', 'upcoming', 'pending', 'ns']);
const FINISHED_STATUSES = new Set(['finished', 'ended', 'ft', 'full_time', 'cancelled', 'canceled', 'postponed', 'abandoned']);

// ---- Tự dò Referer/Origin THẬT bằng trình duyệt headless -----------------
// Y HỆT cơ chế của chuoichientv.service.js (cùng họ CDN edgemaxcdn.org qua
// wrapper 100ycdn.com, Referer đổi theo phiên — xem chú thích chi tiết bên
// đó) — nhưng CACHE RIÊNG (globalThis key riêng), KHÔNG dùng chung cache với
// Chuối Chiên: dù cùng CDN, Referer dò được có thể khác nhau tuỳ domain
// trang xem đang mở (đã xác nhận qua thực tế Referer của CDN này đổi theo
// từng phiên/domain embed, xem FIX 26/09/2026 trong m3uPlaylist.js).
const DETECT_REFERER_TIMEOUT_MS = 12000;
const DETECT_REFERER_TTL_MS = 2 * 60 * 60 * 1000;
const detectCache = globalThis.__bonglauRefererDetectCache || { value: null, detectedAt: 0, inFlight: null };
globalThis.__bonglauRefererDetectCache = detectCache;

async function detectPlayerReferer(sampleWatchUrls) {
  const urls = (Array.isArray(sampleWatchUrls) ? sampleWatchUrls : [sampleWatchUrls]).filter(Boolean);
  if (!urls.length) return detectCache.value;
  if (detectCache.value && Date.now() - detectCache.detectedAt < DETECT_REFERER_TTL_MS) {
    return detectCache.value;
  }
  if (detectCache.inFlight) return detectCache.inFlight;

  detectCache.inFlight = (async () => {
    try {
      for (const watchUrl of urls) {
        const found = await fetchFirstRequestHeaders(watchUrl, /\.m3u8(\?|$)/i, {
          timeoutMs: DETECT_REFERER_TIMEOUT_MS
        });
        const referer = found?.headers?.referer || found?.headers?.Referer || null;
        if (referer) {
          detectCache.value = referer;
          detectCache.detectedAt = Date.now();
          console.log(`[bonglau] tự dò được Referer thật từ trình duyệt (${watchUrl}): ${referer}`);
          return detectCache.value;
        }
        console.error(`[bonglau] ${watchUrl}: mở trang xong nhưng không bắt được request .m3u8 nào, thử URL kế tiếp nếu còn`);
      }
      return detectCache.value;
    } catch (error) {
      console.error('[bonglau] dò Referer bằng trình duyệt headless thất bại (dùng fallback hardcode):', error.message);
      return detectCache.value;
    } finally {
      detectCache.inFlight = null;
    }
  })();

  return detectCache.inFlight;
}

// ---- Tự dò domain trang xem đang hoạt động -------------------------------
// Domain xem thấy được lúc lấy mẫu: lau05.bonglautv1.pro (config HTML) và
// lau05.bonglautv1.org (bắt được qua Google Analytics dl= của chính trang
// khi đang mở) — TLD đổi (.pro/.org) giống hệt kiểu đổi domain mirror của
// Chuối Chiên. Dò cả 2 TLD, số thứ tự 01-15, domain nào phản hồi trước dùng
// domain đó. Đặt BONGLAU_WATCH_DOMAIN để ép cứng, bỏ qua dò.
const WATCH_DOMAIN_PROBE_MAX = 15;
const WATCH_DOMAIN_PROBE_TIMEOUT_MS = 2500;
const WATCH_DOMAIN_TLDS = ['pro', 'org'];

async function probeDomainAlive(domain) {
  try {
    await axios.get(`${domain}/`, {
      timeout: WATCH_DOMAIN_PROBE_TIMEOUT_MS,
      validateStatus: () => true,
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    return true;
  } catch {
    return false;
  }
}

async function listAliveWatchDomains(limit = 4) {
  const forced = process.env.BONGLAU_WATCH_DOMAIN;
  if (forced) return [forced.replace(/\/+$/, '')];

  const found = [];
  for (let n = 1; n <= WATCH_DOMAIN_PROBE_MAX && found.length < limit; n++) {
    for (const tld of WATCH_DOMAIN_TLDS) {
      if (found.length >= limit) break;
      const domain = `https://lau${String(n).padStart(2, '0')}.bonglautv1.${tld}`;
      if (await probeDomainAlive(domain)) found.push(domain);
    }
  }
  return found;
}

class BongLauService {
  constructor() {
    this.client = createHttpClient({
      baseURL: BONGLAU_API_BASE,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Referer': BONGLAU_API_REFERER
      }
    });
    // Cache dự phòng theo externalId, cùng lý do với chuoichientv.service.js
    // (endpoint chi tiết lỗi thì dùng lại bản ghi thô từ lần quét list gần nhất).
    this._rawMatchCache = new Map();
  }

  detectCdn(url) {
    const u = String(url || '').toLowerCase();
    if (u.includes('edgemaxcdn')) return 'EDGEMAX';
    if (u.includes('hdplaylink')) return 'HDPLAYLINK';
    if (u.includes('cloudflare')) return 'CLOUDFLARE';
    return 'HLS';
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

    const commentators = (m.blvs || []).flatMap((b) => (b.streams || []).map((s) => ({
      id: `${b._id || b.username}_${s.label || ''}`,
      name: s.label ? `${b.name} (${s.label})` : b.name,
      avatar: b.avatar || '',
      streamUrl: s.url,
      isLive: true,
      cdn: this.detectCdn(s.url),
      referer: referer || null
    }))).filter((c) => c.streamUrl);

    return {
      matchId: `bl_${externalId}`,
      originalId: externalId,
      slug,
      source: 'bonglau',
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
        liveUrl: `${BONGLAU_SITE_URL}/truc-tiep/${externalId}`,
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
      for (const m of list) {
        const key = m?.externalId || m?._id;
        if (key) this._rawMatchCache.set(String(key), m);
      }
      return list;
    } catch (error) {
      console.error(`Error fetching BongLau list (type=${type}):`, error.message);
      return [];
    }
  }

  async detectRefererFromRaw(rawLiveList) {
    const sample = (rawLiveList || []).find((m) => (m.externalId || m._id) && (m.slug || m.teams?.home?.name));
    if (!sample) return detectCache.value;
    const externalId = sample.externalId || sample._id;
    const domains = await listAliveWatchDomains(4);
    const watchUrls = domains.map((d) => `${d}/truc-tiep/${externalId}`);
    return detectPlayerReferer(watchUrls);
  }

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
    const cleanId = String(matchId || '').replace(/^bl_/, '');
    if (!cleanId) return null;
    try {
      const { data } = await this.client.get(`/matches/external/${cleanId}`, { params: { _t: Date.now() } });
      const detail = data?.data || null;
      if (detail) return detail;
    } catch (error) {
      console.error('Error fetching BongLau match detail:', error.message);
    }
    return this._rawMatchCache.get(cleanId) || null;
  }

  async getStreamLinks(matchId) {
    const raw = await this.findRawMatch(matchId);
    if (!raw) return [];
    return this.mapStreams(this.normalizeMatch(raw, detectCache.value));
  }
}

const bonglauService = new BongLauService();
export default bonglauService;
