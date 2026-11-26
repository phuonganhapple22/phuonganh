// Bộ đọc schema MỚI của Khán Đài (giao diện NemBienTV, domain khandaia.one).
//
// FIX (26/11/2026 — "không bắt được API trận, 0 trận"): site ĐÃ ĐỔI HẲN cách phát dữ liệu:
//   - KHÔNG còn Nuxt (window.__NUXT__) và KHÔNG còn /api/matches/ (404) — nên bản cũ luôn ra 0 trận.
//   - Danh sách trận nằm ở  /cms-schedule.json  (và nhúng sẵn trong HTML ở <script id="cms-home-matches">):
//       [{ matchId, sport, league, home, away, homeLogo, awayLogo, timestamp(giây),
//          hot_priority, early_stream, hasLiveSource, commentators[] }]
//   - Trận đang có nguồn phát nằm ở  /api/cms-match-live  (schema chưa có mẫu đầy đủ -> đọc "mềm", xem bên dưới).
//
// File này KHÔNG import gì (thuần hàm) để test được bằng node trực tiếp.

const FINISH_AFTER_MS = {
  football: 3 * 60 * 60 * 1000,
  basketball: 3 * 60 * 60 * 1000,
  volleyball: 3 * 60 * 60 * 1000,
  tennis: 5 * 60 * 60 * 1000,
  badminton: 3 * 60 * 60 * 1000,
  default: 3.5 * 60 * 60 * 1000
};

const SPORT_ALIAS = {
  football: 'football', soccer: 'football', 'bong-da': 'football',
  basketball: 'basketball', 'bong-ro': 'basketball',
  volleyball: 'volleyball', 'bong-chuyen': 'volleyball',
  badminton: 'badminton', 'cau-long': 'badminton',
  tennis: 'tennis',
  esports: 'esports', esport: 'esports',
  billiards: 'billiards', snooker: 'billiards', pool: 'billiards',
  'table-tennis': 'table-tennis', tabletennis: 'table-tennis', table_tennis: 'table-tennis', 'bong-ban': 'table-tennis',
  boxing: 'boxing', mma: 'boxing'
};

export const SPORT_INFO = {
  football: { name: 'BÓNG ĐÁ', icon: 'fa-futbol' },
  basketball: { name: 'BÓNG RỔ', icon: 'fa-basketball' },
  volleyball: { name: 'BÓNG CHUYỀN', icon: 'fa-volleyball' },
  badminton: { name: 'CẦU LÔNG', icon: 'fa-feather' },
  tennis: { name: 'TENNIS', icon: 'fa-baseball-bat-ball' },
  esports: { name: 'ESPORTS', icon: 'fa-gamepad' },
  billiards: { name: 'BILLIARDS', icon: 'fa-circle-dot' },
  'table-tennis': { name: 'BÓNG BÀN', icon: 'fa-table-tennis-paddle-ball' },
  boxing: { name: 'BOXING', icon: 'fa-hand-fist' }
};

export function canonicalSport(raw) {
  const k = String(raw ?? '').trim().toLowerCase();
  return SPORT_ALIAS[k] || k || 'football';
}

export function slugVi(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/gi, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const ID_KEYS = ['matchId', 'match_id', 'matchID'];
const pickId = (o) => {
  for (const k of ID_KEYS) if (o && o[k] !== undefined && o[k] !== null && o[k] !== '') return String(o[k]);
  return '';
};

// Khoá "trông giống id trận" khi payload dạng { "<matchId>": {...} }
const looksLikeIdKey = (k) => /^[a-z0-9]{10,}$/i.test(k);

/**
 * Gom mọi object có matchId trong cây JSON bất kỳ (mảng, {data:[...]}, {matches:[...]}, {"<id>":{...}}...)
 * -> Map<matchId, object>. Cùng matchId xuất hiện nhiều lần thì gộp trường (cái sau không ghi đè bằng rỗng).
 */
export function collectById(node, out = new Map(), depth = 0, keyHint = '') {
  if (!node || depth > 8) return out;
  if (Array.isArray(node)) {
    for (const it of node) collectById(it, out, depth + 1);
    return out;
  }
  if (typeof node !== 'object') return out;

  let id = pickId(node);
  if (!id && keyHint && looksLikeIdKey(keyHint) && depth > 0 && !Array.isArray(node)
    && ('home' in node || 'away' in node || 'commentators' in node || 'streams' in node || 'stream_url' in node)) {
    id = keyHint;
  }
  if (id) {
    const prev = out.get(id) || {};
    const merged = { ...prev };
    for (const [k, v] of Object.entries(node)) {
      const empty = v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length);
      if (!empty || !(k in merged)) merged[k] = v;
    }
    merged.matchId = id;
    out.set(id, merged);
  }
  for (const [k, v] of Object.entries(node)) {
    if (v && typeof v === 'object') collectById(v, out, depth + 1, k);
  }
  return out;
}

const STREAM_URL_RE = /^https?:\/\/[^\s"'<>]+$/i;
const STREAM_HINT_RE = /(\.m3u8|\.flv|\.mpd|\/hls\/|\/live\/|playlist|manifest|\.ts(\?|$))/i;
const IMAGE_RE = /\.(png|jpe?g|webp|gif|svg|ico)(\?|$)/i;

const pickStr = (o, keys) => {
  for (const k of keys) if (o && typeof o[k] === 'string' && o[k].trim()) return o[k].trim();
  return '';
};

/**
 * Tìm MỌI link phát trong 1 object trận (đệ quy), không cần biết tên khoá
 * (stream_url / streamUrl / url / link / hls / m3u8 / flv / play_url ...).
 * Ngữ cảnh BLV (name/avatar) lấy từ object cha gần nhất có tên.
 * @returns {{id:string,name:string,avatar:string,url:string}[]}
 */
export function extractStreams(node, ctx = {}, out = [], seen = new Set(), depth = 0) {
  if (!node || depth > 7) return out;
  if (Array.isArray(node)) {
    node.forEach((it) => extractStreams(it, ctx, out, seen, depth + 1));
    return out;
  }
  if (typeof node !== 'object') return out;

  const here = {
    id: node.id ?? node.commentatorId ?? node.commentator_id ?? ctx.id ?? '',
    name: pickStr(node, ['name', 'commentator', 'commentatorName', 'blv', 'nickname', 'title', 'label']) || ctx.name || '',
    avatar: pickStr(node, ['avatar', 'avatar_url', 'avatarUrl', 'image', 'img']) || ctx.avatar || ''
  };

  for (const [k, v] of Object.entries(node)) {
    if (typeof v === 'string') {
      const s = v.trim();
      if (!STREAM_URL_RE.test(s) || IMAGE_RE.test(s)) continue;
      if (/logo|avatar|thumb|poster|cover/i.test(k)) continue;
      if (!STREAM_HINT_RE.test(s) && !/(stream|hls|m3u8|flv|play|source|link|url)/i.test(k)) continue;
      if (!STREAM_HINT_RE.test(s)) continue; // khoá nghe giống link phát nhưng giá trị không phải luồng -> bỏ
      if (/hls-decoy/i.test(s)) continue; // playlist GIẢ của site (anti-scrape)
      if (seen.has(s)) continue;
      seen.add(s);
      out.push({ id: String(here.id || ''), name: here.name, avatar: here.avatar, url: s });
    } else if (v && typeof v === 'object') {
      extractStreams(v, here, out, seen, depth + 1);
    }
  }
  return out;
}

const toMs = (ts) => {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n < 1e12 ? n * 1000 : n; // schema mới dùng GIÂY
};

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

function readScore(o) {
  if (o && typeof o.score === 'object' && o.score) return { home: num(o.score.home), away: num(o.score.away) };
  return {
    home: num(o.homeScore ?? o.home_score ?? o.scoreHome ?? 0),
    away: num(o.awayScore ?? o.away_score ?? o.scoreAway ?? 0)
  };
}

/**
 * Gộp lịch (cms-schedule.json / cms-home-matches) với danh sách đang phát (cms-match-live)
 * thành mảng "raw match" duy nhất cho khandaitv.service.js.
 *
 * @param {{schedule?:any, live?:any, hrefByMatchId?:Record<string,string>, now?:number}} input
 */
export function buildRawMatches({ schedule, live, hrefByMatchId = {}, now = Date.now() }) {
  const sched = collectById(schedule);
  const liveMap = collectById(live);
  const ids = new Set([...sched.keys()]);
  // Trận chỉ có ở feed live (đủ tên đội) cũng lấy.
  for (const [id, o] of liveMap) if (!ids.has(id) && (o.home || o.away || o.home_team_name)) ids.add(id);

  const out = [];
  for (const id of ids) {
    const s = sched.get(id) || {};
    const l = liveMap.get(id) || {};
    const m = { ...s, ...Object.fromEntries(Object.entries(l).filter(([, v]) => v !== '' && v != null && !(Array.isArray(v) && !v.length))) };

    const home = String(m.home ?? m.home_team_name ?? m.homeName ?? '').trim();
    const away = String(m.away ?? m.away_team_name ?? m.awayName ?? '').trim();
    if (!home && !away) continue;

    const sport = canonicalSport(m.sport ?? m.sport_slug);
    const startMs = toMs(m.timestamp ?? m.start_time ?? m.startTime ?? m.time);
    const streams = extractStreams([s.commentators, l.commentators, l.streams, l.stream, m.streams, m.stream_url, m.streamUrl, m.url, m.link]
      .filter((x) => x !== undefined && x !== null)
      .map((x) => (typeof x === 'string' ? { url: x } : x)));
    // Gộp thêm các link nằm ngay mức đầu object (stream_url/m3u8/flv...)
    for (const st of extractStreams({ ...l, commentators: undefined })) if (!streams.some((x) => x.url === st.url)) streams.push(st);

    const hasLiveSource = !!(m.hasLiveSource ?? m.has_live_source ?? false) || liveMap.has(id);
    const early = !!(m.early_stream ?? m.earlyStream ?? false);
    const finishAfter = FINISH_AFTER_MS[sport] || FINISH_AFTER_MS.default;
    const statusRaw = String(m.status ?? '').toLowerCase();
    const explicitFinished = /^(finished|ended|ft|full_time|cancelled|canceled|postponed|abandoned)$/.test(statusRaw);
    const explicitUpcoming = /^(scheduled|not_started|upcoming|pending|ns)$/.test(statusRaw);

    const started = startMs ? now >= startMs - 2 * 60 * 1000 : false;
    const finished = explicitFinished || (!!startMs && now > startMs + finishAfter);
    const isLive = !finished && !explicitUpcoming && started && (hasLiveSource || streams.length > 0 || (!!statusRaw && !explicitUpcoming));

    const commentatorNames = Array.isArray(s.commentators) ? s.commentators.map((c) => (typeof c === 'string' ? c : c?.name)).filter(Boolean) : [];

    out.push({
      id,
      sport,
      league: String(m.league ?? m.tournament_name ?? '').trim(),
      home,
      away,
      homeLogo: m.homeLogo ?? m.home_team_logo ?? '',
      awayLogo: m.awayLogo ?? m.away_team_logo ?? '',
      startMs,
      hot: Number(m.hot_priority ?? 0) > 0 || !!m.is_hot,
      hasLiveSource,
      earlyStream: early,
      isLive,
      isFinished: finished,
      score: readScore(m),
      matchTimeText: String(m.match_time ?? m.minute ?? m.elapsed ?? '').trim(),
      commentatorNames,
      streams,
      href: hrefByMatchId[id] || (typeof m.url === 'string' && /^(https?:)?\//.test(m.url) ? m.url : '') || (typeof m.href === 'string' ? m.href : '')
    });
  }
  return out;
}

/** Từ danh sách href trên trang chủ, tìm đường dẫn trận chứa matchId (không cần đoán pattern URL). */
export function mapHrefsToMatchIds(hrefs, matchIds) {
  const out = {};
  const list = (hrefs || []).filter(Boolean);
  for (const id of matchIds) {
    const hit = list.find((h) => String(h).includes(id));
    if (hit) out[id] = hit;
  }
  return out;
}
