import { buildMatchSlug } from '@/src/utils/slug';
import { getBrowser, captureM3u8ViaBrowser } from '@/src/utils/browserFetch';
import {
  buildRawMatches,
  mapHrefsToMatchIds,
  collectById,
  canonicalSport,
  slugVi as slugifyVi,
  SPORT_INFO
} from '@/src/utils/khandaiCms';

// KhanDaiTV (giao diện NemBienTV).
//
// FIX (26/11/2026 — "không bắt được API trận (HTTP 200, title=NemBienTV...), 0 trận"):
// khandaia.one ĐÃ ĐỔI HẲN schema — không còn Nuxt (window.__NUXT__) và /api/matches/ trả 404.
// Dữ liệu mới (xem src/utils/khandaiCms.js):
//   /cms-schedule.json   : lịch trận [{matchId, sport, league, home, away, homeLogo, awayLogo,
//                          timestamp(giây), hot_priority, early_stream, hasLiveSource, commentators[]}]
//                          (cũng được nhúng sẵn trong HTML: <script id="cms-home-matches">)
//   /api/cms-match-live  : các trận đang có nguồn phát (+ link BLV khi có)
// Cách lấy: mở trang chủ bằng Chromium (vượt Cloudflare như cũ), bắt 2 response trên, nếu trang chưa tự gọi
// thì fetch() NGAY TRONG TRANG, cuối cùng đọc <script id="cms-home-matches">. Đồng thời gom href các thẻ <a>
// chứa matchId để biết URL trang trận THẬT (không phải đoán pattern) — dùng khi cần bắt m3u8 từ trang trận.
// Giữ nguyên toàn bộ interface cũ (getAllMatchesByTab/getMatchesByTab/getCounts/getStreamLinks/...).
const KHANDAITV_BASE_URL = process.env.KHANDAITV_DOMAIN || process.env.KHANDAITV_BASE_URL || 'https://khandaia.one';
const KHANDAITV_CANDIDATES = [KHANDAITV_BASE_URL.replace(/\/+$/, '')];
const activeBaseUrl = () => KHANDAITV_CANDIDATES[0];

// Tên môn (tham số cũ của các nơi gọi) -> slug môn chuẩn của schema mới. null = tất cả.
const SPORT_FILTER = {
  all: null,
  football: 'football',
  basketball: 'basketball', 'bong-ro': 'basketball',
  volleyball: 'volleyball', 'bong-chuyen': 'volleyball',
  billiards: 'billiards',
  'cau-long': 'badminton', badminton: 'badminton',
  esports: 'esports',
  tennis: 'tennis',
  'bong-ban': 'table-tennis', 'table-tennis': 'table-tennis',
  boxing: 'boxing'
};
const sportKey = (v) => (v in SPORT_FILTER ? SPORT_FILTER[v] : 'football');

let rawMatchesCache = { data: null, fetchedAt: 0, pending: null };
const RAW_CACHE_TTL_MS = 20 * 1000;
let lastGood = { data: null, at: 0 };
const STALE_MAX_MS = (() => {
  const raw = String(process.env.KHANDAITV_STALE_MAX_MS ?? '').trim();
  return raw !== '' && Number.isFinite(Number(raw)) && Number(raw) >= 0 ? Number(raw) : 15 * 60 * 1000;
})();

const resolvedCache = new Map();
const KD_MAX_MATCHES = Number(process.env.KHANDAITV_KD_MAX || 60); // tối đa số trận hỏi streamUrl mỗi lượt quét
const KD_CONCURRENCY = 5;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Mở trang chủ bằng Chromium thật và lấy: lịch trận, feed live, danh sách href, tiêu đề/chẩn đoán.
 */
async function scrapeSite(baseUrl) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  const got = { schedule: null, live: null };
  const seen = [];
  let status = 0;
  let gotoError = '';
  try {
    try {
      const real = await browser.userAgent();
      await page.setUserAgent(String(real).replace(/HeadlessChrome/i, 'Chrome'));
    } catch { /* dùng UA mặc định */ }
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8' });

    page.on('response', async (resp) => {
      try {
        const u = resp.url();
        const isSchedule = /\/cms-schedule\.json/i.test(u);
        const isLive = /\/api\/cms-match-live/i.test(u);
        if (!isSchedule && !isLive) return;
        seen.push(`${resp.status()} ${u.slice(0, 120)}`);
        if (resp.status() >= 400) return;
        const body = JSON.parse(await resp.text());
        if (isSchedule) got.schedule = body; else got.live = body;
      } catch { /* response không đọc/parse được — bỏ qua, có fallback bên dưới */ }
    });

    try {
      const r = await page.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded', timeout: 28000 });
      status = r?.status() || 0;
    } catch (e) {
      gotoError = String(e?.message || e).split('\n')[0];
    }

    // 1) Chờ trang tự gọi 2 API (tối đa ~12s). Cloudflare "Just a moment" tự chuyển trang nên cứ poll.
    const waitUntil = Date.now() + 12000;
    while (Date.now() < waitUntil && !(got.schedule && got.live)) await sleep(400);

    // 2) Lịch nhúng sẵn trong HTML (không cần mạng thêm).
    if (!got.schedule) {
      for (let i = 0; i < 6 && !got.schedule; i++) {
        try {
          got.schedule = await page.evaluate(() => {
            const el = document.getElementById('cms-home-matches');
            return el ? JSON.parse(el.textContent) : null;
          });
        } catch { /* đang chuyển trang */ }
        if (!got.schedule) await sleep(1000);
      }
    }

    // 3) fetch() ngay trong trang (cùng cookie/TLS Chrome thật) nếu vẫn thiếu.
    const inPage = async (path) => {
      try {
        const r = await page.evaluate(async (u) => {
          const res = await fetch(u, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
          return { status: res.status, text: await res.text() };
        }, `${baseUrl}${path}`);
        seen.push(`${r.status} (fetch trong trang) ${path}`);
        return r.status < 400 ? JSON.parse(r.text) : null;
      } catch { return null; }
    };
    if (!got.schedule) got.schedule = await inPage(`/cms-schedule.json?_=${Date.now()}`);
    if (!got.live) got.live = await inPage(`/api/cms-match-live?_=${Date.now()}`);

    // 4) Link phát từng trận: GET /truc-tiep/<matchId>?kd_source=1 -> {"found":true,"earlyStream":true,"streamUrl":"https://.../index.m3u8"}
    //    (bắt từ DevTools thật 26/11/2026). Fetch CÙNG ORIGIN trong trang (cookie connect.sid + Referer = trang trận như player thật).
    const kd = [];
    try {
      const schedMap = collectById(got.schedule);
      const liveMap = collectById(got.live);
      // FIX (26/11/2026 — "có trận bóng chuyền đang live nhưng bị lọc mất, 24/24 trận đều thành upcoming"):
      // bản trước CHỈ hỏi streamUrl những trận có hasLiveSource=true trong JSON. Nếu cờ này trong cms-schedule.json
      // không bật (hoặc feed cms-match-live đọc không ra) thì trận đang đá không bao giờ được hỏi -> không có link -> bị
      // coi là upcoming. Giờ hỏi MỌI trận đang đá / sắp đá (trong [-3h, +4h] quanh giờ hiện tại), ưu tiên gần giờ nhất.
      const nowMs = Date.now();
      const startOf = (m) => { const n = Number(m.timestamp ?? m.start_time ?? 0); return !Number.isFinite(n) || n <= 0 ? 0 : (n < 1e12 ? n * 1000 : n); };
      const flagged = (m) => m.hasLiveSource === true || m.hasLiveSource === 1 || m.hasLiveSource === 'true';
      const wanted = [...schedMap.entries()]
        .map(([id, m]) => ({ id, ts: startOf(m), m }))
        .filter(({ id, ts, m }) => liveMap.has(id) || flagged(m) || (ts && nowMs >= ts - 3 * 3600000 && nowMs <= ts + 4 * 3600000))
        .sort((a, b) => Math.abs((a.ts || nowMs) - nowMs) - Math.abs((b.ts || nowMs) - nowMs))
        .map(({ id }) => id)
        .slice(0, KD_MAX_MATCHES);
      for (let i = 0; i < wanted.length; i += KD_CONCURRENCY) {
        const chunk = wanted.slice(i, i + KD_CONCURRENCY);
        // eslint-disable-next-line no-await-in-loop
        const res = await page.evaluate(async (ids) => Promise.all(ids.map(async (id) => {
          try {
            const r = await fetch(`/truc-tiep/${id}?kd_source=1`, {
              credentials: 'same-origin',
              referrer: `${location.origin}/truc-tiep/${id}`,
              headers: { Accept: '*/*', 'Cache-Control': 'no-cache' }
            });
            const t = await r.text();
            return { id, status: r.status, text: t.slice(0, 2000) };
          } catch (e) { return { id, status: 0, text: '' }; }
        })), chunk).catch(() => []);
        for (const r of res || []) {
          let j = null;
          try { j = JSON.parse(r.text); } catch { /* không phải JSON (vd trang HTML/challenge) */ }
          if (j && j.found && typeof j.streamUrl === 'string' && j.streamUrl) {
            kd.push({ matchId: r.id, found: true, earlyStream: !!j.earlyStream, streamUrl: j.streamUrl });
          }
        }
      }
      seen.push(`kd_source: ${kd.length}/${wanted.length} trận có streamUrl`);
    } catch (e) {
      seen.push(`kd_source lỗi: ${String(e?.message || e).slice(0, 80)}`);
    }

    let hrefs = [];
    try {
      hrefs = await page.evaluate(() => [...document.querySelectorAll('a[href]')].map((a) => a.getAttribute('href')));
    } catch { /* bỏ qua */ }
    const title = await page.title().catch(() => '');
    const finalUrl = page.url();
    return { ...got, kd, hrefs, seen, title, finalUrl, status, gotoError };
  } finally {
    await page.close().catch(() => {});
  }
}

const absUrl = (href) => {
  if (!href) return '';
  if (/^https?:/i.test(href)) return href;
  if (href.startsWith('//')) return `https:${href}`;
  return `${activeBaseUrl()}${href.startsWith('/') ? '' : '/'}${href}`;
};

class KhanDaiTvService {
  getFullUrl(url) {
    if (!url) return '';
    if (url.startsWith('http')) return url;
    return `${activeBaseUrl()}${url}`;
  }

  detectCdn(url) {
    const u = String(url || '').toLowerCase();
    if (u.includes('tencent') || u.includes('tlivecdn') || u.includes('liveplay')) return 'TENCENT';
    if (u.includes('alibaba') || u.includes('aliyun') || u.includes('alicdn')) return 'ALIBABA';
    if (u.includes('phaohoa')) return 'PHAOHOA';
    if (u.includes('cloudflare')) return 'CLOUDFLARE';
    return 'HLS';
  }

  /**
   * Lấy TOÀN BỘ trận (mọi môn, mọi trạng thái) 1 lần, cache ~20s; lượt rỗng/lỗi dùng lại bản tốt gần nhất
   * (tối đa STALE_MAX_MS) để playlist không bị "0 trận" chập chờn.
   */
  async getAllRawMatches() {
    const now = Date.now();
    if (rawMatchesCache.data && now - rawMatchesCache.fetchedAt < RAW_CACHE_TTL_MS) return rawMatchesCache.data;
    if (rawMatchesCache.pending) return rawMatchesCache.pending;

    const attemptFetch = async (label) => {
      const base = activeBaseUrl();
      const r = await scrapeSite(base);
      const ids = [...collectById(r.schedule).keys()];
      const hrefByMatchId = mapHrefsToMatchIds((r.hrefs || []).map(absUrl), ids);
      const out = buildRawMatches({ schedule: r.schedule, live: [r.live, r.kd], hrefByMatchId });
      if (!out.length) {
        const challenge = /just a moment|checking your browser|attention required/i.test(r.title || '');
        const neverLoaded = !r.finalUrl || r.finalUrl === 'about:blank' || /^chrome-error:/i.test(r.finalUrl);
        console.error(
          `[khandaitv] ${label} (${base}): 0 trận (HTTP ${r.status || 'n/a'})` +
          (neverLoaded
            ? ` — KHÔNG MỞ ĐƯỢC TRANG${r.gotoError ? `, lỗi goto: ${r.gotoError}` : ''} [domain chết/đổi? kiểm tra khandaitv=... trong SOURCE_DOMAINS]`
            : ` — title="${r.title}" url="${r.finalUrl}"` +
              (challenge ? ' [NGHI NGỜ kẹt Cloudflare]' : ' [không đọc được cms-schedule.json / cms-home-matches — schema có thể đã đổi tiếp]') +
              (r.seen?.length ? ` | request: ${r.seen.join(' | ')}` : ''))
        );
      } else {  // luôn in log chẩn đoán (không cần biến môi trường)
        const withStream = out.filter((m) => m.streams.length).length;
        console.log(`[khandaitv] ${label}: ${out.length} trận, live=${out.filter((m) => m.isLive).length}, có link phát sẵn=${withStream}, live-feed=${r.live ? 'có' : 'KHÔNG'}, kd_source=${(r.kd || []).length}`);
        const nowMs = Date.now();
        // Chỉ in chi tiết cho trận ĐÃ ĐÁ nhưng CHƯA lên live (bất thường); trận live bình thường thì không in.
        for (const m of out.filter((x) => x.startMs && x.startMs <= nowMs && !x.isFinished && !x.isLive)) {
          console.log(`[khandaitv] CHƯA LÊN LIVE: ${m.sport} "${m.home} - ${m.away}" bắt đầu ${Math.round((nowMs - m.startMs) / 60000)}p trước | hasLiveSource=${m.hasLiveSource} | link=${m.streams.length} | isLive=${m.isLive}`);
        }
        if (r.live && !withStream) console.log(`[khandaitv] mẫu cms-match-live: ${JSON.stringify(r.live).slice(0, 600)}`);
      }
      return out;
    };

    const staleData = () => {
      const age = Date.now() - lastGood.at;
      return lastGood.data && lastGood.data.length && age <= STALE_MAX_MS ? { data: lastGood.data, ageSec: Math.round(age / 1000) } : null;
    };

    const task = (async () => {
      try {
        let out = await attemptFetch('lần 1');
        if (!out.length) out = await attemptFetch('lần 2 (thử lại)');
        if (out.length) {
          lastGood = { data: out, at: Date.now() };
          rawMatchesCache = { data: out, fetchedAt: Date.now(), pending: null };
          return out;
        }
        const stale = staleData();
        if (stale) {
          console.warn(`[khandaitv] lần quét này ra 0 trận — dùng lại ${stale.data.length} trận của lần quét tốt cách đây ${stale.ageSec}s`);
          rawMatchesCache = { data: stale.data, fetchedAt: Date.now(), pending: null };
          return stale.data;
        }
        rawMatchesCache = { data: out, fetchedAt: 0, pending: null };
        return out;
      } catch (error) {
        console.error('Error fetching KhanDaiTV via browser [build-marker-v3-cms]:', error.message);
        const stale = staleData();
        const data = stale ? stale.data : (rawMatchesCache.data || []);
        rawMatchesCache = { data, fetchedAt: data.length ? Date.now() : 0, pending: null };
        return data;
      }
    })();

    rawMatchesCache.pending = task;
    return task;
  }

  normalizeMatch(m) {
    // m = "raw match" do buildRawMatches() (src/utils/khandaiCms.js) dựng từ cms-schedule.json + cms-match-live.
    const sport = canonicalSport(m.sport);
    const info = SPORT_INFO[sport] || { name: String(sport).toUpperCase(), icon: 'fa-futbol' };
    const isLive = !!m.isLive;
    const isFinished = !!m.isFinished;

    const matchDate = m.startMs ? new Date(m.startMs) : new Date();
    const tz = { timeZone: 'Asia/Ho_Chi_Minh' };
    const timeStr = matchDate.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', hour12: false, ...tz });
    const dateStr = matchDate.toLocaleDateString('en-CA', tz); // YYYY-MM-DD (giờ VN)
    const [yyyy, mm, dd] = dateStr.split('-');

    const commentators = (m.streams || []).filter((c) => !/hls-decoy/i.test(c.url)).map((c, i) => ({
      id: c.id || `s${i + 1}`,
      name: c.name || `Server ${i + 1}`,
      avatar: this.getFullUrl(c.avatar),
      streamUrl: c.url,
      isLive: true,
      cdn: this.detectCdn(c.url)
    }));

    const elapsed = String(m.matchTimeText || '').trim();
    const slug = `${slugifyVi(m.home)}-vs-${slugifyVi(m.away)}-ngay-${dd}-${mm}-${yyyy}`;
    const liveUrl = m.href ? absUrl(m.href) : `${activeBaseUrl()}/truc-tiep/${m.id}`;

    return {
      matchId: `kd_${m.id}`,
      originalId: m.id,
      slug,
      source: 'khandaitv',
      sport,
      sportName: info.name,
      sportIcon: info.icon,
      competition: { name: m.league || '', logo: '', icon: '' },
      homeTeam: { name: m.home || 'Home', logo: this.getFullUrl(m.homeLogo) },
      awayTeam: { name: m.away || 'Away', logo: this.getFullUrl(m.awayLogo) },
      score: { home: m.score?.home ?? 0, away: m.score?.away ?? 0 },
      status: {
        isLive,
        isFinished,
        isHalfTime: /^HT$/i.test(elapsed),
        isUpcoming: !isLive && !isFinished,
        name: isLive ? (elapsed && !/^\d+$/.test(elapsed) ? elapsed : 'LIVE') : (isFinished ? 'FT' : 'Sắp diễn ra'),
        text: isLive ? (elapsed || 'LIVE') : (isFinished ? 'Kết thúc' : 'Sắp diễn ra'),
        elapsedTime: isLive ? (elapsed && /^\d+$/.test(elapsed) ? `${elapsed}'` : elapsed) : '',
        minutes: elapsed
      },
      stats: { halfTimeScore: '0-0', corners: '0-0', yellowCards: '0-0' },
      matchTime: m.startMs || matchDate.getTime(),
      matchTimeTimestamp: m.startMs || matchDate.getTime(),
      timeFormatted: `${timeStr} - ${dd}/${mm}`,
      dateStr,
      timeStr,
      isHot: !!m.hot,
      hasLiveSource: !!m.hasLiveSource,
      commentators,
      streamers: commentators,
      streamUrl: commentators[0]?.streamUrl || '',
      stream: {
        liveUrl,
        streamerName: commentators[0]?.name || (m.commentatorNames || [])[0] || null,
        streamerAvatar: commentators[0]?.avatar || null
      },
      odds: null
    };
  }

  mapStreams(match) {
    const list = [];
    const seen = new Set();

    for (const c of match?.commentators || []) {
      const url = c.streamUrl || '';
      if (!url || seen.has(url)) continue;
      seen.add(url);
      const isFlv = /\.flv(\?|$)/i.test(url);
      const isM3u8 = /\.m3u8(\?|$)/i.test(url);
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
        format: isFlv ? 'flv' : (isM3u8 ? 'hls' : ''),
        cdn: c.cdn || this.detectCdn(url),
        quality: 'HD'
      });
    }

    if (!list.length && match?.streamUrl) {
      const isFlv = /\.flv(\?|$)/i.test(match.streamUrl);
      const isM3u8 = /\.m3u8(\?|$)/i.test(match.streamUrl);
      list.push({
        id: 'primary',
        streamerId: 'primary',
        name: 'Server 1',
        streamerName: 'Server 1',
        avatar: '',
        streamerAvatar: '',
        link: match.streamUrl,
        m3u8Url: match.streamUrl,
        playUrl: match.streamUrl,
        format: isFlv ? 'flv' : (isM3u8 ? 'hls' : ''),
        cdn: this.detectCdn(match.streamUrl),
        quality: 'HD'
      });
    }

    return list;
  }

  /**
   * Dò trận theo id/slug trong danh sách đã lấy sẵn (không gọi mạng riêng).
   */
  async findRawMatch(slugOrId) {
    if (!slugOrId) return null;
    const key = decodeURIComponent(String(slugOrId)).replace(/\/+$/, '').trim();
    const cleanId = key.replace(/^kd_/, '');
    const all = await this.getAllRawMatches();
    return all.find((m) => String(m.id) === cleanId || this.normalizeMatch(m).slug === key) || null;
  }

  async getAllMatches(sport = 'football') {
    try {
      const want = sportKey(sport);
      const all = await this.getAllRawMatches();
      return all
        .filter((m) => !want || m.sport === want)
        .map((m) => this.normalizeMatch(m));
    } catch (error) {
      console.error('Error fetching KhanDaiTV matches:', error.message);
      return [];
    }
  }

  /**
   * Không còn phân trang thật từ server (đã lấy hết 1 lần) — page/pageSize
   * chỉ dùng để cắt mảng trong bộ nhớ, giữ nguyên interface cho chỗ gọi.
   */
  async getMatchesByTab(tab, sport = 'football', page = 1, pageSize = 18) {
    try {
      const want = tab === 'all' || sport === 'all'
        ? null
        : (tab in SPORT_FILTER ? SPORT_FILTER[tab] : sportKey(sport));

      const all = await this.getAllRawMatches();
      let normalized = all
        .filter((m) => !want || m.sport === want)
        .map((m) => this.normalizeMatch(m));

      const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });
      const tomorrowDate = new Date(Date.now() + 24 * 60 * 60 * 1000);
      const tomorrowStr = tomorrowDate.toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });

      if (tab === 'live') normalized = normalized.filter((m) => m.status.isLive);
      else if (tab === 'upcoming') normalized = normalized.filter((m) => m.status.isUpcoming);
      else if (tab === 'hot') normalized = normalized.filter((m) => m.isHot);
      else if (tab === 'commentator' || tab === 'with-stream') normalized = normalized.filter((m) => m.commentators.length > 0 || m.hasLiveSource);
      else if (tab === 'today') normalized = normalized.filter((m) => m.dateStr === todayStr);
      else if (tab === 'tomorrow') normalized = normalized.filter((m) => m.dateStr === tomorrowStr);

      const totalCount = normalized.length;
      const start = (page - 1) * pageSize;
      const pageItems = normalized.slice(start, start + pageSize);
      const hasMore = start + pageSize < totalCount;

      return { matches: pageItems, hasMore, totalCount };
    } catch (error) {
      console.error(`Error fetching KhanDaiTV tab ${tab} page ${page}:`, error.message);
      return { matches: [], hasMore: false, totalCount: 0 };
    }
  }

  /** Fetch every page for a tab (used by /live aggregator). */
  async getAllMatchesByTab(tab, sport = 'all', pageSize = 50) {
    const all = [];
    const seen = new Set();
    let page = 1;
    const maxPages = 30;

    while (page <= maxPages) {
      const { matches, hasMore, totalCount } = await this.getMatchesByTab(
        tab,
        sport,
        page,
        pageSize
      );

      for (const m of matches || []) {
        const key = m.matchId || m.originalId;
        if (!key || seen.has(key)) continue;
        seen.add(key);
        all.push(m);
      }

      if (!hasMore) {
        return { matches: all, hasMore: false, totalCount: totalCount || all.length };
      }
      page += 1;
    }

    return { matches: all, hasMore: false, totalCount: all.length };
  }

  async getCounts(sport = 'football') {
    try {
      const want = sportKey(sport);
      const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });
      const tomorrowDate = new Date(Date.now() + 24 * 60 * 60 * 1000);
      const tomorrowStr = tomorrowDate.toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });

      const all = await this.getAllRawMatches();
      const normalized = all
        .filter((m) => !want || m.sport === want)
        .map((m) => this.normalizeMatch(m));

      const liveCount = normalized.filter((m) => m.status.isLive).length;
      const upcomingCount = normalized.filter((m) => m.status.isUpcoming).length;
      const hotCount = normalized.filter((m) => m.isHot).length;
      const todayCount = normalized.filter((m) => m.dateStr === todayStr).length || normalized.length;
      const tomorrowCount = normalized.filter((m) => m.dateStr === tomorrowStr).length;
      const commentatorCount = normalized.filter((m) => m.commentators.length > 0).length;

      return {
        live: liveCount,
        upcoming: upcomingCount,
        hot: hotCount,
        commentator: commentatorCount,
        today: todayCount,
        tomorrow: tomorrowCount,
        tomorrow_date: tomorrowStr
      };
    } catch (error) {
      console.error('Error fetching KhanDaiTV counts:', error.message);
      return { live: 0, upcoming: 0, hot: 0, commentator: 0, today: 0, tomorrow: 0 };
    }
  }

  /**
   * Link phát: ưu tiên link có sẵn trong cms-schedule / cms-match-live. Nếu trận có nguồn phát
   * (hasLiveSource) nhưng JSON không kèm link thì mở TRANG TRẬN THẬT (href lấy từ thẻ <a> trang chủ)
   * bằng Chromium và bắt request .m3u8 do player tự gọi. Cache 2 phút để khỏi mở lại.
   */
  async getStreamLinks(matchId) {
    try {
      const raw = await this.findRawMatch(matchId);
      if (!raw) return [];
      let match = this.normalizeMatch(raw);
      let list = this.mapStreams(match);
      if (list.length) return list;

      if (!(raw.hasLiveSource || raw.isLive || raw.earlyStream)) return [];
      const cached = resolvedCache.get(raw.id);
      if (cached && Date.now() - cached.at < 2 * 60 * 1000) return cached.list;

      // BẪY: trang tự gọi 10 playlist GIẢ /assets/hls-decoy-v13b/channel-01..10.m3u8 (cùng domain, để đánh lạc người bắt request).
      // Link THẬT nằm ở CDN ngoài (vd https://play.saigon8386.live/live_xxx/live_xxx@saigon8386.m3u8) -> loại mọi URL "decoy".
      const cap = await captureM3u8ViaBrowser(absUrl(raw.href || `/truc-tiep/${raw.id}`), {
        timeoutMs: 20000,
        referer: `${activeBaseUrl()}/`,
        matchUrl: /^https?:\/\/(?!(?:[^/]*\.)?khandaia\.[^/]+\/assets\/hls-decoy)(?![^?#]*hls-decoy)[^?#]*\.m3u8(?:[?#]|$)/i
      });
      const good = (cap.found || []).filter((f) => f.status == null || f.status < 400);
      match = {
        ...match,
        commentators: good.map((f, i) => ({
          id: `m3u8_${i + 1}`, name: `Server ${i + 1}`, avatar: '', streamUrl: f.url, isLive: true, cdn: this.detectCdn(f.url)
        }))
      };
      list = this.mapStreams(match);
      resolvedCache.set(raw.id, { at: Date.now(), list });
      return list;
    } catch (error) {
      console.error('Error fetching KhanDaiTV stream links:', error.message);
      return [];
    }
  }

  async getMatchDetail(slugOrId) {
    const raw = await this.findRawMatch(slugOrId);
    if (!raw) return null;
    const match = this.normalizeMatch(raw);
    if (!match.slug) match.slug = buildMatchSlug(match) || match.matchId;
    const streams = this.mapStreams(match);
    return { match, streams, matchId: match.matchId };
  }

  async getMatchLiveSnapshot(slugOrId) {
    const raw = await this.findRawMatch(slugOrId);
    return raw ? this.normalizeMatch(raw) : null;
  }
}

const khandaitvService = new KhanDaiTvService();
export default khandaitvService;
