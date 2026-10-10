import { buildMatchSlug, slugifyVi } from '@/src/utils/slug';
import { fetchPageGlobal } from '@/src/utils/browserFetch';

// KhanDaiTV (tên gọi khác: "Khán Đài TV") — đã xác nhận qua bản HTML lấy từ
// site (window.__NUXT__/__NUXT_DATA__, 08/09/2026): cùng schema trận đấu
// (id, sport, home_team_name, tournament_name, commentators[].stream_url...)
// với nguồn Pháo Hoa đã có (xem phaohoa.service.js) — tức CÙNG 1 backend,
// khác domain/skin. Theo yêu cầu, vẫn thêm thành 1 nguồn RIÊNG trên giao
// diện (chấp nhận có thể trùng trận với Pháo Hoa vì chung backend).
//
// FIX (09/09/2026 — theo yêu cầu "đừng bắt chước domain Pháo Hoa"): domain
// THẬT, ĐỘC LẬP do người dùng cung cấp: https://khandai3.link.
//
// FIX (10/09/2026 — QUAN TRỌNG, đổi hẳn cách lấy dữ liệu): domain này được
// Cloudflare bảo vệ bằng "Just a moment..." (JS challenge) cho TOÀN BỘ
// domain (đã tự kiểm tra: cả trang chủ lẫn /api/matches/ đều bị chặn 403
// như nhau khi gọi bằng axios/HTTP thường từ server) — KHÔNG phải chặn
// riêng API. Gọi thẳng /api/matches/ bằng axios (kiểu phaohoa.service.js)
// KHÔNG dùng được ở nguồn này. Chuyển sang dùng trình duyệt Chromium
// headless thật (đã có sẵn cho nguồn Giờ Vàng, xem src/utils/browserFetch)
// để mở trang chủ — trình duyệt thật có thể vượt qua challenge vì nó chạy
// đúng JS mà Cloudflare yêu cầu (không đảm bảo 100%, tuỳ mức độ chặn, nhưng
// là cách duy nhất còn khả thi). Sau khi trang tải xong, đọc thẳng
// window.__NUXT__ (dữ liệu đã được chính app tự giải mã để chạy, khỏi cần
// tự viết lại bộ giải mã định dạng "devalue" mà Nuxt dùng để nhúng dữ liệu
// vào HTML).
//
// Vì mở trình duyệt tốn vài giây (không thể làm mỗi query như axios), toàn
// bộ trận (mọi môn, mọi trạng thái) được lấy 1 LẦN duy nhất mỗi khi cache
// hết hạn (RAW_CACHE_TTL_MS), sau đó MỌI hàm bên dưới (getMatchesByTab,
// getCounts, findRawMatch...) đều lọc lại từ danh sách đã lấy sẵn trong bộ
// nhớ, thay vì tự gọi mạng riêng như các nguồn khác.
const KHANDAITV_BASE_URL = process.env.KHANDAITV_DOMAIN || process.env.KHANDAITV_BASE_URL || 'https://khandai3.link';

// Domain Khán Đài chỉ dùng ĐÚNG 1 giá trị khai báo (khandaitv=... trong SOURCE_DOMAINS, hoặc KHANDAITV_BASE_URL).
const KHANDAITV_CANDIDATES = [KHANDAITV_BASE_URL.replace(/\/+$/, '')];
const activeBaseUrl = () => KHANDAITV_CANDIDATES[0];

const SPORT_ID_MAP = {
  football: 41,
  'bong-chuyen': 43,
  volleyball: 43,
  billiards: 44,
  'cau-long': 45,
  esports: 46,
  'bong-ro': 47,
  basketball: 47,
  tennis: 48,
  'bong-ban': 49,
  boxing: 50
};

// Trận đấu trong payload luôn có 2 khoá này — dùng để nhận diện 1 object
// bất kỳ trong cây dữ liệu window.__NUXT__ có phải là 1 trận đấu hay không,
// KHÔNG cần biết trước tên khoá cha (vd "catalog"/"matches"/"live"...) mà
// app này dùng để chứa danh sách trận — mỗi site Nuxt có thể đặt tên khác
// nhau, nhưng bản thân object trận đấu thì luôn có các trường này (đã xác
// nhận qua JSON thật từ /api/matches/ do người dùng gửi).
function looksLikeRawMatch(obj) {
  return !!obj
    && typeof obj === 'object'
    && !Array.isArray(obj)
    && 'id' in obj
    && 'home_team_name' in obj
    && 'away_team_name' in obj;
}

function collectRawMatches(node, seen, out, depth = 0) {
  if (!node || depth > 8) return;
  if (Array.isArray(node)) {
    for (const item of node) {
      if (looksLikeRawMatch(item)) {
        if (!seen.has(item.id)) {
          seen.add(item.id);
          out.push(item);
        }
      } else if (item && typeof item === 'object') {
        collectRawMatches(item, seen, out, depth + 1);
      }
    }
    return;
  }
  if (typeof node === 'object') {
    for (const key of Object.keys(node)) {
      collectRawMatches(node[key], seen, out, depth + 1);
    }
  }
}

let rawMatchesCache = { data: null, fetchedAt: 0, pending: null };
const RAW_CACHE_TTL_MS = 20 * 1000; // đủ nhanh cho tỉ số live, đủ lâu để đỡ mở trình duyệt liên tục

// FIX (02/10/2026 — "cứ quét ra 0 trận rồi lại quét ra bình thường, lặp đi lặp lại"):
// trình duyệt headless vượt Cloudflare KHÔNG chắc 100% mỗi lần (xem ghi chú
// bên dưới) — có lượt kẹt ở trang "Just a moment..." nên ra 0 trận, lượt sau
// lại qua được. Lỗi gốc: lượt rỗng đó vẫn bị LƯU vào cache như một kết quả hợp
// lệ và GHI ĐÈ dữ liệu tốt vừa lấy được -> workflow quét mỗi 2 phút sinh ra
// playlist 0 trận (mọi kênh Khán Đài biến mất khỏi VLC/app) rồi lại đầy lại.
// Cách sửa: nhớ riêng "lần quét tốt gần nhất" (lastGood); lượt nào ra rỗng/lỗi
// thì DÙNG LẠI dữ liệu đó thay vì trả rỗng, tối đa STALE_MAX_MS (mặc định 15
// phút, đổi bằng env KHANDAITV_STALE_MAX_MS) — quá hạn mà vẫn rỗng mới thừa
// nhận là hết trận/lỗi thật để không giữ dữ liệu cũ mãi.
let lastGood = { data: null, at: 0 };
const STALE_MAX_MS = (() => {
  const raw = String(process.env.KHANDAITV_STALE_MAX_MS ?? '').trim();
  return raw !== '' && Number.isFinite(Number(raw)) && Number(raw) >= 0 ? Number(raw) : 15 * 60 * 1000;
})();

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
   * Lấy TOÀN BỘ trận (mọi môn, mọi trạng thái) đúng 1 lần bằng trình duyệt
   * headless thật, cache lại trong bộ nhớ ~20s. Mọi hàm khác trong class
   * này đều gọi qua đây rồi tự lọc, KHÔNG gọi mạng riêng lẻ nữa.
   */
  async getAllRawMatches() {
    const now = Date.now();
    if (rawMatchesCache.data && now - rawMatchesCache.fetchedAt < RAW_CACHE_TTL_MS) {
      return rawMatchesCache.data;
    }
    // Nhiều request cùng lúc khi cache vừa hết hạn → chỉ mở trình duyệt 1
    // lần, các request còn lại đợi chung kết quả đó.
    if (rawMatchesCache.pending) {
      return rawMatchesCache.pending;
    }

    // FIX (27/09/2026 — "luôn báo 0 trận, không rõ vì sao"): trước đây chỉ
    // thử 1 LẦN DUY NHẤT rồi bỏ cuộc luôn nếu ra rỗng — nhưng bản thân cơ
    // chế vượt Cloudflare (poll liên tục chờ challenge tự giải, xem
    // browserFetch.js) vốn đã KHÔNG chắc chắn 100% mỗi lần thử, có thể ăn
    // may qua được ở lần thử thứ 2 dù lần 1 vẫn còn kẹt ở trang "Just a
    // moment...". Thử lại 1 lần với TAB MỚI (không dùng lại tab cũ có thể
    // đã bị đánh dấu/kẹt) trước khi kết luận hẳn là lỗi, đồng thời LUÔN in
    // ra chẩn đoán (tiêu đề trang, URL cuối cùng, đoạn text đầu trang) khi
    // ra rỗng — để log lần sau chỉ thẳng ĐÚNG nguyên nhân (còn kẹt Cloudflare
    // hay domain đã đổi/chết) thay vì chỉ thấy mỗi "0 trận".
    const attemptFetch = async (attemptLabel, baseUrl) => {
      const { data, status, diagnostic } = await fetchPageGlobal(`${baseUrl}/`, {
        evalExpr: 'window.__NUXT__',
        timeoutMs: 28000,
        bailOnTitle: /^(?!.*(trực tiếp|xem bóng)).*(cá cược|nhà cái|casino|nổ hũ|đá gà)/i, // không bail nếu tiêu đề nói về xem trực tiếp // FIX (08/10/2026): trang cá cược mạo danh -> thôi chờ
        autoUserAgent: true // FIX (06/10/2026): UA thật của Chromium đang chạy, không dùng UA cứng Chrome/120 lệch phiên bản
      });
      const out = [];
      collectRawMatches(data, new Set(), out);
      if (!out.length) {
        const isChallenge = diagnostic && /just a moment|checking your browser|attention required/i.test(
          `${diagnostic.title} ${diagnostic.bodySnippet}`
        );
        // FIX (06/10/2026): url="about:blank" = tab CHƯA hề mở được trang (lỗi mạng/DNS/bị cắt kết nối),
        // không phải "trang tải xong mà đổi schema" như thông báo cũ — nói rõ + in lỗi goto thật.
        const neverLoaded = diagnostic && (!diagnostic.finalUrl || diagnostic.finalUrl === 'about:blank' || /^chrome-error:/i.test(diagnostic.finalUrl));
        console.error(
          `[khandaitv] ${attemptLabel} (${baseUrl}): 0 trận (HTTP ${status || 'n/a'})` +
          (neverLoaded
            ? ` — KHÔNG MỞ ĐƯỢC TRANG ${baseUrl}` +
              (diagnostic.gotoError ? `, lỗi goto: ${diagnostic.gotoError}` : '') +
              ' [domain có thể đã chết/đổi: kiểm tra KHANDAITV_BASE_URL trong SOURCE_DOMAINS, hoặc chạy Check Domains]'
            : diagnostic && /^(?!.*(trực tiếp|xem bóng)).*(cá cược|nhà cái|casino|nổ hũ|đá gà)/i.test(diagnostic.title)
            ? ` — title="${diagnostic.title}" url="${diagnostic.finalUrl}" [ĐÂY LÀ TRANG CÁ CƯỢC/NHÀ CÁI, KHÔNG PHẢI Khán Đài TV — domain sai/bị đổi chủ, sửa khandaitv=... trong SOURCE_DOMAINS]`
            : diagnostic
            ? ` — title="${diagnostic.title}" url="${diagnostic.finalUrl}"` +
              (diagnostic.gotoError ? ` goto="${diagnostic.gotoError}"` : '') +
              (isChallenge ? ' [NGHI NGỜ vẫn đang kẹt ở trang thách thức Cloudflare]' : ' [trang tải xong nhưng không thấy window.__NUXT__ có trận — có thể domain đã đổi schema/API]')
            : ' — không lấy được chẩn đoán trang (page.evaluate lỗi).')
        );
      }
      return out;
    };

    // Dữ liệu cũ còn dùng được (trong hạn STALE_MAX_MS) hoặc null.
    const staleData = () => {
      const age = Date.now() - lastGood.at;
      return lastGood.data && lastGood.data.length && age <= STALE_MAX_MS ? { data: lastGood.data, ageSec: Math.round(age / 1000) } : null;
    };

    const task = (async () => {
      try {
        let out = await attemptFetch('lần 1', activeBaseUrl());
        if (!out.length) {
          out = await attemptFetch('lần 2 (thử lại)', activeBaseUrl());
        }
        if (out.length) {
          lastGood = { data: out, at: Date.now() };
          rawMatchesCache = { data: out, fetchedAt: Date.now(), pending: null };
          return out;
        }
        // Rỗng sau 2 lần thử: KHÔNG ghi đè dữ liệu tốt — dùng lại bản gần nhất.
        const stale = staleData();
        if (stale) {
          console.warn(`[khandaitv] lần quét này ra 0 trận — dùng lại ${stale.data.length} trận của lần quét tốt cách đây ${stale.ageSec}s (tối đa ${Math.round(STALE_MAX_MS / 1000)}s)`);
          rawMatchesCache = { data: stale.data, fetchedAt: Date.now(), pending: null };
          return stale.data;
        }
        rawMatchesCache = { data: out, fetchedAt: Date.now(), pending: null };
        return out;
      } catch (error) {
        console.error('Error fetching KhanDaiTV via browser [build-marker-v2]:', error.message);
        const stale = staleData();
        const data = stale ? stale.data : (rawMatchesCache.data || []);
        if (stale) console.warn(`[khandaitv] lỗi khi quét — dùng lại ${stale.data.length} trận của lần quét tốt cách đây ${stale.ageSec}s`);
        rawMatchesCache = { data, fetchedAt: data.length ? Date.now() : 0, pending: null };
        return data;
      }
    })();

    rawMatchesCache.pending = task;
    return task;
  }

  normalizeMatch(m) {
    // FIX (10/09/2026 — theo dữ liệu JSON thật người dùng gửi từ
    // /api/matches/?ordering=smart&page_size=30): khandai3.link dùng status
    // CHI TIẾT theo từng giai đoạn trận đấu (vd "half_time" khi đang nghỉ
    // giữa hiệp) — KHÁC với Pháo Hoa vốn chỉ trả đúng 1 chữ "live" chung
    // cho mọi trận đang đá. Coi mọi status KHÔNG nằm trong nhóm "chưa đá"
    // và KHÔNG nằm trong nhóm "đã kết thúc" là đang live (chấp nhận mọi giá
    // trị con chưa biết trước như first_half/second_half/extra_time...).
    const rawStatus = String(m.status || '').toLowerCase();
    const NOT_STARTED_STATUSES = new Set(['scheduled', 'not_started', 'upcoming', 'pending', 'ns']);
    const FINISHED_STATUSES = new Set(['finished', 'ended', 'ft', 'full_time', 'cancelled', 'canceled', 'postponed', 'abandoned', 'awarded']);
    const isNotStarted = NOT_STARTED_STATUSES.has(rawStatus);
    const isFinished = FINISHED_STATUSES.has(rawStatus);
    const isLive = !!rawStatus && !isNotStarted && !isFinished;

    const sportInfoMap = {
      41: { name: 'BÓNG ĐÁ', icon: 'fa-futbol', slug: 'football' },
      43: { name: 'BÓNG CHUYỀN', icon: 'fa-volleyball', slug: 'bong-chuyen' },
      44: { name: 'BILLIARDS', icon: 'fa-circle-dot', slug: 'billiards' },
      45: { name: 'CẦU LÔNG', icon: 'fa-feather', slug: 'cau-long' },
      46: { name: 'ESPORTS', icon: 'fa-gamepad', slug: 'esports' },
      47: { name: 'BÓNG RỔ', icon: 'fa-basketball', slug: 'bong-ro' },
      48: { name: 'TENNIS', icon: 'fa-baseball-bat-ball', slug: 'tennis' },
      49: { name: 'BÓNG BÀN', icon: 'fa-table-tennis-paddle-ball', slug: 'bong-ban' },
      50: { name: 'BOXING', icon: 'fa-hand-fist', slug: 'boxing' }
    };

    const sportInfo = sportInfoMap[m.sport]
      || (m.sport_slug ? { name: (m.sport_name || m.sport_slug).toUpperCase(), icon: 'fa-futbol', slug: m.sport_slug } : null)
      || { name: 'BÓNG ĐÁ', icon: 'fa-futbol', slug: 'football' };

    const matchDate = m.start_time ? new Date(m.start_time) : new Date();
    const timeStr = matchDate.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Ho_Chi_Minh' });
    const dateStr = matchDate.toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }); // YYYY-MM-DD
    const dd = String(matchDate.getDate()).padStart(2, '0');
    const mm = String(matchDate.getMonth() + 1).padStart(2, '0');
    const yyyy = matchDate.getFullYear();

    const commentators = (m.commentators || []).map((c) => {
      const streamUrl = c.stream_url || c.backup_stream_url || c.flv_stream_url || '';
      return {
        id: c.id,
        name: c.name,
        avatar: this.getFullUrl(c.avatar_url),
        streamUrl,
        isLive: !!c.is_live,
        cdn: this.detectCdn(streamUrl)
      };
    }).filter((c) => c.streamUrl || c.name);

    const primaryStream = commentators.find((c) => c.streamUrl)?.streamUrl
      || m.primary_stream_url
      || m.backup_stream_url
      || '';

    const elapsed = String(m.match_time || '').trim();
    const slug = m.slug
      || `${slugifyVi(m.home_team_name)}-vs-${slugifyVi(m.away_team_name)}-ngay-${dd}-${mm}-${yyyy}`;

    return {
      matchId: `kd_${m.id}`,
      originalId: m.id,
      slug,
      source: 'khandaitv',
      sport: sportInfo.slug,
      sportName: sportInfo.name,
      sportIcon: sportInfo.icon,
      competition: {
        name: m.tournament_name || m.tournament_name_en || '',
        logo: this.getFullUrl(m.tournament_icon_url),
        icon: this.getFullUrl(m.tournament_icon_url)
      },
      homeTeam: {
        name: m.home_team_name || 'Home',
        logo: this.getFullUrl(m.home_team_logo)
      },
      awayTeam: {
        name: m.away_team_name || 'Away',
        logo: this.getFullUrl(m.away_team_logo)
      },
      score: {
        home: m.home_score ?? 0,
        away: m.away_score ?? 0
      },
      status: {
        isLive,
        isFinished,
        isHalfTime: /^HT$/i.test(elapsed),
        isUpcoming: !isLive && !isFinished,
        name: isLive
          ? (elapsed && !/^\d+$/.test(elapsed) ? elapsed : (elapsed ? 'Hiệp 1' : 'LIVE'))
          : (isFinished ? 'FT' : 'Sắp diễn ra'),
        text: isLive ? (elapsed || 'LIVE') : (isFinished ? 'Kết thúc' : 'Sắp diễn ra'),
        elapsedTime: isLive ? (elapsed && /^\d+$/.test(elapsed) ? `${elapsed}'` : elapsed) : '',
        minutes: elapsed
      },
      stats: {
        halfTimeScore: `${m.home_halftime_score ?? 0}-${m.away_halftime_score ?? 0}`,
        corners: '0-0',
        yellowCards: '0-0'
      },
      matchTime: matchDate.getTime(),
      matchTimeTimestamp: matchDate.getTime(),
      timeFormatted: `${timeStr} - ${dd}/${mm}`,
      dateStr,
      timeStr,
      isHot: !!m.is_hot,
      commentators,
      streamers: commentators,
      streamUrl: primaryStream,
      stream: {
        // Domain thật (khandai3.link) dùng route "/truc-tiep/{slug}" KHÔNG có
        // dấu "/" cuối — đã tự kiểm tra trực tiếp trên site.
        liveUrl: `${activeBaseUrl()}/truc-tiep/${slug}`,
        streamerName: commentators[0]?.name || null,
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
    return all.find((m) =>
      String(m.id) === cleanId
      || m.slug === key
      || m.slug === cleanId
    ) || null;
  }

  async getAllMatches(sport = 'football') {
    try {
      const sportId = sport === 'basketball' || sport === 'bong-ro' ? 47 : (SPORT_ID_MAP[sport] || 41);
      const all = await this.getAllRawMatches();
      return all
        .filter((m) => !sportId || m.sport === sportId)
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
      const targetSportId = tab === 'all' || sport === 'all'
        ? null
        : (SPORT_ID_MAP[tab] !== undefined
          ? SPORT_ID_MAP[tab]
          : (SPORT_ID_MAP[sport] !== undefined
            ? SPORT_ID_MAP[sport]
            : (sport === 'basketball' || sport === 'bong-ro' ? 47 : 41)));

      const all = await this.getAllRawMatches();
      let normalized = all
        .filter((m) => !targetSportId || m.sport === targetSportId)
        .map((m) => this.normalizeMatch(m));

      const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });
      const tomorrowDate = new Date(Date.now() + 24 * 60 * 60 * 1000);
      const tomorrowStr = tomorrowDate.toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });

      if (tab === 'live') normalized = normalized.filter((m) => m.status.isLive);
      else if (tab === 'upcoming') normalized = normalized.filter((m) => m.status.isUpcoming);
      else if (tab === 'hot') normalized = normalized.filter((m) => m.isHot);
      else if (tab === 'commentator' || tab === 'with-stream') normalized = normalized.filter((m) => m.commentators.length > 0);
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
      const sportId = sport === 'basketball' || sport === 'bong-ro' ? 47 : (SPORT_ID_MAP[sport] || 41);
      const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });
      const tomorrowDate = new Date(Date.now() + 24 * 60 * 60 * 1000);
      const tomorrowStr = tomorrowDate.toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });

      const all = await this.getAllRawMatches();
      const normalized = all
        .filter((m) => !sportId || m.sport === sportId)
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

  async getStreamLinks(matchId) {
    try {
      const raw = await this.findRawMatch(matchId);
      if (!raw) return [];
      return this.mapStreams(this.normalizeMatch(raw));
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
