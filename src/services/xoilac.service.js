import { load } from 'cheerio';
import { createHttpClient } from '@/src/utils/httpClient';
import { mapPool, isStaleLiveMatch } from '@/src/utils/playerGet';
import { filterMinorLeagues } from '@/src/utils/leagueFilter';

// Thêm nguồn Xôi Lạc TV (xoilacxc.tv / xoilacxcw.tv). Trang chủ render SẴN
// toàn bộ danh sách trận trong HTML tĩnh (giống Gà Vàng) nên chỉ cần fetch
// HTML + cheerio, không cần trình duyệt headless.
//
// Cấu trúc đã đối chiếu với bản HTML trang chủ người dùng gửi (03/10/2026):
//   - Mỗi trận: <div class="main-grid-match ..." data-fid data-sport
//     data-status data-runtime(giây, UNIX) data-league data-hot>
//   - Tên đội: .gmd-home_team p / .gmd-away_team p
//   - Danh sách BLV của trận: .grid-match__footer-center a.commentator
//     (href = /truc-tiep/<slug>/link/<N>, chữ trong <span> là tên BLV)
//   - Tỉ số/phút thi đấu KHÔNG có trong HTML tĩnh (JS phía client cập nhật
//     sau) -> để 0-0, giống gavang33.service.js.
//
// CHƯA XÁC NHẬN: link .m3u8 thật nằm ở trang /truc-tiep/<slug>/link/<N>
// (chưa có bản HTML trang đó để đối chiếu). parseStreamUrls() bên dưới dò
// theo kiểu "quét mọi URL .m3u8/.flv trong HTML/script/data-*" cho an toàn;
// nếu trang đó chỉ nhúng <iframe> hoặc gọi API riêng, cần gửi thêm 1 bản
// HTML (hoặc request bắt từ DevTools) của 1 trang link/N để chỉnh lại.
const XOILAC_BASE_URL = String(process.env.XOILAC_DOMAIN || process.env.XOILAC_BASE_URL || 'https://xoilacxc.tv').replace(/\/+$/, '');

const client = createHttpClient(
  {
    baseURL: XOILAC_BASE_URL,
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'vi,en-US;q=0.9,en;q=0.8'
    },
    timeout: 10000
  },
  { maxAttempts: 2 }
);

// API tỉ số trực tiếp (bắt từ DevTools 03/10/2026): GET /football/match/detail_live
// trả về MỌI trận bóng đá đang diễn ra/vừa xong trong 1 lần gọi. CHỈ có tỉ
// số/trạng thái/thống kê — KHÔNG có link stream. Cần Origin/Referer của site.
const XOILAC_SCORE_API = String(process.env.XOILAC_SCORE_API || 'https://fb-api.sportliveapiz.com').replace(/\/+$/, '');
// Origin/Referer của API tỉ số theo domain site đang chạy (đã thấy xoilacxcw.tv
// rồi xoilacxyc.io cùng gọi được) -> thử lần lượt, domain cấu hình lên đầu.
const XOILAC_SCORE_ORIGIN = String(process.env.XOILAC_SCORE_ORIGIN || 'https://xoilacxyc.io').replace(/\/+$/, '');
const SCORE_ORIGINS = [...new Set([XOILAC_SCORE_ORIGIN, XOILAC_BASE_URL, 'https://xoilacxyc.io', 'https://xoilacxcw.tv'])];
const scoreClient = createHttpClient(
  {
    baseURL: XOILAC_SCORE_API,
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36',
      Accept: 'application/json, text/javascript, */*; q=0.01',
      'Accept-Language': 'vi,en-US;q=0.9,en;q=0.8'
    },
    timeout: 8000
  },
  { maxAttempts: 1 }
);

async function fetchLiveScoreResults() {
  let lastError = null;
  for (const origin of SCORE_ORIGINS) {
    try {
      const { data } = await scoreClient.get('/football/match/detail_live', { headers: { Origin: origin, Referer: `${origin}/` } });
      if (data?.code === 0 && Array.isArray(data.results)) return data.results;
      lastError = new Error(`phản hồi lạ (code=${data?.code})`);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('không có Origin nào dùng được');
}

/** Phút thi đấu từ mốc bắt đầu hiệp hiện tại (score[4], giây UNIX). */
function footballMinute(statusId, halfStartSec, nowSec) {
  if (statusId === 3) return 'HT';
  if (statusId === 7) return 'Pen';
  if (!halfStartSec) return '';
  const elapsed = Math.max(0, Math.floor((nowSec - halfStartSec) / 60)) + 1;
  const base = { 2: 0, 4: 45, 5: 90, 6: 90 }[statusId];
  const cap = { 2: 45, 4: 90, 5: 105, 6: 120 }[statusId];
  if (base === undefined) return '';
  const m = base + elapsed;
  return m > cap ? `${cap}+` : String(m);
}

/** Gộp tỉ số/trạng thái từ detail_live vào danh sách trận bóng đá (khớp theo fid). */
function overlayLiveScores(matches, results, nowSec = Math.floor(Date.now() / 1000)) {
  const byId = new Map();
  for (const r of Array.isArray(results) ? results : []) {
    if (r?.id && Array.isArray(r.score)) byId.set(r.id, r);
  }
  return matches.map((m) => {
    if (m.sport !== 'football') return m;
    const r = byId.get(m.originalId);
    if (!r) return m;
    const statusId = Number(r.status_id ?? r.score[1]);
    const home = Array.isArray(r.score[2]) ? r.score[2] : [];
    const away = Array.isArray(r.score[3]) ? r.score[3] : [];
    const st = mapStatus('football', statusId);
    const minute = st.isLive ? footballMinute(statusId, Number(r.score[4]) || 0, nowSec) : '';
    const label = st.isLive ? (st.isHalfTime ? 'HT' : (minute ? `${minute}'` : 'LIVE')) : (st.isFinished ? 'FT' : 'Sắp diễn ra');
    return {
      ...m,
      score: { home: home[0] || 0, away: away[0] || 0 },
      status: {
        ...st,
        name: st.isLive ? (st.isHalfTime ? 'HT' : 'LIVE') : (st.isFinished ? 'FT' : 'Sắp diễn ra'),
        text: st.isLive ? label : (st.isFinished ? 'Kết thúc' : 'Sắp diễn ra'),
        elapsedTime: st.isLive && !st.isHalfTime ? minute : '',
        minutes: minute
      },
      // [0] bàn thắng, [1] hiệp 1, [2] thẻ đỏ, [3] thẻ vàng, [4] phạt góc
      stats: {
        halfTimeScore: `${home[1] || 0}-${away[1] || 0}`,
        corners: `${home[4] || 0}-${away[4] || 0}`,
        yellowCards: `${home[3] || 0}-${away[3] || 0}`
      }
    };
  });
}

const SPORT_INFO = {
  football: { name: 'BÓNG ĐÁ', icon: 'fa-futbol' },
  basketball: { name: 'BÓNG RỔ', icon: 'fa-basketball' },
  volleyball: { name: 'BÓNG CHUYỀN', icon: 'fa-volleyball' },
  tennis: { name: 'TENNIS', icon: 'fa-baseball-bat-ball' }
};

// Mã status (cùng bộ mã giữa data-status trên trang chủ và status_id của API
// detail_live, đã đối chiếu với dữ liệu thật 03/10/2026):
//   bóng đá: 1 chưa đá, 2 hiệp 1, 3 nghỉ giữa hiệp, 4 hiệp 2, 5 hiệp phụ,
//   7 luân lưu, 8 kết thúc, 9 hoãn, 10 gián đoạn, 11 bỏ dở, 12 huỷ,
//   13 chưa xác định giờ.  Bóng rổ: 2-9 các hiệp, 10 kết thúc.
// Môn khác (tennis 52, bóng chuyền 434...) mã lạ -> coi là ĐANG ĐÁ nếu đã
// qua giờ bóng lăn; isStaleLiveMatch() phía dưới vẫn cắt trận quá giờ.
function mapStatus(sport, code) {
  const n = parseInt(code, 10);
  const UP = { isLive: false, isFinished: false, isUpcoming: true, isHalfTime: false };
  const END = { isLive: false, isFinished: true, isUpcoming: false, isHalfTime: false };
  const LIVE = { isLive: true, isFinished: false, isUpcoming: false, isHalfTime: false };
  if (!n || n === 1 || n === 13) return UP;
  if (sport === 'football') {
    if (n === 3) return { ...LIVE, isHalfTime: true };
    if ([2, 4, 5, 6, 7].includes(n)) return LIVE;
    return END; // 8 kết thúc, 9-12 hoãn/gián đoạn/huỷ -> không hiện trong live/upcoming
  }
  if (sport === 'basketball') return n >= 10 ? END : LIVE;
  return LIVE;
}

function getFullUrl(url) {
  if (!url) return '';
  if (/^(https?:)?\/\//i.test(url) || url.startsWith('data:')) return url.startsWith('//') ? `https:${url}` : url;
  return `${XOILAC_BASE_URL}${url.startsWith('/') ? '' : '/'}${url}`;
}

function textOf($el) {
  return ($el.first().text() || '').replace(/\s+/g, ' ').trim();
}

function parseMatchCard($, el) {
  const $m = $(el);
  const fid = $m.attr('data-fid') || '';
  if (!fid) return null;

  const sport = SPORT_INFO[$m.attr('data-sport')] ? $m.attr('data-sport') : ($m.attr('data-sport') || 'football');
  const info = SPORT_INFO[sport] || { name: String(sport).toUpperCase(), icon: 'fa-futbol' };

  const runtimeSec = parseInt($m.attr('data-runtime') || '0', 10);
  const matchDate = runtimeSec ? new Date(runtimeSec * 1000) : new Date();

  const link = $m.find('a[href*="/truc-tiep/"]').first();
  const href = link.attr('href') || '';
  const detailUrl = href ? getFullUrl(href) : '';
  const slug = (href.match(/\/truc-tiep\/([^/]+)\/?/) || [])[1] || '';

  const homeName = textOf($m.find('.gmd-home_team .team-name-group p')) || 'Home';
  const awayName = textOf($m.find('.gmd-away_team .team-name-group p')) || 'Away';
  const homeLogo = getFullUrl($m.find('.gmd-home_team img').first().attr('src') || $m.find('.gmd-home_team img').first().attr('data-src'));
  const awayLogo = getFullUrl($m.find('.gmd-away_team img').first().attr('src') || $m.find('.gmd-away_team img').first().attr('data-src'));

  const league = $m.attr('data-league') || textOf($m.find('.gmd-match-league .text-ellipsis'));
  const leagueLogo = getFullUrl($m.find('.gmd-comp_logo').first().attr('src'));

  // Danh sách BLV: chỉ lấy trong .grid-match__footer-center (footer-left
  // cũng có khối trùng nhưng không chứa link BLV). Bỏ trùng theo href.
  const blvLinks = [];
  const seenHref = new Set();
  $m.find('.grid-match__footer-center a.commentator').each((_, a) => {
    const h = $(a).attr('href') || '';
    if (!h || seenHref.has(h)) return;
    seenHref.add(h);
    blvLinks.push({ name: textOf($(a).find('span')) || `BLV ${blvLinks.length + 1}`, url: getFullUrl(h) });
  });

  const status = mapStatus(sport, $m.attr('data-status'));

  const timeStr = matchDate.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Ho_Chi_Minh' });
  const dateStr = matchDate.toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });
  const [, mo, da] = dateStr.split('-');

  return {
    matchId: `xl_${fid}`,
    originalId: fid,
    slug,
    detailUrl,
    source: 'xoilac',
    sport,
    sportName: info.name,
    sportIcon: info.icon,
    competition: { name: league, logo: leagueLogo, icon: leagueLogo },
    homeTeam: { name: homeName, logo: homeLogo },
    awayTeam: { name: awayName, logo: awayLogo },
    score: { home: 0, away: 0 },
    status: {
      ...status,
      name: status.isLive ? (status.isHalfTime ? 'HT' : 'LIVE') : (status.isFinished ? 'FT' : 'Sắp diễn ra'),
      text: status.isLive ? (status.isHalfTime ? 'HT' : 'LIVE') : (status.isFinished ? 'Kết thúc' : 'Sắp diễn ra'),
      elapsedTime: '',
      minutes: ''
    },
    stats: { halfTimeScore: '0-0', corners: '0-0', yellowCards: '0-0' },
    matchTime: matchDate.getTime(),
    matchTimeTimestamp: matchDate.getTime(),
    timeFormatted: `${timeStr} - ${da}/${mo}`,
    dateStr,
    timeStr,
    isHot: /\bon\b/i.test($m.attr('data-hot') || ''),
    blvLinks, // nội bộ — dùng để lấy stream ở bước sau
    commentators: [],
    streamers: [],
    streamUrl: '',
    stream: {
      // Khác rỗng để trận chưa có link vẫn không bị loại khỏi playlist tĩnh
      // (xem FIX 23/09/2026 trong phalang.service.js).
      liveUrl: detailUrl || XOILAC_BASE_URL,
      streamerName: null,
      streamerAvatar: null
    },
    odds: null
  };
}

function parseHomepage(html) {
  const $ = load(html);
  const out = [];
  const seen = new Set();
  $('.main-grid-match[data-fid]').each((_, el) => {
    const m = parseMatchCard($, el);
    if (m && !seen.has(m.matchId)) {
      seen.add(m.matchId);
      out.push(m);
    }
  });
  return out;
}

/** Quét mọi URL .m3u8/.flv trong HTML (thẻ, thuộc tính data-*, script, JSON escape). */
function parseStreamUrls(html) {
  const text = String(html || '')
    .replace(/\\u0026/g, '&')
    .replace(/\\u002F/gi, '/')
    .replace(/\\\//g, '/')
    .replace(/&amp;/g, '&');
  const found = [];
  const seen = new Set();
  const re = /https?:\/\/[^\s"'<>\\)]+?\.(?:m3u8|flv)(?:\?[^\s"'<>\\)]*)?/gi;
  let m;
  while ((m = re.exec(text))) {
    const u = m[0];
    if (!seen.has(u)) {
      seen.add(u);
      found.push(u);
    }
  }
  // HLS lên trước, FLV sau (app/player xử lý HLS tốt hơn) — sort ổn định.
  const rank = (u) => (/\.m3u8(\?|$)/i.test(u) ? 0 : 1);
  return found.map((u, i) => ({ u, i })).sort((a, b) => rank(a.u) - rank(b.u) || a.i - b.i).map(({ u }) => u);
}

/**
 * Trang /truc-tiep/<slug>/ (và /link/N) nhúng sẵn MỌI BLV của trận trong JS:
 *   var list_stream = [["<embed1>","<embed2>"], ["<embed>"], ...];
 * chỉ số mảng = data-link của nút BLV (tv_link_N). Đối chiếu trang thật
 * 03/10/2026: mỗi phần tử là URL TRANG NHÚNG dạng
 *   https://xl365.domainkqt.cc/ajax/chanel/type/<5|7|8>/link/<channel>
 * (iframe#iframe-stream), KHÔNG phải link .m3u8 -> cần thêm 1 bước mở trang
 * nhúng đó (resolveEmbedStream). 1 request trang chi tiết là đủ cho tất cả BLV.
 */
function parseListStream(html) {
  const m = String(html || '').match(/var\s+list_stream\s*=\s*(\[[\s\S]*?\]\s*\]|\[\s*\])\s*;/);
  if (!m) return [];
  try {
    const arr = JSON.parse(m[1]);
    return Array.isArray(arr) ? arr.map((x) => (Array.isArray(x) ? x.filter((u) => typeof u === 'string' && u) : [])) : [];
  } catch {
    return [];
  }
}

/** Tên BLV theo chỉ số: <a class="player-link" data-link="N">...tên</a>. */
function parseBlvNames(html) {
  const $ = load(html);
  const names = {};
  $('a.player-link[data-link]').each((_, a) => {
    const idx = parseInt($(a).attr('data-link'), 10);
    if (Number.isNaN(idx) || names[idx]) return;
    names[idx] = textOf($(a)) || `BLV ${idx + 1}`;
  });
  return names;
}

/**
 * Trang nhúng (xl365.domainkqt.cc/ajax/chanel/type/<N>/link/<channel>) render
 * sẵn trong HTML (đối chiếu file thật channel-5.htm, 03/10/2026):
 *   var urlStream = "https://live2.domaincdn.cc/livecdn/channel-5.flv?auth_key=<ts>-0-0-<md5>";
 *   var isFlv = true;
 * auth_key do SERVER ký lúc render trang (không có API/JS phụ nào), và đổi mỗi
 * lần tải -> luôn phải mở trang nhúng ngay lúc cần, không lưu link cũ. Trang
 * còn chứa URL quảng cáo (.mp4 TVC, ảnh) -> ưu tiên đọc đúng biến urlStream,
 * chỉ quét tự do khi không có biến đó.
 */
function parseUrlStream(html) {
  const m = String(html || '').match(/var\s+urlStream\s*=\s*(["'])(.*?)\1\s*;/);
  if (!m) return '';
  const url = m[2].replace(/\\\//g, '/').replace(/&amp;/g, '&').trim();
  return /^https?:\/\//i.test(url) ? url : '';
}

/** Mở trang nhúng, lấy link stream (kể cả iframe lồng 1 cấp nếu không thấy gì). */
async function resolveEmbedStream(embedUrl, depth = 0) {
  // Thử Referer là domain site đang dùng, rồi domain site trình duyệt thật
  // gửi (xoilacxcw.tv) — trang nhúng có thể kiểm tra Referer.
  // Site xoay domain (xoilacxc.tv -> xoilacxcw.tv -> xoilacxyc.io ...): thử cả
  // các domain đã thấy phòng khi trang nhúng chỉ nhận Referer trong danh sách.
  const referers = [...new Set([XOILAC_BASE_URL, XOILAC_SCORE_ORIGIN, 'https://xoilacxyc.io'])];
  for (const ref of referers) {
    try {
      const { data } = await client.get(embedUrl, { headers: { Referer: `${ref}/`, Origin: ref } });
      const body = typeof data === 'string' ? data : JSON.stringify(data);
      const direct = parseUrlStream(body);
      if (direct) return [direct];
      const urls = parseStreamUrls(body);
      if (urls.length) return urls;
      if (depth < 1) {
        const inner = body.match(/<iframe[^>]+src=["']([^"']+)["']/i);
        if (inner) {
          const found = await resolveEmbedStream(new URL(inner[1], embedUrl).href, depth + 1);
          if (found.length) return found;
        }
      }
    } catch (error) {
      console.error(`[xoilac] lỗi mở trang nhúng ${embedUrl} (Referer ${ref}):`, error.message);
    }
  }
  console.error(`[xoilac] trang nhúng không có link stream: ${embedUrl}`);
  return [];
}

async function fetchCommentatorsForMatch(match) {
  const first = (match.blvLinks || [])[0];
  const pageUrl = first?.url || match.detailUrl;
  if (!pageUrl) return [];
  let html = '';
  try {
    ({ data: html } = await client.get(pageUrl, { headers: { Referer: `${XOILAC_BASE_URL}/` } }));
  } catch (error) {
    console.error(`[xoilac] lỗi mở trang trận ${pageUrl}:`, error.message);
    return [];
  }
  const list = parseListStream(html);
  const names = parseBlvNames(html);
  const targets = list.map((embeds, idx) => ({ idx, embeds, name: names[idx] || `BLV ${idx + 1}` })).filter((t) => t.embeds.length).slice(0, 5);

  const resolved = await mapPool(targets, 3, async (t) => {
    for (const embed of t.embeds) {
      // Trình duyệt thật nạp `<embed>/off-tvc?is_off_add=false` khi không có TVC
      // (xem show_player() trong trang trận) -> thử URL gốc trước, rồi bản đó.
      for (const candidate of [embed, `${embed}/off-tvc?is_off_add=false`]) {
        const urls = await resolveEmbedStream(candidate);
        if (urls.length) return { t, embed: candidate, urls };
      }
    }
    return null;
  });

  const seenUrl = new Set();
  const out = [];
  for (const r of resolved) {
    if (!r) continue;
    const streamUrl = r.urls[0];
    if (seenUrl.has(streamUrl)) continue;
    seenUrl.add(streamUrl);
    out.push({
      id: `${match.originalId}_${r.t.idx}`,
      name: r.t.name,
      avatar: null,
      streamUrl,
      flvStreamUrl: r.urls.find((u) => /\.flv(\?|$)/i.test(u)) || '',
      isLive: true,
      cdn: /\.flv(\?|$)/i.test(streamUrl) ? 'FLV' : 'HLS',
      // Player chạy trong iframe của trang nhúng -> Referer/Origin khi gọi CDN
      // là domain trang nhúng (xl365.domainkqt.cc), không phải domain Xôi Lạc.
      referer: `${new URL(r.embed).origin}/`
    });
  }
  return out;
}

function applyCommentators(match, commentators) {
  if (!commentators.length) return match;
  return {
    ...match,
    commentators,
    streamers: commentators,
    streamUrl: commentators[0].streamUrl,
    stream: {
      liveUrl: match.stream.liveUrl,
      streamerName: commentators[0].name || null,
      streamerAvatar: commentators[0].avatar || null
    }
  };
}

function mapStreams(match) {
  const list = [];
  const seen = new Set();
  for (const c of match?.commentators || []) {
    const url = c.streamUrl || '';
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const isFlv = /\.flv(\?|$)/i.test(url);
    list.push({
      id: c.id,
      streamerId: c.id,
      name: c.name,
      streamerName: c.name,
      avatar: c.avatar,
      streamerAvatar: c.avatar,
      link: url,
      // FLV thật (vd live2.domaincdn.cc/livecdn/channel-5.flv?auth_key=...)
      // KHÔNG được gắn vào m3u8Url — normalizeStreamList() tự thử đoán bản
      // HLS cùng đường dẫn và preferHlsForIptv() kiểm tra lại trước khi dùng.
      m3u8Url: isFlv ? '' : url,
      flvUrl: isFlv ? url : '',
      playUrl: url,
      format: isFlv ? 'flv' : 'hls',
      cdn: c.cdn,
      quality: 'HD'
    });
  }
  return list;
}

class XoilacService {
  async fetchHomepageMatches() {
    const { data: html } = await client.get('/');
    const matches = parseHomepage(html);
    // Tỉ số/trạng thái tươi hơn HTML tĩnh. Lỗi API này KHÔNG được làm hỏng
    // cả nguồn -> bỏ qua, dùng tạm trạng thái từ trang chủ.
    try {
      return overlayLiveScores(matches, await fetchLiveScoreResults());
    } catch (error) {
      console.error('[xoilac] không lấy được detail_live, dùng trạng thái trang chủ:', error.message);
    }
    return matches;
  }

  async getAllMatchesByTab(tab, sport = 'all', concurrency = 6) {
    try {
      const all = await this.fetchHomepageMatches();
      let filtered = all;
      if (tab === 'live') filtered = all.filter((m) => m.status.isLive);
      else if (tab === 'upcoming') filtered = all.filter((m) => m.status.isUpcoming);
      if (sport !== 'all') filtered = filtered.filter((m) => m.sport === sport);

      // Bỏ giải cỏ/hạng 2/nữ/trẻ TRƯỚC khi gọi trang BLV (đỡ tốn request) — xem src/utils/leagueFilter.js.
      filtered = filterMinorLeagues(filtered, 'xoilac');

      // Bỏ trận "live" đã quá giờ hợp lý (nguồn hay quên cập nhật trạng thái).
      const stale = filtered.filter((m) => m.status.isLive && isStaleLiveMatch(m));
      if (stale.length) {
        console.log(`[xoilac] bỏ ${stale.length} trận "live" đã quá giờ: ${stale.map((m) => m.slug || m.matchId).join(', ')}`);
        filtered = filtered.filter((m) => !stale.includes(m));
      }

      // Chỉ trận LIVE mới cần gọi trang BLV để lấy link thật; trận có BLV
      // nhưng không lấy được link nào thì bỏ (quy tắc chung của project).
      const live = filtered.filter((m) => m.status.isLive);
      if (live.length) {
        const list = await mapPool(live, concurrency, (m) => fetchCommentatorsForMatch(m));
        const withStreams = new Set();
        live.forEach((m, i) => {
          const commentators = list[i] || [];
          if (commentators.length) {
            filtered[filtered.indexOf(m)] = applyCommentators(m, commentators);
            withStreams.add(m.matchId);
          }
        });
        filtered = filtered.filter((m) => !m.status.isLive || withStreams.has(m.matchId));
      }

      // blvLinks chỉ dùng nội bộ, không đẩy ra ngoài.
      filtered = filtered.map(({ blvLinks, ...rest }) => rest);
      return { matches: filtered, hasMore: false, totalCount: filtered.length };
    } catch (error) {
      console.error(`Error fetching Xoilac tab ${tab}:`, error.message);
      return { matches: [], hasMore: false, totalCount: 0 };
    }
  }

  async getStreamLinks(matchId) {
    try {
      const all = await this.fetchHomepageMatches();
      const clean = String(matchId).replace(/^xl_/, '');
      const match = all.find((m) => m.originalId === clean || m.matchId === matchId || m.slug === matchId);
      if (!match) return [];
      const commentators = await fetchCommentatorsForMatch(match);
      return mapStreams({ commentators });
    } catch (error) {
      console.error('Error fetching Xoilac stream links:', error.message);
      return [];
    }
  }
}

const xoilacService = new XoilacService();
export default xoilacService;
export { parseUrlStream, parseStreamUrls, overlayLiveScores, footballMinute, parseListStream, parseBlvNames };
