import { createHttpClient } from '@/src/utils/httpClient';
import { slugifyVi } from '@/src/utils/slug';
import { fetchRenderedHtml, fetchFirstRequestHeaders } from '@/src/utils/browserFetch';
import { filterDeadHlsLinks } from '@/src/utils/linkProbe';

// Trang web: đổi tên miền tuỳ ý qua GIOVANG_DOMAIN (không cần sửa code).
// API JSON danh sách trận lại nằm ở 1 domain CDN/backend riêng dùng chung
// bởi nhiều site cùng plugin "wp-football-livestream" — xác nhận qua
// DevTools ngày 13/08/2026: có 2 file JSON tĩnh riêng biệt, không cần
// cookie/auth, không bị chặn bot (khác hẳn VSC9):
//   - live.json: CHỈ chứa trận đang live (status_code LIVE/1H/2H/HT/...)
//   - all.json : chứa MỌI trận (NS chưa đá, FT kết thúc, PEND bị hoãn...,
//     và cả LIVE) — đây mới là nguồn cho tab "sắp diễn ra"/"hôm nay"/...
// FIX (30/09/2026 — "link Giờ Vàng không xem được"): kiểm tra thực tế cho thấy
// giovang.city đã REDIRECT hẳn sang https://giovang.blog/ (canonical + mọi
// link trong trang đều là giovang.blog; trang còn nhắc mirror giovang.cv).
// Playlist vẫn gửi Referer https://giovang.city -> CDN phát (vcdn.cloud) không
// còn nhận domain cũ làm Referer. Domain mặc định đổi sang giovang.blog; ngoài
// ra ensureSiteOrigin() tự theo redirect để lần sau đổi domain KHÔNG cần sửa
// code, và detectPlayerReferer() lấy Referer THẬT từ trình duyệt (xem dưới).
const BASE_URL = String(process.env.GIOVANG_DOMAIN || 'https://giovang.love').replace(/\/+$/, '');
const SITE_CHECK_TTL_MS = 6 * 60 * 60 * 1000; // theo dõi redirect domain 6 tiếng/lần
const DETECT_REFERER_TIMEOUT_MS = 12000; // ngắn để không kéo dài tổng thời gian quét
const DETECT_REFERER_TTL_MS = 2 * 60 * 60 * 1000; // domain player không đổi liên tục cỡ phút
const DETECT_FAIL_BACKOFF_MS = 10 * 60 * 1000; // dò lỗi -> nghỉ 10 phút, không mở trình duyệt cho từng trận
const detectCache = globalThis.__giovangRefererDetectCache || { value: null, detectedAt: 0, failedAt: 0, inFlight: null };
globalThis.__giovangRefererDetectCache = detectCache;
const diagLogged = globalThis.__giovangDiagLogged || new Set(); // mỗi link/trang chỉ log 1 lần/tiến trình (tối đa ~300 mục)
globalThis.__giovangDiagLogged = diagLogged;
// FIX (03/11/2026 — "các trận bóng đá live Giờ Vàng không xem được, môn khác vẫn xem được"): trang đã đổi sang
// https://giovang.love/ (CDN vcdn.cloud nhận Referer này). Domain mặc định đổi giovang.blog -> giovang.love;
// ensureSiteOrigin() vẫn tự theo redirect nếu site đổi tiếp. Link .m3u8 trong HTML có thể nằm trong JSON/JS
// (dấu & viết \\u0026, \\/ ...) nên extractHlsUrls() giờ giải mã đủ — trước đây link bị CẮT mất phần ?token.
// Trận bóng đá thường có nhiều link (nhiều BLV/server): giữ tối đa GIOVANG_MAX_SERVERS server khác nhau
// (mặc định 3) để khi server 1 hỏng thì đổi sang server khác, không chỉ xuất 1 link duy nhất.
const GIOVANG_MAX_SERVERS = Math.max(1, Number(process.env.GIOVANG_MAX_SERVERS) || 3);
// FIX (03/11/2026, lần 2 — log thật: mỗi BLV có 1 \"pc_stream_url\" dạng .../<id>_hd/<id>_hd@720p.m3u8 và <id> chính là
// MỐC THỜI GIAN (giây, UNIX) lúc tạo luồng): trận 19:15 ngày 03/11 đang lấy link id 1793510867 = tạo lúc 12:27 ngày 01/11 —
// luồng cũ đã chết từ 2 ngày trước (404), trong khi luồng mới của cùng trang có id 17937xxxxx (tạo 03/11). Trước đây code
// lấy link ĐẦU TIÊN trong HTML nên trúng luồng cũ. Giờ: đọc mốc thời gian từ id, ưu tiên link MỚI NHẤT, bỏ link quá cũ
// (mặc định > 30 giờ; đổi bằng GIOVANG_MAX_LINK_AGE_HOURS). Nếu TẤT CẢ link đều cũ vẫn giữ link mới nhất (không làm rỗng trận).
const GIOVANG_MAX_LINK_AGE_MS = (Number(process.env.GIOVANG_MAX_LINK_AGE_HOURS) > 0 ? Number(process.env.GIOVANG_MAX_LINK_AGE_HOURS) : 30) * 60 * 60 * 1000;

/** Mốc thời gian (ms) nhúng trong id luồng của link, hoặc 0 nếu không đọc được. */
function streamCreatedAtMs(url) {
  const m = String(url).match(/\/(1[5-9]\d{8})_(?:hd|sd|fhd)\b/i) || String(url).match(/\/(1[5-9]\d{8})\b/);
  return m ? Number(m[1]) * 1000 : 0;
}

/** Cặp {tên BLV -> link} đọc từ JSON nhúng trong trang (\"blv_name\":\"..\",...,\"pc_stream_url\":\"..\"). */
function extractBlvStreamNames(text) {
  const names = new Map();
  const re = /\"blv_name\"\s*:\s*\"((?:[^\"\\]|\\.)*)\"[^{}]*?\"(?:pc_stream_url|mobile_stream_url|link_stream_hd|link_stream_sd)\"\s*:\s*\"((?:[^\"\\]|\\.)*\.m3u8[^\"\\]*)\"/gi;
  for (const m of String(text || '').matchAll(re)) {
    let name = m[1];
    try { name = JSON.parse(`"${m[1]}"`); } catch { /* giữ nguyên */ }
    const url = cleanUrl(m[2]);
    if (!names.has(url)) names.set(url, String(name).trim());
  }
  return names;
}

/** Sắp xếp link: mới nhất trước; bỏ link quá cũ nếu còn link mới. */
function rankHlsByFreshness(urls) {
  const now = Date.now();
  const withTs = urls.map((url, i) => ({ url, i, ts: streamCreatedAtMs(url) }));
  const fresh = withTs.filter((x) => !x.ts || now - x.ts <= GIOVANG_MAX_LINK_AGE_MS);
  const pool = fresh.length ? fresh : withTs; // toàn bộ đều cũ -> vẫn giữ (không làm rỗng)
  pool.sort((a, b) => (b.ts || now) - (a.ts || now) || a.i - b.i); // không đọc được mốc -> coi như mới, giữ thứ tự gốc
  return { urls: pool.map((x) => x.url), droppedStale: withTs.length - pool.length, allStale: !fresh.length && withTs.length > 0 };
}

const LIVE_API_HOST = process.env.GIOVANG_LIVE_API_HOST || 'https://live-api.keonhacaitp.one';
// FIX (03/11/2026 — "các trận live Giờ Vàng báo HTTP 404, link không còn tồn tại - CDN đã gỡ/đã đổi url"):
// link .m3u8 lấy từ trang trận có thể đã chết trên CDN. Dò nhanh từng link (kèm Referer thật) và BỎ link
// trả 404/410 — chỉ khi chắc chắn (xem src/utils/linkProbe.js: lỗi mạng/403/timeout -> giữ link; và chỉ
// bỏ khi đã thấy ≥1 link khác trên cùng CDN phát được, tránh làm rỗng cả nguồn nếu CI bị CDN chặn bằng 404).
// Tắt hẳn: đặt biến GIOVANG_PROBE_ALIVE=off.
// FIX (03/11/2026, lần 3): dò từ IP máy chủ CI nhận 404 cho link mà trên web VẪN PHÁT (CDN chặn theo IP/Referer)
// -> loại nhầm trận đang live. Mặc định giờ TẮT: giữ MỌI link lấy từ trang. Muốn bật lại lọc link chết: GIOVANG_PROBE_ALIVE=on.
const GIOVANG_PROBE_ALIVE = String(process.env.GIOVANG_PROBE_ALIVE || '').toLowerCase() === 'on';
const LIVE_JSON_PATH = '/storage/livestream/live.json';
const ALL_JSON_PATH = '/storage/livestream/all.json';

// Các status_code mà site coi là "đang diễn ra" (xác nhận từ script inline
// của trang: LIVE_STATUS = ['1H','2H','HT','PEN','LIVE','ET']).
const LIVE_STATUS_CODES = ['1H', '2H', 'HT', 'PEN', 'LIVE', 'ET'];

const SPORT_TYPE_MAP = {
  football: 'football',
  bongda: 'football',
  basketball: 'basketball',
  bongro: 'basketball',
  volleyball: 'volleyball',
  bongchuyen: 'volleyball',
  badminton: 'badminton',
  caulong: 'badminton',
  tennis: 'tennis',
  // Chưa xác nhận được chuỗi "type" thô THẬT SỰ mà API giovang trả về cho
  // các chặng đua F1 (mới xuất hiện) — gộp sẵn các biến thể hay gặp, khớp
  // với alias tương ứng trong SPORT_ALIASES (src/utils/playerGet.js) để dù
  // API đặt tên kiểu nào thì trận vẫn rơi đúng vào tab "F1" thay vì "other".
  f1: 'f1',
  'f-1': 'f1',
  formula1: 'f1',
  'formula-1': 'f1',
  racing: 'f1',
  motorracing: 'f1',
  'motor-racing': 'f1',
  motorsport: 'f1',
  duaxe: 'f1',
  'dua-xe': 'f1',
};

function cleanUrl(str) {
  return String(str || '')
    .replace(/&quot;|&#0*34;|&#x0*22;/gi, '"')
    .replace(/&amp;/gi, '&')
    .replace(/&#x2F;|&#0*47;/gi, '/')
    .replace(/\\\//g, '/')
    .replace(/\\u002F/gi, '/')
    .replace(/\\u0026/gi, '&')
    .replace(/\\u003D/gi, '=')
    .replace(/\\u003F/gi, '?');
}

// FIX (03/11/2026 — "trận live Giờ Vàng ghi 'Chưa có link — chờ cập nhật'"): link .m3u8 trong HTML trận
// (pc_stream_url) có thể 404 vì CDN chưa/không còn phát đúng id đó. Sinh thêm các biến thể chất lượng
// cùng pattern CDN (…_hd/…_hd@720p.m3u8 -> _sd/@480p...) để dò thử; chỉ link nào dò ra m3u8 hợp lệ mới được dùng.
function qualityVariants(url) {
  const out = new Set();
  const m = String(url).match(/^(.*\/)(\d+)_hd\/\2_hd@720p\.m3u8(\?.*)?$/i);
  if (m) {
    const [, base, id, q = ''] = m;
    for (const [dir, res] of [['hd', '1080p'], ['hd', '480p'], ['sd', '480p'], ['sd', '360p']]) {
      out.add(`${base}${id}_${dir}/${id}_${dir}@${res}.m3u8${q}`);
    }
    out.add(`${base}${id}_hd/playlist.m3u8${q}`);
    out.add(`${base}${id}_hd/index.m3u8${q}`);
  }
  out.delete(url);
  return [...out];
}

class GiovangService {
  constructor() {
    this.client = createHttpClient({
      timeout: 15000,
      headers: {
        Accept: '*/*',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Origin: BASE_URL,
        Referer: `${BASE_URL}/`,
      },
    });
    this.cache = new Map();
    this.lastDiagnostics = null;
    this.siteOrigin = BASE_URL; // domain THẬT sau redirect (cập nhật bởi ensureSiteOrigin)
    this.siteCheckedAt = 0;
  }

  /** Theo redirect của trang chủ để biết domain thật đang dùng (giovang.city -> giovang.blog...). */
  async ensureSiteOrigin() {
    if (Date.now() - this.siteCheckedAt < SITE_CHECK_TTL_MS) return this.siteOrigin;
    this.siteCheckedAt = Date.now(); // đặt trước: lỗi cũng không bị thử lại dồn dập
    try {
      const res = await this.client.get(`${BASE_URL}/`, { timeout: 8000, maxRedirects: 5, responseType: 'text', headers: { Accept: 'text/html' } });
      const finalUrl = res?.request?.res?.responseUrl || res?.request?._redirectable?._currentUrl || '';
      const origin = /^https?:\/\//i.test(finalUrl) ? new URL(finalUrl).origin : '';
      if (origin && origin !== this.siteOrigin) {
        console.log(`[giovang] domain thật sau redirect: ${this.siteOrigin} -> ${origin}`);
        this.siteOrigin = origin;
      }
    } catch (err) {
      console.warn('[giovang] ensureSiteOrigin lỗi (giữ domain hiện tại):', err.message);
    }
    return this.siteOrigin;
  }

  /**
   * Referer THẬT mà player của trang gửi cho CDN phát (vcdn.cloud...) — lấy bằng
   * trình duyệt headless mở 1 trang trận, cùng cách Sao Kê đang dùng. Cache 2
   * tiếng; dò lỗi thì nghỉ 10 phút (trả null -> dùng `${siteOrigin}/`).
   */
  async detectPlayerReferer(pageUrl) {
    if (detectCache.value && Date.now() - detectCache.detectedAt < DETECT_REFERER_TTL_MS) return detectCache.value;
    if (detectCache.inFlight) return detectCache.inFlight;
    if (!pageUrl || Date.now() - detectCache.failedAt < DETECT_FAIL_BACKOFF_MS) return null;
    detectCache.inFlight = (async () => {
      try {
        const found = await fetchFirstRequestHeaders(pageUrl, /\.m3u8(\?|$)/i, { timeoutMs: DETECT_REFERER_TIMEOUT_MS });
        const referer = found?.headers?.referer || found?.headers?.Referer || null;
        if (referer && /^https?:\/\//i.test(referer)) {
          detectCache.value = referer;
          detectCache.detectedAt = Date.now();
          console.log(`[giovang] tự dò được Referer thật từ trình duyệt: ${referer}`);
          return referer;
        }
        detectCache.failedAt = Date.now();
        console.warn('[giovang] mở trang bằng trình duyệt xong nhưng không bắt được request .m3u8 nào — dùng Referer = domain trang');
        return null;
      } catch (error) {
        detectCache.failedAt = Date.now();
        console.warn('[giovang] dò Referer bằng trình duyệt thất bại (dùng Referer = domain trang):', error.message);
        return null;
      } finally {
        detectCache.inFlight = null;
      }
    })();
    return detectCache.inFlight;
  }

  async cached(key, loader, ttl = 20 * 1000) {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < ttl) return hit.value;
    const value = await loader();
    this.cache.set(key, { at: Date.now(), value });
    return value;
  }

  buildDetailUrl(m) {
    // Xác nhận thật từ URL trận đấu thật (13/08/2026): dạng
    // "truc-tiep-{home}-vs-{away}-{dd}-{mm}-{id}" — CHỈ ngày-tháng, không
    // có năm, khớp với field day_month ("13/08") chứ không phải date đầy đủ.
    const home = slugifyVi(m?.teams?.home?.name);
    const away = slugifyVi(m?.teams?.away?.name);
    const dayMonth = String(m?.day_month || '').replace('/', '-');
    const slug = [home, away ? `vs-${away}` : '', dayMonth, m?.id]
      .filter(Boolean)
      .join('-')
      .replace(/-+/g, '-');
    return `${this.siteOrigin}/truc-tiep-${slug}`;
  }

  normalizeMatch(m) {
    const statusCode = String(m.status_code || '').toUpperCase();
    const isLive = LIVE_STATUS_CODES.includes(statusCode) || m.is_live === true;
    const isFinished = statusCode === 'FT';
    const timestampMs = (m.time_start || 0) * 1000;
    const matchDate = timestampMs ? new Date(timestampMs) : new Date();
    const timeStr = m.time ? String(m.time).slice(0, 5) : matchDate.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Ho_Chi_Minh' });
    const dateStr = matchDate.toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });
    const elapsed = statusCode === 'HT' ? 'HT' : (m.live_time ? `${m.live_time}` : '');

    const detailUrl = this.buildDetailUrl(m);
    const sportSlug = SPORT_TYPE_MAP[String(m.type || '').toLowerCase()] || String(m.type || 'football');

    return {
      matchId: `giovang_${m.id}`,
      originalId: m.id,
      source: 'giovang',
      sport: sportSlug,
      competition: {
        name: m.league?.title || '',
        logo: cleanUrl(m.league?.icon),
        icon: cleanUrl(m.league?.icon),
      },
      homeTeam: {
        name: (m.teams?.home?.name || 'Home').trim(),
        logo: cleanUrl(m.teams?.home?.logo),
      },
      awayTeam: {
        name: (m.teams?.away?.name || 'Away').trim(),
        logo: cleanUrl(m.teams?.away?.logo),
      },
      score: {
        home: m.score?.fulltime?.home ?? 0,
        away: m.score?.fulltime?.away ?? 0,
      },
      status: {
        isLive,
        isFinished,
        isHalfTime: statusCode === 'HT',
        isUpcoming: !isLive && !isFinished,
        name: isLive ? (m.status || 'LIVE') : (isFinished ? 'FT' : 'Sắp diễn ra'),
        text: isLive ? (m.status || 'LIVE') : (isFinished ? 'Kết thúc' : 'Sắp diễn ra'),
        elapsedTime: isLive && elapsed ? (/^\d+$/.test(elapsed) ? `${elapsed}'` : elapsed) : '',
        minutes: elapsed,
      },
      matchTime: timestampMs,
      matchTimeTimestamp: timestampMs,
      timeFormatted: `${timeStr} - ${m.day_month || ''}`,
      dateStr,
      timeStr,
      isHot: !!m.is_hot,
      commentators: (m.blv || []).map((key) => ({ id: key, name: key, streamUrl: '' })),
      streamers: [],
      stream: {
        liveUrl: detailUrl,
        matchId: m.id,
      },
    };
  }

  async fetchJson(path, label) {
    const url = `${LIVE_API_HOST}${path}?t=${Date.now()}`;
    const response = await this.client.get(url);
    const diag = { url, status: response.status, contentType: response.headers?.['content-type'] || '' };
    const list = response.data?.response;
    if (!Array.isArray(list)) {
      console.warn(`[giovang] ${label} trả về định dạng không đúng — không tìm thấy field "response" là mảng`);
      diag.error = 'invalid_format';
      this.lastDiagnostics = { ...this.lastDiagnostics, [label]: diag };
      return [];
    }
    diag.rawRecordsFound = list.length;
    this.lastDiagnostics = { ...this.lastDiagnostics, [label]: diag };
    return list.map((m) => this.normalizeMatch(m));
  }

  /**
   * live.json chỉ chứa trận đang live (cập nhật real-time, đáng tin nhất
   * cho trạng thái live) — all.json chứa MỌI trận (NS/FT/PEND/LIVE...) làm
   * nguồn cho các tab còn lại. Gộp 2 nguồn, ưu tiên bản ghi từ live.json
   * khi trùng id vì nó cập nhật sát thời gian thực hơn.
   */
  async fetchAllMatches() {
    await this.ensureSiteOrigin(); // trước normalizeMatch -> liveUrl đúng domain thật
    const [liveList, allList] = await Promise.all([
      this.fetchJson(LIVE_JSON_PATH, 'liveJson').catch((err) => {
        this.lastDiagnostics = { ...this.lastDiagnostics, liveJson: { error: err.message } };
        console.warn('[giovang] fetchJson(live.json) lỗi:', err.message);
        return [];
      }),
      this.fetchJson(ALL_JSON_PATH, 'allJson').catch((err) => {
        this.lastDiagnostics = { ...this.lastDiagnostics, allJson: { error: err.message } };
        console.warn('[giovang] fetchJson(all.json) lỗi:', err.message);
        return [];
      }),
    ]);
    const merged = new Map();
    for (const m of allList) merged.set(m.originalId, m);
    for (const m of liveList) merged.set(m.originalId, m); // live.json đè lên, ưu tiên real-time
    return [...merged.values()];
  }

  async getMatchesByTab(tab = 'live') {
    return this.cached(`matches:${tab}`, async () => {
      const all = await this.fetchAllMatches();

      const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });
      const tomorrowStr = new Date(Date.now() + 24 * 60 * 60 * 1000).toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });

      let matches;
      if (tab === 'live') matches = all.filter((m) => m.status.isLive);
      else if (tab === 'upcoming') matches = all.filter((m) => m.status.isUpcoming);
      else if (tab === 'hot') matches = all.filter((m) => m.isHot);
      else if (tab === 'today') matches = all.filter((m) => m.dateStr === todayStr);
      else if (tab === 'tomorrow') matches = all.filter((m) => m.dateStr === tomorrowStr);
      else matches = all;

      return { matches, hasMore: false, totalCount: matches.length };
    });
  }

  /** all.json/live.json trả về mọi trận trong 1 lần gọi — không có phân trang thật. */
  async getAllMatchesByTab(tab = 'live') {
    return this.getMatchesByTab(tab);
  }

  extractHlsUrls(text) {
    const input = cleanUrl(text);
    const found = input.match(/https?:[^'"\s<>\\]+?\.m3u8(?:\?[^'"\s<>\\]*)?/gi) || [];
    return [...new Set(found.map(cleanUrl))];
  }

  /**
   * Log CHẨN ĐOÁN (mỗi link/trang chỉ 1 lần): link .m3u8 nằm ở đâu trong trang (đoạn mã xung quanh),
   * hoặc — nếu không có link — tiêu đề trang + các iframe. Giúp biết link hỏng/404 đến từ đâu mà khỏi đoán.
   */
  logLinkDiagnostics({ targetUrl, html, hlsUrls, via }) {
    if (diagLogged.size > 300) return;
    const text = cleanUrl(typeof html === 'string' ? html : '');
    const once = (key, fn) => {
      if (diagLogged.has(key)) return;
      diagLogged.add(key);
      fn();
    };
    const iframes = [...text.matchAll(/<iframe[^>]*?\ssrc=["']([^"']+)["']/gi)].map((m) => m[1]).slice(0, 3);
    if (hlsUrls.length) {
      for (const url of hlsUrls.slice(0, 3)) {
        once(`url|${url}`, () => {
          const i = text.indexOf(url);
          const ctx = i >= 0 ? text.slice(Math.max(0, i - 90), i + url.length + 20).replace(/\s+/g, ' ') : '(không thấy nguyên văn trong HTML)';
          console.log(`[giovang] link lấy từ ${via}: ${url}\n          ngữ cảnh trong trang: ${ctx}`);
        });
      }
    } else {
      once(`none|${targetUrl}`, () => {
        const title = ((text.match(/<title[^>]*>([^<]{0,120})/i) || [])[1] || '').trim();
        console.warn(`[giovang] KHÔNG tìm thấy link .m3u8 trong trang ${targetUrl} (HTML ${text.length} ký tự, tiêu đề: "${title}", iframe: ${iframes.join(' | ') || 'không có'})`);
      });
    }
  }

  async getMatchDetail(idOrUrl) {
    await this.ensureSiteOrigin();
    const rawId = String(idOrUrl || '').replace(/^giovang_/, '');
    const detailUrl = /^https?:\/\//i.test(rawId) ? rawId : null;

    let targetUrl = detailUrl;
    if (!targetUrl) {
      // Không có URL đầy đủ (gọi bằng id trần) — thử suy luận lại từ cache
      // danh sách gần nhất để lấy đúng slug thật thay vì đoán.
      const cachedLive = this.cache.get('matches:live')?.value?.matches || [];
      const cachedAll = this.cache.get('matches:all')?.value?.matches || [];
      const found = [...cachedLive, ...cachedAll].find((m) => m.originalId === rawId || m.matchId === `giovang_${rawId}`);
      targetUrl = found?.stream?.liveUrl || `${this.siteOrigin}/?livestream=${encodeURIComponent(rawId)}`;
    }

    let html = '';
    let hlsUrls = [];

    // Trang chi tiết render sẵn phía server (WordPress, không phải SPA như
    // VSC9) — thử HTTP thường trước, nhẹ và nhanh hơn hẳn mở trình duyệt.
    try {
      const response = await this.client.get(targetUrl);
      this.lastDiagnostics = { ...this.lastDiagnostics, detailHttp: { status: response.status, htmlLength: String(response.data || '').length } };
      if (response.status < 400) {
        html = response.data;
        hlsUrls = this.extractHlsUrls(html);
      }
    } catch (err) {
      this.lastDiagnostics = { ...this.lastDiagnostics, detailHttp: { error: err.message } };
      console.warn('[giovang] getMatchDetail HTTP lỗi:', err.message);
    }

    let via = hlsUrls.length ? 'HTML (HTTP thường)' : 'none';

    // Không tìm thấy link m3u8 nào trong HTML thô (trận có thể lazy-load
    // player bằng JS) → dự phòng mở bằng trình duyệt headless để đọc DOM
    // đã render đầy đủ.
    if (!hlsUrls.length) {
      try {
        const rendered = await fetchRenderedHtml(targetUrl, {
          timeoutMs: 25000,
          userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        });
        html = rendered.html || html;
        hlsUrls = this.extractHlsUrls(html);
        if (hlsUrls.length) via = 'DOM trình duyệt headless';
        this.lastDiagnostics = { ...this.lastDiagnostics, detailBrowser: { status: rendered.status, htmlLength: html.length, foundAfterBrowser: hlsUrls.length } };
      } catch (err) {
        this.lastDiagnostics = { ...this.lastDiagnostics, detailBrowser: { error: err.message } };
        console.warn('[giovang] getMatchDetail fetchRenderedHtml lỗi:', err.message);
      }
    }

    const blvNames = extractBlvStreamNames(html);
    if (hlsUrls.length > 1 || hlsUrls.some((u) => streamCreatedAtMs(u))) {
      const ranked = rankHlsByFreshness(hlsUrls);
      if (ranked.droppedStale || ranked.urls[0] !== hlsUrls[0]) {
        console.log(`[giovang] ${targetUrl}: xếp link theo độ mới (bỏ ${ranked.droppedStale} link cũ > ${Math.round(GIOVANG_MAX_LINK_AGE_MS / 3600000)}h${ranked.allStale ? '; TẤT CẢ đều cũ -> giữ link mới nhất' : ''}); dùng: ${ranked.urls[0]}`);
      }
      hlsUrls = ranked.urls;
      this.lastDiagnostics = { ...this.lastDiagnostics, linkFreshness: { total: ranked.urls.length + ranked.droppedStale, droppedStale: ranked.droppedStale, allStale: ranked.allStale } };
    }

    this.logLinkDiagnostics({ targetUrl, html, hlsUrls, via });

    // Referer gắn cho MỌI link của trận: Referer thật dò từ trình duyệt (nếu có),
    // không thì `${domain thật}/` (kiểu trình duyệt thật luôn có dấu "/" cuối).
    // m3uPlaylist.js ưu tiên stream.referer này hơn danh sách ứng viên hardcode.
    const referer = hlsUrls.length
      ? ((await this.detectPlayerReferer(targetUrl)) || `${this.siteOrigin}/`)
      : null;

    let probe = await filterDeadHlsLinks(hlsUrls, { source: 'giovang', referer, enabled: GIOVANG_PROBE_ALIVE });
    this.lastDiagnostics = { ...this.lastDiagnostics, linkProbe: probe.stats };

    // Mọi link trong HTML đều chết (404/410) -> thử CỨU trận thay vì bỏ trắng:
    //  (1) mở trang bằng trình duyệt, bấm Play và bắt link .m3u8 THẬT mà player gọi (có thể khác pc_stream_url);
    //  (2) thử các biến thể chất lượng của link đã chết.
    // Link nào dò ra m3u8 hợp lệ mới được giữ; không cứu được thì trận không có stream (playlist sẽ bỏ trận này).
    let rescued = 'no';
    if (GIOVANG_PROBE_ALIVE && hlsUrls.length && !probe.alive.length && probe.dropped.length) {
      const candidates = new Set();
      try {
        const found = await fetchFirstRequestHeaders(targetUrl, /\.m3u8(\?|$)/i, { timeoutMs: 20000 });
        if (found?.url && !probe.dropped.includes(found.url)) candidates.add(found.url);
      } catch (err) {
        console.warn('[giovang] cứu link bằng trình duyệt lỗi:', err.message);
      }
      if (candidates.size) {
        const retry = await filterDeadHlsLinks([...candidates], { source: 'giovang', referer, enabled: true });
        // chỉ nhận link THẬT SỰ phát được (sống) — không nhận link "chưa rõ"/404 chưa xác nhận
        const confirmed = [];
        for (const u of retry.alive) {
          if (retry.unconfirmed.includes(u)) continue;
          confirmed.push(u);
        }
        if (confirmed.length) {
          probe = { ...retry, alive: confirmed };
          rescued = 'yes';
          console.log(`[giovang] cứu được ${confirmed.length} link cho ${targetUrl}: ${confirmed[0]}`);
        }
      }
    }
    this.lastDiagnostics = { ...this.lastDiagnostics, linkRescue: rescued };

    // Gộp link trùng (cùng đường dẫn, khác tham số vô nghĩa) rồi giữ tối đa GIOVANG_MAX_SERVERS server.
    const seenPath = new Set();
    const uniqueAlive = probe.alive.filter((u) => {
      const k = String(u).split('?')[0];
      if (seenPath.has(k)) return false;
      seenPath.add(k);
      return true;
    }).slice(0, GIOVANG_MAX_SERVERS);

    const labelFor = (url, index) => (blvNames.get(url) ? `Giovang ${index + 1} - ${blvNames.get(url)}` : `Giovang ${index + 1}`);
    const streams = uniqueAlive.map((url, index) => ({
      id: `giovang_${rawId}_${index + 1}`,
      streamerName: labelFor(url, index),
      name: labelFor(url, index),
      m3u8Url: url,
      playUrl: url,
      format: 'hls',
      referer,
    }));
    // Trận chỉ có 1 link: thêm bản dự phòng GỬI KHÔNG Referer/Origin (1 số CDN từ chối Referer lạ nhưng
    // vẫn phát khi không có) để người xem có đường lùi khi bản có Referer báo lỗi.
    if (uniqueAlive.length === 1 && GIOVANG_MAX_SERVERS > 1) {
      streams.push({
        id: `giovang_${rawId}_2`,
        streamerName: 'Giovang 2 (dự phòng)',
        name: 'Giovang 2 (dự phòng)',
        m3u8Url: uniqueAlive[0],
        playUrl: uniqueAlive[0],
        format: 'hls',
        referer: null,
        noReferer: true,
      });
    }

    return {
      matchId: `giovang_${rawId}`,
      match: { matchId: `giovang_${rawId}`, source: 'giovang', stream: { liveUrl: targetUrl, matchId: rawId } },
      streams,
    };
  }
}

const giovangService = new GiovangService();
export default giovangService;
