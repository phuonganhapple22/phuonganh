import { pickBestStream } from '@/src/utils/streamQuality';
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
// FIX 2 (23/09/2026 — "1 số trận Phá Làng/Chuối Chiến VẪN không xem được
// dù đã có #EXTVLCOPT"): bản đầu GÁN CỨNG 1 Referer/nguồn — sai với đúng
// bài học mà chính /api/proxy/hls.js đã rút ra trước đây (xem
// REFERER_CANDIDATES_BY_SOURCE bên đó): nhiều CDN không nhất quán — có CDN
// (vd link "Server 1" trơn của Phá Làng, lấy trực tiếp từ source_live) TỰ
// PHÁT ĐƯỢC KHÔNG CẦN REFERER, gán thêm Referer sai vào có thể càng khiến
// CDN từ chối; có CDN khác (vd pull.digitalcdn.net của Phá Làng khi có
// BLV, hoặc 1 số endpoint edgemaxcdn.org của Chuối Chiến) lại đòi ĐÚNG 1
// domain cụ thể mới cho qua, sai domain là bị 401/403/451 ngay — và không
// đoán trước được chính xác domain nào cho từng link cụ thể, vì cùng 1
// nguồn có thể trả về nhiều loại CDN con khác nhau tuỳ trận. KHÔNG đoán mù
// 1 giá trị tĩnh nữa — DÒ THẬT bằng 1 request thử (Range 0-0, tải rất ít
// dữ liệu) tới ĐÚNG link CDN của trận đó, thử lần lượt các ứng viên
// (giống hệt danh sách REFERER_CANDIDATES_BY_SOURCE trong
// pages/api/proxy/hls.js — giữ đồng bộ 2 nơi), ứng viên nào không bị CDN
// trả 401/403/451 thì dùng đúng ứng viên đó (kể cả khi ứng viên thắng là
// "không gửi Referer nào cả" — lúc đó KHÔNG ghi dòng #EXTVLCOPT nào, đúng
// như trường hợp "Server 1" trơn). Nhớ lại theo HOSTNAME CDN (không phải
// theo từng link riêng — link .m3u8 mỗi trận khác nhau nhưng cùng 1 CDN
// thường cùng 1 chính sách) để các trận sau CÙNG 1 tiến trình (`--watch`)
// không phải dò lại từ đầu mỗi 2 phút, đỡ tốn thời gian + tránh dội quá
// nhiều request thử vào CDN nguồn.
// FIX (24/09/2026 — theo yêu cầu "đổi tên các trận của các nguồn theo form
// như ảnh 8"): tên kênh .m3u theo mẫu Ola TV:
//   "24/09 18:35 🟢 ⚽ China vs Maldives (Dương Kiên)"
//   - Chấm trạng thái: 🟢 đang live, 🟡 sắp đá (trong vòng
//     UPCOMING_SOON_MINUTES phút tới, hoặc đã quá giờ đá nhưng chưa live),
//     không có chấm nếu còn lâu mới đá.
//   - Giờ đá "HH:mm dd/MM", rồi icon môn thể thao, tên trận, (BLV/server).
//   - Bỏ các nhãn [LIVE]/[hls]/[flv]/[sắp diễn ra] cũ. Tên nguồn nằm ở
//     group-title (app tự hiện dưới tên trận).
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
  // ứng trong pages/api/proxy/hls.js): domain player fhd-01.cctvsignal.xyz.
  // FIX (26/09/2026 — "vẫn lỗi"): bắt THÊM 1 lần DevTools khác, ra domain
  // KHÁC hẳn — https://live.chuoichien.tv/. Domain player nhúng của nguồn
  // này ĐỔI THEO TỪNG PHIÊN (100ycdn.com là wrapper ngẫu nhiên) nên KHÔNG
  // có 1 giá trị cố định đúng mãi mãi — để cả 2 giá trị đã xác nhận thật
  // làm ứng viên, giá trị mới nhất lên đầu. CHUOICHIENTV_PLAYER_DOMAIN vẫn
  // cho phép ép ứng viên đầu tiên nếu cần debug 1 giá trị cụ thể.
  chuoichientv: [
    `${String(process.env.CHUOICHIENTV_PLAYER_DOMAIN || 'https://live.chuoichien.tv').replace(/\/+$/, '')}/`,
    'https://fhd-01.cctvsignal.xyz/',
    'https://live05.chuoichientv.me/',
    'https://chuoichientv.link/',
    null
  ],
  // Bông Lau TV — CHUNG CDN edgemaxcdn.org/wrapper 100ycdn.com với Chuối
  // Chiên (xem bonglau.service.js), nên dùng chung luôn danh sách ứng viên.
  bonglau: [
    `${String(process.env.BONGLAU_PLAYER_DOMAIN || 'https://live.chuoichien.tv').replace(/\/+$/, '')}/`,
    'https://fhd-01.cctvsignal.xyz/',
    'https://live05.chuoichientv.me/',
    'https://chuoichientv.link/',
    null
  ],
  // FIX (30/09/2026): giovang.city đã redirect sang giovang.blog; giovang.cv là mirror còn nhắc trên trang.
  giovang: [`${String(process.env.GIOVANG_DOMAIN || 'https://giovang.blog').replace(/\/+$/, '')}/`, 'https://giovang.cv/', null],
  khandaitv: [process.env.KHANDAITV_DOMAIN || process.env.KHANDAITV_BASE_URL || 'https://khandai3.link', null],
  // FIX (29/09/2026): trình duyệt thật luôn gửi Referer có dấu "/" cuối
  // (https://phalang.live/) — đặt bản có "/" LÊN ĐẦU cho khớp CDN kiểm tra chuỗi chính xác.
  phalang: [`${String(process.env.PHALANG_DOMAIN || 'https://phalang.live').replace(/\/+$/, '')}/`, String(process.env.PHALANG_DOMAIN || 'https://phalang.live').replace(/\/+$/, ''), null],
  // FIX (24/09/2026 — theo yêu cầu "tiện thêm #EXTVLCOPT vào luôn" cho 2
  // nguồn mới Gà Vàng + Sao Kê, trước đó bị bỏ sót khỏi danh sách này nên
  // chưa từng có Referer nào được gắn):
  // FIX (24/09/2026): đồng bộ với pages/api/proxy/hls.js — domain chính
  // (GAVANG_DOMAIN) trước, kèm 2 mirror dự phòng, cuối cùng là không Referer.
  gavang: [
    ...new Set([
      String(process.env.GAVANG_DOMAIN || process.env.GAVANG_BASE_URL || 'https://gavanglinkp.tv').replace(/\/+$/, ''),
      'https://gavanglinkp.tv',
      'https://gavangtv.tv',
      'https://gavangtvv.cc'
    ])
  ].map((d) => `${d}/`).concat([null]),
  // Sao Kê dùng CHUNG 2 CDN với Chuối Chiến (stream.hdplaylink.com,
  // edgemaxcdn.org — xem cảnh báo trong saoke.service.js) nên ưu tiên thử
  // lại đúng các Referer đã biết của Chuối Chiến trước, thêm domain thật
  // của chính Sao Kê (siteUrl trong config) làm ứng viên bổ sung.
  // FIX (24/09/2026 — "Sao Kê các trận lỗi không xem được", link ra kèm
  // Referer chuoichientv): Referer đúng của Sao Kê là CHÍNH DOMAIN của nó
  // (trang Sao Kê tự phát bằng Referer đó) -> đặt LÊN ĐẦU; Referer Chuối
  // Chiến chỉ còn dự phòng. Quan trọng vì khi dò thất bại (IP CI bị CDN
  // chặn) code dùng ứng viên ĐẦU TIÊN làm best-guess.
  // Xôi Lạc TV (03/10/2026): CHƯA bắt được Referer thật của CDN — đoán domain
  // trang xem (có "/" cuối như trình duyệt thật) rồi tới không Referer. Nếu
  // CDN chặn hotlink thì set XOILAC_IPTV_REFERER hoặc gửi request bắt từ DevTools.
  xoilac: [
    'https://xl365.domainkqt.cc/',
    `${String(process.env.XOILAC_DOMAIN || process.env.XOILAC_BASE_URL || 'https://xoilacxc.tv').replace(/\/+$/, '')}/`,
    'https://xoilacxcw.tv/',
    null
  ],
  // Xoigac TV (04/10/2026): request m3u8 thật tới AWS IVS (*.playlist.live-video.net)
  // KHÔNG gửi Referer -> thử không Referer trước, site sau (phòng /hls/<id> trên site đòi Referer).
  xoigac: [
    null,
    `${String(process.env.XOIGAC_DOMAIN || process.env.XOIGAC_BASE_URL || 'https://xoigac.live').replace(/\/+$/, '')}/`
  ],
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

/**
 * FIX (25/09/2026 — GitHub-only deploy): Kiểm tra env var override referer
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
 * Dò xem CDN của link `url` (nguồn `source`) chấp nhận Referer nào — trả về
 * chuỗi Referer thắng, hoặc `null` nếu CDN không cần Referer / không dò
 * được ứng viên nào (khi đó KHÔNG ghi #EXTVLCOPT, để link ở dạng trần —
 * an toàn hơn là gán 1 Referer chưa xác minh có thể làm CDN càng chặn).
 */
async function resolveIptvReferer(url, source) {
  // FIX (25/09/2026): Kiểm tra override env var trước
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

  // Link AWS IVS (*.live-video.net): request m3u8 thật của trình duyệt KHÔNG kèm Referer
  // (bắt 04/10/2026) -> không ghi Referer, khỏi dò (dò từ IP CI hay thất bại rồi gán nhầm best-guess).
  if (/(^|\.)live-video\.net$/i.test(host)) return null;

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
 * Build an IPTV-style M3U playlist from live match + stream entries.
 * One stream source = one #EXTINF entry.
 * Entries are grouped by source (Pháo Hoa, Giờ Vàng) — both via a
 * `# ===== <Nguồn> =====` comment header (visible when opened as text) and
 * the `group-title` attribute (used by players like VLC/TiviMate to group
 * channels visually).
 *
 * @param {Array<{ match: object, stream: object }>} entries
 * @returns {string}
 */
export function buildM3uPlaylist(entries = [], options = {}) {
  // FIX (26/09/2026 — "VLC xem được nhưng app IPTV trên điện thoại thì
  // không"): #EXTVLCOPT là cú pháp RIÊNG của VLC/libVLC — hầu hết app IPTV
  // Android (TiviMate, IPTV Smarters, GSE, Perfect Player mặc định...) chạy
  // engine ExoPlayer, KHÔNG đọc #EXTVLCOPT nên bỏ qua hoàn toàn Referer/
  // User-Agent đã set -> phát bằng header mặc định -> bị CDN chặn hotlink.
  // ExoPlayer/đa số app đó lại hiểu 1 quy ước khác: gắn thẳng header vào
  // URL bằng dấu "|", vd "https://...m3u8|Referer=xxx&User-Agent=yyy".
  // options.format === 'app' bật quy ước này (dùng CHUNG URL thay vì
  // #EXTVLCOPT) — giữ format mặc định (VLC) KHÔNG đổi để không phá vỡ
  // playlist đang chạy tốt trên VLC/PC.
  const useAppHeaderStyle = options.format === 'app';
  // FIX (27/09/2026 — "app IPTV (aPTV, IPTV Live...) vẫn không xem được dù
  // đã dùng bản -app.m3u"): quy ước header kiểu "|User-Agent=...&Referer=..."
  // KHÔNG PHẢI chuẩn M3U chính thức — chỉ 1 số app (VLC, Kodi IPTV Simple
  // Client, TiviMate tự xử lý riêng) hiểu quy ước này; nhiều app IPTV khác
  // (aPTV, IPTV Live, Emby,...) coi URL kết thúc ngay tại dấu "|", bỏ qua
  // toàn bộ phần header phía sau -> gọi link trần, vẫn bị CDN chặn 403 y hệt
  // như không có gì. Format 'proxy' giải quyết TRIỆT ĐỂ cho MỌI app: link
  // trỏ qua route sống /api/proxy/hls (pages/api/proxy/hls.js) — server tự
  // gắn đúng Referer/User-Agent rồi mới gọi CDN thật, nên app chỉ thấy 1 URL
  // trần bình thường, không cần biết/hỗ trợ header gì cả. Cần baseUrl trỏ
  // tới 1 server ĐANG CHẠY SỐNG (Vercel/Render/VPS) — không dùng được nếu
  // chỉ deploy tĩnh lên GitHub (route /api/proxy/hls không tồn tại ở đó).
  const useProxyStyle = options.format === 'proxy';
  const proxyBaseUrl = String(options.baseUrl || '').replace(/\/+$/, '');
  const lines = ['#EXTM3U', ''];
  entries = Array.isArray(entries) ? entries : [];

  // QUAN TRỌNG: KHÔNG được gom vật lý theo nguồn (nhóm hết Pháo Hoa, rồi
  // hết Giờ Vàng...) — làm vậy phá vỡ thứ tự thời gian tổng thể giữa các
  // nguồn. `entries` truyền vào đây đã được sort đúng theo giờ thi đấu
  // thực (matchTimeTimestamp) từ playlistBuilder.service.js — chỉ cần giữ
  // NGUYÊN thứ tự đó khi in ra. Việc gom nhóm theo nguồn cho người xem vẫn
  // được giữ nhờ thuộc tính `group-title` trên từng dòng #EXTINF —
  // VLC/TiviMate/hầu hết player IPTV tự nhóm kênh theo group-title mà
  // không cần các dòng nằm liền kề nhau trong file.
  const withUrl = entries.filter((entry) => {
    const url = entry.stream?.playUrl || entry.stream?.m3u8Url || entry.stream?.flvUrl || '';
    return !!url;
  });

  if (!withUrl.length) return lines.join('\n').trim() + '\n';

  // Dòng thống kê đầu file (giữ lại thông tin "mỗi nguồn bao nhiêu trận")
  // — chỉ để tham khảo, KHÔNG dùng để sắp xếp lại danh sách.
  const countBySource = new Map();
  for (const entry of withUrl) {
    const key = entry?.match?.source || 'unknown';
    countBySource.set(key, (countBySource.get(key) || 0) + 1);
  }
  const orderedKeys = [
    ...SOURCE_GROUP_ORDER.filter((k) => countBySource.has(k)),
    ...[...countBySource.keys()].filter((k) => !SOURCE_GROUP_ORDER.includes(k))
  ];
  const summary = orderedKeys.map((k) => `${getSourceShortLabel(k)} (${countBySource.get(k)} trận)`).join(', ');
  lines.push(`# ===== Tất cả trận, sắp theo giờ thi đấu thực — ${summary} =====`);
  lines.push('');

  let lastDateStr = '';
  for (const entry of withUrl) {
    const { match, stream } = entry;
    const url = stream?.playUrl || stream?.m3u8Url || stream?.flvUrl || '';

    const logo = match?.homeTeam?.logo || match?.competition?.logo || '';
    // FIX (24/09/2026 — theo yêu cầu "tên group các nguồn thành tiếng Việt"):
    // dùng nhãn có dấu (Giờ Vàng, Khán Đài, Chuối Chiên, Phá Làng, Gà Vàng, Sao Kê)
    // thay vì nhãn không dấu (Gio Vang TV...) — chỉ đổi ở file .m3u, giao diện web giữ nguyên.
    const group = getSourceShortLabel(match);
    // Tên kênh: "24/09 18:35 🟢 ⚽ Home vs Away (BLV)" — xem getStatusDot()/getSportIcon().
    // FIX (24/09/2026 — "vẫn bị sắp xếp sai", app sort theo TÊN): chấm 🟢/🟡 đặt
    // SAU ngày giờ, không đứng đầu tên — emoji có mã ký tự lớn hơn chữ số nên
    // đứng đầu sẽ bị đẩy xuống cuối danh sách, sau cả các trận ngày hôm sau.
    const time = formatKickoffHourFirst(match, { dateFirst: KICKOFF_DATE_FIRST }) || match?.timeFormatted || '';
    const title = getMatchTitle(match);
    const streamer = stream.streamerName || stream.name || 'Server';
    const nameParts = [time, getStatusDot(match), getSportIcon(match), title, `(${streamer})`].filter(Boolean);
    const displayName = nameParts.join(' ');

    // Dòng phân cách khi sang ngày mới (giờ Việt Nam) — chỉ để dễ đọc
    // bằng mắt khi mở file .m3u dạng text, không ảnh hưởng player parse.
    const dateStr = match?.dateStr || '';
    if (dateStr && dateStr !== lastDateStr) {
      lines.push(`# ----- Ngày ${dateStr} -----`);
      lastDateStr = dateStr;
    }

    const attrs = ['#EXTINF:-1'];
    if (logo) attrs.push(`tvg-logo="${logo}"`);
    attrs.push(`group-title="${group}"`);

    lines.push(`${attrs.join(' ')} , ${displayName}`);
    // FIX 23/09/2026 (xem resolveIptvReferer() phía trên): referer đã được
    // DÒ THỬ THẬT và gắn sẵn vào entry.iptvReferer trong
    // matchesToPlaylistEntries() — ở đây chỉ đọc lại, không đoán/dò gì
    // thêm. entry.iptvReferer === null nghĩa là CDN không cần Referer
    // (hoặc dò thất bại) -> không ghi dòng http-referrer (xem FIX bên dưới).
    // FIX (24/09/2026 — theo yêu cầu "thêm EXTVLCOPT cho các file m3u của các
    // nguồn và all.m3u"): trước đây CDN dò ra "không cần Referer" (iptvReferer
    // === null) thì KHÔNG ghi #EXTVLCOPT nào -> link trần, app IPTV dùng
    // User-Agent mặc định của player (VLC/LibVLC...) dễ bị 1 số CDN từ chối.
    // Giờ MỌI link phát thật (iptvReferer !== undefined, tức đã qua bước dò
    // trong matchesToPlaylistEntries) đều có #EXTVLCOPT http-user-agent; dòng
    // http-referrer chỉ ghi khi có Referer đã dò/chọn (không ép Referer sai
    // cho CDN không cần). Entry placeholder (trận chưa đá / chưa có link,
    // iptvReferer === undefined) không phải link phát -> không ghi.
    if (entry.iptvReferer !== undefined) {
      if (useAppHeaderStyle || useProxyStyle) {
        // 'app': header gắn thẳng vào URL bằng dấu "|" (xem đoạn build outUrl
        // bên dưới). 'proxy': KHÔNG cần header gì cả (server tự gắn), URL
        // cũng được viết lại hoàn toàn bên dưới. Cả 2 format đều KHÔNG ghi
        // #EXTVLCOPT — VLC không đọc quy ước "|", còn 'proxy' vốn dĩ không
        // cần header nào ở phía client.
      } else {
        if (entry.iptvReferer) lines.push(`#EXTVLCOPT:http-referrer=${entry.iptvReferer}`);
        lines.push(`#EXTVLCOPT:http-user-agent=${IPTV_HEADER_UA}`);
      }
    }
    let outUrl = url;
    if (useAppHeaderStyle && entry.iptvReferer !== undefined) {
      const headerParts = [`User-Agent=${IPTV_HEADER_UA}`];
      if (entry.iptvReferer) headerParts.push(`Referer=${entry.iptvReferer}`);
      // FIX (29-30/09/2026): CDN của Phá Làng (pull.digitalcdn.net) và Giờ Vàng
      // (vcdn.cloud) cần thêm Origin như trình duyệt thật — chỉ gắn cho 2 nguồn
      // này để không ảnh hưởng các nguồn đang chạy tốt.
      if (entry.iptvReferer && ['phalang', 'giovang'].includes(getSourceKey(match))) {
        try { headerParts.push(`Origin=${new URL(entry.iptvReferer).origin}`); } catch { /* referer không hợp lệ -> bỏ Origin */ }
      }
      outUrl = `${url}|${headerParts.join('&')}`;
    } else if (useProxyStyle && entry.iptvReferer !== undefined && proxyBaseUrl) {
      const sourceKey = getSourceKey(match);
      const qs = new URLSearchParams({ url });
      if (sourceKey) qs.set('source', sourceKey);
      outUrl = `${proxyBaseUrl}/api/proxy/hls?${qs.toString()}`;
    }
    lines.push(outUrl);
    lines.push('');
  }

  return lines.join('\n').trim() + '\n';
}

// Bộ nhớ đệm kết quả nâng HLS + dò Referer (xem chú thích trong matchesToPlaylistEntries).
const ENRICH_TTL_MS = Number(process.env.ENRICH_CACHE_TTL_MS) > 0 ? Number(process.env.ENRICH_CACHE_TTL_MS) : 90 * 1000;
const enrichCache = new Map();

/**
 * Flatten matches into playlist entries.
 * - Live match (has a resolved stream): one match → one stream (first m3u8
 *   only) to avoid duplicate channels.
 * - Upcoming match (next 24h, no stream yet): entry points at
 *   /api/playlist/resolve — the player looks up the real link only when it
 *   actually opens the channel (works whenever the source publishes it,
 *   before or after kickoff). Needs an absolute `baseUrl` since the .m3u
 *   file is opened by players on a different machine; skipped without one.
 */
export async function matchesToPlaylistEntries(matches = [], { baseUrl = '' } = {}) {
  const entries = [];
  // Tách làm 2 bước: (1) gom hết entries KHÔNG chờ mạng gì cả (nhanh), rồi
  // (2) chạy preferHlsForIptv() SONG SONG có giới hạn số luồng (mapPool)
  // thay vì tuần tự từng cái — tránh cộng dồn thời gian xác minh khi có
  // nhiều trận FLV cùng lúc.
  const pendingUpgrades = [];
  const safeMatches = Array.isArray(matches) ? matches : [];
  for (const match of safeMatches) {
    const matchStreams = Array.isArray(match?.streams) ? match.streams : [];
    // HOÀN TÁC (23/09/2026 — "hôm qua Chuối Chiến vẫn xem bình thường,
    // từ lúc [tôi] đổi mới bị vậy"): 2 lần "FIX" trước đó (loại CDN EDGEMAX
    // rồi HDPLAYLINK) dựa trên vài lần test 403 cụ thể, nhưng người dùng
    // xác nhận NGAY BẢN ĐẦU TIÊN (chỉ gán 1 Referer tĩnh, KHÔNG lọc CDN gì
    // cả) đã xem được — tức là 403 lúc test rất có thể do đúng lúc đó
    // trận/link vừa hết giờ live hoặc CDN tạm trục trặc, KHÔNG PHẢI CDN
    // luôn luôn chặn. Loại bỏ nhầm 1 CDN vẫn hoạt động tốt gây hại nhiều
    // hơn lợi (mất kênh oan). Quay lại đúng cách chọn ban đầu: lấy stream
    // ĐẦU TIÊN có link phát được, không lọc theo `cdn` nữa. Nếu sau này có
    // bằng chứng CHẮC CHẮN 1 CDN cụ thể luôn luôn chặn (nhiều lần test vào
    // NHIỀU thời điểm/trận khác nhau, không chỉ 1-2 lần trùng lúc trận vừa
    // kết thúc) thì mới nên loại lại.
    // FIX (29/09/2026 — "Chuối Chiên/Sao Kê/Bông Lau ghi HD mà xem mờ như SD"):
    // trước đây lấy stream ĐẦU TIÊN có link — thường là bản thấp. Giờ chọn
    // stream CHẤT LƯỢNG CAO NHẤT (FHD > HD > SD, theo nhãn của nguồn — xem
    // utils/streamQuality.js); bằng điểm thì vẫn lấy cái đầu tiên như cũ nên
    // nguồn không có nhãn chất lượng không bị đổi hành vi.
    const stream = pickBestStream(matchStreams.filter((s) => s?.m3u8Url || s?.flvUrl || s?.playUrl));
    if (stream) {
      const entry = { match, stream };
      entries.push(entry);
      pendingUpgrades.push(entry);
      continue;
    }

    // Trận live chưa có stream sẵn -> vẫn đưa vào playlist, trỏ tới
    // /api/playlist/resolve (route này tự resolve link thật ngay lúc
    // player mở kênh).
    const source = getSourceKey(match);
    const isLiveNoStream = !!match?.status?.isLive;

    // FIX (20/09/2026 — chế độ playlist tĩnh HOÀN TOÀN không có server nào
    // chạy sống, chỉ có file trên GitHub): trước đây thiếu baseUrl thì BỎ
    // QUA hẳn trận này (`continue`) — nghĩa là mọi trận CHƯA ĐẤU (chưa có
    // stream sẵn) biến mất khỏi playlist tĩnh, dù trận đó có tồn tại và có
    // giờ đá rõ ràng. Theo yêu cầu: vẫn LIỆT KÊ trận chưa đấu (kèm giờ đá)
    // dù tạm thời CHƯA BẤM XEM ĐƯỢC (không có server để tra link thật) —
    // sẽ tự xem được ở lần GitHub Actions chạy kế tiếp SAU khi trận đã live
    // (lúc đó match.streams đã có sẵn, rơi vào nhánh phía trên, ghi thẳng
    // link CDN thật). Không có baseUrl thì không thể tạo link resolver
    // (route đó thậm chí không tồn tại) — dùng tạm link TRANG GỐC của trận
    // (match.stream.liveUrl, vốn đã có sẵn cho hầu hết nguồn dùng làm khoá
    // tra cứu) làm giá trị hiển thị/tham khảo, KHÔNG phải link phát —
    // player mở sẽ báo lỗi/không phát được cho tới khi có link thật, đúng
    // như đã thống nhất.
    const fallbackUrl = match?.stream?.liveUrl || '';
    const params = new URLSearchParams({
      source,
      matchId: match.matchId || '',
      url: fallbackUrl,
      sport: match.sport || 'football'
    });
    const resolverUrl = baseUrl
      ? `${baseUrl}/api/playlist/resolve?${params.toString()}`
      : fallbackUrl; // không có server -> dùng tạm link trang gốc, chưa phát được ngay

    if (!resolverUrl) continue; // thật sự không có gì để ghi (hiếm, nguồn thiếu cả link trang gốc)

    entries.push({
      match,
      // Chỉ gắn nhãn "sắp diễn ra" cho trận thật sự chưa đá — trận đang
      // live mà rơi vào nhánh này chỉ là do stream chưa kịp resolve sẵn,
      // không phải chưa bắt đầu, nên không gắn cờ `upcoming`.
      upcoming: !isLiveNoStream,
      stream: {
        m3u8Url: resolverUrl,
        streamerName: baseUrl
          ? (isLiveNoStream ? 'Đang tải link...' : formatUpcomingBadge(match))
          : 'Chưa có link — chờ cập nhật'
      }
    });
  }

  // Chạy song song, tối đa 8 xác minh cùng lúc — đủ nhanh để không kéo dài
  // tổng thời gian, vẫn tránh dội quá nhiều request cùng lúc vào CDN nguồn.
  // FIX (06/10/2026 — "generate-playlists hàng chục phút mới lưu file, không đều 2-3 phút"):
  // generateOnce() gọi hàm này ~20 lần/chu kỳ (7 tab môn + từng nguồn) với CÙNG các trận -> mỗi lần
  // lại HEAD-probe CDN + dò Referer lại từ đầu (mỗi probe có timeout riêng, CDN chặn IP CI thì
  // chờ hết timeout) => thời gian nhân lên ~20 lần. Nhớ kết quả (promise, kể cả đang chạy) theo
  // nguồn + link + referer trong ENRICH_TTL_MS để các lần gọi còn lại trong cùng chu kỳ dùng lại.
  await mapPool(pendingUpgrades, 8, async (entry) => {
    const sourceKeyForCache = getSourceKey(entry.match);
    const cacheKey = [
      sourceKeyForCache,
      entry.match?.matchId || entry.match?.stream?.liveUrl || '',
      entry.stream?.streamerName || entry.stream?.name || '',
      entry.stream?.playUrl || entry.stream?.m3u8Url || entry.stream?.flvUrl || '',
      entry.stream?.referer || ''
    ].join('|');
    const now = Date.now();
    let cached = enrichCache.get(cacheKey);
    if (!cached || now - cached.at > ENRICH_TTL_MS) {
      const promise = (async () => {
        entry.stream = await preferHlsForIptv(entry.stream);
        // FIX 23/09/2026 (xem resolveIptvReferer() đầu file): dò Referer THẬT
        // cho đúng link CDN cuối cùng (sau khi đã nâng FLV->HLS nếu có) — phải
        // làm SAU preferHlsForIptv() vì link có thể vừa đổi. entry.upcoming
        // không tồn tại ở nhánh này (chỉ trận có stream sẵn mới vào
        // pendingUpgrades) nên luôn dò, không cần điều kiện thêm.
        const finalUrl = entry.stream?.playUrl || entry.stream?.m3u8Url || entry.stream?.flvUrl || '';
        const sourceKey = getSourceKey(entry.match);
        // FIX (25/09/2026 — "bắt link chuẩn từ Sao Kê"): nếu chính service nguồn
        // đã TỰ DÒ được Referer THẬT bằng trình duyệt headless (xem
        // detectPlayerReferer() trong saoke.service.js, field `referer` gắn
        // qua streamsFromMatchCard() trong playerGet.js), dùng thẳng giá trị đó
        // — đáng tin hơn hẳn so với đoán/dò-bằng-HEAD-request ở resolveIptvReferer()
        // bên dưới, vì đây là Referer trình duyệt THẬT đã dùng để phát thành công,
        // không phải suy đoán từ 1 danh sách ứng viên cố định.
        //
        // FIX (25/09/2026 — "đổi CHUOICHIENTV_IPTV_REFERER không có tác dụng"):
        // nhánh trên đọc thẳng entry.stream.referer TRƯỚC khi gọi
        // resolveIptvReferer() — mà getOverrideReferer() (đọc env var override)
        // chỉ nằm BÊN TRONG resolveIptvReferer(). Với Chuối Chiên/Sao Kê, service
        // LUÔN tự dò được referer bằng trình duyệt headless nên entry.stream.referer
        // hầu như luôn có giá trị -> nhánh resolveIptvReferer() không bao giờ được
        // gọi tới -> đổi biến môi trường override không có tác dụng gì, vẫn dùng
        // đúng giá trị tự dò cũ. Phải kiểm tra override TRƯỚC, cho MỌI nguồn, để
        // người dùng luôn ép được 1 Referer cụ thể bất kể service có tự dò được
        // hay không.
        const overrideReferer = getOverrideReferer(sourceKey);
        entry.iptvReferer = overrideReferer
          ? overrideReferer
          : entry.stream?.referer
            ? entry.stream.referer
            : finalUrl
              ? await resolveIptvReferer(finalUrl, sourceKey)
              : null;

        return { stream: entry.stream, iptvReferer: entry.iptvReferer };
      })();
      cached = { at: now, promise };
      enrichCache.set(cacheKey, cached);
      promise.catch(() => enrichCache.delete(cacheKey));
      if (enrichCache.size > 2000) {
        for (const [k, v] of enrichCache) if (now - v.at > ENRICH_TTL_MS) enrichCache.delete(k);
      }
    }
    const result = await cached.promise;
    entry.stream = { ...result.stream };
    entry.iptvReferer = result.iptvReferer;
  });

  return entries;
}
