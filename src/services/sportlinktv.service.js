// SportlinkTV (sportlinktv.pages.dev) — nguồn JSON tĩnh được host trên
// Cloudflare Pages. Dữ liệu trận đấu lấy từ 1 endpoint JSON công khai:
//   https://sonujson-v6.pages.dev/Data/events/football.json
// (chỉ bóng đá, đây là filter sẵn từ URL của nguồn)
//
// Cấu trúc JSON (xác nhận từ HTML trang sportlinktv.pages.dev, 11/2026):
//   Array hoặc { events: Array } — mỗi phần tử có:
//     id, event: { startTimeIST, startTime, endTime, category, teamA, teamB, teamAFlag, teamBFlag },
//     streams: [{ title, link, type, key }]
//   - type: "HLS" hoặc "DASH"
//   - key: "kid:key" (ClearKey cho DASH, có thể rỗng)
//   - Thời gian có thể mang suffix IST (+05:30) hoặc UTC.
//
// FIX (22/11/2026 — "sportlink không ghi được link trận đấu vào playlist"): trận trả ra SAI FORM so với các nguồn khác nên
// bị rớt ở các bước phía sau playlistBuilder/m3uPlaylist:
//   - homeTeam/awayTeam là chuỗi (các nguồn khác là { name, logo }) -> tên trận thành "Home", logo/lọc giải hỏng;
//   - thiếu matchTimeTimestamp/dateStr/timeStr -> trận sắp đá bị loại khỏi cửa sổ 24h, giờ trống, sort sai;
//   - stream DASH (.mpd) không có field `link` + .mpd không nằm trong isPlayableStreamUrl -> bị lọc hết, trận không có link;
//   - phần "|Referer=...&User-Agent=..." sau link bị cắt bỏ rồi vứt luôn (CDN chặn hotlink -> không phát);
//   - gọi buildMatchSlug sai chữ ký (truyền 3 tham số thay vì 1 object).
// Giờ trận có đủ field như các nguồn khác, giữ header Referer/Origin từ link, link DASH xếp trước HLS.
// Chỉ lấy bóng đá (football.json đã filter sẵn).
// Trận live: startTime <= now <= endTime (mặc định endTime = startTime + 3h).
// Trận sắp đấu: startTime trong 36h tới.

import axios from 'axios';
import { buildMatchSlug } from '@/src/utils/slug';

const DATA_URL = process.env.SPORTLINKTV_DATA_URL || 'https://sonujson-v6.pages.dev/Data/events/football.json';
const DURATION_MS = 3 * 60 * 60 * 1000; // 3h mặc định nếu không có endTime
// 36h theo yêu cầu 22/11/2026 (đổi bằng SPORTLINKTV_UPCOMING_HOURS) — phải khớp UPCOMING_WINDOW_HOURS_BY_SOURCE trong playlistBuilder.service.js.
const UPCOMING_WINDOW_MS = (Number(process.env.SPORTLINKTV_UPCOMING_HOURS) > 0 ? Number(process.env.SPORTLINKTV_UPCOMING_HOURS) : 36) * 60 * 60 * 1000;

/** Phân tích chuỗi thời gian theo cùng logic trang sportlinktv.pages.dev. */
function parseDate(value) {
  if (!value) return null;
  // Số epoch (giây hoặc mili-giây) — nguồn đôi khi trả timestamp thay vì chuỗi ngày.
  if (typeof value === 'number' || /^\d{10,13}$/.test(String(value).trim())) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) {
      const dtNum = new Date(n < 99999999999 ? n * 1000 : n);
      if (!isNaN(dtNum.getTime())) return dtNum;
    }
  }
  let s = String(value).trim();
  if (!s || s === 'null' || s === 'undefined') return null;

  const isIST = /\bIST\b/i.test(s);
  if (isIST) s = s.replace(/\s*IST\s*$/i, '').trim();

  // ISO-like: YYYY-MM-DD[T ]HH:MM[:SS][.ms][offset|Z]
  let m = s.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})[T\s](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?\s*([+-]\d{2}:?\d{2}|Z)?$/);
  if (m) {
    const [, y, mo, d, h, mi, se = '00', off] = m;
    let offset = '+0000';
    if (off) offset = off === 'Z' ? '+0000' : (off.includes(':') ? off.replace(':', '') : off);
    else if (isIST) offset = '+0530';
    const iso = `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}T${h.padStart(2, '0')}:${mi}:${se}${offset.slice(0, 3)}:${offset.slice(3)}`;
    const dt = new Date(iso);
    if (!isNaN(dt.getTime())) return dt;
  }

  // "DD MMM YYYY HH:MM [AM/PM] [offset]"
  const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
  m = s.match(/^(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{4})[,\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?\s*([+-]\d{2}:?\d{2})?$/i);
  if (m) {
    const [, d, mon, y, h, mi, se = '00', ampm, off] = m;
    const mi2 = MONTHS[mon.toLowerCase().slice(0, 3)];
    if (mi2 !== undefined) {
      let hour = parseInt(h, 10);
      if (ampm) {
        if (ampm.toUpperCase() === 'PM' && hour < 12) hour += 12;
        if (ampm.toUpperCase() === 'AM' && hour === 12) hour = 0;
      }
      const offset = off ? (off.includes(':') ? off.replace(':', '') : off) : (isIST ? '+0530' : '+0000');
      const iso = `${y}-${String(mi2 + 1).padStart(2, '0')}-${d.padStart(2, '0')}T${String(hour).padStart(2, '0')}:${mi}:${se}${offset.slice(0, 3)}:${offset.slice(3)}`;
      const dt = new Date(iso);
      if (!isNaN(dt.getTime())) return dt;
    }
  }

  const dt = new Date(s);
  return isNaN(dt.getTime()) ? null : dt;
}

/** Cache raw JSON 20s để không gọi lại khi nhiều request đến cùng lúc. */
let rawCache = { data: null, fetchedAt: 0, pending: null };
const RAW_TTL_MS = 20 * 1000;

async function fetchRaw() {
  const now = Date.now();
  if (rawCache.data && now - rawCache.fetchedAt < RAW_TTL_MS) return rawCache.data;
  if (rawCache.pending) return rawCache.pending;

  rawCache.pending = (async () => {
    try {
      const res = await axios.get(DATA_URL, {
        timeout: 15000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Accept: 'application/json, */*',
          Origin: 'https://sportlinktv.pages.dev',
          Referer: 'https://sportlinktv.pages.dev/'
        }
      });
      const json = res.data;
      const list = Array.isArray(json) ? json : (Array.isArray(json?.events) ? json.events : []);
      rawCache = { data: list, fetchedAt: Date.now(), pending: null };
      return list;
    } catch (err) {
      rawCache.pending = null;
      throw err;
    }
  })();
  return rawCache.pending;
}

/**
 * Chuẩn hóa danh sách stream thô của 1 trận.
 * - Tách header sau dấu "|" trong link ("url|Referer=...&User-Agent=...&Origin=...").
 * - Link HLS xếp trước DASH (app IPTV phát HLS ổn định hơn), tối đa 3 link.
 * - Luôn có `link` (normalizeStreamList() đọc field này) và `referer` nếu nguồn có kèm.
 */
function buildStreams(rawStreams) {
  const list = Array.isArray(rawStreams) ? rawStreams : [];
  const seen = new Set();
  const out = [];
  list.forEach((s, i) => {
    if (!s) return;
    const full = String(s.link || s.url || s.stream || '').trim();
    const [urlPart, ...headerParts] = full.split('|');
    const link = String(urlPart || '').trim();
    if (!link || !/^https?:\/\//i.test(link)) return;
    if (seen.has(link)) return;
    const t = String(s.type || '').toLowerCase();
    const isDash = t === 'dash' || /\.mpd(\?|$)/i.test(link);
    const isHls = t === 'hls' || t === '0' || /\.m3u8(\?|$)/i.test(link);
    if (!isDash && !isHls) return;
    seen.add(link);

    // Header đi kèm: sau dấu "|" hoặc field riêng (referer/origin/headers).
    const headers = {};
    String(headerParts.join('|') || '').split('&').forEach((kv) => {
      const idx = kv.indexOf('=');
      if (idx <= 0) return;
      const val = kv.slice(idx + 1).trim();
      let decoded = val;
      try { decoded = decodeURIComponent(val); } catch { /* giữ nguyên giá trị thô */ }
      headers[kv.slice(0, idx).trim().toLowerCase()] = decoded;
    });
    const extra = (s.headers && typeof s.headers === 'object') ? s.headers : {};
    Object.keys(extra).forEach((k) => { if (!headers[k.toLowerCase()]) headers[k.toLowerCase()] = String(extra[k]); });
    const referer = String(headers.referer || headers.referrer || s.referer || s.referrer || headers.origin || s.origin || '').trim();
    const title = String(s.title || s.name || `Stream ${i + 1}`).trim();

    out.push({
      title,
      name: title,
      streamerName: title,
      link,
      m3u8Url: isHls ? link : undefined,
      playUrl: link,
      format: isDash ? 'dash' : 'hls',
      clearKey: String(s.api || s.key || s.clearKey || '').trim() || undefined,
      referer: referer ? (/^https?:\/\//i.test(referer) ? referer.replace(/\/*$/, '/') : referer) : undefined,
      cdn: ''
    });
  });
  // DASH trước, HLS sau (theo yêu cầu 22/11/2026; sort ổn định giữ thứ tự gốc trong từng nhóm).
  out.sort((a, b) => (a.format === 'dash' ? 0 : 1) - (b.format === 'dash' ? 0 : 1));
  return out.slice(0, 3);
}

/** Chuẩn hóa 1 raw item thành match card theo format chung của project. */
function normalizeItem(item, index) {
  try {
    const info = item.event || {};
    const st = parseDate(info.startTimeIST) || parseDate(info.startTime) || parseDate(item.startTime);
    if (!st) return null;

    let en = parseDate(info.endTimeIST) || parseDate(info.endTime) || parseDate(item.endTime);
    if (!en || en <= st) en = new Date(st.getTime() + DURATION_MS);

    const streams = buildStreams(item.streams);

    const id = String(item.id ?? index);
    const homeName = String(info.teamA || info.home || '').trim() || 'Home';
    const awayName = String(info.teamB || info.away || '').trim() || 'Away';
    const homeLogo = String(info.teamAFlag || info.homeFlag || '').trim() || undefined;
    const awayLogo = String(info.teamBFlag || info.awayFlag || '').trim() || undefined;
    const tournament = String(info.category || info.league || info.tournament || info.type || info.name || item.title || '').trim();
    const now = Date.now();
    const isLive = now >= st.getTime() && now <= en.getTime();
    const isUpcoming = now < st.getTime() && st.getTime() - now <= UPCOMING_WINDOW_MS;
    const isFinished = now > en.getTime();

    // Giờ/ngày theo giờ Việt Nam (cùng định dạng các nguồn khác: dateStr = yyyy-mm-dd).
    const timeStr = st.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Ho_Chi_Minh' });
    const dateStr = st.toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });
    const [, mo, da] = dateStr.split('-');

    return {
      matchId: `sportlinktv_${id}`,
      originalId: id,
      source: 'sportlinktv',
      sport: 'football',
      sportCategory: 'football',
      sportName: 'BÓNG ĐÁ',
      competition: { name: tournament, logo: '', icon: '' },
      homeTeam: { name: homeName, logo: homeLogo },
      awayTeam: { name: awayName, logo: awayLogo },
      tournament,
      matchTime: st.getTime(),
      matchTimeTimestamp: st.getTime(),
      startTime: st.getTime(),
      endTime: en.getTime(),
      timeFormatted: `${timeStr} - ${da}/${mo}`,
      dateStr,
      timeStr,
      homeFlag: homeLogo,
      awayFlag: awayLogo,
      status: {
        isLive,
        isUpcoming,
        isFinished,
        isDone: isFinished,
        name: isLive ? 'LIVE' : (isFinished ? 'FT' : 'Sắp diễn ra'),
        text: isLive ? 'LIVE' : (isFinished ? 'Kết thúc' : 'Sắp diễn ra'),
        raw: isLive ? 'live' : isUpcoming ? 'upcoming' : 'done'
      },
      streams,
      // Trận SẮP ĐÁ chưa có link vẫn phải nằm trong playlist (m3uPlaylist chỉ ghi kênh chờ khi có liveUrl) -> đặt liveUrl.
      // Trận đang live mà không có link thì KHÔNG đặt, tránh ghi kênh giả.
      stream: {
        liveUrl: (!streams.length && !isLive) ? 'https://sportlinktv.pages.dev/' : undefined,
        streamerName: streams[0]?.title || null
      },
      slug: buildMatchSlug({ homeTeam: { name: homeName }, awayTeam: { name: awayName }, matchTimeTimestamp: st.getTime() })
    };
  } catch {
    return null;
  }
}

class SportlinkTvService {
  /**
   * Lấy danh sách trận theo tab + sport.
   * tab: 'live' | 'upcoming' | 'all'
   * sport: 'football' | 'all' (nguồn này CHỈ có bóng đá)
   */
  async getAllMatchesByTab(tab = 'live', sport = 'football') {
    const list = await fetchRaw();
    const all = list.map((item, i) => normalizeItem(item, i)).filter(Boolean);

    let matches;
    if (tab === 'live') {
      matches = all.filter((m) => m.status.isLive);
    } else if (tab === 'upcoming') {
      matches = all.filter((m) => m.status.isUpcoming);
    } else {
      matches = all.filter((m) => m.status.isLive || m.status.isUpcoming);
    }

    // Lọc theo sport (nguồn chỉ có football nhưng giữ compat với interface chung)
    if (sport && sport !== 'all' && sport !== 'football') {
      matches = [];
    }

    return {
      matches,
      totalCount: matches.length,
      hasMore: false
    };
  }

  /**
   * Lấy stream links cho 1 trận theo matchId.
   * matchId dạng "sportlinktv_<rawId>"
   */
  async getStreamLinks(matchId) {
    const rawId = String(matchId || '').replace(/^sportlinktv_/, '');
    const list = await fetchRaw();
    const item = list.find((x, i) => String(x?.id ?? i) === rawId);
    if (!item) return [];
    return buildStreams(item.streams);
  }
}

export default new SportlinkTvService();
