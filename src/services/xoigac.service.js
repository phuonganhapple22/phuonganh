import { load } from 'cheerio';
import { createHttpClient } from '@/src/utils/httpClient';
import { isStaleLiveMatch } from '@/src/utils/playerGet';
import { filterMinorLeagues } from '@/src/utils/leagueFilter';
import { fetchPageGlobal } from '@/src/utils/browserFetch';

// Nguồn Xoigac TV (xoigac.live). Trang chủ render SẴN toàn bộ trận có BLV:
//   1. <script type="application/json" id="focusMatchesData">[ {...}, ... ]</script>
//      mỗi phần tử = 1 cặp (trận, BLV/streamer): id, streamSessionId,
//      playbackIdentifier ("<id>_<session>"), homeTeam/awayTeam (+logo, tỉ số),
//      status (NS/1H/HT/2H/FT...), minute, league, matchDate (ISO UTC),
//      streamerNickname, isLive (trận đang đá), isStreamerLiveNow (BLV đang phát),
//      sportType (football/basketball), matchUrl.
//   2. <div class="focus-card" data-card-id="<playbackIdentifier>"
//      data-stream-url="/hls/<id>/index.m3u8" ...> — link HLS TƯƠNG ĐỐI trên
//      chính domain site.
// Đối chiếu với bản HTML trang chủ người dùng gửi (04/10/2026, 70 phần tử).
//
// KHÔNG dùng trường "streamUrl" trong JSON: đó là địa chỉ RTMPS để BLV ĐẨY
// luồng lên (ingest của AWS IVS), không phải link xem.
//
// Request m3u8 THẬT người dùng bắt được (04/10/2026) là AWS IVS:
//   https://4ac07980a95d.aps12.playlist.live-video.net/v1/playlist/<token ký sẵn>.m3u8
// gọi KHÔNG kèm Referer, chỉ User-Agent + Accept. Host 4ac07980a95d trùng kênh
// trong trường rtmps:// của trang -> đúng luồng của BLV. Token nằm trong ĐƯỜNG
// DẪN và có hạn -> KHÔNG nên lưu link IVS đó; dùng /hls/<id>/index.m3u8 trên site
// (nhiều khả năng site chuyển hướng 302 sang link IVS mới mỗi lần mở; proxy
// hls.js đã theo chuyển hướng và dùng URL cuối làm gốc cho các dòng tương đối).
//
// ĐÃ XÁC NHẬN (05/10/2026, từ HTML trang player người dùng gửi — hàm
// loadIvsStreamer): trình phát tự xin link bằng
//   GET /api/stream/info/<matchId>_<streamSessionId>   ->  JSON { playbackUrl }
// với <matchId>_<streamSessionId> chính là playbackIdentifier. playbackUrl là link
// AWS IVS có token, có hạn -> KHÔNG cache lâu; lấy mới mỗi lần getStreamLinks()
// (resolve.js / stream.js gọi lúc bấm xem). Mỗi BLV có session riêng -> link IVS
// riêng, nên KHÔNG còn gộp BLV theo URL. Nếu API lỗi/không trả playbackUrl thì
// rơi về data-stream-url (/hls/<id>/index.m3u8) như trước.
const XOIGAC_BASE_URL = String(process.env.XOIGAC_DOMAIN || process.env.XOIGAC_BASE_URL || 'https://xoigac.live').replace(/\/+$/, '');

// FIX (05/10/2026 — "đã đổi domain Xoigac sang domain mới mà Generate vẫn quét domain cũ"):
// trước đây danh sách này CỨNG gồm cả https://xoigac.live và https://xoigac.top, nên dù cấu hình
// domain mới thì mỗi chu kỳ 2 phút vẫn gọi cả domain cũ (log 403 "https://xoigac.live lỗi") rồi
// lượt trình duyệt thật còn mở lại domain cũ lần nữa. Giờ CHỈ dùng domain cấu hình
// (XOIGAC_DOMAIN / XOIGAC_BASE_URL, lấy từ SOURCE_DOMAINS hoặc file data/source-domains.txt).
// Muốn thêm domain dự phòng (mirror) thì đặt biến môi trường XOIGAC_MIRRORS=domain1,domain2 —
// domain nào trả được trang chủ có focusMatchesData thì dùng domain đó cho cả link tương đối.
const XOIGAC_MIRRORS = String(process.env.XOIGAC_MIRRORS || '')
  .split(/[,\s]+/)
  .map((u) => u.trim())
  .filter(Boolean)
  .map((u) => (/^https?:\/\//i.test(u) ? u : `https://${u}`).replace(/\/+$/, ''));
const XOIGAC_BASES = [...new Set([XOIGAC_BASE_URL, ...XOIGAC_MIRRORS])];

const client = createHttpClient(
  {
    baseURL: XOIGAC_BASE_URL,
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'vi,en-US;q=0.9,en;q=0.8'
    },
    timeout: 12000
  },
  { maxAttempts: 2 }
);

// Gọi API xin link IVS: ngắn hơn trang chủ, không thử lại (đã có fallback /hls/).
const playbackClient = createHttpClient(
  {
    baseURL: XOIGAC_BASE_URL,
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36',
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'vi,en-US;q=0.9,en;q=0.8'
    },
    timeout: 8000
  },
  { maxAttempts: 1 }
);

const MAX_RESOLVE_PER_MATCH = 6;
const PREFETCH_LIMIT_MS = 40000;

const SPORT_INFO = {
  football: { name: 'BÓNG ĐÁ', icon: 'fa-futbol' },
  basketball: { name: 'BÓNG RỔ', icon: 'fa-basketball' }
};

// Mã trạng thái kiểu API-Football (đối chiếu: NS, 1H với dữ liệu thật).
const LIVE_CODES = new Set(['1H', 'HT', '2H', 'ET', 'BT', 'P', 'LIVE', 'Q1', 'Q2', 'Q3', 'Q4', 'OT']);
const FINISHED_CODES = new Set(['FT', 'AET', 'PEN', 'AWD', 'WO']);
// PST hoãn, CANC huỷ, ABD bỏ dở, SUSP/INT gián đoạn -> không hiện trong live/upcoming.
const OFF_CODES = new Set(['PST', 'CANC', 'ABD', 'SUSP', 'INT']);

function mapStatus(code, isLiveFlag) {
  const c = String(code || '').toUpperCase();
  if (isLiveFlag === true || LIVE_CODES.has(c)) {
    const half = c === 'HT';
    return { isLive: true, isFinished: false, isUpcoming: false, isHalfTime: half };
  }
  if (FINISHED_CODES.has(c) || OFF_CODES.has(c)) return { isLive: false, isFinished: true, isUpcoming: false, isHalfTime: false };
  return { isLive: false, isFinished: false, isUpcoming: true, isHalfTime: false };
}

function abs(url, base = XOIGAC_BASE_URL) {
  if (!url) return '';
  if (/^(https?:)?\/\//i.test(url)) return url.startsWith('//') ? `https:${url}` : url;
  return `${base}${url.startsWith('/') ? '' : '/'}${url}`;
}

/** Lấy playbackUrl (AWS IVS) của 1 BLV qua API của chính trình phát. Lỗi -> ''. */
async function fetchPlaybackUrl(base, identifier) {
  if (!identifier) return '';
  // API đã bị chặn (401/403) gần đây -> khỏi dội thêm request vô ích, để đường trình duyệt lo.
  if (Date.now() - apiBlockedAt < API_BLOCK_COOLDOWN_MS) return '';
  try {
    const { data } = await playbackClient.get(`${base}/api/stream/info/${encodeURIComponent(identifier)}`, {
      headers: { Referer: `${base}/` }
    });
    const body = typeof data === 'string' ? JSON.parse(data) : data;
    const url = body?.playbackUrl || body?.data?.playbackUrl || '';
    if (!/^https?:\/\//i.test(url)) {
      console.error(`[xoigac] ${base}/api/stream/info/${identifier}: không có playbackUrl (keys: ${Object.keys(body || {}).join(',') || '-'})`);
      return '';
    }
    return url;
  } catch (error) {
    const st = error?.response?.status;
    if (st === 401 || st === 403) apiBlockedAt = Date.now();
    const snippet = typeof error?.response?.data === 'string' ? error.response.data.replace(/\s+/g, ' ').slice(0, 120) : '';
    console.error(`[xoigac] ${base}/api/stream/info/${identifier}: ${error.message}${st ? ` (HTTP ${st})` : ''}${snippet ? ` | ${snippet}` : ''}`);
    return '';
  }
}

// FIX (05/10/2026 — log CI: "[xoigac] https://xoigac.live lỗi: Request failed with status code 403"):
// site chặn request kiểu axios từ IP máy chủ (WAF/Cloudflare). Khi mọi domain đều 403 thì mở
// Chromium headless thật (src/utils/browserFetch) — cùng cách đã dùng cho Giờ Vàng/Khán Đài.
// Trong CÙNG phiên trình duyệt (đã qua thử thách, có cookie) xin luôn /api/stream/info/<id>
// cho các BLV đang phát, để khỏi phải gọi lại API từ axios (cũng sẽ bị 403). Tắt bằng XOIGAC_BROWSER=0.
const BROWSER_EVAL = `(() => {
  const s = document.getElementById('focusMatchesData');
  if (!s) return null;
  if (!window.__xg) {
    let records = [];
    try { records = JSON.parse(s.textContent); } catch (e) { return null; }
    const cards = Array.from(document.querySelectorAll('.focus-card[data-card-id]')).map((e) => ({
      id: e.getAttribute('data-card-id'),
      streamUrl: e.getAttribute('data-stream-url') || '',
      slug: e.getAttribute('data-streamer-slug') || '',
      avatar: e.getAttribute('data-streamer-avatar') || ''
    }));
    const ids = Array.from(new Set(records.filter((r) => r.isStreamerLiveNow === true)
      .map((r) => r.playbackIdentifier || (r.id + '_' + r.streamSessionId)))).slice(0, 40);
    window.__xg = { records: records, cards: cards, info: {}, pending: ids.length };
    ids.forEach((id) => {
      fetch('/api/stream/info/' + encodeURIComponent(id), { credentials: 'same-origin', signal: AbortSignal.timeout(8000) })
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => { window.__xg.info[id] = (j && (j.playbackUrl || (j.data && j.data.playbackUrl))) || ''; })
        .catch(() => { window.__xg.info[id] = ''; })
        .finally(() => { window.__xg.pending -= 1; });
    });
  }
  return window.__xg.pending <= 0 ? { records: window.__xg.records, cards: window.__xg.cards, info: window.__xg.info } : null;
})()`;

async function fetchHomepageViaBrowser(base) {
  const { data, status, diagnostic } = await fetchPageGlobal(`${base}/`, {
    evalExpr: BROWSER_EVAL,
    timeoutMs: 28000,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });
  if (!data?.records?.length) {
    const d = diagnostic ? ` | title="${diagnostic.title}" body="${String(diagnostic.bodySnippet || '').replace(/\s+/g, ' ').slice(0, 100)}"` : '';
    throw new Error(`trình duyệt không đọc được focusMatchesData (HTTP ${status || 'n/a'})${d}`);
  }
  const cardAttrs = new Map();
  for (const c of data.cards || []) cardAttrs.set(c.id, { streamUrl: c.streamUrl, slug: c.slug, avatar: c.avatar });
  const info = new Map(Object.entries(data.info || {}).filter(([, v]) => v));
  return { records: data.records, cardAttrs, info };
}

/** Lấy mảng focusMatchesData + map data-card-id -> thuộc tính link HLS trên thẻ. */
function parseHomepage(html) {
  const m = String(html || '').match(/<script[^>]*id=["']focusMatchesData["'][^>]*>([\s\S]*?)<\/script>/i);
  let records = [];
  if (m) {
    try {
      const arr = JSON.parse(m[1]);
      if (Array.isArray(arr)) records = arr;
    } catch (error) {
      console.error('[xoigac] focusMatchesData không phải JSON hợp lệ:', error.message);
    }
  }

  const $ = load(html);
  const cardAttrs = new Map();
  $('.focus-card[data-card-id]').each((_, el) => {
    const $c = $(el);
    cardAttrs.set($c.attr('data-card-id'), {
      streamUrl: $c.attr('data-stream-url') || '',
      slug: $c.attr('data-streamer-slug') || '',
      avatar: $c.attr('data-streamer-avatar') || ''
    });
  });
  return { records, cardAttrs };
}

/** Gộp các bản ghi (trận, BLV) thành 1 trận có nhiều BLV. */
function buildMatches(records, cardAttrs, base = XOIGAC_BASE_URL) {
  const toAbs = (u) => abs(u, base);
  const byMatch = new Map();
  for (const r of records) {
    if (r?.id === undefined || r?.id === null) continue;
    // Trận TẠO TAY có id âm riêng cho từng BLV (-5158, -5159, -5160 cùng là
    // Malaysia vs Vietnam) -> gộp theo đội + giờ để không ra 3 trận giống nhau.
    const key = Number(r.id) < 0 ? `m:${r.homeTeam}|${r.awayTeam}|${r.matchDate}` : String(r.id);
    if (!byMatch.has(key)) byMatch.set(key, []);
    byMatch.get(key).push(r);
  }

  const out = [];
  for (const [, rows] of byMatch) {
    const first = rows[0];
    const id = String(first.id);
    const sport = String(first.sportType || 'football').toLowerCase();
    const info = SPORT_INFO[sport] || { name: sport.toUpperCase(), icon: 'fa-futbol' };

    // Ưu tiên bản ghi đang live nếu có (đỡ lấy nhầm NS khi cùng trận).
    const anyLive = rows.some((r) => r.isLive === true);
    const status = mapStatus(first.status, anyLive);

    const matchDate = first.matchDate ? new Date(first.matchDate) : new Date();
    const ts = Number.isNaN(matchDate.getTime()) ? new Date() : matchDate;
    const timeStr = ts.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Ho_Chi_Minh' });
    const dateStr = ts.toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });
    const [, mo, da] = dateStr.split('-');

    // BLV đang phát thật (isStreamerLiveNow). Bỏ trùng theo playbackIdentifier (mỗi BLV
    // = 1 session = 1 link IVS riêng). streamUrl ở đây là link /hls/ dự phòng (có thể
    // rỗng); link IVS thật được lấy lúc getStreamLinks() qua /api/stream/info/.
    const commentators = [];
    const seenId = new Set();
    for (const r of rows) {
      if (r.isStreamerLiveNow !== true) continue;
      const pid = String(r.playbackIdentifier || `${r.id}_${r.streamSessionId}`);
      if (seenId.has(pid)) continue;
      const attrs = cardAttrs.get(pid) || {};
      const url = attrs.streamUrl ? toAbs(attrs.streamUrl) : '';
      seenId.add(pid);
      commentators.push({
        id: pid,
        name: r.streamerNickname ? `BLV ${r.streamerNickname}` : `BLV ${commentators.length + 1}`,
        avatar: attrs.avatar ? toAbs(attrs.avatar) : null,
        streamUrl: url,
        flvStreamUrl: '',
        isLive: true,
        cdn: 'HLS',
        referer: `${base}/`
      });
    }

    const minute = status.isLive ? (status.isHalfTime ? 'HT' : (first.minute ? String(first.minute) : '')) : '';
    const detailUrl = toAbs(first.matchUrl);
    const safeId = id.replace('-', 'm'); // trận tạo tay có id âm (-5158)

    out.push({
      matchId: `xg_${safeId}`,
      originalId: id,
      slug: String(first.matchUrl || '').replace(/^\//, '').split('/')[0] || '',
      detailUrl,
      source: 'xoigac',
      sport,
      sportName: info.name,
      sportIcon: info.icon,
      competition: { name: first.league || '', logo: toAbs(first.leagueLogo), icon: toAbs(first.leagueLogo) },
      homeTeam: { name: first.homeTeam || 'Home', logo: toAbs(first.homeTeamLogo) },
      awayTeam: { name: first.awayTeam || 'Away', logo: toAbs(first.awayTeamLogo) },
      score: { home: Number(first.homeScore) || 0, away: Number(first.awayScore) || 0 },
      status: {
        ...status,
        name: status.isLive ? (status.isHalfTime ? 'HT' : 'LIVE') : (status.isFinished ? 'FT' : 'Sắp diễn ra'),
        text: status.isLive ? (status.isHalfTime ? 'HT' : (minute ? `${minute}'` : 'LIVE')) : (status.isFinished ? 'Kết thúc' : 'Sắp diễn ra'),
        elapsedTime: status.isLive && !status.isHalfTime ? minute : '',
        minutes: minute
      },
      stats: { halfTimeScore: '0-0', corners: '0-0', yellowCards: '0-0' },
      matchTime: ts.getTime(),
      matchTimeTimestamp: ts.getTime(),
      timeFormatted: `${timeStr} - ${da}/${mo}`,
      dateStr,
      timeStr,
      isHot: false,
      commentators: status.isLive ? commentators : [],
      streamers: status.isLive ? commentators : [],
      streamUrl: status.isLive && commentators[0] ? commentators[0].streamUrl : '',
      stream: {
        // Khác rỗng để trận chưa có link vẫn nằm trong playlist tĩnh (xem phalang.service.js).
        liveUrl: detailUrl || base,
        streamerName: status.isLive && commentators[0] ? commentators[0].name : null,
        streamerAvatar: status.isLive && commentators[0] ? commentators[0].avatar : null
      },
      odds: null,
      _liveCommentators: commentators,
      _base: base
    });
  }
  return out;
}

function mapStreams(commentators) {
  return (commentators || []).map((c) => ({
    id: c.id,
    streamerId: c.id,
    name: c.name,
    streamerName: c.name,
    avatar: c.avatar,
    streamerAvatar: c.avatar,
    link: c.streamUrl,
    m3u8Url: c.streamUrl,
    playUrl: c.streamUrl,
    format: 'hls',
    cdn: c.cdn,
    quality: 'HD'
  }));
}

// Builder gọi getStreamLinks() cho TỪNG trận live (song song) -> trước đây mỗi lần lại
// tải lại cả trang chủ, dễ quá hạn 4,5s và dễ bị site chặn vì dội request. Giữ kết quả
// 30s trong bộ nhớ, các lời gọi đồng thời dùng chung 1 request.
const HOMEPAGE_TTL_MS = 45000;
let preferredBase = '';
let homepageCache = { at: 0, matches: null, pending: null };

let apiBlockedAt = 0;
const API_BLOCK_COOLDOWN_MS = 300000;
const ivsCache = new Map(); // playbackIdentifier -> { at, url }
let browserInfoPromise = null;
let browserInfoAt = 0;

/** Mở trình duyệt thật (1 lần / 45s, dùng chung) để xin link IVS cho mọi BLV đang phát. */
async function ensureBrowserInfo(base) {
  if (process.env.XOIGAC_BROWSER === '0') return;
  if (browserInfoPromise) return browserInfoPromise;
  if (Date.now() - browserInfoAt < HOMEPAGE_TTL_MS) return;
  browserInfoPromise = (async () => {
    try {
      console.warn(`[xoigac] API link IVS bị chặn/thiếu -> xin qua trình duyệt thật (${base})`);
      const { info } = await fetchHomepageViaBrowser(base);
      for (const [id, url] of info) ivsCache.set(id, { at: Date.now(), url });
      console.warn(`[xoigac] trình duyệt xin được ${info.size} link IVS`);
    } catch (error) {
      console.error(`[xoigac] trình duyệt xin link IVS lỗi: ${error.message}`);
    } finally {
      browserInfoAt = Date.now();
      browserInfoPromise = null;
    }
  })();
  return browserInfoPromise;
}

/** Lấy link IVS cho danh sách identifier: cache -> axios -> trình duyệt. Trả Map id -> url (chỉ id có link). */
async function resolveIvs(base, ids) {
  const out = new Map();
  const need = [];
  for (const id of ids) {
    const c = ivsCache.get(id);
    if (c?.url && Date.now() - c.at < HOMEPAGE_TTL_MS) out.set(id, c.url);
    else need.push(id);
  }
  if (!need.length) return out;
  await Promise.all(
    need.map(async (id) => {
      const url = await fetchPlaybackUrl(base, id);
      if (url) {
        ivsCache.set(id, { at: Date.now(), url });
        out.set(id, url);
      }
    })
  );
  const missing = need.filter((id) => !out.has(id));
  if (missing.length) {
    await ensureBrowserInfo(base);
    for (const id of missing) {
      const c = ivsCache.get(id);
      if (c?.url) out.set(id, c.url);
    }
  }
  return out;
}

class XoigacService {
  async fetchHomepageMatches() {
    const now = Date.now();
    if (homepageCache.matches && now - homepageCache.at < HOMEPAGE_TTL_MS) return homepageCache.matches;
    if (homepageCache.pending) return homepageCache.pending;
    homepageCache.pending = this._fetchHomepageMatchesUncached()
      .then((matches) => {
        homepageCache = { at: Date.now(), matches, pending: null };
        return matches;
      })
      .catch((error) => {
        homepageCache.pending = null;
        throw error;
      });
    return homepageCache.pending;
  }

  async _fetchHomepageMatchesUncached() {
    let lastError = null;
    // Lượt 1: axios (nhanh). Domain nào chạy được lần trước thì thử trước.
    const bases = preferredBase ? [preferredBase, ...XOIGAC_BASES.filter((b) => b !== preferredBase)] : XOIGAC_BASES;
    for (const base of bases) {
      try {
        const { data: html } = await client.get(`${base}/`);
        const { records, cardAttrs } = parseHomepage(html);
        if (!records.length) {
          lastError = new Error(`${base}: không có focusMatchesData`);
          console.error(`[xoigac] ${base}: không có focusMatchesData`);
          continue;
        }
        preferredBase = base;
        console.log(`[xoigac] OK ${base} (axios): ${records.length} bản ghi${lastError ? ' — các domain lỗi ở trên chỉ là thử trước, đã tự chuyển sang domain này' : ''}`);
        return buildMatches(records, cardAttrs, base);
      } catch (error) {
        lastError = error;
        console.error(`[xoigac] ${base} lỗi: ${error.message}`);
      }
    }
    // Lượt 2: trình duyệt thật (vượt WAF/Cloudflare) — mất vài giây nên chỉ dùng khi lượt 1 hỏng hết.
    if (process.env.XOIGAC_BROWSER !== '0') {
      for (const base of bases) {
        try {
          console.warn(`[xoigac] axios bị chặn -> thử trình duyệt thật cho ${base}`);
          const { records, cardAttrs, info } = await fetchHomepageViaBrowser(base);
          preferredBase = base;
          for (const [id, url] of info) ivsCache.set(id, { at: Date.now(), url });
          console.warn(`[xoigac] trình duyệt OK ${base}: ${records.length} bản ghi, ${info.size} link IVS`);
          return buildMatches(records, cardAttrs, base);
        } catch (error) {
          lastError = error;
          console.error(`[xoigac] trình duyệt ${base} lỗi: ${error.message}`);
        }
      }
    }
    throw lastError || new Error('không có domain Xoigac nào dùng được');
  }

  async getAllMatchesByTab(tab, sport = 'all', opts = {}) {
    try {
      const all = await this.fetchHomepageMatches();
      // Builder playlist: xin trước link IVS (kể cả qua trình duyệt, không bị hạn chờ 15s của từng trận)
      // để lúc resolve từng trận chỉ việc đọc cache.
      if (opts.prefetchIvs && tab === 'live') {
        // Bọc try/catch + hạn chờ: lỗi/treo ở bước này KHÔNG ĐƯỢC làm mất cả danh sách trận (chỉ mất link IVS).
        try {
          const liveIds = [...new Set(all.filter((m) => m.status.isLive).flatMap((m) => m._liveCommentators.map((c) => c.id)))];
          if (liveIds.length) {
            const base = all.find((m) => m._base)?._base || XOIGAC_BASE_URL;
            let timer;
            const limit = new Promise((resolve) => { timer = setTimeout(() => resolve(null), PREFETCH_LIMIT_MS); });
            const ivs = await Promise.race([resolveIvs(base, liveIds), limit]).finally(() => clearTimeout(timer));
            if (!ivs) console.error(`[xoigac] lấy trước link IVS quá ${PREFETCH_LIMIT_MS / 1000}s -> bỏ qua, dùng link dự phòng`);
            // QUAN TRỌNG: playlistBuilder.resolveStreams() dùng streamsFromMatchCard() TRƯỚC, lấy thẳng
            // commentators[].streamUrl trong danh sách (không gọi getStreamLinks) -> phải ghi đè link IVS vào đây,
            // nếu không playlist chỉ có link /hls/ dự phòng.
            if (ivs) {
              for (const m of all) {
                for (const c of m._liveCommentators) {
                  const u = ivs.get(c.id);
                  if (u) { c.streamUrl = u; c.cdn = 'IVS'; c.referer = ''; }
                }
                if (m.status.isLive && m._liveCommentators[0]) m.streamUrl = m._liveCommentators[0].streamUrl;
              }
              console.log(`[xoigac] playlist: ${ivs.size}/${liveIds.length} BLV có link IVS`);
            }
          }
        } catch (error) {
          console.error(`[xoigac] lấy trước link IVS lỗi (bỏ qua, vẫn giữ danh sách trận): ${error.message}`);
        }
      }
      let filtered = all.filter((m) => !m.status.isFinished);
      if (tab === 'live') filtered = filtered.filter((m) => m.status.isLive);
      else if (tab === 'upcoming') filtered = filtered.filter((m) => m.status.isUpcoming);
      if (sport !== 'all') filtered = filtered.filter((m) => m.sport === sport);

      // Bỏ giải cỏ/hạng 2/nữ/trẻ (src/utils/leagueFilter.js).
      filtered = filterMinorLeagues(filtered, 'xoigac');

      // Trận "live" quá giờ hợp lý (nguồn quên cập nhật) thì bỏ.
      filtered = filtered.filter((m) => !(m.status.isLive && isStaleLiveMatch(m)));

      // Trận live mà không có BLV nào đang phát/không có link thì bỏ (quy tắc chung của project).
      filtered = filtered.filter((m) => !m.status.isLive || m.commentators.length > 0);

      return { matches: filtered.map(({ _liveCommentators, _base, ...rest }) => rest), hasMore: false, totalCount: filtered.length };
    } catch (error) {
      console.error(`Error fetching Xoigac tab ${tab}:`, error.message);
      return { matches: [], hasMore: false, totalCount: 0 };
    }
  }

  async getStreamLinks(matchId) {
    try {
      const all = await this.fetchHomepageMatches();
      const clean = String(matchId).replace(/^xg_/, '').replace(/^m/, '-');
      const match = all.find((m) => m.originalId === clean || m.matchId === matchId || m.slug === matchId);
      if (!match) return [];
      const base = match._base || XOIGAC_BASE_URL;
      const list = (match._liveCommentators || []).slice(0, MAX_RESOLVE_PER_MATCH);
      // Xin link IVS mới cho từng BLV (song song); lỗi -> dùng link /hls/ dự phòng, không có thì bỏ BLV đó.
      const ivs = await resolveIvs(base, list.map((c) => c.id));
      const resolved = list.map((c) => {
        const url = ivs.get(c.id);
        if (url) return { ...c, streamUrl: url, cdn: 'IVS', referer: '' };
        return c.streamUrl ? c : null;
      });
      const ok = resolved.filter(Boolean);
      const nIvs = ok.filter((c) => c.cdn === 'IVS').length;
      console.log(`[xoigac] ${matchId}: ${nIvs}/${list.length} BLV có link IVS, ${ok.length - nIvs} dùng link /hls/ dự phòng, ${list.length - ok.length} bỏ`);
      return mapStreams(ok);
    } catch (error) {
      console.error('Error fetching Xoigac stream links:', error.message);
      return [];
    }
  }
}

const xoigacService = new XoigacService();
export default xoigacService;
export { parseHomepage, buildMatches };
