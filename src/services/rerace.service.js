import { load as cheerioLoad } from 'cheerio';
import { createHttpClient } from '@/src/utils/httpClient';
import { captureM3u8ViaBrowser } from '@/src/utils/browserFetch';

// Nguồn Rerace (rerace.net) — trang F1 + thể thao khác, KHÔNG tự host video mà nhúng player bên thứ ba.
// Thêm 08/11/2026. Dữ liệu lấy từ 3 chỗ (đã thấy trong Network của trang /watch/?e=f1-2026-r20&s=f1-2026-r20-src175):
//   1) Trang chủ https://www.rerace.net/  (HTML tĩnh, ĐÃ XÁC NHẬN từ file nguon_F1.txt):
//        - Chặng F1 đang tới: <div data-hero data-sig="f1-2026-r19|..."> + các <li class="session-card" data-start data-end> (ms epoch)
//        - Thẻ trận: <article data-match="31121"> link /watch/?m=31121&s=football, chip giải, <time datetime>, "N sources"
//   2) https://weelo.live/feed/events.json   (danh sách sự kiện/nguồn phát — CHƯA THẤY nội dung, parser đọc "chịu lỗi")
//   3) https://api.ppv.st/api/streams        (danh sách trận ppv, dạng {streams:[{category,streams:[{id,name,iframe,uri_name,starts_at,ends_at,always_live}]}]})
//   Player: https://weelo.live/<hash>/index.html + https://weelo.live/players/state.json (link m3u8 có thể nằm ở đây — CHƯA XÁC NHẬN).
// CHƯA XÁC NHẬN: cấu trúc JSON thật của events.json/state.json và CDN có đòi Referer không.
// -> getStreamLinks() quét mọi m3u8 tìm được trong các trang/JSON trên; nếu không ra thì trả [] (không bịa link).
const RERACE_BASE = String(process.env.RERACE_DOMAIN || process.env.RERACE_BASE_URL || 'https://www.rerace.net').replace(/\/+$/, '');
const WEELO_BASE = String(process.env.RERACE_WEELO_DOMAIN || 'https://weelo.live').replace(/\/+$/, '');
// Trang player weelo.live/<hash>/index.html được trình duyệt gọi với Origin/Referer = weellz.live (bắt từ DevTools 08/11/2026);
// feed/events.json + api.ppv.st thì gửi Origin/Referer = rerace.net.
const PLAYER_ORIGIN = String(process.env.RERACE_PLAYER_ORIGIN || 'https://weellz.live').replace(/\/+$/, '');
const PPV_API = String(process.env.RERACE_PPV_API || 'https://api.ppv.st/api/streams');
// Mặc định: F1/đua xe + bóng đá (trận ppv). Đổi bằng RERACE_SPORTS=f1,football,fight,hockey,... hoặc all. Bóng rổ luôn bị bỏ (như site).
const UPCOMING_HOURS_OTHER = Math.max(1, Number(process.env.RERACE_UPCOMING_HOURS) || 24); // F1 luôn giữ cả cuối tuần; môn khác chỉ N giờ tới
// Số server/trận: F1 lấy TẤT CẢ (MAX_STREAMS); bóng đá & môn khác chỉ lấy 1 link chất lượng tốt nhất (RERACE_MAX_SERVERS_OTHER, mặc định 1).
const MAX_SERVERS_OTHER = Math.max(1, Number(process.env.RERACE_MAX_SERVERS_OTHER) || 1);
const INCLUDE_247 = process.env.RERACE_INCLUDE_247 === '1'; // kênh 24/7 (always_live) mặc định bỏ
const SPORTS_ENABLED = String(process.env.RERACE_SPORTS || 'f1,motor-sports,football').toLowerCase().split(/[,\s]+/).filter(Boolean);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const TTL_MS = 45000;
// FIX (13/11/2026 — "[rerace] rr_32157/32158/32159: 0 link phát" dù có 3 trận live): trang embed bóng đá (iframe ppv)
// dựng player bằng JS và giấu link m3u8 (mã hoá/gọi API sau khi chạy script) -> quét HTML tĩnh bằng axios không thấy
// gì, hoặc bị chặn từ IP máy chủ. Khi quét tĩnh KHÔNG ra link thì mở trang embed bằng Chromium thật (như người xem,
// gửi Referer rerace.net), tự bấm Play và BẮT request m3u8 mà player gọi — kèm Referer/Origin thật để proxy dùng lại.
// Tắt bằng RERACE_BROWSER=0; số lần mở trình duyệt tối đa / trận: RERACE_BROWSER_TRIES (mặc định 2).
const BROWSER_ON = process.env.RERACE_BROWSER !== '0';
const BROWSER_TRIES = Math.max(0, Number(process.env.RERACE_BROWSER_TRIES) || 2);
const BROWSER_TIMEOUT_MS = Math.max(5000, Number(process.env.RERACE_BROWSER_TIMEOUT_MS) || 14000);
const STATIC_SCAN_LIMIT_MS = 9000; // quét tĩnh (axios) quá ngần này thì bỏ qua, chuyển sang trình duyệt
const withTimeout = (promise, ms, fallback) => {
  let timer;
  return Promise.race([
    Promise.resolve(promise).catch(() => fallback),
    new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), ms); })
  ]).finally(() => clearTimeout(timer));
};
const MAX_STREAMS = Math.max(1, Number(process.env.RERACE_MAX_SERVERS) || 24); // lấy TẤT CẢ server của 1 trận (mặc định tối đa 24)

const client = createHttpClient(
  { headers: { 'User-Agent': UA, Accept: 'text/html,application/json,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9' }, timeout: 12000 },
  { maxAttempts: 2 }
);

const SPORT_INFO = {
  f1: { name: 'F1', icon: 'fa-flag-checkered' },
  football: { name: 'BÓNG ĐÁ', icon: 'fa-futbol' },
  fight: { name: 'ĐỐI KHÁNG', icon: 'fa-hand-fist' },
  hockey: { name: 'KHÚC CÔN CẦU', icon: 'fa-hockey-puck' },
  baseball: { name: 'BÓNG CHÀY', icon: 'fa-baseball' },
  'american-football': { name: 'BÓNG BẦU DỤC', icon: 'fa-football' }
};

const CATEGORY_MAP = { soccer: 'football', 'ice-hockey': 'hockey', motorsports: 'motor-sports', motorsport: 'motor-sports', 'motor-sports': 'motor-sports',
  'combat-sports': 'fight', fighting: 'fight', boxing: 'fight', mma: 'fight', ufc: 'fight', racing: 'motor-sports', 'australian-football': 'afl' };
const BASKETBALL_RE = /\b(nba|wnba|basketball|euroleague|eurocup|ncaab|march madness|nbl)\b/i;
const normSport = (s) => {
  const v0 = String(s || '').toLowerCase();
  const v = CATEGORY_MAP[v0] || v0;
  return v === 'motor-sports' || v === 'motorsport' || v === 'motorsports' ? 'f1' : v;
};
const sportAllowed = (s) => SPORTS_ENABLED.includes('all') || SPORTS_ENABLED.map(normSport).includes(normSport(s));
const abs = (u, base = RERACE_BASE) => { try { return new URL(u, `${base}/`).toString(); } catch { return ''; } };
const clean = (u) => String(u || '').replace(/\\u0026/g, '&').replace(/\\\//g, '/').replace(/&amp;/g, '&');

function statusFor(startMs, endMs, now = Date.now()) {
  if (startMs && endMs && now >= startMs && now <= endMs) return 'live';
  if (startMs && now < startMs) return 'upcoming';
  if (endMs && now > endMs) return 'finished';
  return startMs && now >= startMs && now - startMs < 3 * 3600000 ? 'live' : 'upcoming';
}

function buildMatch({ id, title, sport, startMs, endMs, league, thumb, watchUrl, sources = 0, eventId = '', session = '' }) {
  const st = statusFor(startMs, endMs);
  const isLive = st === 'live';
  const d = new Date(startMs || Date.now());
  const timeStr = d.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Ho_Chi_Minh' });
  const dateStr = d.toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });
  const [, mo, da] = dateStr.split('-');
  const info = SPORT_INFO[sport] || { name: String(sport).toUpperCase(), icon: 'fa-futbol' };
  const t0 = String(title);
  const atM = /^(.+?)\s+at\s+(.+)$/i.exec(t0);
  const vsM = /^(.+?)\s+(?:vs\.?|v)\s+(.+)$/i.exec(t0);
  const home = atM ? atM[2] : vsM ? vsM[1] : t0;
  const away = atM ? atM[1] : vsM ? vsM[2] : session || '';
  return {
    matchId: `rr_${id}`,
    originalId: String(id),
    eventId,
    slug: String(id),
    detailUrl: watchUrl,
    source: 'rerace',
    sport,
    sportName: info.name,
    sportIcon: info.icon,
    competition: { name: league || info.name, logo: '', icon: '' },
    homeTeam: { name: home, logo: thumb || '' },
    awayTeam: { name: away, logo: '' },
    score: { home: 0, away: 0 },
    status: {
      isLive, isFinished: st === 'finished', isUpcoming: st === 'upcoming', isHalfTime: false,
      name: isLive ? 'LIVE' : st === 'finished' ? 'FT' : 'Sắp diễn ra',
      text: isLive ? 'LIVE' : st === 'finished' ? 'Kết thúc' : 'Sắp diễn ra',
      elapsedTime: '', minutes: ''
    },
    stats: { halfTimeScore: '0-0', corners: '0-0', yellowCards: '0-0' },
    matchTime: startMs || Date.now(),
    matchTimeTimestamp: startMs || Date.now(),
    timeFormatted: `${timeStr} - ${da}/${mo}`,
    dateStr, timeStr,
    isHot: sport === 'f1',
    sourceCount: sources,
    commentators: [], streamers: [],
    streamUrl: '',
    stream: { liveUrl: watchUrl, streamerName: null, streamerAvatar: null },
    odds: null
  };
}

/** Trang chủ -> chặng F1 (từng session) + thẻ trận. Đã đối chiếu với file nguon_F1.txt. */
export function parseHomepage(html) {
  const $ = cheerioLoad(String(html || ''));
  const out = [];

  const hero = $('[data-hero]').first();
  if (hero.length) {
    const eventId = String(hero.attr('data-sig') || '').split('|')[0] || 'f1';
    const eventName = hero.find('h2').first().text().trim() || 'Formula 1';
    const watchUrl = abs(hero.find('a[href*="/watch/?e="]').first().attr('href') || `/watch/?e=${eventId}`);
    hero.find('li.session-card').each((i, el) => {
      const startMs = Number($(el).attr('data-start'));
      const endMs = Number($(el).attr('data-end'));
      const session = $(el).find('span.truncate').first().text().trim() || `Session ${i + 1}`;
      if (!startMs) return;
      out.push(buildMatch({
        id: `${eventId}-s${i + 1}`, eventId, session, sport: 'f1', league: 'Formula 1',
        title: `F1 ${eventName} - ${session}`, startMs, endMs: endMs || startMs + 2 * 3600000, watchUrl, sources: 0
      }));
    });
  }

  $('article[data-match]').each((_, el) => {
    const a = $(el).find('h3 a').first();
    const href = a.attr('href') || '';
    const sport = normSport((href.match(/[?&]s=([^&]+)/) || [])[1] || '');
    const t = $(el).find('time').first().attr('datetime');
    const startMs = t ? Date.parse(t) : 0;
    const srcN = Number(($(el).find('p').last().text().match(/(\d+)\s+sources?/i) || [])[1]) || 0;
    out.push(buildMatch({
      id: $(el).attr('data-match'), sport: sport || 'other', title: a.text().trim(),
      league: $(el).find('.chip').first().text().trim(), thumb: $(el).find('img').first().attr('src') || '',
      startMs, endMs: startMs + 3 * 3600000, watchUrl: abs(clean(href)), sources: srcN
    }));
  });
  return out;
}

/** Origin/Referer đúng theo từng loại URL (khớp request thật của trình duyệt). */
function headersFor(url, referer) {
  const isPlayerPage = url.startsWith(WEELO_BASE) && !/\/(feed|players)\//.test(url);
  if (isPlayerPage) return { Origin: PLAYER_ORIGIN, Referer: `${PLAYER_ORIGIN}/` };
  const h = { Origin: RERACE_BASE, Referer: referer || `${RERACE_BASE}/` };
  if (url.startsWith(RERACE_BASE)) delete h.Origin; // cùng origin: trình duyệt không gửi Origin cho GET
  return h;
}
const getText = async (url, referer) => {
  const { data } = await client.get(url, { headers: headersFor(url, referer), responseType: 'text', transformResponse: (r) => r });
  return typeof data === 'string' ? data : JSON.stringify(data);
};

const M3U8_RE = /https?:\\?\/\\?\/(?:[^\s"'<>\\]|\\\/|\\u0026)+?\.m3u8(?:\?(?:[^\s"'<>\\]|\\\/|\\u0026)*)?/gi;
export const findM3u8 = (text) => [...new Set((String(text || '').match(M3U8_RE) || []).map(clean))];

// ---- Trang embed bóng đá (taifood-blog.asia/embed/<giải>/<ngày>/<nhà>-<khách>, iframe của api.ppv.st) ----
// CHƯA có mã nguồn thật của trang embed (site chặn bot) -> quét "chịu lỗi" theo nhiều dạng thường gặp:
//   m3u8 tuyệt đối / thoát \/ / tương đối ("/hls/x.m3u8"), chuỗi base64 (atob("...") hoặc "aHR0c..."), <iframe src>, <script src> cùng site, endpoint fetch()/api trong script.
// Kết quả thật để đối chiếu: GET /api/rerace/debug?id=<matchId> (trả trace từng bước, không cần dán mã nguồn).
const EMBED_ORIGIN = String(process.env.RERACE_EMBED_ORIGIN || 'https://taifood-blog.asia').replace(/\/+$/, '');
const SKIP_SCRIPT_RE = /googletagmanager|google-analytics|googlesyndication|doubleclick|cloudflare|cloudflareinsights|jquery|bootstrap|fontawesome|gstatic|googleapis|jsdelivr|cdnjs|unpkg|histats|adsbygoogle|disqus|facebook|twitter|clarity\.ms|yandex|hotjar/i;
const REL_M3U8_RE = /["'`]((?:\.{0,2}\/)[^"'`\s<>\\]+?\.m3u8(?:\?[^"'`\s<>\\]*)?)["'`]/gi;
const ATOB_RE = /atob\(\s*["'`]([A-Za-z0-9+/=_-]{16,})["'`]\s*\)/g;
const B64_URL_RE = /["'`](aHR0c[A-Za-z0-9+/=_-]{12,})["'`]/g;
const API_HINT_RE = /(?:fetch|axios\.get|\$\.get|\$\.getJSON)\s*\(\s*["'`]([^"'`\s]+)["'`]|\.open\(\s*["'`]GET["'`]\s*,\s*["'`]([^"'`\s]+)["'`]/g;
const resolveUrl = (u, base) => { try { return new URL(u, base).toString(); } catch { return ''; } };
const b64dec = (v) => { try { return Buffer.from(String(v).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'); } catch { return ''; } };

export function extractM3u8(text, baseUrl = RERACE_BASE) {
  const src = clean(text);
  const out = new Set(findM3u8(src));
  for (const m of src.matchAll(REL_M3U8_RE)) { const u = resolveUrl(m[1], baseUrl); if (u) out.add(u); }
  for (const re of [ATOB_RE, B64_URL_RE]) {
    for (const m of src.matchAll(re)) {
      const dec = b64dec(m[1]);
      if (/m3u8/i.test(dec)) findM3u8(clean(dec)).forEach((u) => out.add(u));
    }
  }
  return [...out];
}

/** Token a-p của luồng weelo trong URL iframe: ?stream=<token> hoặc /<token>/... */
export function weeloTokenOf(u) {
  try {
    const x = new URL(u);
    const q = x.searchParams.get('stream');
    if (q && /^[a-p]{16,}$/.test(q)) return q;
    const m = /\/([a-p]{16,})(?:\/|$)/.exec(x.pathname);
    return m ? m[1] : '';
  } catch { return ''; }
}

/** Quét 1 trang embed (đệ quy tối đa 2 cấp, tối đa `budget.n` request). trace[] ghi lại từng bước để debug. */
async function scanEmbed(url, referers, { depth = 0, visited = new Set(), budget = { n: 8 }, trace = [] } = {}) {
  const found = new Set();
  if (depth > 2 || budget.n <= 0 || visited.has(url)) return [];
  visited.add(url);
  let html = '';
  for (const ref of [...new Set(referers)]) {
    if (budget.n <= 0) break;
    budget.n -= 1;
    try {
      html = await getText(url, ref);
      trace.push({ url, referer: ref, ok: true, bytes: html.length });
      if (html) break;
    } catch (e) { trace.push({ url, referer: ref, ok: false, error: e.response?.status ? `HTTP ${e.response.status}` : e.message }); }
  }
  if (!html) return [];
  extractM3u8(html, url).forEach((u) => found.add(u));
  if (found.size) { trace.push({ url, m3u8: [...found].slice(0, 5) }); return [...found]; }

  const $ = cheerioLoad(html);
  const origin = (() => { try { return new URL(url).origin; } catch { return ''; } })();
  const nextRefs = [`${origin}/`, ...referers];
  const iframes = $('iframe[src]').map((_, e) => resolveUrl($(e).attr('src'), url)).get().filter(Boolean).slice(0, 2);
  const scripts = $('script[src]').map((_, e) => resolveUrl($(e).attr('src'), url)).get()
    .filter((u) => u && !SKIP_SCRIPT_RE.test(u)).slice(0, 4);
  const apis = [];
  for (const m of clean(html).matchAll(API_HINT_RE)) {
    const u = resolveUrl(m[1] || m[2], url);
    if (u && u.startsWith(origin) && !/\.(css|js|png|jpe?g|gif|svg|ico|woff2?)(\?|$)/i.test(u)) apis.push(u);
  }
  for (const next of [...iframes, ...scripts, ...new Set(apis)].slice(0, 6)) {
    for (const u of await scanEmbed(next, nextRefs, { depth: depth + 1, visited, budget, trace })) found.add(u);
    if (found.size) break;
  }
  if (!found.size) trace.push({ url, m3u8: [], hint: `không thấy m3u8 (iframe=${iframes.length}, script=${scripts.length}, api=${apis.length})` });
  return [...found];
}

let cache = { at: 0, matches: null, pending: null };
const streamObjs = new Map(); // eventId -> [{id,label,language,url(iframe)}]
const sourceHints = new Map(); // eventId/matchId -> [url trang player] lấy từ events.json / ppv

/** Gom mọi URL http(s) trong 1 giá trị bất kỳ (chuỗi/mảng/object). */
function collectUrls(v, out = []) {
  if (!v) return out;
  if (typeof v === 'string') { if (/^https?:\/\//i.test(v)) out.push(v); return out; }
  if (Array.isArray(v)) { v.forEach((x) => collectUrls(x, out)); return out; }
  if (typeof v === 'object') Object.values(v).forEach((x) => collectUrls(x, out));
  return out;
}

const WEELO_SERIES = String(process.env.RERACE_SERIES || 'f1').toLowerCase().split(/[,\s]+/).filter(Boolean);

/**
 * https://weelo.live/feed/events.json — ĐÃ XÁC NHẬN cấu trúc (mẫu 08/11/2026):
 *   { generated_at, count, live, events: [ { id:"f2-2026-r5", title, series:"f1|f2|f3|supercup|general", circuit, country,
 *       sessions:[{key,name,startsAt,endsAt}], streams:[ ... ] } ] }
 * Mỗi session -> 1 trận. `streams[]` (mẫu chưa có phần tử nào nên chưa biết shape) được quét lấy mọi URL làm "gợi ý" player.
 * Mặc định chỉ lấy series f1 (đổi bằng RERACE_SERIES=f1,f2,f3,supercup,general hoặc all).
 */
async function loadWeeloEvents() {
  const out = [];
  try {
    const raw = JSON.parse(await getText(`${WEELO_BASE}/feed/events.json`));
    for (const ev of Array.isArray(raw?.events) ? raw.events : []) {
      const series = String(ev?.series || '').toLowerCase();
      if (!ev?.id || !(WEELO_SERIES.includes('all') || WEELO_SERIES.includes(series))) continue;
      // streams[] (xác nhận từ app JS): { id:"...-src175", label, language, url:<iframe https>, kind:"iframe" }
      const evStreams = (Array.isArray(ev.streams) ? ev.streams : [])
        .filter((x) => x && typeof x.url === 'string' && /^https?:\/\/[^\s"'<>]+$/i.test(x.url) && (x.kind || 'iframe') === 'iframe')
        .map((x) => ({ id: String(x.id || ''), label: String(x.label || ''), language: String(x.language || ''), url: x.url }));
      if (evStreams.length) streamObjs.set(String(ev.id), evStreams);
      const evUrls = [...new Set([...evStreams.map((x) => x.url), ...collectUrls(ev.streams)])];
      if (evUrls.length) sourceHints.set(String(ev.id), evUrls);
      const watchUrl = `${RERACE_BASE}/watch/?e=${ev.id}`;
      for (const se of Array.isArray(ev.sessions) ? ev.sessions : []) {
        const startMs = Date.parse(se?.startsAt);
        const endMs = Date.parse(se?.endsAt) || startMs + 3600000;
        if (!startMs) continue;
        const sid = `${ev.id}__${se.key || se.name}`;
        if (evUrls.length) sourceHints.set(sid, evUrls);
        out.push(buildMatch({
          id: sid, eventId: String(ev.id), session: se.name, sport: series === 'f1' ? 'f1' : normSport(series),
          league: ({ f1: 'Formula 1', f2: 'Formula 2', f3: 'Formula 3', supercup: 'Porsche Supercup', general: 'F1 Academy' })[series] || series.toUpperCase(),
          title: `${ev.title || ev.id} - ${se.name}`, startMs, endMs, watchUrl, sources: evUrls.length
        }));
      }
    }
  } catch (e) { console.error(`[rerace] events.json lỗi: ${e.message}`); }
  return out;
}

async function loadPpv() {
  const out = [];
  try {
    const raw = JSON.parse(await getText(PPV_API));
    for (const cat of raw?.streams || []) {
      for (const s of cat?.streams || []) {
        if (!s?.id) continue;
        const catSlug = String(cat.category || s.category_name || '').toLowerCase().trim().replace(/\s+/g, '-');
        if (catSlug === 'basketball' || BASKETBALL_RE.test(`${s.name || ''} ${s.tag || ''}`)) continue;
        if (Number(s.always_live) && !INCLUDE_247) continue;
        const sport = normSport(catSlug);
        if (!sportAllowed(sport)) continue;
        const startMs = (Number(s.starts_at) || 0) * 1000;
        const endMs = (Number(s.ends_at) || 0) * 1000 || startMs + 3 * 3600000;
        // Mỗi trận: [chính, ...substreams] = các server (app JS: sources = [t, ...t.substreams]); url = iframe https.
        const objs = [s, ...(Array.isArray(s.substreams) ? s.substreams : [])]
          .filter((x) => x && typeof x.iframe === 'string' && /^https?:\/\/[^\s"'<>]+$/i.test(x.iframe))
          .map((x) => ({ id: String(x.id || ''), label: String(x.source_tag || x.tag || ''), language: String(x.locale || ''), url: x.iframe }));
        if (objs.length) { streamObjs.set(String(s.id), objs); sourceHints.set(String(s.id), objs.map((o) => o.url)); }
        out.push(buildMatch({ id: s.id, sport, title: s.name || s.tag || `ppv ${s.id}`, league: s.tag && !/24\/7/.test(s.tag) ? s.tag : '', thumb: s.poster, startMs, endMs, watchUrl: `${RERACE_BASE}/watch/?m=${s.id}&s=${sport}`, sources: objs.length }));
      }
    }
  } catch (e) { console.error(`[rerace] ppv lỗi: ${e.message}`); }
  return out;
}

class ReraceService {
  async fetchAll() {
    if (cache.matches && Date.now() - cache.at < TTL_MS) return cache.matches;
    if (cache.pending) return cache.pending;
    cache.pending = (async () => {
      const [html, events, ppv] = await Promise.all([
        getText(`${RERACE_BASE}/`).catch((e) => { console.error(`[rerace] trang chủ lỗi: ${e.message}`); return ''; }),
        loadWeeloEvents(),
        loadPpv()
      ]);
      // F1 xuất hiện ở CẢ 2 nguồn: weelo events.json (session) và ppv (category Motorsports, tag "Formula 1", vd "São Paulo Grand Prix - Race"
      // với ~16 server theo ngôn ngữ). Gộp: server ppv được thêm vào session weelo cùng giờ (±45 phút) rồi bỏ bản ppv -> không trùng kênh.
      const f1Sessions = events.filter((e) => e.sport === 'f1');
      const ppvKept = [];
      for (const pm of ppv) {
        const twin = pm.sport === 'f1' && /formula\s*1|^f1$/i.test(pm.competition?.name || '')
          ? f1Sessions.find((e) => Math.abs(e.matchTime - pm.matchTime) <= 45 * 60000 && !/f2|f3|academy/i.test(e.competition?.name || ''))
          : null;
        if (!twin) { ppvKept.push(pm); continue; }
        const extra = streamObjs.get(pm.originalId) || [];
        const cur = streamObjs.get(twin.originalId) || [];
        const have = new Set(cur.map((o) => o.url));
        streamObjs.set(twin.originalId, [...cur, ...extra.filter((o) => !have.has(o.url))]);
        twin.sourceCount = (streamObjs.get(twin.originalId) || []).length;
      }
      // events.json là nguồn chính cho F1; session trong hero trang chủ chỉ là dự phòng khi events.json lỗi/rỗng.
      const home = parseHomepage(html).filter((m) => !(events.length && m.eventId));
      const seen = new Set();
      const all = [...events, ...ppvKept, ...home].filter((m) => {
        if (!sportAllowed(m.sport) || seen.has(m.originalId)) return false;
        seen.add(m.originalId);
        return true;
      });
      console.log(`[rerace] ${all.length} trận (${all.filter((m) => m.status.isLive).length} live)`);
      cache = { at: Date.now(), matches: all, pending: null };
      return all;
    })().catch((e) => { cache.pending = null; throw e; });
    return cache.pending;
  }

  async getAllMatchesByTab(tab, sport = 'all') {
    try {
      let list = (await this.fetchAll()).filter((m) => !m.status.isFinished);
      if (tab === 'live') list = list.filter((m) => m.status.isLive);
      else if (tab === 'upcoming') list = list.filter((m) => m.status.isUpcoming && (m.sport === 'f1' || m.matchTime - Date.now() <= UPCOMING_HOURS_OTHER * 3600000));
      if (sport !== 'all') list = list.filter((m) => m.sport === normSport(sport));
      return { matches: list, hasMore: false, totalCount: list.length };
    } catch (error) {
      console.error(`Error fetching Rerace tab ${tab}:`, error.message);
      return { matches: [], hasMore: false, totalCount: 0 };
    }
  }

  /**
   * Luồng thật của trang (xác nhận từ app JS + DevTools):
   *   events[].streams[].url (iframe trên weellz.live) --> player gọi https://weelo.live/<token a-p>/index.html (Origin/Referer weellz.live).
   * Token là chuỗi chỉ gồm a-p do site cấp (không tự tính được) -> lấy từ trang iframe. File index.html nhiều khả năng là playlist HLS
   * đặt tên .html: chỉ nhận khi nội dung bắt đầu bằng #EXTM3U. Không có thì trả [] (không bịa link).
   */
  async getStreamLinks(matchId, debug = null) {
    try {
      const all = await this.fetchAll();
      const clean_ = String(matchId).replace(/^rr_/, '');
      const m = all.find((x) => x.originalId === clean_ || x.matchId === matchId);
      if (!m) return [];

      const objs = [...(streamObjs.get(m.eventId) || []), ...(streamObjs.get(m.originalId) || [])];
      const known = new Set(objs.map((o) => o.url));
      for (const u of [...(sourceHints.get(m.originalId) || []), ...(sourceHints.get(m.eventId) || [])]) {
        if (!known.has(u)) { known.add(u); objs.push({ id: '', label: '', language: '', url: u }); }
      }
      const Q = { '4K': 0, UHD: 0, FHD: 1, HD: 2, SD: 3 };
      const qOf = (o) => { const x = /\b(4K|UHD|FHD|HD|SD)\b/i.exec(o.label || ''); return x ? Q[x[1].toUpperCase()] : 2; };
      objs.sort((a, b) => qOf(a) - qOf(b)); // sort ổn định: cùng chất lượng giữ thứ tự gốc
      const weeloHost = WEELO_BASE.replace(/^https?:\/\//, '').replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
      const TOKEN_RE = new RegExp(String.raw`https?://${weeloHost}/[a-p]{16,}/index\.html`, 'gi'); // chạy trên html đã clean() (bỏ \/)

      const limit = m.sport === 'f1' ? MAX_STREAMS : MAX_SERVERS_OTHER; // objs đã sort chất lượng cao -> link đầu tiên tìm được là tốt nhất
      const found = new Map(); // url -> {obj, kind}
      const add = (url, obj, kind, referer = '') => { if (!found.has(url) && found.size < limit) found.set(url, { obj, kind, referer }); };
      let browserTries = 0;

      for (const o of objs.slice(0, MAX_STREAMS)) {
        if (found.size >= limit) break;
        if (/\.m3u8(\?|$)/i.test(o.url)) { add(o.url, o, 'hls'); continue; }
        // 0) F1: iframe weellz.live/beta?stream=<token a-p>&r=1 -> master playlist https://weelo.live/<token>/index.html
        //    (DevTools 08/11/2026: master gebdace.../index.html -> <token>/tracks-v3a1|v2a1|a1/style.css (playlist đặt tên .css),
        //     segment weelo.live/ingest/<uuid>/IMG_xxxx.jpg|png|webp, key AES rewnd.live/k/...). Token nằm ngay trong URL iframe.
        const tok = weeloTokenOf(o.url);
        if (tok) {
          const idx = `${WEELO_BASE}/${tok}/index.html`;
          if (debug) debug.trace[o.url] = [];
          try {
            const body = await getText(idx);
            debug?.trace[o.url].push({ url: idx, ok: true, bytes: body.length, m3u8: /^\s*#EXTM3U/.test(body) });
            if (/^\s*#EXTM3U/.test(body)) { add(idx, o, 'weelo'); continue; }
            for (const u of extractM3u8(body, idx)) add(u, o, 'hls');
            if (found.size) continue;
          } catch (e) {
            const st = e.response?.status;
            debug?.trace[o.url].push({ url: idx, ok: false, error: st ? `HTTP ${st}` : e.message });
            // 404/410 = phiên chưa phát/đã hết -> bỏ; lỗi mạng/403 từ IP server vẫn giữ link (proxy sẽ thử lại với Referer đúng)
            if (st !== 404 && st !== 410) { add(idx, o, 'weelo'); continue; }
          }
        }
        const before = found.size;
        const refs = [`${RERACE_BASE}/`, `${EMBED_ORIGIN}/`, `${PLAYER_ORIGIN}/`];
        const trace = debug ? (debug.trace[o.url] = []) : [];
        // Quét tĩnh (axios) có giới hạn thời gian để còn thời gian cho bước trình duyệt bên dưới.
        await withTimeout((async () => {
            // 1) quét trang embed (m3u8 trực tiếp / base64 / iframe / script / api)
            for (const u of await scanEmbed(o.url, refs, { trace })) add(u, o, 'hls');
          // 2) luồng weelo.live/<token a-p>/index.html (F1) — playlist HLS đặt tên .html
          if (found.size < limit) try {
            const html = await getText(o.url, `${RERACE_BASE}/`);
            const tokens = clean(html).match(TOKEN_RE) || [];
            for (const t of new Set(tokens)) {
              try {
                const body = await getText(t);
                if (/^\s*#EXTM3U/.test(body)) add(t, o, 'weelo');
                else for (const u of findM3u8(body)) add(u, o, 'hls');
              } catch (e) { console.error(`[rerace] ${t}: ${e.message}`); }
            }
          } catch (e) { console.error(`[rerace] ${o.url}: ${e.message}`); }
        })(), STATIC_SCAN_LIMIT_MS, null);
        // 3) Không ra link -> mở trang embed bằng trình duyệt thật, bắt request m3u8 do player tự gọi.
        if (found.size === before && found.size < limit && BROWSER_ON && browserTries < BROWSER_TRIES) {
          browserTries += 1;
          const targets = [{ url: o.url, referer: `${RERACE_BASE}/` }];
          if (browserTries > 1 && m.detailUrl) targets.push({ url: m.detailUrl, referer: '' }); // lượt 2: trang xem của rerace (iframe nằm trong ngữ cảnh thật)
          const tgt = targets[targets.length - 1];
          try {
            const r = await captureM3u8ViaBrowser(tgt.url, { referer: tgt.referer || undefined, timeoutMs: BROWSER_TIMEOUT_MS });
            trace.push({ browser: tgt.url, found: r.found.map((f) => f.url).slice(0, 5), title: r.title, xhr: r.seen.slice(0, 8) });
            for (const f of r.found) {
              if (/\.m3u8(\?|$)/i.test(f.url)) add(f.url, o, 'hls', f.headers?.referer || f.headers?.Referer || '');
              else add(f.url, o, 'weelo', f.headers?.referer || f.headers?.Referer || '');
            }
            if (!r.found.length) console.error(`[rerace] trình duyệt không bắt được m3u8 từ ${tgt.url} (title="${r.title}", xhr=${r.seen.length})`);
          } catch (e) {
            trace.push({ browser: tgt.url, error: e.message });
            console.error(`[rerace] trình duyệt lỗi ${tgt.url}: ${e.message}`);
          }
        }
      }
      // dự phòng: players/state.json
      if (!found.size) {
        try { for (const u of findM3u8(await getText(`${WEELO_BASE}/players/state.json`))) add(u, { id: '', label: '' }, 'hls'); } catch { /* bỏ qua */ }
      }

      // Player chạy trong iframe -> request m3u8/ts mang Referer = origin trang embed (weellz.live cho F1, taifood-blog.asia cho bóng đá...).
      const refererOf = (obj) => { try { return `${new URL(obj.url).origin}/`; } catch { return `${PLAYER_ORIGIN}/`; } };
      const list = [...found.entries()].map(([url, { obj, referer: capturedRef }], i) => {
        const name = `Server ${i + 1}${obj.label ? ` - ${obj.label}` : ''}`;
        return {
          id: obj.id || `${m.originalId}_${i}`, streamerId: obj.id || `${m.originalId}_${i}`, name, streamerName: name,
          avatar: null, streamerAvatar: null, link: url, m3u8Url: url, playUrl: url, format: 'hls', cdn: 'HLS',
          quality: /\b4K|UHD\b/i.test(name) ? '4K' : /\bSD\b/i.test(name) ? 'SD' : 'HD', language: obj.language || undefined, referer: capturedRef || refererOf(obj)
        };
      });
      if (debug) { debug.match = { id: m.matchId, title: `${m.homeTeam?.name} - ${m.awayTeam?.name}`, sport: m.sport, servers: objs.length }; debug.links = list.map((x) => ({ name: x.name, url: x.link, referer: x.referer })); }
      console.log(`[rerace] ${matchId}: ${list.length} link phát (${objs.length} server nguồn${objs.length ? '' : ' — trận KHÔNG có iframe/server nào từ ppv/events.json'})`);
      return list;
    } catch (error) {
      console.error('Error fetching Rerace stream links:', error.message);
      return [];
    }
  }
}

const reraceService = new ReraceService();
export default reraceService;
