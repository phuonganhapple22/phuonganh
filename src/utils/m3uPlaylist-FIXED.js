import {
  formatKickoffHourFirst,
  toMatchTimeMs,
  formatUpcomingBadge,
  getMatchTitle,
  getSourceKey,
  getSourceShortLabel,
  SOURCE_GROUP_ORDER,
  isFlvUrl,
  isM3u8Url,
  flvToM3u8Candidate,
  verifyStreamUrlPlayable,
  mapPool
} from '@/src/utils/playerGet';

// FIX (23/09/2026 — "nguồn Chuối Chiến trong all.m3u add trên app IPTV
// không xem được, dù link .m3u8 y hệt trên web vẫn phát bình thường"):
// CDN của Chuối Chiến (edgemaxcdn.org) — và tương tự các nguồn khác dùng
// CDN riêng — chặn hotlink theo Referer (xem REFERER_CANDIDATES_BY_SOURCE
// trong pages/api/proxy/hls.js, đã tự dò và xác nhận cần đúng Referer mới
// cho phát). Trang web tự gửi đúng Referer của chính nó nên phát được;
// nhưng app IPTV (VLC/TiviMate/Perfect Player/...) mở THẲNG link trong file
// .m3u tĩnh này thì KHÔNG gửi Referer nào — bị CDN từ chối. File .m3u này
// chạy hoàn toàn tĩnh trên GitHub (không có server để bọc qua
// /api/proxy/hls như bên web), nên phải nhúng Referer/User-Agent NGAY
// TRONG file .m3u bằng cú pháp #EXTVLCOPT — được VLC/TiviMate/Perfect
// Player/IPTV Smarters/... hỗ trợ sẵn để tự đính kèm header khi phát, không
// cần proxy.
//
// FIX 2 (25/09/2026 — "GitHub Actions CI IP bị CDN chặn, probe referer thất
// bại"): Khi chỉ deploy lên GitHub (không có VPS), GitHub Actions CI IP bị
// CDN chặn -> probeReferer() LUÔN timeout/lỗi. Code fallback về best-guess
// (ứng viên đầu tiên) nhưng referer đó có thể đã hết hạn. GIẢI PHÁP: thêm
// env var OVERRIDE để user có thể set referer thủ công khi cần mà không cần
// đợi dò lại hay sửa code — VD:
//   CHUOICHIENTV_IPTV_REFERER=https://fhd-01.cctvsignal.xyz/
//   SAOKE_IPTV_REFERER=https://sk.mediastation.live/
// Các biến này CHỈ dùng để override best-guess khi GitHub Actions dò thất bại.
const UPCOMING_SOON_MINUTES = 60;

// FIX (24/09/2026 — "trận 01:00 25/09 bị xếp trên trận 21:00 24/09"): app
// IPTV (Ola TV...) tự sort danh sách theo TÊN kênh. Để giờ đứng trước ngày
// ("21:00 24/09") thì sort theo tên xếp "01:00 25/09" lên trên "21:00 24/09".
// Đặt NGÀY trước, GIỜ sau ("24/09 21:00") thì sort theo tên ra đúng thứ tự
// thời gian. Đổi thành false nếu muốn giờ trước ngày (giống ảnh mẫu).
const KICKOFF_DATE_FIRST = true;

function getStatusDot(match) {
  const status = match?.status || {};
  if (status.isLive) return '🟢';
  if (status.isFinished) return '';
  const ms = toMatchTimeMs(match?.matchTimeTimestamp || match?.matchTime);
  if (!ms) return '';
  const diffMin = (ms - Date.now()) / 60000;
  return diffMin <= UPCOMING_SOON_MINUTES ? '🟡' : '';
}

function getSportIcon(match) {
  const raw = `${match?.sport || ''} ${match?.sportCategory || ''}`.toLowerCase();
  if (/basket|bong-ro|bóng rổ/.test(raw)) return '🏀';
  if (/volley|chuyen|chuyền/.test(raw)) return '🏐';
  if (/badminton|cau-long|cầu lông/.test(raw)) return '🏸';
  if (/tennis/.test(raw)) return '🎾';
  if (/f1|motor|dua-xe|đua xe/.test(raw)) return '🏎️';
  return '⚽';
}

const IPTV_HEADER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Giữ ĐỒNG BỘ danh sách ứng viên với REFERER_CANDIDATES_BY_SOURCE trong
// pages/api/proxy/hls.js — sửa 1 nơi thì nhớ sửa nơi kia theo, tránh lệch.
const REFERER_CANDIDATES_BY_SOURCE = {
  // FIX (25/09/2026 — bắt request THẬT bằng DevTools, xem chú thích tương
  // ứng trong pages/api/proxy/hls.js): domain player CHUẨN là
  // fhd-01.cctvsignal.xyz, KHÔNG phải live05.chuoichientv.me/chuoichientv.link
  // như đoán trước đây — 2 domain đó giờ chỉ còn là ứng viên dự phòng.
  chuoichientv: [
    `${String(process.env.CHUOICHIENTV_PLAYER_DOMAIN || 'https://fhd-01.cctvsignal.xyz').replace(/\/+$/, '')}/`,
    'https://live05.chuoichientv.me/',
    'https://chuoichientv.link/',
    null
  ],
  giovang: [process.env.GIOVANG_DOMAIN || 'https://giovang.city', null],
  khandaitv: [process.env.KHANDAITV_DOMAIN || process.env.KHANDAITV_BASE_URL || 'https://khandai3.link', null],
  phalang: ['https://phalang.live', 'https://phalang.live/', null],
  gavang: [
    ...new Set([
      String(process.env.GAVANG_DOMAIN || process.env.GAVANG_BASE_URL || 'https://gavanglinkp.tv').replace(/\/+$/, ''),
      'https://gavanglinkp.tv',
      'https://gavangtv.tv',
      'https://gavangtvv.cc'
    ])
  ].map((d) => `${d}/`).concat([null]),
  saoke: [
    // Referer/Origin thật của player (bắt từ DevTools 24/09/2026) — đặt LÊN ĐẦU.
    `${String(process.env.SAOKE_PLAYER_DOMAIN || 'https://sk.mediastation.live').replace(/\/+$/, '')}/`,
    `${String(process.env.SAOKE_DOMAIN || process.env.SAOKE_BASE_URL || 'https://vip3.saoketv40.xyz').replace(/\/+$/, '')}/`,
    'https://live05.chuoichientv.me/',
    'https://chuoichientv.link/',
    null
  ]
};

const IPTV_REFERER_PROBE_TIMEOUT_MS = 4000;
// null nằm trong danh sách nghĩa là "không gửi Referer nào" — luôn xếp
// CUỐI khi không nhớ được lựa chọn thắng trước đó (xem workingRefererByHost),
// vì đa số CDN thật sự cần Referer đúng, chỉ 1 số ít không cần.
const workingRefererByHost = new Map();

function isHotlinkBlockStatus(status) {
  return status === 401 || status === 403 || status === 451;
}

async function probeReferer(url, referer) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), IPTV_REFERER_PROBE_TIMEOUT_MS);
  try {
    const headers = { 'User-Agent': IPTV_HEADER_UA, Range: 'bytes=0-0' };
    if (referer) {
      headers.Referer = referer;
      try {
        headers.Origin = new URL(referer).origin;
      } catch {
        // referer không phải URL hợp lệ (không nên xảy ra với danh sách cố định trên) -> bỏ qua Origin
      }
    }
    const res = await fetch(url, { headers, signal: controller.signal });
    return !isHotlinkBlockStatus(res.status);
  } catch {
    // Lỗi mạng/timeout khi DÒ THỬ không có nghĩa link chết — có thể do
    // chính máy chủ GitHub Actions bị CDN chặn IP (khác hẳn máy người dùng
    // thật sẽ mở link), nên KHÔNG loại bỏ ứng viên vì lý do này, tránh gán
    // nhầm "không cần Referer" chỉ vì lần dò từ CI bị chặn IP. Coi như dò
    // thất bại (không dùng ứng viên này) nhưng vẫn thử ứng viên tiếp theo.
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * FIX (25/09/2026 — GitHub-only deploy, probe referer không chính xác):
 * Dò xem có env var override cho nguồn cụ thể không trước khi probe CDN.
 * Người dùng có thể set như: CHUOICHIENTV_IPTV_REFERER=https://.../ 
 * để bypass probe thất bại khi GitHub Actions IP bị chặn.
 */
function getOverrideReferer(source) {
  const envVar = `${source.toUpperCase()}_IPTV_REFERER`;
  const override = process.env[envVar];
  if (override) {
    console.log(`[m3uPlaylist] Dùng override referer từ ${envVar}: ${override}`);
    return override;
  }
  return null;
}

/**
 * Dò xem CDN của link `url` (nguồn `source`) chấp nhận Referer nào — trả về
 * chuỗi Referer thắng, hoặc `null` nếu CDN không cần Referer / không dò
 * được ứng viên nào (khi đó KHÔNG ghi #EXTVLCOPT, để link ở dạng trần —
 * an toàn hơn là gán 1 Referer chưa xác minh có thể làm CDN càng chặn).
 */
async function resolveIptvReferer(url, source) {
  // FIX (25/09/2026): kiểm tra override env var trước
  const override = getOverrideReferer(source);
  if (override) return override;

  const candidates = REFERER_CANDIDATES_BY_SOURCE[source];
  if (!candidates) return null;

  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    return null;
  }

  // FIX (24/09/2026): khoá nhớ theo CẢ nguồn + host — Sao Kê và Chuối Chiến
  // dùng chung CDN edgemaxcdn.org, nếu chỉ nhớ theo host thì Referer của nguồn
  // này bị áp nhầm sang nguồn kia.
  const cacheKey = `${source}|${host}`;
  const remembered = workingRefererByHost.get(cacheKey);
  if (remembered !== undefined) return remembered;

  for (const referer of candidates) {
    // eslint-disable-next-line no-await-in-loop
    const ok = await probeReferer(url, referer);
    if (ok) {
      workingRefererByHost.set(cacheKey, referer);
      return referer;
    }
  }
  // FIX (23/09/2026 — "nguồn Chuối Chiến không có #EXTVLCOPT như các nguồn
  // khác nên không xem được"): dò THẤT BẠI với CẢ 3 ứng viên (kể cả "không
  // Referer") không có nghĩa CDN thật sự không cần Referer — CHÍNH pages/
  // api/proxy/hls.js trước đây đã ghi nhận đúng hiện tượng này với CDN
  // hdplaylink.com của Chuối Chiến: dù thử "không gửi Referer/Origin" vẫn
  // bị chặn y hệt -> kết luận nhiều khả năng CDN chặn theo IP máy chủ
  // trung tâm dữ liệu (Vercel/GitHub Actions), KHÔNG liên quan Referer.
  // Máy chủ CI ở đây cũng là IP trung tâm dữ liệu -> dò từ đây với CDN kiểu
  // này LUÔN thất bại bất kể Referer, cho kết quả giả (false negative) —
  // trong khi máy thật của người xem (IP nhà mạng bình thường) thì Referer
  // đúng vẫn phát được tốt. Vì vậy: KHÔNG bỏ trắng khi dò thất bại toàn bộ —
  // quay về dùng ứng viên ĐẦU TIÊN (best-guess đã biết là hay đúng nhất,
  // xem REFERER_CANDIDATES_BY_SOURCE) thay vì không ghi gì — có Referer
  // (dù chưa chắc 100%) vẫn tốt hơn hẳn để trần không Referer, vì phần lớn
  // trường hợp CDN các nguồn này THẬT SỰ cần đúng Referer mới phát được
  // (đã xác nhận qua thực tế người dùng test — thêm Referer sửa được đa số
  // trận). Không nhớ lại (workingRefererByHost) cho trường hợp này, để lần
  // dò sau (2 phút kế) vẫn thử lại từ đầu, phòng khi CDN chỉ chặn tạm thời.
  const bestGuess = candidates.find((c) => c);
  if (bestGuess) {
    console.warn(`[m3uPlaylist] Probe referer thất bại cho ${source} ${host} — fallback best-guess: ${bestGuess}`);
  }
  return bestGuess || null;
}

/**
 * Thử nâng 1 link FLV lên bản HLS song song (nhiều CDN lộ cùng 1 stream ra
 * cả 2 đuôi .flv/.m3u8) — xác minh (HEAD ngắn) bản đoán đó CÒN PHÁT ĐƯỢC
 * THẬT hay không rồi mới ưu tiên dùng, không đoán suông. Không xác minh
 * được thì giữ nguyên FLV như cũ.
 */
export async function preferHlsForIptv(stream) {
  const url = stream?.playUrl || stream?.m3u8Url || stream?.flvUrl || '';
  const alreadyHls = isM3u8Url(url);
  if (alreadyHls || !isFlvUrl(url)) return stream;

  const candidate = flvToM3u8Candidate(url);
  if (!candidate) return stream;

  const ok = await verifyStreamUrlPlayable(candidate).catch(() => false);
  if (!ok) return stream;

  return { ...stream, playUrl: candidate, m3u8Url: candidate, format: 'hls' };
}

/**
 * Map từng match 1 entry .m3u8 (có thể nhiều stream/BLV cho 1 trận —
 * build song song tất cả).
 *
 * @param {Object} match — Dữ liệu trận (từ các service).
 * @param {string} sourceKey — Khóa nguồn (dùng để dò Referer riêng theo từng
 * nguồn).
 * @returns {Promise<Array>} Danh sách entry, mỗi entry có:
 *   - title: Tên kênh .m3u8.
 *   - streamUrl: Link stream.
 *   - iptvReferer: Referer để ghi vào #EXTVLCOPT (null nếu không cần).
 */
export async function matchToPlaylistEntries(match, sourceKey) {
  const entries = [];
  const streams = (match?.streams || match?.streamers || match?.commentators || []).filter((s) => s?.playUrl);

  for (const stream of streams) {
    const streamUrl = stream.playUrl || stream.link || '';
    if (!streamUrl) continue;

    const title = `${getStatusDot(match)} ${formatUpcomingBadge(match)} ${getMatchTitle(match)} (${stream.streamerName || stream.name || 'Stream'})`;
    const hlsStream = await preferHlsForIptv(stream);
    const finalUrl = hlsStream.playUrl || streamUrl;

    // FIX (25/09/2026 — GitHub-only): dò referer riêng cho từng source+url.
    const iptvReferer = await resolveIptvReferer(finalUrl, sourceKey);

    entries.push({
      title,
      streamUrl: finalUrl,
      iptvReferer
    });
  }

  return entries;
}

/**
 * Gộp tất cả entry từ mọi match → 1 danh sách để build .m3u.
 */
export async function matchesToPlaylistEntries(matches, sourceKey) {
  const allEntries = [];
  for (const match of matches) {
    const entries = await matchToPlaylistEntries(match, sourceKey);
    allEntries.push(...entries);
  }
  return allEntries;
}

/**
 * Build M3U content từ danh sách entry.
 *
 * @param {Array} entries — Danh sách entry (mỗi entry có title, streamUrl,
 * iptvReferer).
 * @param {Object} options — Tùy chọn:
 *   - header: Header tùy chỉnh (mặc định: M3U chuẩn).
 *   - groupTitle: Nhóm kênh (mặc định: lấy từ entry.sourceLabel hay
 *     "Thể thao").
 * @returns {string} Nội dung file M3U.
 */
export function buildM3uPlaylist(entries = [], options = {}) {
  const lines = ['#EXTM3U'];

  for (const entry of entries) {
    if (entry.iptvReferer) lines.push(`#EXTVLCOPT:http-referrer=${entry.iptvReferer}`);
    lines.push(`#EXTVLCOPT:http-user-agent=${IPTV_HEADER_UA}`);
    lines.push(`#EXTINF:-1 group-title="${entry.groupTitle || 'Thể thao}'",${entry.title}`);
    lines.push(entry.streamUrl);
  }

  return lines.join('\n');
}

export default { matchToPlaylistEntries, matchesToPlaylistEntries, buildM3uPlaylist, preferHlsForIptv };
