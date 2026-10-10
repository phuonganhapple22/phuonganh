/** Sport category tabs for home page (Pháo Hoa, Giờ Vàng). */
import axios from 'axios';

export const SPORT_TABS = [
  { id: 'all', label: 'Tất cả' },
  { id: 'football', label: 'Bóng đá' },
  { id: 'basketball', label: 'Bóng rổ' },
  { id: 'volleyball', label: 'Bóng chuyền' },
  { id: 'badminton', label: 'Cầu lông' },
  { id: 'tennis', label: 'Tennis' },
  { id: 'f1', label: 'F1' },
  { id: 'esports', label: 'Esports' }
].filter(({ id }) => id !== 'esports');

const SPORT_ALIASES = {
  football: 'football',
  soccer: 'football',
  'bong-da': 'football',
  basketball: 'basketball',
  'bong-ro': 'basketball',
  volleyball: 'volleyball',
  'bong-chuyen': 'volleyball',
  badminton: 'badminton',
  'cau-long': 'badminton',
  tennis: 'tennis',
  esports: 'esports',
  esport: 'esports',
  lol: 'esports',
  dota2: 'esports',
  csgo: 'esports',
  // Nguồn Giờ Vàng (giovang) mới thêm các chặng đua F1 — chưa xác nhận
  // được CHÍNH XÁC chuỗi "type" thô mà API của họ trả về cho F1, nên gộp
  // sẵn các biến thể hay gặp (tiếng Anh lẫn slug tiếng Việt không dấu) để
  // khớp được dù họ đặt tên kiểu nào.
  f1: 'f1',
  'f-1': 'f1',
  formula1: 'f1',
  'formula-1': 'f1',
  formula_1: 'f1',
  racing: 'f1',
  motorracing: 'f1',
  'motor-racing': 'f1',
  motorsport: 'f1',
  'motor-sport': 'f1',
  grandprix: 'f1',
  'grand-prix': 'f1',
  duaxe: 'f1',
  'dua-xe': 'f1',
  'dua-xe-f1': 'f1'
};

const SOURCE_LABELS = {
  giovang: 'Gio Vang TV',
  khandaitv: 'Khan Dai TV',
  chuoichientv: 'Chuoi Chien TV',
  phalang: 'Pha Lang TV',
  gavang: 'Ga Vang TV',
  saoke: 'Sao Ke Live TV',
  gavang33: 'GaVang33 TV',
  bonglau: 'Bong Lau TV',
  xoilac: 'Xoi Lac TV',
  xoigac: 'Xoi Gac TV'
};

const SOURCE_SHORT = {
  giovang: 'Giờ Vàng',
  khandaitv: 'Khán Đài',
  chuoichientv: 'Chuối Chiên',
  phalang: 'Phá Làng',
  gavang: 'Gà Vàng',
  saoke: 'Sao Kê',
  gavang33: 'GaVang33',
  bonglau: 'Bông Lau',
  xoilac: 'Xôi Lạc',
  xoigac: 'Xôi Gấc' // FIX (05/10/2026): tên đúng là "Xôi Gấc" (trước ghi nhầm "Xôi Gác") — đây là tên group-title trong file .m3u
};

// Thứ tự nhóm theo nguồn dùng chung cho danh sách trên trang quét lẫn file
// playlist .m3u, để cả hai nơi hiển thị nhất quán.
// FIX (23-24/09/2026 — theo yêu cầu, thêm nguồn Gà Vàng TV và Sao Kê Live
// TV): xem gavang.service.js, saoke.service.js + playlistBuilder.service.js.
// FIX (27/09/2026 — theo yêu cầu, thêm GaVang33TV): xem gavang33.service.js
// — nguồn ĐỘC LẬP với "gavang" (khác domain/API hoàn toàn, chỉ trùng
// thương hiệu nhái), không phải bản thay thế.
// FIX (27/09/2026 — theo yêu cầu, thêm Bông Lau TV): xem bonglau.service.js
// — ĐÃ BÁO TRƯỚC nguồn này dùng CHUNG API/CDN/pool trận với chuoichientv
// (chỉ khác domain/giao diện), người dùng vẫn muốn tách thành nguồn riêng.
export const SOURCE_GROUP_ORDER = ['giovang', 'khandaitv', 'chuoichientv', 'phalang', 'gavang', 'saoke', 'gavang33', 'bonglau', 'xoilac', 'xoigac'];

// Danh sách nguồn dùng để vẽ công tắc bật/tắt trên giao diện. Giữ đồng bộ
// với SOURCE_GROUP_ORDER — mỗi nguồn 1 công tắc, người dùng tự chọn nguồn
// nào muốn hiện/ẩn, lưu lại trên trình duyệt (localStorage) nên vẫn còn
// nguyên sau khi tải lại trang.
// FIX (25/08/2026 — theo yêu cầu): chỉ còn Pháo Hoa + Giờ Vàng. Đã xoá hẳn
// Gà Vàng, Xôi Lạc, VSC9, 90 Phút, AFF Cup, Custom Sources — code các nguồn
// này (services, API routes liên quan) cũng đã bị xoá khỏi project, không
// chỉ ẩn trên giao diện.
// FIX (09/09/2026 — theo yêu cầu): thêm Khán Đài TV (khandaitv.service.js),
// domain khandai3.link. Cùng schema dữ liệu trận đấu với nguồn Pháo Hoa
// hiện có (đã xác nhận qua bản HTML lấy từ site) nhưng domain HOÀN TOÀN
// ĐỘC LẬP với domain Pháo Hoa (không dùng chung/ăn theo phaohoa.live) — để
// khi domain Pháo Hoa gặp sự cố, Khán Đài không bị kéo theo. Vẫn cố tình để
// thành 1 nguồn RIÊNG theo yêu cầu, nên có thể thấy trận trùng giữa Pháo
// Hoa và Khán Đài (do chung backend) — đây là hành vi CHỦ Ý chứ không phải lỗi.
// LƯU Ý (20/09/2026): đã xác nhận Khán Đài hoạt động bình thường trở lại
// qua GitHub Actions (không còn bị chặn như lúc chạy trên IP Vercel trước
// đây) — xem thêm scripts/generate-playlists-standalone.mjs.
// FIX (17/09/2026 — theo yêu cầu): thêm Chuối Chiên TV
// (chuoichientv.service.js), domain chuoichientv.link/live05.chuoichientv.me.
// KHÁC HẲN backend với Pháo Hoa/Khán Đài — API riêng (api-v2.chuoichientv.net),
// schema JSON gọn (blvs[].streams[].url có sẵn link .m3u8), gọi thẳng bằng
// HTTP thường là được, KHÔNG bị Cloudflare chặn, KHÔNG cần trình duyệt
// headless — đơn giản hơn hẳn 2 nguồn kia.
// FIX (18/09/2026 — theo yêu cầu): thêm Phá Làng TV (phalang.service.js),
// domain phalang.tv. API riêng (api.plapi202624081158.com/matches/graph +
// /match/{id}/live) — is_live trả thẳng boolean (không cần suy luận từ
// status string như chuoichientv), nhưng link stream LUÔN phải gọi riêng
// /match/{id}/live cho trận đang live (đã thấy trường hợp source_live=null
// dù is_live=true trong response danh sách).
// FIX (20/09/2026 — theo yêu cầu): LOẠI BỎ Pháo Hoa — domain phaohoa1.live
// đã chết hẳn (DNS không phân giải được), mọi request gửi tới chỉ tốn thời
// gian chờ rồi lỗi, không còn mang lại trận nào. Không xoá
// src/services/phaohoa.service.js (phòng khi domain khác hoạt động lại) —
// chỉ ngừng gọi/hiển thị ở mọi nơi khác trong pipeline.
export const SOURCE_TOGGLE_LIST = [
  { key: 'giovang', label: 'Giờ Vàng' },
  { key: 'khandaitv', label: 'Khán Đài' },
  { key: 'chuoichientv', label: 'Chuối Chiên' },
  { key: 'phalang', label: 'Phá Làng' },
  { key: 'gavang33', label: 'GaVang33' },
  { key: 'bonglau', label: 'Bông Lau' },
  { key: 'xoilac', label: 'Xôi Lạc' },
  { key: 'xoigac', label: 'Xôi Gấc' }
];

// Bump the key once so an old browser setting cannot hide every source after
// the source list/status handling changes. New choices are still persisted.
const SOURCE_TOGGLE_STORAGE_KEY = 'player-get:enabled-sources:v6';

/** Mặc định: tất cả nguồn đều bật. */
export function getDefaultEnabledSources() {
  return SOURCE_TOGGLE_LIST.reduce((acc, s) => {
    acc[s.key] = true;
    return acc;
  }, {});
}

/** Đọc trạng thái bật/tắt nguồn đã lưu trên trình duyệt (an toàn cho SSR). */
export function loadEnabledSources() {
  const defaults = getDefaultEnabledSources();
  if (typeof window === 'undefined') return defaults;
  try {
    const raw = window.localStorage.getItem(SOURCE_TOGGLE_STORAGE_KEY);
    if (!raw) return defaults;
    const saved = JSON.parse(raw);
    return { ...defaults, ...saved };
  } catch {
    return defaults;
  }
}

/** Lưu trạng thái bật/tắt nguồn vào trình duyệt. */
export function saveEnabledSources(enabledSources) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(
      SOURCE_TOGGLE_STORAGE_KEY,
      JSON.stringify(enabledSources || {})
    );
  } catch {
    // localStorage có thể bị chặn (chế độ ẩn danh...) — bỏ qua, không critical.
  }
}

/** True nếu nguồn của trận đang được bật (mặc định bật khi chưa có key). */
export function isSourceEnabled(match, enabledSources) {
  const key = getSourceKey(match);
  if (!enabledSources) return true;
  return enabledSources[key] !== false;
}


export function normalizeSport(sport) {
  if (!sport) return 'other';
  const key = String(sport).toLowerCase().trim();
  return SPORT_ALIASES[key] || 'other';
}

export function getSourceKey(match) {
  // FIX (20/09/2026): mặc định cũ là 'phaohoa' — nguồn đã bị loại bỏ khỏi
  // pipeline (xem SOURCE_GROUP_ORDER), giữ nguyên default đó sẽ gắn nhầm
  // nhãn "Pháo Hoa" cho match không rõ nguồn. Đổi thành 'unknown' — trường
  // hợp này hiếm khi xảy ra (mọi service đều tự gắn source qua
  // tagMatchSource khi build danh sách).
  return match?.source || 'unknown';
}

export function getSourceLabel(matchOrSource) {
  const key = typeof matchOrSource === 'string' ? matchOrSource : getSourceKey(matchOrSource);
  const customLabel = typeof matchOrSource === 'object' ? matchOrSource?.sourceLabel : '';
  return SOURCE_LABELS[key] || customLabel || key;
}

export function getSourceShortLabel(matchOrSource) {
  const key = typeof matchOrSource === 'string' ? matchOrSource : getSourceKey(matchOrSource);
  const customLabel = typeof matchOrSource === 'object' ? matchOrSource?.sourceLabel : '';
  return SOURCE_SHORT[key] || customLabel || key;
}

export function isM3u8Url(url) {
  if (!url || typeof url !== 'string') return false;
  return /\.m3u8(\?|$)/i.test(url);
}

export function isFlvUrl(url) {
  if (!url || typeof url !== 'string') return false;
  return /\.flv(\?|$)/i.test(url);
}

/** HLS twin of an FLV path, when the CDN happens to expose one at the same path. */
export function flvToM3u8Candidate(url) {
  if (!isFlvUrl(url)) return '';
  return url.replace(/\.flv(?=\?|$)/i, '.m3u8');
}

/**
 * FIX "Không thể tìm thấy trang ... .quickscoreboardz.com" (DNS_PROBE_
 * FINISHED_NXDOMAIN) trên các trận CÓ bình luận viên (web lẫn playlist):
 * một số domain CDN mà nguồn trả về vẫn phản hồi bình thường khi server
 * (Vercel, hạ tầng nước ngoài) tự kiểm tra, nhưng đã bị nhà mạng trong
 * nước (VNPT/Viettel/FPT...) chặn DNS riêng cho người xem VN — nên link
 * vẫn lọt qua mọi bộ lọc hiện có rồi báo lỗi khi bấm phát thật. Domain
 * kiểu này không tự "khỏi" được bằng retry/kiểm tra mạng từ server, phải
 * liệt kê thủ công. Đây là điểm lọc DÙNG CHUNG cho MỌI nguồn (xem
 * normalizeStreamList() bên dưới — nơi duy nhất mọi nguồn đều đi qua trước
 * khi ra playlist/web) — thêm domain mới vào đây khi có báo lỗi kèm tên
 * domain cụ thể, KHÔNG cần sửa gì ở từng service riêng lẻ.
 */
const DEAD_STREAM_DOMAINS = [
  'quickscoreboardz.com',
  'livefeedtextbox.com'
];

export function isDeadStreamDomain(url) {
  if (!url || typeof url !== 'string') return false;
  let host = '';
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return DEAD_STREAM_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));
}

/**
 * FIX "vẫn có link trận đấu mà không xem được" dù domain lạ (chưa từng có
 * trong DEAD_STREAM_DOMAINS) — lớp lọc CUỐI CÙNG áp dụng cho MỌI nguồn (Gà
 * mọi nguồn ngay trước khi đưa vào
 * playlist/web (gọi từ playlistBuilder.service.js:resolveStreams, sau
 * normalizeStreamList — điểm mà TẤT CẢ nguồn đều đi qua). Gửi 1 request GET
 * ngắn, hủy ngay sau khi nhận header (không tải hết nội dung), loại link
 * nếu 1 trong 2 tín hiệu chắc chắn sau xảy ra:
 *   1) Lỗi tầng DNS/kết nối (ENOTFOUND, EAI_AGAIN, ECONNREFUSED) → domain
 *      chết thật.
 *   2) Content-Type trả về là text/html → CDN trả 1 TRANG WEB (trang lỗi/
 *      trang chặn/trang yêu cầu đăng nhập...) thay vì dữ liệu stream thật —
 *      link .m3u8/.flv thật KHÔNG BAO GIỜ có content-type html, bất kể
 *      status code là gì.
 * CHỦ Ý KHÔNG xét status code (403/302...): đã thử coi 403 là chết ở lần
 * sửa trước — loại oan gần như toàn bộ link Xôi Lạc/Gà Vàng vẫn phát tốt,
 * vì nhiều CDN vốn luôn trả 403 cho request kiểm tra dù player thật vẫn
 * phát bình thường. KHÔNG lặp lại cách đó.
 */
export async function verifyStreamUrlPlayable(url) {
  if (!url) return false;
  if (isDeadStreamDomain(url)) return false;
  try {
    const res = await axios.get(url, {
      timeout: 3000,
      maxRedirects: 3,
      validateStatus: () => true,
      responseType: 'stream',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: '*/*'
      }
    });
    const contentType = String(res.headers?.['content-type'] || '').toLowerCase();
    res.data?.destroy?.(); // chỉ cần header, hủy ngay không tải phần thân
    return !contentType.includes('text/html');
  } catch (err) {
    const code = err?.code || '';
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'ECONNREFUSED') return false;
    // Lỗi khác (timeout, TLS lạ...) — không đủ chắc chắn để loại, tránh bỏ
    // oan 1 link vẫn còn dùng được trong player thật.
    return true;
  }
}

export function isPlayableStreamUrl(url) {
  if (!url || typeof url !== 'string') return false;
  if (!/^https?:\/\//i.test(url)) return false;
  if (isDeadStreamDomain(url)) return false;
  if (isM3u8Url(url) || isFlvUrl(url)) return true;
  // Chấp nhận URL CDN stream hợp lệ không có phần mở rộng .m3u8/.flv
  // (Tencent liveplay, Alibaba/AliCDN, phaohoa, và các CDN phổ biến khác)
  const u = url.toLowerCase();
  const knownCdn =
    u.includes('tlivecdn') ||
    u.includes('liveplay') ||
    u.includes('tencent') ||
    u.includes('aliyun') ||
    u.includes('alicdn') ||
    u.includes('phaohoa') ||
    u.includes('bpmedialive') ||
    u.includes('procdnlive') ||
    u.includes('scorecast') ||
    u.includes('xl365') ||
    u.includes('golivenow') ||
    u.includes('vncdn') ||
    u.includes('livestreambong') ||
    u.includes('/live/') ||
    u.includes('/stream/') ||
    u.includes('/hls/');
  return knownCdn;
}

/**
 * Normalize stream objects for the live playlist page.
 * Accepts HLS (.m3u8) and FLV. Prefers m3u8; derives m3u8 twin from flv when needed.
 */
export function normalizeStreamList(list = []) {
  return (list || [])
    .map((s) => {
      const raw = s.m3u8Url || s.link || s.streamUrl || s.flvUrl || '';
      const flvUrl = s.flvUrl || (isFlvUrl(raw) ? raw : '');
      let m3u8Url = '';
      if (isM3u8Url(s.m3u8Url)) m3u8Url = s.m3u8Url;
      else if (isM3u8Url(raw)) m3u8Url = raw;
      else if (flvUrl) m3u8Url = flvToM3u8Candidate(flvUrl);

      // Prefer real HLS; else keep FLV as playable copy target
      const playUrl = (isM3u8Url(s.m3u8Url) && s.m3u8Url)
        || (isM3u8Url(raw) && raw)
        || flvUrl
        || m3u8Url
        || raw;

      const format = isM3u8Url(playUrl) ? 'hls' : (isFlvUrl(playUrl) ? 'flv' : 'url');

      return {
        ...s,
        m3u8Url: playUrl,
        flvUrl: flvUrl || (isFlvUrl(playUrl) ? playUrl : ''),
        playUrl,
        format,
        streamerName: s.streamerName || s.name || 'Server',
        streamerAvatar: s.streamerAvatar || s.avatar || '',
        cdn: s.cdn || ''
      };
    })
    .filter((s) => isPlayableStreamUrl(s.playUrl || s.m3u8Url));
}

/**
 * Extract streams already present on the list-card object, without doing a
 * second network round-trip to fetch match detail.
 *
 * FIX (17/09/2026 — "các trận đang live nguồn Chuối Chiên không xem
 * được"): resolveStreams() trong playlistBuilder.service.js gọi hàm này
 * TRƯỚC TIÊN; nếu trả về rỗng mới rơi xuống nhánh gọi riêng
 * chuoichientvService.getStreamLinks(matchId) — hàm đó lại gọi
 * findRawMatch() để fetch THÊM 1 LẦN NỮA sang API ngoài
 * (`/matches/external/{id}`) chỉ để lấy đúng cái danh sách BLV/link stream
 * mà lần gọi danh sách trận ban đầu (`/matches?type=live`) ĐÃ CÓ SẴN rồi
 * (xem chuoichientv.service.js — normalizeMatch() dựng `commentators` trực
 * tiếp từ `m.blvs` ngay trong response danh sách). Lần gọi thứ 2 này không
 * cần thiết và là điểm lỗi thêm vô ích (endpoint riêng, có thể sai id/timeout
 * /đổi schema) — mỗi khi nó lỗi thì match live mất sạch nút ▶ dù dữ liệu
 * cần thiết đã nằm sẵn trong tay. Trước đây hàm này CHỈ áp dụng lối tắt này
 * cho nguồn 'phaohoa' — giờ thêm 'chuoichientv' vào vì nguồn này cũng trả
 * sẵn đầy đủ link stream ngay trong danh sách, y hệt Pháo Hoa, không cần
 * gọi chi tiết riêng.
 */
export function streamsFromMatchCard(match) {
  if (Array.isArray(match?.streams) && match.streams.length) {
    const list = normalizeStreamList(match.streams);
    return list.length ? list : null;
  }

  if (match?.source !== 'phaohoa' && match?.source !== 'chuoichientv' && match?.source !== 'phalang' && match?.source !== 'gavang' && match?.source !== 'saoke' && match?.source !== 'gavang33' && match?.source !== 'bonglau' && match?.source !== 'xoilac' && match?.source !== 'xoigac') return null;

  const fromCommentators = (match.commentators || match.streamers || [])
    .filter((c) => c.streamUrl || c.link || c.m3u8Url)
    .map((c) => ({
      id: c.id,
      name: c.name,
      streamerName: c.name,
      avatar: c.avatar,
      streamerAvatar: c.avatar,
      link: c.streamUrl || c.link || c.m3u8Url,
      m3u8Url: c.streamUrl || c.link || c.m3u8Url,
      cdn: c.cdn || '',
      // Referer THẬT tự dò được (hiện chỉ saoke.service.js gắn field này —
      // xem detectPlayerReferer() ở đó) — các nguồn khác luôn undefined,
      // m3uPlaylist.js tự rơi về danh sách ứng viên hardcode như cũ.
      referer: c.referer || null
    }));

  if (fromCommentators.length) {
    const list = normalizeStreamList(fromCommentators);
    return list.length ? list : null;
  }

  if (match.streamUrl && isPlayableStreamUrl(match.streamUrl)) {
    return normalizeStreamList([{
      name: 'Server 1',
      streamerName: 'Server 1',
      link: match.streamUrl,
      m3u8Url: match.streamUrl
    }]);
  }

  return null;
}

export function matchCacheKey(match) {
  return match?.matchId || match?.stream?.liveUrl || '';
}

/**
 * Different sources report matchTimeTimestamp in different units
 * (some sources: seconds, others: milliseconds). Normalize to ms
 * so sorting/filtering across sources lines up correctly.
 */
export function toMatchTimeMs(ts) {
  if (!ts) return 0;
  return ts < 99999999999 ? ts * 1000 : ts;
}

/** True when a match's kickoff falls within the next `hours` (default 24h). */
export function isWithinNextHours(match, hours = 24) {
  const ms = toMatchTimeMs(match?.matchTimeTimestamp);
  if (!ms) return false;
  const now = Date.now();
  return ms > now && ms <= now + hours * 60 * 60 * 1000;
}

/** True when a match hasn't started and isn't finished yet (any source). */
export function isUpcomingMatch(match) {
  const status = match?.status || {};
  if (status.isLive || status.isFinished) return false;
  if (status.isUpcoming) return true;
  // Sources without an explicit isUpcoming flag: infer from time.
  return isWithinNextHours(match, 24 * 7);
}

/**
 * True khi trận đang được đánh dấu "sắp diễn ra" nhưng giờ bóng lăn đã qua
 * (tức dữ liệu đã cũ / nguồn chưa cập nhật trạng thái sang live/FT).
 * Dùng để hiện badge "Đang kiểm tra..." hoặc ẩn nút xem thay vì hiện stream lỗi.
 */
export function isStaleUpcoming(match) {
  const status = match?.status || {};
  if (status.isLive || status.isFinished) return false;
  const ms = toMatchTimeMs(match?.matchTimeTimestamp);
  if (!ms) return false;
  // Coi là stale nếu giờ dự kiến đã qua nhưng vẫn chưa được đánh dấu live
  return ms < Date.now();
}

// Thời lượng "live" hợp lý tối đa theo môn — quá mốc này mà vẫn được đánh
// dấu live thì nhiều khả năng trận đã kết thúc từ lâu và nguồn (hay gặp
// nhất: Gà Vàng) chưa cập nhật lại trạng thái, chứ không phải trận thật sự
// đang kéo dài. Để dư dả (hiệp phụ, luân lưu, delay bình luận viên...).
const MAX_LIVE_DURATION_HOURS = {
  football: 3.5,
  basketball: 3,
  volleyball: 3,
  badminton: 2.5,
  tennis: 6, // Grand Slam 5 set có thể kéo rất dài
  esports: 5
};
const DEFAULT_MAX_LIVE_DURATION_HOURS = 4;

/**
 * True khi trận đang đánh dấu "live" nhưng đã trôi qua quá lâu so với giờ
 * bóng lăn ban đầu để còn thực sự đang diễn ra — dữ liệu cũ nhiều khả năng
 * do nguồn quên cập nhật trạng thái sang "kết thúc". Dùng để tự lọc bỏ thay
 * vì hiện nhầm 1 trận đã xong từ lâu là "đang live".
 */
export function isStaleLiveMatch(match) {
  const status = match?.status || {};
  if (!status.isLive) return false;
  const ms = toMatchTimeMs(match?.matchTimeTimestamp);
  if (!ms) return false; // không có giờ bóng lăn thì không đủ căn cứ để coi là cũ
  const sportKey = normalizeSport(match?.sport);
  const maxHours = MAX_LIVE_DURATION_HOURS[sportKey] ?? DEFAULT_MAX_LIVE_DURATION_HOURS;
  return Date.now() - ms > maxHours * 60 * 60 * 1000;
}

/** Giờ bóng lăn thực (dd/MM HH:mm) tính từ matchTimeTimestamp, dùng chung
 *  cho cả trận sắp diễn ra lẫn trận live không đọc được phút thi đấu.
 *
 *  QUAN TRỌNG: NGÀY phải đứng TRƯỚC giờ trong chuỗi trả về (không phải
 *  "HH:mm dd/MM" như trước) — vì chuỗi này được dùng làm phần đầu tên
 *  kênh trong file .m3u (xem m3uPlaylist.js). Rất nhiều app IPTV tự sắp
 *  xếp danh sách kênh theo TÊN (so sánh chuỗi ký tự) thay vì theo đúng
 *  thứ tự dòng trong file — nếu giờ đứng trước ngày, 1 trận "00:00
 *  15/08" sẽ bị app xếp LÊN TRƯỚC trận "18:00 14/08" chỉ vì so sánh
 *  chuỗi thấy "0" < "1" ở đầu, dù file gốc đã sort đúng theo thời gian
 *  thực. Đặt ngày trước để so sánh chuỗi cũng ra đúng thứ tự ngày trước,
 *  giờ sau — khớp với sort thời gian thực bất kể app có tự sort theo
 *  tên hay không.
 *
 *  QUAN TRỌNG: hàm này LUÔN trả về ngày-giờ đá (không bao giờ trả về
 *  "LIVE"/phút thi đấu) — dùng làm phần ĐẦU tên kênh trong .m3u để giữ
 *  đúng thứ tự sort-theo-tên ở mọi trạng thái trận (live/sắp đá đều
 *  giống nhau). Nhãn LIVE/phút thi đấu hiển thị THÊM vào sau, xem
 *  getLiveBadge() — không được gộp chung vào 1 hàm rồi thay thế phần
 *  ngày-giờ như formatMatchTime() làm cho web, vì làm vậy sẽ khiến tên
 *  trận live bắt đầu bằng "18'" thay vì ngày-giờ, phá sort-theo-tên y hệt
 *  lỗi ngày/giờ đã fix trước đó — nhưng lần này xảy ra riêng với các
 *  trận live. */
export function formatKickoffTime(match) {
  const ts = match?.matchTimeTimestamp || match?.matchTime;
  if (!ts) return '';
  const ms = toMatchTimeMs(ts);
  const date = new Date(ms);
  const timeStr = date.toLocaleTimeString('vi-VN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'Asia/Ho_Chi_Minh'
  });
  const dateStr = date.toLocaleDateString('vi-VN', {
    day: '2-digit',
    month: '2-digit',
    timeZone: 'Asia/Ho_Chi_Minh'
  });
  return `${dateStr} ${timeStr}`;
}

/** Giờ đá dạng "18:35 24/09" (giờ trước, ngày sau) — dùng cho tên kênh .m3u
 *  theo mẫu Ola TV (xem buildM3uPlaylist() trong m3uPlaylist.js). */
export function formatKickoffHourFirst(match, { dateFirst = false } = {}) {
  const ts = match?.matchTimeTimestamp || match?.matchTime;
  if (!ts) return '';
  const date = new Date(toMatchTimeMs(ts));
  // Dùng formatToParts để luôn ra đúng "HH:mm dd/MM", không phụ thuộc
  // locale/ICU của máy chạy (Node trên CI có thể ra "24-09" thay vì "24/09").
  const parts = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    day: '2-digit',
    month: '2-digit',
    hourCycle: 'h23',
    timeZone: 'Asia/Ho_Chi_Minh'
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t)?.value || '';
  const hm = `${get('hour')}:${get('minute')}`;
  const dm = `${get('day')}/${get('month')}`;
  return dateFirst ? `${dm} ${hm}` : `${hm} ${dm}`;
}

/** Nhãn LIVE ngắn gọn ("18'", "HT", "LIVE"...) dùng để GẮN THÊM cạnh
 *  ngày-giờ trong tên kênh .m3u (xem getPlaylistLabel() trong
 *  m3uPlaylist.js) — không thay thế ngày-giờ như formatMatchTime(). Trả
 *  về '' khi trận không phải đang live. */
export function getLiveBadge(match) {
  const status = match?.status || {};
  if (!status.isLive) return '';
  // Chỉ hiện nhãn LIVE tĩnh — KHÔNG hiện số phút thi đấu (ví dụ "34'")
  // trong tên trận, dù ở web hay trong file .m3u. Vẫn giữ các nhãn không
  // phải số phút như "HT" (nghỉ giữa hiệp) nếu nguồn có trả về.
  const looksLikeMinuteClock = (v) => /^\d{1,3}(\+\d{1,2})?['’]?$/i.test(String(v || '').trim());

  const raw = String(status.elapsedTime || '').trim();
  if (raw && !looksLikeMinuteClock(raw)) return raw;

  const fallback = String(status.text || status.name || '').trim();
  if (fallback && !looksLikeMinuteClock(fallback)) return fallback;

  return 'LIVE';
}

export function formatMatchTime(match) {
  const status = match?.status || {};
  const kickoff = formatKickoffTime(match);

  // Trận đang live: hiện GIỜ BÓNG LĂN (kickoff) trước — vì UI đã có sẵn 1
  // badge đỏ "LIVE" riêng ngay cạnh (xem MatchCard/MatchListRow), nên nếu
  // hàm này cũng trả về "LIVE" thì người xem thấy 2 chữ LIVE cạnh nhau mà
  // KHÔNG thấy giờ bắt đầu trận đâu cả — đúng lỗi đã gặp. Ưu tiên:
  //   1) Giờ bóng lăn (kickoff) — luôn có ý nghĩa, không đổi giữa các lần
  //      làm mới cache nên không sợ hiện sai.
  //   2) Nếu có thêm nhãn không phải số phút (vd "HT" nghỉ giữa hiệp) thì
  //      nối thêm sau giờ bóng lăn, dạng "21:00 · HT".
  //   3) Chỉ khi HOÀN TOÀN không có kickoff (nguồn không trả giờ) mới rơi
  //      xuống nhãn live tĩnh ("LIVE") để badge không bao giờ trống.
  if (status.isLive) {
    const badge = getLiveBadge(match);
    const meaningfulBadge = badge && badge !== 'LIVE' ? badge : '';
    if (kickoff) return meaningfulBadge ? `${kickoff} · ${meaningfulBadge}` : kickoff;
    if (badge) return badge;
    if (match?.timeFormatted) return match.timeFormatted;
    return 'LIVE';
  }

  // Trận đã kết thúc: hiện rõ "Kết thúc" thay vì giờ bóng lăn lúc trước.
  if (status.isFinished) {
    return status.text || 'Kết thúc';
  }

  if (kickoff) return kickoff;
  if (match?.timeFormatted) return match.timeFormatted;
  return '';
}


export function getMatchTitle(match) {
  if (match?.title) return match.title;
  const home = match?.homeTeam?.name || 'Home';
  const away = match?.awayTeam?.name || 'Away';
  if (!match?.awayTeam?.name) return home;
  return `${home} vs ${away}`;
}

export function tagMatchSource(match, source) {
  return {
    ...match,
    source,
    sportCategory: normalizeSport(match.sport)
  };
}

/** Short "Sắp diễn ra" style label for a match that hasn't kicked off yet. */
export function formatUpcomingBadge(match) {
  const ms = toMatchTimeMs(match?.matchTimeTimestamp);
  if (!ms) return 'Sắp diễn ra';
  const diffMin = Math.round((ms - Date.now()) / 60000);
  if (diffMin <= 0) return 'Sắp diễn ra';
  if (diffMin < 60) return `Bắt đầu sau ${diffMin} phút`;
  const hours = Math.floor(diffMin / 60);
  const mins = diffMin % 60;
  return mins ? `Bắt đầu sau ${hours}h${mins}p` : `Bắt đầu sau ${hours}h`;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch JSON with exponential backoff.
 * Retries on network errors, 408/429/5xx, and success:false timeout-like messages.
 */
export async function fetchWithRetry(url, options = {}, maxAttempts = 4) {
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await fetch(url, options);
      const retryableStatus =
        response.status === 408 ||
        response.status === 429 ||
        response.status >= 500;

      if (!response.ok) {
        if (retryableStatus && attempt < maxAttempts) {
          await sleep(500 * Math.pow(2, attempt - 1));
          continue;
        }
        return { success: false, data: [], message: `HTTP ${response.status}` };
      }

      const contentType = response.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) {
        if (attempt < maxAttempts) {
          await sleep(500 * Math.pow(2, attempt - 1));
          continue;
        }
        return { success: false, data: [], message: 'Invalid content-type' };
      }

      const json = await response.json();
      if (json && json.success === false && attempt < maxAttempts) {
        const msg = json.message || 'API failed';
        if (/timeout|failed to fetch|ECONN|network|503|502|500|429/i.test(msg)) {
          await sleep(500 * Math.pow(2, attempt - 1));
          continue;
        }
      }
      return json;
    } catch (err) {
      lastError = err;
      if (attempt < maxAttempts) {
        await sleep(500 * Math.pow(2, attempt - 1));
        continue;
      }
    }
  }

  return {
    success: false,
    data: [],
    message: lastError?.message || 'Fetch failed'
  };
}

/** Run async tasks with a concurrency limit. */
export async function mapPool(items, concurrency, fn) {
  const results = new Array(items.length);
  let next = 0;

  async function worker() {
    while (next < items.length) {
      const i = next;
      next += 1;
      results[i] = await fn(items[i], i);
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, Math.max(items.length, 1)) },
    () => worker()
  );
  await Promise.all(workers);
  return results;
}

export function filterBySportTab(matches, tabId) {
  // FIX "a.filter is not a function": nếu vì lý do gì đó `matches` không
  // phải mảng (cache lỗi, dữ liệu nguồn bất thường...) thì trả về mảng
  // rỗng thay vì để .filter ném lỗi làm sập cả route /api/playlist —
  // người dùng thấy playlist rỗng tạm thời còn hơn thấy trang lỗi.
  if (!Array.isArray(matches)) return [];
  if (!tabId || tabId === 'all') return matches;
  return matches.filter((m) => m.sportCategory === tabId);
}

/**
 * Lọc danh sách trận theo NGUỒN (phaohoa/giovang) — dùng cho playlist .m3u
 * riêng từng nguồn (?source=phaohoa), tương tự cách filterBySportTab lọc
 * theo môn thể thao. sourceKey rỗng hoặc 'all' thì giữ nguyên toàn bộ
 * (không lọc) — khớp hành vi mặc định hiện có.
 */
export function filterBySource(matches, sourceKey) {
  if (!Array.isArray(matches)) return [];
  if (!sourceKey || sourceKey === 'all') return matches;
  return matches.filter((m) => getSourceKey(m) === sourceKey);
}

export function countBySportTab(matches) {
  const list = Array.isArray(matches) ? matches : [];
  const counts = { all: list.length };
  SPORT_TABS.forEach((tab) => {
    if (tab.id === 'all') return;
    counts[tab.id] = list.filter((m) => m.sportCategory === tab.id).length;
  });
  return counts;
}
