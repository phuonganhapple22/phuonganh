import { load } from 'cheerio';
import { createHttpClient } from '@/src/utils/httpClient';
import { mapPool, isStaleLiveMatch } from '@/src/utils/playerGet';

// Domain nguồn lậu này cũng đổi thường xuyên (đã thấy nhiều domain mirror
// cùng thương hiệu: gavangtv.tv, gavangtvv.cc, gavanglinkp.tv...) — override
// qua biến môi trường GAVANG_DOMAIN trên Vercel/GitHub Actions khi cần,
// không cần sửa code.
const GAVANG_BASE_URL = process.env.GAVANG_DOMAIN || process.env.GAVANG_BASE_URL || 'https://gavanglinkp.tv';

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
  const isLive = /bals-live-match/.test(cardClass);
  const isFinished = /bals-finished-match/.test(cardClass);
  const isUpcoming = !isLive && !isFinished;
  // FIX (23/09/2026 — đối chiếu lại với trang chủ thật): thẻ trận bóng rổ
  // có thêm data-sport="basketball" (thẻ bóng đá không có, mặc định coi là
  // football) — xem CSS chọn theo `[data-sport="basketball"]` trong chính
  // trang, không phải đoán mò.
  const sport = $card.attr('data-sport') === 'basketball' ? 'basketball' : 'football';

  const link = $card.find('> .block a[href*="/truc-tiep/"]').first();
  const detailUrl = link.attr('href') || '';
  const slugMatch = detailUrl.match(/\/truc-tiep\/([^/]+)\/?/);
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
    detailUrl: detailUrl ? getFullUrl(detailUrl) : '',
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
      liveUrl: detailUrl ? getFullUrl(detailUrl) : `${GAVANG_BASE_URL}/`,
      streamerName: null,
      streamerAvatar: null
    },
    odds: null
  };
}

function parseMatchListPage(html) {
  const $ = load(html);
  const matches = [];
  $('.match-card[data-match-id]').each((_, card) => {
    const m = parseMatchCard($, card);
    if (m) matches.push(m);
  });
  return matches;
}

/**
 * Trang chủ chỉ cho danh sách + điểm số — link .m3u8/.flv thật chỉ nằm ở
 * trang chi tiết từng trận (#commentators-grid .commentator-card). Chỉ gọi
 * cho trận ĐANG LIVE (trận chưa đá không có gì để lấy, tốn request vô ích).
 */
async function fetchCommentatorsForMatch(match) {
  if (!match.detailUrl) return [];
  try {
    const { data: html } = await client.get(match.detailUrl);
    const $ = load(html);
    const commentators = [];
    $('#commentators-grid .commentator-card').each((_, el) => {
      const $c = $(el);
      const streamUrl = $c.attr('data-stream-url') || '';
      const flvUrl = $c.attr('data-stream-url-flv') || '';
      if (!streamUrl && !flvUrl) return;
      const name = $c.attr('data-stream-name') || textOf($c.find('span').first()) || 'Server';
      const avatarRaw = $c.find('img').attr('data-src') || $c.find('img').attr('src') || '';
      commentators.push({
        id: $c.attr('data-streamer-id') || name,
        name,
        avatar: getFullUrl(avatarRaw),
        streamUrl: streamUrl || flvUrl,
        flvStreamUrl: flvUrl,
        isLive: true,
        cdn: detectCdn(streamUrl || flvUrl, $c.attr('data-cdn'))
      });
    });
    // FIX (24/09/2026 — "có trận xem được, có trận lỗi"): mỗi trận có nhiều
    // BLV, mỗi BLV 1 link riêng; playlist chỉ lấy link ĐẦU TIÊN. Trước đây
    // giữ nguyên thứ tự trên trang nên nhiều trận bị dồn vào link FLV (hoặc
    // link không phải HLS) dù trận đó có sẵn link HLS — app IPTV/player web
    // xử lý FLV kém hơn hẳn HLS. Xếp link HLS (.m3u8) lên trước, FLV/khác
    // xuống sau (sort ổn định — giữ nguyên thứ tự BLV trong cùng nhóm).
    const rank = (c) => (/\.m3u8(\?|$)/i.test(c.streamUrl) ? 0 : (/\.flv(\?|$)/i.test(c.streamUrl) ? 2 : 1));
    return commentators
      .map((c, i) => ({ c, i }))
      .sort((a, b) => rank(a.c) - rank(b.c) || a.i - b.i)
      .map(({ c }) => c);
  } catch (error) {
    console.error(`Error fetching GaVang match detail (${match.slug}):`, error.message);
    return [];
  }
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
    return parseMatchListPage(html);
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
        const commentatorsList = await mapPool(liveMatches, concurrency, (m) => fetchCommentatorsForMatch(m));
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
