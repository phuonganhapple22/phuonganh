import { createHttpClient } from '@/src/utils/httpClient';
import { isStaleLiveMatch } from '@/src/utils/playerGet';
import { filterMinorLeagues } from '@/src/utils/leagueFilter';
import { fetchPageGlobal } from '@/src/utils/browserFetch';

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
  return Array.isArray(list) ? list : [];
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

function pickStreams(raw, base) {
  const list = [];
  const seen = new Set();
  const push = (c, bio) => {
    const url = abs(c?.stream_url || '', base);
    if (!/^https?:\/\//i.test(url) || seen.has(url)) return;
    seen.add(url);
    const who = c.commentator || c || {};
    const name = who.name || bio || `BLV ${list.length + 1}`;
    list.push({
      id: `${raw.id}_${who.slug || who.id || list.length}`,
      name,
      avatar: who.avatar_url || who.avatar ? abs(who.avatar_url || who.avatar, base) : null,
      streamUrl: url,
      flvStreamUrl: c.flv_stream_url || who.flv_stream_url || '',
      isLive: true,
      cdn: 'HLS',
      referer: `${base}/`
    });
  };
  for (const cs of raw.commentator_streams || []) {
    // BLV chưa bật phát (is_live=false) thì link chưa có luồng -> bỏ.
    if (cs?.is_live === false) continue;
    push(cs);
  }
  if (!list.length) {
    for (const c of raw.commentators || []) {
      if (c?.is_live === false) continue;
      push(c);
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

function buildMatches(rawList, base = XOICHE_BASE_URL) {
  const out = [];
  for (const r of rawList) {
    if (r?.id === undefined || r?.id === null || r?.is_active === false) continue;
    const sport = String(r.sport_slug || r.sport?.slug || 'football').toLowerCase();
    const info = SPORT_INFO[sport] || { name: String(r.sport_name || sport).toUpperCase(), icon: 'fa-futbol' };
    const status = mapStatus(r);

    const d = r.start_time ? new Date(r.start_time) : new Date();
    const ts = Number.isNaN(d.getTime()) ? new Date() : d;
    const timeStr = ts.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Ho_Chi_Minh' });
    const dateStr = ts.toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });
    const [, mo, da] = dateStr.split('-');

    const commentators = status.isLive ? pickStreams(r, base) : [];
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
      competition: { name: r.tournament_name || r.tournament?.name || '', logo: logo(r.tournament?.icon), icon: logo(r.tournament?.icon) },
      homeTeam: { name: r.home_team_name || r.home_team?.name || 'Home', logo: logo(r.home_team_logo || r.home_team?.logo) },
      awayTeam: { name: r.away_team_name || r.away_team?.name || 'Away', logo: logo(r.away_team_logo || r.away_team?.logo) },
      score: { home: Number(r.home_score) || 0, away: Number(r.away_score) || 0 },
      status: {
        ...status,
        name: status.isLive ? (status.isHalfTime ? 'HT' : 'LIVE') : (status.isFinished ? 'FT' : 'Sắp diễn ra'),
        text: status.isLive ? (status.isHalfTime ? 'HT' : (minute ? `${minute}'` : 'LIVE')) : (status.isFinished ? 'Kết thúc' : 'Sắp diễn ra'),
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
        console.log(`[xoiche] OK ${base} (axios): ${raw.length} trận`);
        return buildMatches(raw, base);
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
          return buildMatches(raw, base);
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
