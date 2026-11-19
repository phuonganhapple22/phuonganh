import { createHttpClient } from '@/src/utils/httpClient';
import { isStaleLiveMatch } from '@/src/utils/playerGet';
import { filterMinorLeagues } from '@/src/utils/leagueFilter';
import { fetchPageGlobal, captureM3u8ViaBrowser } from '@/src/utils/browserFetch';

// Nguồn Xôi Chè TV (xoiche.live — canonical hiện tại: xoiche1.live).
// Site là Nuxt 3 (SSR). Toàn bộ dữ liệu trang chủ nằm trong
//   <script type="application/json" id="__NUXT_DATA__">[ ... ]</script>
// ở dạng "devalue" (mảng phẳng, giá trị tham chiếu nhau bằng chỉ số). Sau khi giải mã:
//   data['home-initial-data'].rawMatches = [ {...trận}, ... ]   (36 trận, hasApiMore=true -> còn trận ở API phân trang)
// mỗi trận có: id, slug, status ('live' | 'scheduled' | 'finished'), start_time (ISO +07:00),
//   home_score/away_score, match_time ('FT', phút...), home_team_name/away_team_name (+ home_team.logo...),
//   tournament_name, sport_slug (football, volleyball, basketball, tennis, badminton, table-tennis, esports),
//   commentator_streams[] = { stream_url (HLS), flv_stream_url, is_live, commentator{name, slug, avatar} }.
// Link HLS là link CÔNG KHAI dạng https://live.khoga.space/live/livehub<N>/index.m3u8 (không token trong URL).
// KHÔNG dùng backup_stream_url: đó là địa chỉ rtmp:// kèm sign để BLV ĐẨY luồng lên.
//
// CHƯA XÁC NHẬN: CDN khoga.space có đòi Referer hay không (proxy hls.js sẽ thử không Referer rồi tới Referer site).
// CHƯA CÓ: các trận ở trang 2+ (API phân trang của site, chưa bắt được request) — hiện chỉ lấy trận trong trang chủ.
const XOICHE_BASE_URL = String(process.env.XOICHE_DOMAIN || process.env.XOICHE_BASE_URL || 'https://xoiche.live').replace(/\/+$/, '');
const XOICHE_MIRRORS = String(process.env.XOICHE_MIRRORS || '')
  .split(/[,\s]+/)
  .map((u) => u.trim())
  .filter(Boolean)
  .map((u) => (/^https?:\/\//i.test(u) ? u : `https://${u}`).replace(/\/+$/, ''));
const XOICHE_BASES = [...new Set([XOICHE_BASE_URL, ...XOICHE_MIRRORS])];

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const client = createHttpClient(
  {
    baseURL: XOICHE_BASE_URL,
    headers: {
      'User-Agent': UA,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'vi,en-US;q=0.9,en;q=0.8'
    },
    timeout: 12000
  },
  { maxAttempts: 2 }
);

const MAX_RESOLVE_PER_MATCH = 6;
const HOMEPAGE_TTL_MS = 45000;
const STALE_MAX_MS = 10 * 60 * 1000;

const SPORT_INFO = {
  football: { name: 'BÓNG ĐÁ', icon: 'fa-futbol' },
  volleyball: { name: 'BÓNG CHUYỀN', icon: 'fa-volleyball' },
  basketball: { name: 'BÓNG RỔ', icon: 'fa-basketball' },
  tennis: { name: 'QUẦN VỢT', icon: 'fa-table-tennis-paddle-ball' },
  badminton: { name: 'CẦU LÔNG', icon: 'fa-shuttlecock' },
  'table-tennis': { name: 'BÓNG BÀN', icon: 'fa-table-tennis-paddle-ball' },
  esports: { name: 'ESPORTS', icon: 'fa-gamepad' }
};

function abs(url, base = XOICHE_BASE_URL) {
  if (!url) return '';
  if (/^(https?:)?\/\//i.test(url)) return url.startsWith('//') ? `https:${url}` : url;
  return `${base}${url.startsWith('/') ? '' : '/'}${url}`;
}

/** Giải mã payload Nuxt (devalue) -> object gốc. */
function decodeNuxtData(arr) {
  const memo = new Map();
  const WRAPPERS = new Set(['ShallowReactive', 'Reactive', 'Ref', 'ShallowRef', 'readonly', 'shallowReadonly']);
  const res = (i) => {
    if (typeof i !== 'number') return i;
    if (i < 0) return null; // undefined / null / NaN / Infinity -> null
    if (memo.has(i)) return memo.get(i);
    const v = arr[i];
    let out;
    if (Array.isArray(v)) {
      if (v.length === 2 && typeof v[0] === 'string' && WRAPPERS.has(v[0])) {
        out = res(v[1]);
      } else if (typeof v[0] === 'string' && ['Set', 'Map', 'Date', 'BigInt', 'RegExp', 'null', 'undefined'].includes(v[0])) {
        out = v[0] === 'Date' ? arr[v[1]] : null;
      } else {
        out = [];
        memo.set(i, out);
        for (const x of v) out.push(res(x));
      }
    } else if (v && typeof v === 'object') {
      out = {};
      memo.set(i, out);
      for (const k of Object.keys(v)) out[k] = res(v[k]);
    } else {
      out = v;
    }
    memo.set(i, out);
    return out;
  };
  return res(0);
}

/** Lấy mảng rawMatches từ chuỗi JSON của <script id="__NUXT_DATA__">. */
function parseNuxtPayload(jsonText) {
  const arr = JSON.parse(jsonText);
  const root = decodeNuxtData(arr);
  const home = root?.data?.['home-initial-data'];
  const list = home?.rawMatches || home?.fetchedMatches || [];
  // Chỉ giữ trận có BLV (trận không có BLV thì không có link phát).
  return Array.isArray(list) ? list.filter((r) => (r?.commentator_streams?.length || 0) > 0 || (r?.commentators?.length || 0) > 0) : [];
}

function extractPayloadFromHtml(html) {
  const m = String(html || '').match(/<script[^>]*id=["']__NUXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  return m ? m[1] : '';
}

const BROWSER_EVAL = `(() => { const s = document.getElementById('__NUXT_DATA__'); return s ? s.textContent : null; })()`;

async function fetchRawMatchesViaBrowser(base) {
  const { data, status, diagnostic } = await fetchPageGlobal(`${base}/`, { evalExpr: BROWSER_EVAL, timeoutMs: 28000, userAgent: UA });
  if (!data || typeof data !== 'string') {
    const d = diagnostic ? ` | title="${diagnostic.title}"` : '';
    throw new Error(`trình duyệt không đọc được __NUXT_DATA__ (HTTP ${status || 'n/a'})${d}`);
  }
  return parseNuxtPayload(data);
}

// FIX (19/11/2026 — "không lấy được link các trận live"): trang trận hiện có bộ chọn chất lượng FHD/HD/SD và nạp luồng SAU khi tải
// ("Đang tải luồng phát..."), nên link không còn chắc nằm ở field `stream_url` như trước. Bản cũ chỉ đọc đúng `stream_url` -> trận live
// không có link -> bị chuyển thành "Chờ BLV" rồi mất khỏi tab live. Giờ quét SÂU mọi field của BLV để tìm link .m3u8/.flv (field nào
// cũng được: hls_url, fhd/hd/sd, urls{...}, streams[...]), ưu tiên FHD > HD > SD, bỏ rtmp/backup/push.
const STREAM_URL_RE = /^(?:https?:)?\/\/[^\s"'<>]+?\.(?:m3u8|flv)(?:\?[^\s"'<>]*)?$|^(?:https?:)?\/\/[^\s"'<>]+\/index\.m3u8(?:\?[^\s"'<>]*)?$/i;
const BAD_KEY_RE = /(backup|rtmp|push|publish|ingest|thumb|avatar|logo|image|poster)/i;
function qualityRank(path) {
  const k = String(path).toLowerCase();
  if (/(fhd|1080|full_?hd)/.test(k)) return 0;
  if (/(^|[^a-z])hd([^a-z]|$)|720/.test(k)) return 1;
  if (/(^|[^a-z])sd([^a-z]|$)|480|360/.test(k)) return 3;
  return 2;
}
function extractStreamUrls(obj, base = XOICHE_BASE_URL) {
  const found = [];
  const walk = (v, path, depth) => {
    if (depth > 6 || v === null || v === undefined) return;
    if (typeof v === 'string') {
      const t = v.trim().replace(/\\\//g, '/');
      if (STREAM_URL_RE.test(t) || (/^\/[^\s]*\.m3u8(\?|$)/i.test(t))) found.push({ url: abs(t, base), path });
      return;
    }
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${path}[${i}]`, depth + 1)); return; }
    if (typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        if (BAD_KEY_RE.test(k)) continue;
        walk(x, `${path}.${k}`, depth + 1);
      }
    }
  };
  walk(obj, '', 0);
  const seen = new Set();
  return found
    .map((f, i) => ({ ...f, i, rank: qualityRank(f.path) + (/\.m3u8(\?|$)|\/index\.m3u8/i.test(f.url) ? 0 : 0.5) }))
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .filter((f) => (seen.has(f.url) ? false : (seen.add(f.url), true)))
    .map((f) => f.url);
}

// Link đã lấy được riêng cho từng trận (từ API chi tiết / trình duyệt) — nhớ vài phút để khỏi lấy lại mỗi lượt quét.
const resolvedLinks = new Map(); // `${id}` -> { at, urls: [], ok }
const RESOLVED_TTL_MS = 3 * 60 * 1000;
const RESOLVED_FAIL_TTL_MS = 60 * 1000;

function pickStreams(raw, base, { ignoreLiveFlag = false } = {}) {
  const list = [];
  const seen = new Set();
  const push = (c, bio) => {
    const who = c.commentator || c || {};
    const direct = abs(c?.stream_url || '', base);
    const urls = [];
    if (/^https?:\/\//i.test(direct) && /\.(?:m3u8|flv)(?:\?|$)/i.test(direct)) urls.push(direct);
    // stream_url có thể là link không đuôi (token) -> vẫn nhận như bản cũ nếu là http(s).
    else if (/^https?:\/\//i.test(direct)) urls.push(direct);
    for (const u of extractStreamUrls(c, base)) if (!urls.includes(u)) urls.push(u);
    const best = urls.find((u) => /\.m3u8(\?|$)|\/index\.m3u8/i.test(u)) || urls[0];
    if (!best || seen.has(best)) return;
    seen.add(best);
    const flv = c.flv_stream_url || who.flv_stream_url || urls.find((u) => /\.flv(\?|$)/i.test(u)) || '';
    list.push({
      id: `${raw.id}_${who.slug || who.id || list.length}`,
      name: who.name || bio || `BLV ${list.length + 1}`,
      avatar: who.avatar_url || who.avatar ? abs(who.avatar_url || who.avatar, base) : null,
      streamUrl: best,
      flvStreamUrl: flv ? abs(flv, base) : '',
      isLive: true,
      cdn: 'HLS',
      // Player của site đặt referrerpolicy="no-referrer" (xem trang trận) -> KHÔNG ép Referer; m3uPlaylist tự dò ([null, site]).
      referer: null
    });
  };
  for (const cs of raw.commentator_streams || []) {
    // BLV chưa bật phát (is_live=false) thì link chưa có luồng -> bỏ (trừ lượt dự phòng ignoreLiveFlag).
    if (cs?.is_live === false && !ignoreLiveFlag) continue;
    push(cs);
  }
  if (!list.length) {
    for (const c of raw.commentators || []) {
      if (c?.is_live === false && !ignoreLiveFlag) continue;
      push(c);
    }
  }
  // Link đã lấy riêng cho trận này (API chi tiết / trình duyệt) — gắn cho BLV đầu tiên của trận.
  if (!list.length) {
    const r = resolvedLinks.get(String(raw.id));
    if (r?.ok && r.urls.length) {
      const who = raw.commentator_streams?.[0]?.commentator || raw.commentators?.[0] || {};
      const best = r.urls.find((u) => /\.m3u8(\?|$)|\/index\.m3u8/i.test(u)) || r.urls[0];
      list.push({
        id: `${raw.id}_${who.slug || 'blv'}`,
        name: who.name || 'BLV',
        avatar: who.avatar_url || who.avatar ? abs(who.avatar_url || who.avatar, base) : null,
        streamUrl: best,
        flvStreamUrl: r.urls.find((u) => /\.flv(\?|$)/i.test(u)) || '',
        isLive: true,
        cdn: 'HLS',
        referer: null
      });
    }
  }
  return list;
}

function mapStatus(raw) {
  const s = String(raw.status || '').toLowerCase();
  const mt = String(raw.match_time || '').toUpperCase();
  if (s === 'live') return { isLive: true, isFinished: false, isUpcoming: false, isHalfTime: mt === 'HT' };
  if (s === 'finished' || s === 'ended' || s === 'cancelled' || s === 'postponed') return { isLive: false, isFinished: true, isUpcoming: false, isHalfTime: false };
  return { isLive: false, isFinished: false, isUpcoming: true, isHalfTime: false };
}


// Tên giải trên site trùng nhau giữa các nước ("Premier League" của Anh, Nga, Belarus...; "Serie A" của Ý, Brazil...).
// Bộ lọc giải nhỏ so khớp theo TÊN nên sẽ giữ nhầm giải nước khác. Dựa vào id giải (api_football_id của apifootball)
// để đổi tên giải lạ thành "<Nước> <tên giải>" -> bộ lọc loại đúng; giải gốc (Anh/Tây Ban Nha/Ý/Đức/Pháp) giữ nguyên tên.
const TOP5_LEAGUE_IDS = { 'premier league': 152, 'la liga': 302, 'serie a': 207, 'bundesliga': 175, 'ligue 1': 168 };
function leagueName(r) {
  const name = String(r.tournament_name || r.tournament?.name || '').trim();
  const want = TOP5_LEAGUE_IDS[name.toLowerCase()];
  const id = Number(r.tournament?.api_football_id);
  if (want && id && id !== want) {
    const c = String(r.home_team?.country || r.away_team?.country || '').trim();
    if (name.toLowerCase() === 'serie a' && /brazil/i.test(c)) return 'Brazilian Serie A';
    return c && c !== 'intl' ? `${c} ${name}` : `${name} (giai khac)`;
  }
  return name;
}

// FIX (13/11/2026 — "đến giờ live là danh sách trận bị mất"): site đổi status sang 'live' ngay giờ bóng lăn nhưng BLV chưa
// bật phát (commentator_streams[].is_live=false) -> không có link -> bị loại khỏi tab live, mà cũng không còn là
// 'scheduled' nên rơi khỏi tab sắp diễn ra => mất hẳn. Giờ trận live CHƯA có link phát được chuyển thành "chờ BLV"
// (isUpcoming + isWaiting) và tự thành LIVE ở lần quét sau khi BLV bật phát. Giữ tối đa XOICHE_WAIT_MAX_MIN phút (mặc định 180).
const WAIT_MAX_MS = (() => {
  const n = Number(process.env.XOICHE_WAIT_MAX_MIN);
  return (Number.isFinite(n) && n > 0 ? n : 180) * 60 * 1000;
})();

function buildMatches(rawList, base = XOICHE_BASE_URL) {
  const out = [];
  for (const r of rawList) {
    if (r?.id === undefined || r?.id === null || r?.is_active === false) continue;
    const sport = String(r.sport_slug || r.sport?.slug || 'football').toLowerCase();
    const info = SPORT_INFO[sport] || { name: String(r.sport_name || sport).toUpperCase(), icon: 'fa-futbol' };
    let status = mapStatus(r);
    // Tính link phát sớm: trận live mà chưa có link nào thì coi là "chờ BLV" thay vì vứt.
    let streamsNow = status.isLive ? pickStreams(r, base) : [];
    // Dự phòng: site báo trận 'live' nhưng cờ is_live của BLV sai/đổi nghĩa -> thử lại bỏ qua cờ đó (XOICHE_STRICT_LIVE=on để tắt).
    if (status.isLive && !streamsNow.length && String(process.env.XOICHE_STRICT_LIVE || '').toLowerCase() !== 'on') {
      streamsNow = pickStreams(r, base, { ignoreLiveFlag: true });
    }
    if (status.isLive && !streamsNow.length) {
      status = { isLive: false, isFinished: false, isUpcoming: true, isHalfTime: false, isWaiting: true };
    }

    const d = r.start_time ? new Date(r.start_time) : new Date();
    const ts = Number.isNaN(d.getTime()) ? new Date() : d;
    const timeStr = ts.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Ho_Chi_Minh' });
    const dateStr = ts.toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });
    const [, mo, da] = dateStr.split('-');

    const commentators = status.isLive ? streamsNow : [];
    const firstBlv = (r.commentators && r.commentators[0]) || r.commentator_streams?.[0]?.commentator;
    const blvSlug = firstBlv?.slug ? `?blv=${firstBlv.slug}` : '';
    const detailUrl = `${base}/truc-tiep/${r.slug}${blvSlug}`;
    const minute = status.isLive ? (status.isHalfTime ? 'HT' : String(r.match_time || '').replace(/'/g, '')) : '';
    const logo = (u) => abs(u, base);

    out.push({
      matchId: `xc_${r.id}`,
      originalId: String(r.id),
      slug: r.slug || '',
      detailUrl,
      source: 'xoiche',
      sport,
      sportName: info.name,
      sportIcon: info.icon,
      competition: { name: leagueName(r), logo: logo(r.tournament?.icon), icon: logo(r.tournament?.icon) },
      homeTeam: { name: r.home_team_name || r.home_team?.name || 'Home', logo: logo(r.home_team_logo || r.home_team?.logo) },
      awayTeam: { name: r.away_team_name || r.away_team?.name || 'Away', logo: logo(r.away_team_logo || r.away_team?.logo) },
      score: { home: Number(r.home_score) || 0, away: Number(r.away_score) || 0 },
      status: {
        ...status,
        name: status.isLive ? (status.isHalfTime ? 'HT' : 'LIVE') : (status.isFinished ? 'FT' : (status.isWaiting ? 'Chờ BLV' : 'Sắp diễn ra')),
        text: status.isLive ? (status.isHalfTime ? 'HT' : (minute ? `${minute}'` : 'LIVE')) : (status.isFinished ? 'Kết thúc' : (status.isWaiting ? 'Chờ BLV phát' : 'Sắp diễn ra')),
        elapsedTime: status.isLive && !status.isHalfTime ? minute : '',
        minutes: minute
      },
      stats: { halfTimeScore: `${Number(r.home_halftime_score) || 0}-${Number(r.away_halftime_score) || 0}`, corners: '0-0', yellowCards: '0-0' },
      matchTime: ts.getTime(),
      matchTimeTimestamp: ts.getTime(),
      timeFormatted: `${timeStr} - ${da}/${mo}`,
      dateStr,
      timeStr,
      isHot: !!r.is_hot,
      commentators,
      streamers: commentators,
      streamUrl: commentators[0] ? commentators[0].streamUrl : '',
      stream: {
        // Khác rỗng để trận chưa có link vẫn nằm trong playlist tĩnh (xem xoigac/phalang).
        liveUrl: detailUrl || base,
        streamerName: commentators[0] ? commentators[0].name : null,
        streamerAvatar: commentators[0] ? commentators[0].avatar : null
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
    flvUrl: c.flvStreamUrl || undefined,
    format: 'hls',
    cdn: c.cdn,
    quality: 'HD'
  }));
}


// --- Lịch các ngày sau (API JSON của site) -----------------------------------------------------
// GET /api/matches/?date=YYYY-MM-DD  ->  { count, next, previous, results: [ {trận}, ... ] }  (có phân trang,
// ~30 trận/trang; 1 ngày có thể hơn 300 trận vì site liệt kê cả giải nhỏ). Chỉ trận được gán BLV mới có
// commentator_streams[] -> chỉ giữ các trận đó. Trận "scheduled" chưa có luồng nên link phát chỉ có khi trận
// chuyển sang 'live' (lúc đó trang chủ trả về trận đó, trùng id nên được ưu tiên).
// Biến môi trường: XOICHE_DAYS (số ngày tới, mặc định 2; 0 = tắt), XOICHE_MAX_PAGES (trang tối đa / ngày, mặc định 14),
// XOICHE_SCHEDULE_TTL_MIN (phút giữ cache lịch, mặc định 10).
const intEnv = (name, def, min = 0) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= min ? Math.floor(n) : def;
};
const SCHEDULE_DAYS = intEnv('XOICHE_DAYS', 2);
const SCHEDULE_MAX_PAGES = intEnv('XOICHE_MAX_PAGES', 14, 1);
const SCHEDULE_TTL_MS = intEnv('XOICHE_SCHEDULE_TTL_MIN', 10, 1) * 60000;

const apiClient = createHttpClient(
  {
    baseURL: XOICHE_BASE_URL,
    headers: {
      'User-Agent': UA,
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'vi,en-US;q=0.9,en;q=0.8',
      'X-Site': 'xoiche',
      'X-Site-Id': 'xoiche'
    },
    timeout: 12000
  },
  { maxAttempts: 2 }
);

const hasBlv = (r) => (r?.commentator_streams?.length || 0) > 0 || (r?.commentators?.length || 0) > 0;

function vnDate(offsetDays) {
  const t = new Date(Date.now() + offsetDays * 86400000);
  return t.toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }); // YYYY-MM-DD
}

async function fetchApiPage(base, date, page) {
  const q = page > 1 ? `&page=${page}` : '';
  const { data } = await apiClient.get(`${base}/api/matches/?date=${date}${q}`, { headers: { Referer: `${base}/lich-truc-tiep` } });
  const body = typeof data === 'string' ? JSON.parse(data) : data;
  if (!body || !Array.isArray(body.results)) throw new Error('response không phải JSON danh sách trận');
  return body;
}

/** Lấy mọi trang của 1 ngày, giữ trận có BLV. Lỗi giữa chừng -> trả phần đã lấy được. */
async function fetchDayRaw(base, date) {
  const out = [];
  try {
    const first = await fetchApiPage(base, date, 1);
    out.push(...first.results.filter(hasBlv));
    const pageSize = first.results.length || 30;
    const totalPages = Math.min(Math.ceil((Number(first.count) || pageSize) / pageSize), SCHEDULE_MAX_PAGES);
    const pages = [];
    for (let p = 2; p <= totalPages; p++) pages.push(p);
    for (let i = 0; i < pages.length; i += 4) {
      const chunk = pages.slice(i, i + 4);
      const res = await Promise.all(chunk.map((p) => fetchApiPage(base, date, p).catch((e) => { console.error(`[xoiche] ${date} trang ${p}: ${e.message}`); return null; })));
      for (const b of res) if (b) out.push(...b.results.filter(hasBlv));
    }
    console.log(`[xoiche] lịch ${date}: ${out.length} trận có BLV / ${first.count} trận (${totalPages} trang)`);
  } catch (error) {
    console.error(`[xoiche] lịch ${date} lỗi: ${error.message}${error?.response?.status ? ` (HTTP ${error.response.status})` : ''}`);
  }
  return out;
}

let scheduleCache = { at: 0, raw: [], pending: null };

async function fetchScheduleRaw(base) {
  if (!SCHEDULE_DAYS) return [];
  if (scheduleCache.raw.length && Date.now() - scheduleCache.at < SCHEDULE_TTL_MS) return scheduleCache.raw;
  if (scheduleCache.pending) return scheduleCache.pending;
  scheduleCache.pending = (async () => {
    const days = [];
    for (let d = 1; d <= SCHEDULE_DAYS; d++) days.push(vnDate(d));
    const lists = await Promise.all(days.map((date) => fetchDayRaw(base, date)));
    const raw = lists.flat();
    // Lỗi toàn bộ (rỗng) thì giữ cache cũ thêm một lúc, tránh mất lịch vì 1 lần site chặn.
    const keep = raw.length ? raw : scheduleCache.raw;
    scheduleCache = { at: Date.now(), raw: keep, pending: null };
    return keep;
  })().catch((e) => { scheduleCache.pending = null; console.error(`[xoiche] lịch lỗi: ${e.message}`); return scheduleCache.raw; });
  return scheduleCache.pending;
}

function mergeRaw(primary, extra) {
  const seen = new Set(primary.map((r) => String(r.id)));
  return [...primary, ...extra.filter((r) => !seen.has(String(r.id)))];
}


// --- Lấy link cho trận live mà danh sách KHÔNG có link ----------------------------------------
// (1) Thử vài API JSON chi tiết trận (đoán đường dẫn, quét sâu tìm .m3u8/.flv), (2) mở trang trận bằng trình duyệt thật rồi bắt request
// .m3u8 mà player tự gọi. Có ngân sách thời gian/số trận để không kéo dài lượt quét (builder giới hạn 90s/nguồn).
const RESOLVE_BUDGET_MS = intEnv('XOICHE_RESOLVE_BUDGET_SEC', 55, 5) * 1000;
const BROWSER_MAX = intEnv('XOICHE_BROWSER_MAX', 4, 0);
let diagLogged = 0;

function slimForLog(v) {
  try { return JSON.stringify(v, (k, x) => (typeof x === 'string' && x.length > 90 ? `${x.slice(0, 90)}…` : x)).slice(0, 600); } catch { return ''; }
}

// FIX (19/11/2026): trang trận (SSR) CÓ SẴN dữ liệu đầy đủ trong <script id="__NUXT_DATA__"> ->
//   data['match-detail-<slug>'].match.commentator_streams[].stream_url = https://livecdn321.cdnfastter.xyz/live/live_xxx/index.m3u8?token=...&expires=...
// (danh sách trang chủ/lịch không kèm link có token nên trận live bị coi là thiếu link). Chỉ cần GET trang trận bằng axios, KHÔNG cần trình duyệt.
async function tryDetailPage(base, r) {
  const blv = r.commentator_streams?.[0]?.commentator?.slug || r.commentators?.[0]?.slug || '';
  const url = `${base}/truc-tiep/${r.slug}${blv ? `?blv=${blv}` : ''}`;
  try {
    const res = await client.get(url, { headers: { Referer: `${base}/` }, timeout: 12000, validateStatus: () => true });
    const html = typeof res.data === 'string' ? res.data : '';
    const payload = extractPayloadFromHtml(html);
    if (!payload) return { note: `trang trận HTTP ${res.status}, không có __NUXT_DATA__ (dài ${html.length})` };
    const root = decodeNuxtData(JSON.parse(payload));
    const data = root?.data || {};
    const key = Object.keys(data).find((k) => k.startsWith('match-detail-'));
    const m = key ? (data[key]?.match || data[key]) : null;
    if (!m) return { note: `__NUXT_DATA__ không có match-detail-* (keys: ${Object.keys(data).slice(0, 6).join(',')})` };
    const patch = { commentator_streams: m.commentator_streams || [], commentators: m.commentators || [] };
    const probe = { id: r.id, ...patch };
    if (!pickStreams(probe, base, { ignoreLiveFlag: true }).length) return { note: `trang trận có ${patch.commentator_streams.length} BLV nhưng không có link phát` };
    return { patch };
  } catch (e) {
    return { note: `lỗi tải trang trận: ${e.code || e.message}` };
  }
}

function applyResolvedPatch(r) {
  const hit = resolvedLinks.get(String(r.id));
  if (hit?.ok && hit.patch && Date.now() - hit.at < RESOLVED_TTL_MS) {
    r.commentator_streams = hit.patch.commentator_streams;
    r.commentators = hit.patch.commentators;
    return true;
  }
  return false;
}

async function tryDetailApis(base, r) {
  const id = r.id;
  const slug = r.slug;
  const cands = [
    `/api/matches/${id}/`,
    slug ? `/api/matches/${slug}/` : '',
    `/api/matches/${id}/streams/`,
    `/api/matches/${id}/stream/`,
    `/api/matches/${id}/live/`
  ].filter(Boolean);
  const notes = [];
  for (const path of cands) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const res = await apiClient.get(`${base}${path}`, { headers: { Referer: `${base}/truc-tiep/${slug || ''}` }, timeout: 6000, validateStatus: () => true });
      const body = typeof res.data === 'string' ? (() => { try { return JSON.parse(res.data); } catch { return null; } })() : res.data;
      notes.push(`${res.status} ${path}`);
      if (res.status >= 200 && res.status < 300 && body) {
        const urls = extractStreamUrls(body, base);
        if (urls.length) return { urls, via: `API ${path}`, notes };
      }
    } catch (e) {
      notes.push(`lỗi ${path}: ${e.code || e.message}`);
    }
  }
  return { urls: [], notes };
}

async function resolveOne(base, r, state) {
  const key = String(r.id);
  const hit = resolvedLinks.get(key);
  if (hit && Date.now() - hit.at < (hit.ok ? RESOLVED_TTL_MS : RESOLVED_FAIL_TTL_MS)) return;
  if (Date.now() > state.deadline) return;

  const page = await tryDetailPage(base, r);
  if (page.patch) {
    resolvedLinks.set(key, { at: Date.now(), ok: true, urls: [], patch: page.patch });
    r.commentator_streams = page.patch.commentator_streams;
    r.commentators = page.patch.commentators;
    console.log(`[xoiche] ${r.slug || r.id}: lấy link từ trang trận (__NUXT_DATA__), ${page.patch.commentator_streams.length} BLV`);
    return;
  }
  const apiRes = await tryDetailApis(base, r);
  apiRes.notes = [page.note, ...(apiRes.notes || [])].filter(Boolean);
  if (apiRes.urls.length) {
    resolvedLinks.set(key, { at: Date.now(), ok: true, urls: apiRes.urls, referer: `${base}/` });
    console.log(`[xoiche] ${r.slug || r.id}: lấy được ${apiRes.urls.length} link qua ${apiRes.via}`);
    return;
  }

  let browserNote = 'không dùng trình duyệt';
  if (process.env.XOICHE_BROWSER !== '0' && state.browserLeft > 0 && Date.now() < state.deadline) {
    state.browserLeft -= 1;
    const blv = r.commentator_streams?.[0]?.commentator?.slug || r.commentators?.[0]?.slug || '';
    const target = `${base}/truc-tiep/${r.slug}${blv ? `?blv=${blv}` : ''}`;
    try {
      const cap = await captureM3u8ViaBrowser(target, {
        timeoutMs: Math.min(22000, Math.max(6000, state.deadline - Date.now())),
        referer: `${base}/`,
        matchUrl: /^https?:\/\/(?:[^?#]*\.m3u8(?:[?#]|$)|[^?#]*\.flv(?:[?#]|$))/i
      });
      const good = (cap.found || []).filter((f) => f.status == null || f.status < 400).map((f) => f.url);
      if (good.length) {
        let refOrigin = `${base}/`;
        const h = cap.found.find((f) => f.url === good[0])?.headers || {};
        if (h.referer) refOrigin = h.referer;
        resolvedLinks.set(key, { at: Date.now(), ok: true, urls: good, referer: refOrigin });
        console.log(`[xoiche] ${r.slug || r.id}: trình duyệt bắt được ${good.length} link (${good[0].slice(0, 90)})`);
        return;
      }
      browserNote = `trình duyệt không bắt được .m3u8 (tiêu đề "${cap.title}", request thấy: ${(cap.seen || []).slice(0, 6).join(' | ') || 'không'})`;
    } catch (e) {
      browserNote = `trình duyệt lỗi: ${e.message}`;
    }
  }
  resolvedLinks.set(key, { at: Date.now(), ok: false, urls: [] });
  if (diagLogged < 3) {
    diagLogged += 1;
    const cs = r.commentator_streams?.[0] || r.commentators?.[0] || null;
    console.warn(`[xoiche] KHÔNG lấy được link trận live ${r.slug || r.id}: API chi tiết [${(apiRes.notes || []).join(', ')}]; ${browserNote}; keys BLV=${cs ? Object.keys(cs).join(',') : 'không có BLV'}; mẫu=${slimForLog(cs)}`);
  }
}

/** Với trận 'live' mà danh sách không có link phát -> lấy link riêng (gắn vào resolvedLinks, pickStreams sẽ dùng). */
async function resolveMissingLinks(rawList, base) {
  for (const r of rawList) { if (String(r?.status || '').toLowerCase() === 'live' && !pickStreams(r, base, { ignoreLiveFlag: true }).length) applyResolvedPatch(r); }
  const need = rawList.filter((r) => String(r?.status || '').toLowerCase() === 'live'
    && hasBlv(r) && !pickStreams(r, base, { ignoreLiveFlag: true }).length && !(resolvedLinks.get(String(r.id))?.ok));
  if (!need.length) return;
  diagLogged = 0;
  const state = { deadline: Date.now() + RESOLVE_BUDGET_MS, browserLeft: BROWSER_MAX };
  console.log(`[xoiche] ${need.length} trận live thiếu link trong danh sách -> thử API chi tiết/trình duyệt (tối đa ${BROWSER_MAX} trận mở trình duyệt)`);
  let next = 0;
  const worker = async () => {
    while (next < need.length) {
      const r = need[next]; next += 1;
      // eslint-disable-next-line no-await-in-loop
      await resolveOne(base, r, state).catch((e) => console.error(`[xoiche] resolve ${r.id}: ${e.message}`));
    }
  };
  await Promise.all([worker(), worker()]);
}

let preferredBase = '';
let homepageCache = { at: 0, matches: null, pending: null };

class XoicheService {
  async fetchHomepageMatches() {
    const now = Date.now();
    if (homepageCache.matches && now - homepageCache.at < HOMEPAGE_TTL_MS) return homepageCache.matches;
    if (homepageCache.pending) return homepageCache.pending;
    homepageCache.pending = this._fetchUncached()
      .then((matches) => {
        homepageCache = { at: Date.now(), matches, pending: null };
        return matches;
      })
      .catch((error) => {
        const stale = homepageCache.matches;
        const age = Date.now() - homepageCache.at;
        // Lỗi tạm thời (Cloudflare/timeout) -> dùng lại danh sách tốt gần nhất (tối đa 10 phút) thay vì trả rỗng.
        if (stale && age <= STALE_MAX_MS) {
          console.error(`[xoiche] quét lỗi (${error.message}) — dùng lại danh sách cũ ${Math.round(age / 1000)}s`);
          homepageCache = { at: homepageCache.at, matches: stale, pending: null };
          return stale;
        }
        homepageCache.pending = null;
        throw error;
      });
    return homepageCache.pending;
  }

  async _fetchUncached() {
    let lastError = null;
    const bases = preferredBase ? [preferredBase, ...XOICHE_BASES.filter((b) => b !== preferredBase)] : XOICHE_BASES;
    // Lượt 1: axios (nhanh).
    for (const base of bases) {
      try {
        const { data: html } = await client.get(`${base}/`);
        const payload = extractPayloadFromHtml(html);
        if (!payload) throw new Error('không có __NUXT_DATA__');
        const raw = parseNuxtPayload(payload);
        if (!raw.length) throw new Error('rawMatches rỗng');
        preferredBase = base;
        const extra = await fetchScheduleRaw(base);
        console.log(`[xoiche] OK ${base} (axios): ${raw.length} trận trang chủ + ${extra.length} trận lịch các ngày sau`);
        const merged = mergeRaw(raw, extra);
        await resolveMissingLinks(merged, base);
        return buildMatches(merged, base);
      } catch (error) {
        lastError = error;
        console.error(`[xoiche] ${base} lỗi: ${error.message}`);
      }
    }
    // Lượt 2: trình duyệt thật (nếu bị Cloudflare/WAF chặn). Tắt bằng XOICHE_BROWSER=0.
    if (process.env.XOICHE_BROWSER !== '0') {
      for (const base of bases) {
        try {
          console.warn(`[xoiche] axios lỗi -> thử trình duyệt thật cho ${base}`);
          const raw = await fetchRawMatchesViaBrowser(base);
          if (!raw.length) throw new Error('rawMatches rỗng');
          preferredBase = base;
          const extra = await fetchScheduleRaw(base);
          const merged = mergeRaw(raw, extra);
          await resolveMissingLinks(merged, base);
          return buildMatches(merged, base);
        } catch (error) {
          lastError = error;
          console.error(`[xoiche] trình duyệt ${base} lỗi: ${error.message}`);
        }
      }
    }
    throw lastError || new Error('không có domain Xôi Chè nào dùng được');
  }

  async getAllMatchesByTab(tab, sport = 'all') {
    try {
      const all = await this.fetchHomepageMatches();
      let filtered = all.filter((m) => !m.status.isFinished);
      if (tab === 'live') filtered = filtered.filter((m) => m.status.isLive);
      else if (tab === 'upcoming') filtered = filtered.filter((m) => m.status.isUpcoming);
      if (sport !== 'all') filtered = filtered.filter((m) => m.sport === sport);

      filtered = filterMinorLeagues(filtered, 'xoiche');
      filtered = filtered.filter((m) => !(m.status.isLive && isStaleLiveMatch(m)));
      // Trận live mà không có BLV nào đang phát/không có link thì bỏ (quy tắc chung của project).
      filtered = filtered.filter((m) => !m.status.isLive || m.commentators.length > 0);
      filtered = filtered.filter((m) => !m.status.isWaiting || Date.now() - m.matchTimeTimestamp <= WAIT_MAX_MS);

      return { matches: filtered.map(({ _liveCommentators, _base, ...rest }) => rest), hasMore: false, totalCount: filtered.length };
    } catch (error) {
      console.error(`Error fetching Xoiche tab ${tab}:`, error.message);
      return { matches: [], hasMore: false, totalCount: 0 };
    }
  }

  async getStreamLinks(matchId) {
    try {
      const all = await this.fetchHomepageMatches();
      const clean = String(matchId).replace(/^xc_/, '');
      const match = all.find((m) => m.originalId === clean || m.matchId === matchId || m.slug === matchId);
      if (!match) return [];
      const list = (match._liveCommentators || []).slice(0, MAX_RESOLVE_PER_MATCH);
      console.log(`[xoiche] ${matchId}: ${list.length} BLV có link HLS`);
      return mapStreams(list);
    } catch (error) {
      console.error('Error fetching Xoiche stream links:', error.message);
      return [];
    }
  }
}

const xoicheService = new XoicheService();
export default xoicheService;
export { parseNuxtPayload, decodeNuxtData, buildMatches };
