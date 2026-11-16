import { load } from 'cheerio';
import { createHttpClient } from '@/src/utils/httpClient';
import { mapPool, isStaleLiveMatch } from '@/src/utils/playerGet';
import { fetchRenderedHtml } from '@/src/utils/browserFetch';

// Domain nguồn lậu này cũng đổi thường xuyên (đã thấy nhiều domain mirror
// cùng thương hiệu: gavangtv.tv, gavangtvv.cc, gavanglinkp.tv...) — override
// qua biến môi trường GAVANG_DOMAIN trên Vercel/GitHub Actions khi cần,
// không cần sửa code.
const GAVANG_BASE_URL = process.env.GAVANG_DOMAIN || process.env.GAVANG_BASE_URL || 'https://gavang13.live';

// KHÁC HẲN Giờ Vàng/Khán Đài (phải chạy Puppeteer vì dữ liệu chỉ có sau khi
// chạy JS): trang chủ Gà Vàng TV render SẴN toàn bộ danh sách trận (tên
// đội, giờ đá, tỉ số...) ngay trong HTML thô (xem .match-card trong response
// HTML) — chỉ cần fetch HTML thường + cheerio, NHANH và NHẸ hơn nhiều, y hệt
// cách Pháo Hoa dùng API JSON (chỉ khác nguồn dữ liệu là HTML thay vì JSON).
const client = createHttpClient(
  {
    baseURL: GAVANG_BASE_URL,
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'vi,en-US;q=0.9,en;q=0.8'
    },
    timeout: 8000
  },
  { maxAttempts: 2 }
);

function getFullUrl(url) {
  if (!url) return '';
  if (url.startsWith('http') || url.startsWith('data:')) return url;
  return `${GAVANG_BASE_URL}${url.startsWith('/') ? '' : '/'}${url}`;
}

// CDN của nguồn này (thấy qua data-cdn="tencent"/"alibaba" trên trang chi
// tiết trận — cùng họ CDN mà Pháo Hoa cũng dùng) — tái dùng đúng cách phân
// loại của phaohoa.service.js cho nhất quán.
function detectCdn(url, hintedCdn) {
  const hint = String(hintedCdn || '').toLowerCase();
  if (hint === 'tencent') return 'TENCENT';
  if (hint === 'alibaba') return 'ALIBABA';
  const u = String(url || '').toLowerCase();
  if (u.includes('tencent') || u.includes('tlivecdn') || u.includes('liveplay')) return 'TENCENT';
  if (u.includes('alibaba') || u.includes('aliyun') || u.includes('alicdn')) return 'ALIBABA';
  if (u.includes('cloudflare')) return 'CLOUDFLARE';
  return 'HLS';
}


// FIX (16/11/2026 — "Gà Vàng không lấy được link các trận đang live, trước giờ đá vẫn hiện danh sách"): domain đã đổi
// (gavanglinkp.tv -> gavangz.net -> gavang13.live, xem SOURCE_DOMAINS trên git). Danh sách trận (trang chủ) vẫn đọc được nhưng link phát nằm ở TRANG CHI TIẾT từng trận,
// nơi code cũ chỉ đọc đúng 1 cấu trúc (#commentators-grid .commentator-card[data-stream-url]) và trận live không có link thì BỊ BỎ HẲN
// => mất sạch trận live. Các lỗi có thể gặp khi đổi domain, đã xử lý:
//  (1) href trận là URL TUYỆT ĐỐI trỏ domain cũ/mirror khác -> dựng lại trên domain đang dùng (toSiteUrl);
//  (2) cấu trúc trang chi tiết đổi (khác tên class/thuộc tính) -> dự phòng: thuộc tính data-* bất kỳ chứa .m3u8/.flv, rồi quét regex toàn trang
//      (đã giải mã &quot; \u0026 \/ );
//  (3) trang chi tiết chặn HTTP thường (403/Cloudflare) hoặc chỉ có link sau khi chạy JS -> mở bằng trình duyệt headless (tối đa
//      GAVANG_BROWSER_MAX trận/lần chạy, mặc định 8; tắt: GAVANG_BROWSER_FALLBACK=off);
//  (4) log chẩn đoán "[gavang] ..." khi trận live không lấy được link (HTTP status, tiêu đề, có grid không, số lần thấy m3u8/flv...).
const GAVANG_BROWSER_FALLBACK = String(process.env.GAVANG_BROWSER_FALLBACK || 'on').toLowerCase() !== 'off';
let browserBudget = Math.max(0, Number(process.env.GAVANG_BROWSER_MAX) || 3);
// (được đặt lại mỗi lần quét — xem getAllMatchesByTab/getStreamLinks; trước đây hết ngân sách ở lượt quét đầu thì lượt sau không còn headless)
// Log chi tiết từng trận chưa có link chỉ bật khi đặt GAVANG_DEBUG=on (mặc định tắt cho gọn log).
// FIX (16/11/2026 lần 3): mặc định LUÔN in chẩn đoán cho tối đa 3 trận live không lấy được link (trước đây phải bật GAVANG_DEBUG=on
// nên khi lỗi không có gì trong log để biết site trả gì). GAVANG_DEBUG=on -> tối đa 8 trận.
const GAVANG_DEBUG_ON = String(process.env.GAVANG_DEBUG || '').toLowerCase() === 'on';
let diagBudget = GAVANG_DEBUG_ON ? 8 : 3;
const BROWSER_MAX = Math.max(0, Number(process.env.GAVANG_BROWSER_MAX) || 3);
// Chỉ vào trang chi tiết những trận có ảnh BLV trên thẻ (hành vi cũ) khi đặt GAVANG_ONLY_BLV=on. Mặc định: thử TẤT CẢ trận live.
const GAVANG_ONLY_BLV = String(process.env.GAVANG_ONLY_BLV || '').toLowerCase() === 'on';
// Cache link đã lấy được theo trận (để getStreamLinks() của builder không phải tải lại trang chi tiết).
const STREAM_CACHE_TTL_MS = 3 * 60 * 1000;
const streamCache = new Map(); // originalId -> { at, list }
// Host quảng cáo/chat/analytics — KHÔNG phải player, bỏ qua khi dò iframe.
const NON_PLAYER_HOST_RE = /(google|doubleclick|facebook|twitter|youtube|gstatic|googletagmanager|alpro-api-service|antlive\.pro|sportsfeed\.pro|tracker\.|8xbet|cloudflare\.com|recaptcha)/i;
const STREAM_RE = /https?:\/\/[^\s"'<>\\]+?\.(?:m3u8|flv)(?:\?[^\s"'<>\\]*)?/gi;

// FIX (16/11/2026): domain gavang13.live nhúng player qua iframe dạng
// https://playyyz4.cc/e?hls=https%3A%2F%2Fplayback...m3u8&flv=...&cdn=tencent...
// => link nằm trong query-string đã MÃ HÓA %3A%2F nên regex .m3u8/.flv cũ không bắt được.
// safeDecodeURIComponent giải mã lại (lặp tối đa 2 lần, lỗi thì giữ nguyên).
function safeDecodeURIComponent(v) {
  let out = String(v || '');
  for (let i = 0; i < 2; i += 1) {
    try {
      const d = decodeURIComponent(out);
      if (d === out) break;
      out = d;
    } catch {
      break;
    }
  }
  return out;
}

// Rút link phát (hls/flv) từ 1 URL player kiểu ...?hls=<enc>&flv=<enc>&cdn=tencent
function extractFromPlayerUrl(rawUrl) {
  const decoded = decodeHtmlText(rawUrl);
  let hls = '';
  let flv = '';
  let cdn = '';
  try {
    const u = new URL(decoded, GAVANG_BASE_URL);
    hls = safeDecodeURIComponent(u.searchParams.get('hls') || u.searchParams.get('m3u8') || u.searchParams.get('url') || '');
    flv = safeDecodeURIComponent(u.searchParams.get('flv') || '');
    cdn = u.searchParams.get('cdn') || '';
  } catch {
    const mh = decoded.match(/[?&](?:hls|m3u8)=([^&\s"'<>]+)/i);
    const mf = decoded.match(/[?&]flv=([^&\s"'<>]+)/i);
    const mc = decoded.match(/[?&]cdn=([^&\s"'<>]+)/i);
    hls = mh ? safeDecodeURIComponent(mh[1]) : '';
    flv = mf ? safeDecodeURIComponent(mf[1]) : '';
    cdn = mc ? mc[1] : '';
  }
  if (!/^https?:\/\//i.test(hls)) hls = '';
  if (!/^https?:\/\//i.test(flv)) flv = '';
  return { hls, flv, cdn };
}

function decodeHtmlText(t) {
  return String(t || '')
    .replace(/&quot;|&#0*34;|&#x0*22;/gi, '"')
    .replace(/&amp;/gi, '&')
    .replace(/\\u0026/gi, '&')
    .replace(/\\u002f/gi, '/')
    .replace(/\\\//g, '/');
}

function toSiteUrl(href) {
  if (!href) return '';
  try {
    const base = new URL(GAVANG_BASE_URL);
    const u = new URL(href, base);
    if (u.host !== base.host) return `${base.origin}${u.pathname}${u.search}`; // domain cũ/mirror -> domain đang dùng
    return u.toString();
  } catch {
    return getFullUrl(href);
  }
}

function textOf($el) {
  return ($el.first().text() || '').replace(/\s+/g, ' ').trim();
}

/**
 * Parse 1 khối .match-card trên trang chủ (dùng chung cho cả list trận live
 * và trận sắp đá — trang chủ trộn chung, phân biệt qua class
 * bals-live-match/bals-upcoming-match/bals-finished-match trên chính card).
 */
function parseMatchCard($, card) {
  const $card = $(card);
  const matchId = $card.attr('data-match-id') || '';
  if (!matchId) return null;

  const matchTimeSec = parseInt($card.attr('data-match-time') || '0', 10);
  const matchDate = matchTimeSec ? new Date(matchTimeSec * 1000) : new Date();

  const cardClass = $card.attr('class') || '';
  const statusNameRaw = textOf($card.find('.bals-status-name'));
  const elapsedRaw = textOf($card.find('.bals-elapsed-time'));
  const isFinished = /bals-finished-match/.test(cardClass) || /^(FT|AET|ENDED|FINISHED|KẾT THÚC)$/i.test(statusNameRaw);
  // FIX (16/11/2026 lần 3): thẻ trận đang đá đôi khi không còn class bals-live-match (site đổi class) -> nhận thêm qua
  // class có chữ "live", trạng thái 1H/2H/HT/ET/PEN/LIVE, hoặc có phút thi đấu (vd 23', 45+2').
  const isLive = !isFinished && (
    /bals-live-match/.test(cardClass)
    || /(^|[\s_-])live([\s_-]|$)/i.test(cardClass)
    || /^(1H|2H|HT|ET|OT|PEN|LIVE|Q[1-4]|BREAK)$/i.test(statusNameRaw)
    || /^\d{1,3}(\+\d+)?'?$/.test(elapsedRaw)
  );
  const isUpcoming = !isLive && !isFinished;
  // FIX (23/09/2026 — đối chiếu lại với trang chủ thật): thẻ trận bóng rổ
  // có thêm data-sport="basketball" (thẻ bóng đá không có, mặc định coi là
  // football) — xem CSS chọn theo `[data-sport="basketball"]` trong chính
  // trang, không phải đoán mò.
  const sport = $card.attr('data-sport') === 'basketball' ? 'basketball' : 'football';

  const link = $card.find('> .block a[href*="/truc-tiep/"], > .block a[href*="/basketball/"]').first();
  const detailUrl = link.attr('href') || '';
  const slugMatch = detailUrl.match(/\/(?:truc-tiep|basketball)\/([^/]+)\/?/);
  const slug = slugMatch ? slugMatch[1] : '';

  const competitionName = textOf($card.find('.bals-competition-name'));
  const competitionLogo = getFullUrl($card.find('.bals-competition-name').prevAll('img').attr('src'));

  const homeTeamName = textOf($card.find('.bals-home-team-name')) || 'Home';
  const awayTeamName = textOf($card.find('.bals-away-team-name')) || 'Away';
  // Logo dùng data-src (lazy-load) — src thật chỉ là ảnh placeholder trong
  // suốt. Logo nằm ở THẺ CHA bọc chung (tên đội + logo là 2 phần tử con
  // ngang hàng của cùng 1 div), không nằm trong chính thẻ tên đội — dùng
  // .parent() (không phải .closest('div'), vì bals-home-team-name/away
  // CHÍNH LÀ 1 thẻ div, .closest('div') sẽ trả về ngay chính nó, .find('img')
  // bên trong nó luôn rỗng vì logo là anh em, không phải con).
  const homeTeamLogo = getFullUrl($card.find('.bals-home-team-name').parent().find('img').attr('data-src'));
  const awayTeamLogo = getFullUrl($card.find('.bals-away-team-name').parent().find('img').attr('data-src'));

  // Thẻ trận trên trang chủ liệt kê BLV bằng <img alt="Tên BLV"> (khác logo giải/đội/thẻ phạt/nhà cái).
  // Trận không có ảnh BLV nào = chưa có ai phát => khỏi tốn request vào trang chi tiết.
  const streamerNames = new Set();
  $card.find('img[alt]').each((_, im) => {
    const alt = ($(im).attr('alt') || '').trim();
    if (!alt || /^league$/i.test(alt) || /\blogo$/i.test(alt) || /yellow cards?/i.test(alt) || /8xbet/i.test(alt)) return;
    streamerNames.add(alt);
  });

  const homeScore = parseInt(textOf($card.find('.bals-home-score')) || '0', 10) || 0;
  const awayScore = parseInt(textOf($card.find('.bals-away-score')) || '0', 10) || 0;
  const statusName = textOf($card.find('.bals-status-name'));
  const elapsedTime = textOf($card.find('.bals-elapsed-time'));
  const halfTimeText = textOf($card.find('.bals-ht-score')) || '0-0';
  const cornersText = textOf($card.find('.bals-corners')) || '0-0';
  const yellowCardsText = textOf($card.find('.bals-yellow-cards')) || '0-0';

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
    matchId: `gv_${matchId}`,
    originalId: matchId,
    slug,
    hasStreamers: streamerNames.size > 0,
    detailUrl: detailUrl ? toSiteUrl(detailUrl) : '',
    source: 'gavang',
    sport,
    sportName: sport === 'basketball' ? 'BÓNG RỔ' : 'BÓNG ĐÁ',
    sportIcon: sport === 'basketball' ? 'fa-basketball' : 'fa-futbol',
    competition: { name: competitionName, logo: competitionLogo, icon: competitionLogo },
    homeTeam: { name: homeTeamName, logo: homeTeamLogo },
    awayTeam: { name: awayTeamName, logo: awayTeamLogo },
    score: { home: homeScore, away: awayScore },
    status: {
      isLive,
      isFinished,
      isHalfTime: /^HT$/i.test(statusName),
      isUpcoming,
      name: isLive ? (statusName || 'LIVE') : (isFinished ? 'FT' : 'Sắp diễn ra'),
      text: isLive ? (elapsedTime || statusName || 'LIVE') : (isFinished ? 'Kết thúc' : 'Sắp diễn ra'),
      elapsedTime: isLive ? elapsedTime : '',
      minutes: elapsedTime
    },
    stats: {
      halfTimeScore: halfTimeText,
      corners: cornersText,
      yellowCards: yellowCardsText
    },
    matchTime: matchDate.getTime(),
    matchTimeTimestamp: matchDate.getTime(),
    timeFormatted: `${timeStr} - ${dd}/${mm}`,
    dateStr,
    timeStr,
    isHot: false,
    // commentators/streams sẽ được gắn sau (chỉ với trận live, xem
    // attachStreamsForLiveMatches) — để rỗng ở bước parse danh sách này.
    commentators: [],
    streamers: [],
    streamUrl: '',
    stream: {
      // Placeholder khi chưa có link thật — KHÁC RỖNG để không bị loại khỏi
      // playlist tĩnh (xem FIX 23/09/2026 trong phalang.service.js, cùng
      // lỗi, cùng cách sửa).
      liveUrl: detailUrl ? toSiteUrl(detailUrl) : `${GAVANG_BASE_URL}/`,
      streamerName: null,
      streamerAvatar: null
    },
    odds: null
  };
}

function parseMatchListPage(html) {
  const $ = load(html);
  const matches = [];
  const seenIds = new Set();
  $('.match-card[data-match-id]').each((_, card) => {
    const m = parseMatchCard($, card);
    // Trang chủ lặp 1 trận ở nhiều tab/khối (vd bóng rổ xuất hiện 3 lần) -> chỉ giữ 1, đỡ request thừa.
    if (m && !seenIds.has(m.originalId)) {
      seenIds.add(m.originalId);
      matches.push(m);
    }
  });
  return matches;
}


// FIX (16/11/2026 lần 3): quét link phát trong 1 đoạn text bất kỳ (HTML/script/JSON nhúng/query-string của iframe).
// Bản cũ gọi decodeURIComponent trên CẢ trang -> gặp ký tự "%" lẻ (vd CSS 100%) là văng lỗi, giữ nguyên chuỗi => KHÔNG bắt được
// link bị mã hóa %3A%2F. Giờ giải mã TỪNG token riêng, lỗi token nào bỏ token đó.
function scanStreamUrlsInText(text) {
  const out = [];
  const add = (u) => {
    const clean = String(u || '').replace(/[\\\s"'<>)]+$/g, '');
    // bỏ URL của chính trang player (https://playyyz4.cc/e?hls=https%3A...m3u8) — link thật được tách riêng từ tham số hls=/flv=
    if (/[?&](?:hls|flv|m3u8|url|src|stream)=https?/i.test(clean) || /%3A%2F/i.test(clean)) return;
    if (/^https?:\/\//i.test(clean) && /\.(?:m3u8|flv)(?:\?|$)/i.test(clean) && !out.includes(clean)) out.push(clean);
  };
  const plain = decodeHtmlText(text);
  (plain.match(STREAM_RE) || []).forEach(add);
  // token mã hóa: https%3A%2F%2F...
  (plain.match(/https?%3A%2F%2F[^&"'\s<>\\]+/gi) || []).forEach((tok) => {
    const dec = safeDecodeURIComponent(tok);
    (dec.match(STREAM_RE) || []).forEach(add);
  });
  // tham số hls=/flv=/m3u8= ở bất kỳ đâu (kể cả link player bị escape trong JSON)
  const re = /[?&;](?:hls|flv|m3u8|stream|src|url)=([^&"'\s<>\\]+)/gi;
  let m;
  while ((m = re.exec(plain)) !== null) {
    const dec = safeDecodeURIComponent(m[1]);
    if (/^https?:\/\//i.test(dec)) (dec.match(STREAM_RE) || []).forEach(add);
  }
  return out;
}

// Tìm các iframe player (khác domain, không phải quảng cáo/chat) trong trang.
function findPlayerIframes(html) {
  const out = [];
  let $;
  try { $ = load(html); } catch { return out; }
  $('iframe[src], iframe[data-src]').each((_, el) => {
    const raw = decodeHtmlText($(el).attr('src') || $(el).attr('data-src') || '');
    if (!/^(https?:)?\/\//i.test(raw)) return;
    const abs = raw.startsWith('//') ? `https:${raw}` : raw;
    let host = '';
    try { host = new URL(abs).hostname; } catch { return; }
    if (NON_PLAYER_HOST_RE.test(host)) return;
    if (!out.includes(abs)) out.push(abs);
  });
  return out;
}

/**
 * Trang chủ chỉ cho danh sách + điểm số — link .m3u8/.flv thật chỉ nằm ở
 * trang chi tiết từng trận (#commentators-grid .commentator-card). Chỉ gọi
 * cho trận ĐANG LIVE (trận chưa đá không có gì để lấy, tốn request vô ích).
 */
function parseCommentatorsFromHtml(html) {
  const out = [];
  const seen = new Set();
  const push = (c) => {
    if (!c.streamUrl || seen.has(c.streamUrl)) return;
    seen.add(c.streamUrl);
    out.push(c);
  };
  let $;
  try { $ = load(html); } catch { return out; }

  // (0) CẤU TRÚC MỚI (gavang13.live): iframe player có hls=/flv= trong query-string.
  // Server mặc định = streamer đầu tiên; các server còn lại ở trang /link/N/ (xem fetchCommentatorsForMatch).
  $('iframe[src], iframe[data-src], [data-src*="hls="], [src*="hls="]').each((_, el) => {
    const raw = $(el).attr('src') || $(el).attr('data-src') || '';
    if (!/[?&](hls|flv|m3u8)=/i.test(raw)) return;
    const { hls, flv, cdn } = extractFromPlayerUrl(raw);
    const best = hls || flv;
    if (!best) return;
    let playerReferer = null;
    try { playerReferer = `${new URL(decodeHtmlText(raw), GAVANG_BASE_URL).origin}/`; } catch { /* bỏ qua */ }
    push({
      id: `server_${out.length + 1}`,
      name: `Server ${out.length + 1}`,
      avatar: '',
      streamUrl: best,
      flvStreamUrl: flv,
      isLive: true,
      cdn: detectCdn(best, cdn),
      // Referer/Origin thật khi phát = origin của iframe player (vd https://playyyz4.cc/), KHÔNG phải trang gavang13.live
      referer: playerReferer
    });
  });

  // (1) Cấu trúc cũ đã biết.
  $('#commentators-grid .commentator-card').each((_, el) => {
    const $c = $(el);
    const streamUrl = decodeHtmlText($c.attr('data-stream-url') || '');
    const flvUrl = decodeHtmlText($c.attr('data-stream-url-flv') || '');
    if (!streamUrl && !flvUrl) return;
    const name = $c.attr('data-stream-name') || textOf($c.find('span').first()) || 'Server';
    const avatarRaw = $c.find('img').attr('data-src') || $c.find('img').attr('src') || '';
    push({
      id: $c.attr('data-streamer-id') || name,
      name,
      avatar: getFullUrl(avatarRaw),
      streamUrl: streamUrl || flvUrl,
      flvStreamUrl: flvUrl,
      isLive: true,
      cdn: detectCdn(streamUrl || flvUrl, $c.attr('data-cdn'))
    });
  });

  // (2) Dự phòng: phần tử bất kỳ có thuộc tính data-* chứa link .m3u8/.flv (đổi tên class/thuộc tính).
  if (!out.length) {
    $('*').each((_, el) => {
      const attrs = el.attribs || {};
      const urls = [];
      for (const [k, v] of Object.entries(attrs)) {
        if (!/^data-/i.test(k)) continue;
        const found = decodeHtmlText(v).match(STREAM_RE);
        if (found) urls.push(...found);
      }
      if (!urls.length) return;
      const $c = $(el);
      const best = urls.find((u) => /\.m3u8(\?|$)/i.test(u)) || urls[0];
      const name = attrs['data-stream-name'] || attrs['data-name'] || attrs['data-blv'] || attrs.title || textOf($c.find('span').first()) || `Server ${out.length + 1}`;
      push({
        id: attrs['data-streamer-id'] || attrs['data-id'] || name,
        name,
        avatar: getFullUrl($c.find('img').attr('data-src') || $c.find('img').attr('src') || ''),
        streamUrl: best,
        flvStreamUrl: urls.find((u) => /\.flv(\?|$)/i.test(u)) || '',
        isLive: true,
        cdn: detectCdn(best, attrs['data-cdn'])
      });
    });
  }

  // (3) Dự phòng cuối: quét mọi link .m3u8/.flv trong cả trang (script/JSON nhúng, đã giải mã &quot; \\u0026 \\/ và %3A%2F từng token).
  if (!out.length) {
    scanStreamUrlsInText(html).forEach((u, i) => push({ id: `server_${i + 1}`, name: `Server ${i + 1}`, avatar: '', streamUrl: u, flvStreamUrl: /\.flv(\?|$)/i.test(u) ? u : '', isLive: true, cdn: detectCdn(u, '') }));
  }
  return out;
}

// FIX (16/11/2026): mỗi BLV/streamer có 1 trang riêng .../truc-tiep/<slug>/link/N/ (thẻ <a> tên BLV ở dưới khung player).
// Trang chi tiết chính chỉ nhúng link của server mặc định, muốn đủ server phải vào từng /link/N/.
function parseLinkAnchors(html) {
  const out = [];
  const seen = new Set();
  let $;
  try { $ = load(html); } catch { return out; }
  $('a[href*="/link/"]').each((_, a) => {
    const href = $(a).attr('href') || '';
    const m = href.match(/\/(?:truc-tiep|basketball)\/[^/]+\/link\/(\d+)\/?/);
    if (!m) return;
    const url = toSiteUrl(href);
    if (seen.has(url)) return;
    seen.add(url);
    const name = ($(a).text() || '').replace(/\s+/g, ' ').replace(/Profile/gi, ' ').replace(/\s+/g, ' ').trim()
      || $(a).find('img').attr('alt') || `Server ${m[1]}`;
    out.push({ url, name, index: Number(m[1]) });
  });
  return out.sort((a, b) => a.index - b.index);
}

async function fetchLinkPage(url) {
  try {
    const res = await client.get(url);
    return typeof res.data === 'string' ? res.data : '';
  } catch (error) {
    console.warn(`[gavang] trang link ${url} lỗi HTTP ${error.response?.status || error.code || ''}: ${error.message}`);
    return typeof error.response?.data === 'string' ? error.response.data : '';
  }
}

// Ngân sách thời gian cho cả lần quét (builder huỷ nguồn nếu quá 90s) — hết giờ thì bỏ qua trận còn lại, giữ kết quả đã có.
let scanDeadline = 0;

async function fetchCommentatorsForMatch(match) {
  if (!match.detailUrl) return [];
  const cached = streamCache.get(match.originalId);
  if (cached && Date.now() - cached.at < STREAM_CACHE_TTL_MS && cached.list.length) return cached.list;
  if (scanDeadline && Date.now() > scanDeadline) return [];
  let html = '';
  let status = 0;
  let via = 'HTTP';
  try {
    // Gửi kèm Referer = trang chủ như người dùng bấm từ danh sách vào (một số site chặn truy cập thẳng trang chi tiết).
    const res = await client.get(match.detailUrl, { headers: { Referer: `${GAVANG_BASE_URL}/` } });
    html = typeof res.data === 'string' ? res.data : '';
    status = res.status;
  } catch (error) {
    status = error.response?.status || 0;
    html = typeof error.response?.data === 'string' ? error.response.data : '';
    console.warn(`[gavang] trang chi tiết ${match.slug || match.matchId} lỗi HTTP ${status || error.code || ''}: ${error.message}`);
  }

  let list = html ? parseCommentatorsFromHtml(html) : [];
  const mainHtml = html;

  // Không có link (hoặc bị chặn / link chỉ có sau khi chạy JS) -> trình duyệt headless.
  if (!list.length && GAVANG_BROWSER_FALLBACK && browserBudget > 0) {
    browserBudget -= 1;
    try {
      const r = await fetchRenderedHtml(match.detailUrl, {
        timeoutMs: 25000,
        waitForSelector: 'iframe[src*="hls="], #commentators-grid .commentator-card',
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
      });
      if (r?.html) {
        html = r.html;
        status = r.status || status;
        via = 'trình duyệt headless';
        list = parseCommentatorsFromHtml(html);
      }
    } catch (err) {
      console.warn(`[gavang] trình duyệt headless lỗi (${match.slug || match.matchId}):`, err.message);
    }
  }

  // FIX (16/11/2026 lần 3): trang chi tiết có iframe player nhưng KHÔNG kèm hls=/flv= trên URL (link nằm bên trong trang player,
  // vd https://playyyz4.cc/e?...) -> mở thẳng iframe (kèm Referer = trang trận) rồi quét link ở đó.
  if (!list.length && html) {
    const frames = findPlayerIframes(html).slice(0, 2);
    for (const frameUrl of frames) {
      // eslint-disable-next-line no-await-in-loop
      if (scanDeadline && Date.now() > scanDeadline) break;
      let frameHtml = '';
      try {
        // eslint-disable-next-line no-await-in-loop
        const r = await client.get(frameUrl, { baseURL: undefined, headers: { Referer: match.detailUrl, Origin: GAVANG_BASE_URL } });
        frameHtml = typeof r.data === 'string' ? r.data : (r.data ? JSON.stringify(r.data) : '');
      } catch (error) {
        frameHtml = typeof error.response?.data === 'string' ? error.response.data : '';
      }
      const fromUrl = extractFromPlayerUrl(frameUrl);
      const urls = [fromUrl.hls, fromUrl.flv, ...scanStreamUrlsInText(frameHtml)].filter(Boolean);
      let frameOrigin = null;
      try { frameOrigin = `${new URL(frameUrl).origin}/`; } catch { /* bỏ qua */ }
      [...new Set(urls)].forEach((u, i) => list.push({
        id: `server_${list.length + 1}`,
        name: `Server ${list.length + 1}`,
        avatar: '',
        streamUrl: u,
        flvStreamUrl: /\.flv(\?|$)/i.test(u) ? u : '',
        isLive: true,
        cdn: detectCdn(u, fromUrl.cdn),
        referer: frameOrigin
      }));
      if (list.length) { via = `iframe ${frameUrl.slice(0, 60)}`; break; }
    }
  }

  // Lấy thêm các server của từng BLV ở /link/N/ (nếu có) và gắn đúng tên BLV.
  if (list.length || html) {
    const anchors = parseLinkAnchors(mainHtml || html).slice(0, 4);
    if (anchors.length) {
      const pages = await mapPool(anchors, 2, (a) => (scanDeadline && Date.now() > scanDeadline ? '' : fetchLinkPage(a.url)));
      const byUrl = new Map(list.map((c) => [c.streamUrl, c]));
      anchors.forEach((a, i) => {
        const found = pages[i] ? parseCommentatorsFromHtml(pages[i]) : [];
        const first = found.find((c) => c.streamUrl);
        if (!first) return;
        const existing = byUrl.get(first.streamUrl);
        if (existing) {
          // link/1 thường trùng server mặc định: chỉ gắn lại tên BLV cho đúng
          if (/^Server \d+$/i.test(existing.name)) { existing.name = a.name; existing.id = a.name; }
          return;
        }
        const entry = { ...first, id: `${a.name}#${a.index}`, name: a.name };
        byUrl.set(entry.streamUrl, entry);
        list.push(entry);
      });
    }
  }

  if (!list.length) {
    if (diagBudget > 0) {
      diagBudget -= 1;
      const title = (html.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1] || '';
      const plain = decodeHtmlText(html);
      console.warn(`[gavang] KHÔNG lấy được link trận live ${match.slug || match.matchId} (${match.detailUrl}) — ${via}, HTTP ${status}, độ dài ${html.length}, tiêu đề "${title.trim().slice(0, 80)}", iframe=${findPlayerIframes(html).map((u) => u.slice(0, 70)).join(' | ') || 'không'}, có #commentators-grid=${/id=["']commentators-grid/i.test(html)}, thẻ commentator-card=${(html.match(/commentator-card/g) || []).length}, "m3u8"x${(plain.match(/m3u8/gi) || []).length}, "flv"x${(plain.match(/\.flv/gi) || []).length}, đầu trang: ${plain.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160)}`);
    }
    return [];
  }

  // FIX (24/09/2026): xếp link HLS (.m3u8) lên trước, FLV/khác xuống sau (sort ổn định).
  const rank = (c) => (/\.m3u8(\?|$)/i.test(c.streamUrl) ? 0 : (/\.flv(\?|$)/i.test(c.streamUrl) ? 2 : 1));
  const sorted = list
    .map((c, i) => ({ c, i }))
    .sort((a, b) => rank(a.c) - rank(b.c) || a.i - b.i)
    .map(({ c }) => c);
  if (match.originalId) streamCache.set(match.originalId, { at: Date.now(), list: sorted });
  return sorted;
}

function applyCommentators(match, commentators) {
  if (!commentators.length) return match;
  const primaryStream = commentators.find((c) => c.streamUrl)?.streamUrl || '';
  return {
    ...match,
    commentators,
    streamers: commentators,
    streamUrl: primaryStream,
    stream: {
      liveUrl: match.stream.liveUrl,
      streamerName: commentators[0]?.name || null,
      streamerAvatar: commentators[0]?.avatar || null
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
      cdn: c.cdn,
      quality: 'HD'
    });
  }
  return list;
}

class GaVangService {
  /** Full scan 1 lần: lấy toàn bộ trận trên trang chủ (live + sắp đá trộn chung). */
  async fetchHomepageMatches() {
    const { data: html } = await client.get('/');
    const matches = parseMatchListPage(html);
    if (!matches.length) {
      // Domain mới có thể đổi cấu trúc (hoặc là SPA render bằng JS) -> không còn .match-card[data-match-id] trong HTML thô.
      const text = typeof html === 'string' ? html : '';
      const title = (text.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1] || '';
      console.warn(`[gavang] trang chủ ${GAVANG_BASE_URL} KHÔNG có .match-card nào — độ dài ${text.length}, tiêu đề "${title.trim().slice(0, 80)}", match-card x${(text.match(/match-card/g) || []).length}, data-match-id x${(text.match(/data-match-id/g) || []).length}, "truc-tiep" x${(text.match(/truc-tiep/g) || []).length}, SPA(root/app)=${/id=["'](root|app|__next)["']/i.test(text)}, đầu trang: ${text.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160)}`);
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

      // Chỉ trận LIVE mới cần gọi thêm trang chi tiết để lấy link stream
      // thật — trận sắp đá chưa có gì để lấy (xem fetchCommentatorsForMatch).
      // FIX (24/09/2026 — "có trận lỗi không xem được"): Gà Vàng hay quên
      // cập nhật trạng thái — trận đã đá xong từ lâu vẫn mang class
      // bals-live-match, link stream của nó đã chết -> bấm vào là lỗi.
      // isStaleLiveMatch() (playerGet.js) đã có sẵn nhưng chưa nơi nào gọi:
      // bỏ các trận "live" đã quá thời lượng hợp lý so với giờ bóng lăn.
      const staleLive = filtered.filter((m) => m.status.isLive && isStaleLiveMatch(m));
      if (staleLive.length) {
        console.log(`[gavang] bỏ ${staleLive.length} trận "live" đã quá giờ (nguồn chưa cập nhật trạng thái): ${staleLive.map((m) => m.slug || m.matchId).join(', ')}`);
        filtered = filtered.filter((m) => !staleLive.includes(m));
      }

      const liveMatches = filtered.filter((m) => m.status.isLive);
      if (liveMatches.length) {
        scanDeadline = Date.now() + 60000;
        browserBudget = BROWSER_MAX;
        diagBudget = GAVANG_DEBUG_ON ? 8 : 3;
        // Chỉ vào trang chi tiết các trận live đã có BLV trên trang chủ. Nếu KHÔNG trận nào có dấu hiệu BLV
        // (có thể nguồn đổi giao diện) thì quay về hành vi cũ: thử tất cả.
        const anyStreamerHint = liveMatches.some((m) => m.hasStreamers);
        // FIX (16/11/2026 lần 3): trước đây khi có ÍT NHẤT 1 trận có ảnh BLV thì trận live KHÔNG có ảnh BLV trên thẻ bị bỏ qua hẳn
        // (không vào trang chi tiết) -> mất trận live dù trang chi tiết có link. Giờ thử TẤT CẢ trận live, trận có BLV xếp trước.
        const toFetch = (anyStreamerHint && GAVANG_ONLY_BLV)
          ? liveMatches.filter((m) => m.hasStreamers)
          : [...liveMatches.filter((m) => m.hasStreamers), ...liveMatches.filter((m) => !m.hasStreamers)];
        const fetchedList = await mapPool(toFetch, Math.min(concurrency, 4), (m) => fetchCommentatorsForMatch(m));
        const commentatorsList = liveMatches.map((m) => {
          const k = toFetch.indexOf(m);
          return k === -1 ? [] : (fetchedList[k] || []);
        });
        const withStreams = new Set();
        liveMatches.forEach((m, i) => {
          const commentators = commentatorsList[i] || [];
          if (commentators.length) {
            const updated = applyCommentators(m, commentators);
            const idx = filtered.indexOf(m);
            if (idx !== -1) filtered[idx] = updated;
            withStreams.add(m.matchId);
          }
        });
        // FIX (24/09/2026 — theo yêu cầu "chỉ lấy các trận có bình luận
        // viên thôi"): trận đang live nhưng CHƯA có BLV nào gán (trang chi
        // tiết trống, #commentators-grid rỗng — thường là trận nhỏ, ít
        // người xem, nguồn chưa phân công ai) trước đây vẫn hiện trong
        // playlist kèm dòng "Chưa có link — chờ cập nhật", giờ BỎ HẲN khỏi
        // danh sách luôn thay vì hiện placeholder không xem được.
        console.log(`[gavang] ${liveMatches.length - withStreams.size} trận chưa có BLV (bị bỏ), ${withStreams.size}/${liveMatches.length} trận live có link (nguồn ${GAVANG_BASE_URL})`);
        filtered = filtered.filter((m) => !m.status.isLive || withStreams.has(m.matchId));
      }

      return { matches: filtered, hasMore: false, totalCount: filtered.length };
    } catch (error) {
      console.error(`Error fetching GaVang tab ${tab}:`, error.message);
      return { matches: [], hasMore: false, totalCount: 0 };
    }
  }

  async getStreamLinks(matchId) {
    try {
      const all = await this.fetchHomepageMatches();
      const cleanId = String(matchId).replace(/^gv_/, '');
      const match = all.find((m) => m.originalId === cleanId || m.matchId === matchId || m.slug === matchId);
      if (!match) return [];
      // FIX (16/11/2026 lần 3): scanDeadline/browserBudget là biến cấp module — sau lượt quét danh sách (60s) chúng đã HẾT HẠN/HẾT NGÂN SÁCH
      // nên getStreamLinks (builder gọi sau) trả [] ngay mà không tải gì. Đặt lại hạn riêng cho lần gọi này.
      scanDeadline = Date.now() + 25000;
      if (browserBudget < 1) browserBudget = 1;
      const commentators = await fetchCommentatorsForMatch(match);
      return mapStreams(applyCommentators(match, commentators));
    } catch (error) {
      console.error('Error fetching GaVang stream links:', error.message);
      return [];
    }
  }
}

const gavangService = new GaVangService();
export default gavangService;
