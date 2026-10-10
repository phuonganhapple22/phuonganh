/**
 * GET /api/proxy/hls?url=<link .m3u8/.ts/.key gốc, đã encodeURIComponent>
 *
 * FIX lỗi (xem lỗi.txt, 28/08/2026):
 *   "Access to XMLHttpRequest at 'https://luong.phaohoa.live/live/.../index.m3u8...'
 *    from origin 'https://nguonvip1.vercel.app' has been blocked by CORS policy"
 *   -> hls.js error: networkError manifestLoadError fatal=true
 *
 * NGUYÊN NHÂN: /api/playlist/resolve trước đây trả THẲNG link .m3u8 gốc của
 * CDN pháo hoa (luong.phaohoa.live...) cho trình duyệt. hls.js chạy trong
 * trình duyệt gọi (XHR/fetch) thẳng sang domain CDN đó để tải manifest +
 * từng segment .ts — nhưng CDN pháo hoa KHÔNG gắn header
 * "Access-Control-Allow-Origin" nên trình duyệt tự chặn request theo chính
 * sách CORS (đây là giới hạn phía TRÌNH DUYỆT, không phải lỗi mạng/lỗi
 * server). Vì manifest .m3u8 không tải được -> hls.js coi là lỗi mạng
 * fatal ngay từ bước đầu -> màn hình đen/không phát được.
 *
 * SỬA: route này chạy trên server (Node gọi HTTP thì KHÔNG bị CORS chi phối
 * — CORS chỉ áp dụng cho request phát ra từ trình duyệt), tải giúp nội dung
 * thật từ CDN nguồn:
 *   - Nếu là playlist .m3u8 (văn bản): đọc nội dung, viết lại MỌI link bên
 *     trong (dòng segment thường, link playlist con sau #EXT-X-STREAM-INF,
 *     URI="..." trong #EXT-X-KEY / #EXT-X-MEDIA) thành dạng tuyệt đối rồi
 *     bọc lại qua chính route proxy này -> trình duyệt chỉ còn thấy toàn bộ
 *     link trỏ VỀ DOMAIN CỦA CHÍNH MÌNH (same-origin), không còn gọi thẳng
 *     sang CDN pháo hoa nữa -> hết bị CORS chặn.
 *   - Nếu là segment nhị phân (.ts/.key/...): stream thẳng byte về trình
 *     duyệt, giữ nguyên Content-Type/Content-Length/Range từ CDN gốc.
 * Luôn gắn "Access-Control-Allow-Origin: *" trên MỌI phản hồi của route này
 * để dự phòng (kể cả khi app IPTV/ player khác gọi cross-origin thẳng vào
 * route proxy này thay vì qua trang web).
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// FIX (17/09/2026 — "you do not have permission to access the requested
// resource" khi phát nguồn Chuối Chiên, và tiềm ẩn tương tự cho Giờ Vàng/
// Khán Đài): trước đây route này gắn CỨNG 1 Referer duy nhất (domain Pháo
// Hoa) cho MỌI nguồn — sai với CDN của các nguồn khác (vd edgemaxcdn.org,
// hdplaylink.com của Chuối Chiên), bị chặn vì nhiều CDN kiểm tra Referer
// khớp đúng domain trang gốc mới cho phát (chống hotlink). Giờ chọn Referer
// theo `source` (truyền từ buildProxyStreamUrl -> VideoPlayer -> đây) —
// vẫn giữ Pháo Hoa làm mặc định để không phá vỡ link cũ/link không rõ
// nguồn (playlist .m3u tĩnh tải về từ trước, v.v).
// Gà Vàng có nhiều domain mirror cùng thương hiệu (xem chú thích đầu file
// src/services/gavang.service.js) — domain chính lấy từ GAVANG_DOMAIN (giống
// service), các mirror còn lại chỉ là ứng viên dự phòng cho CDN kiểm tra
// Referer theo domain khác. GIỮ ĐỒNG BỘ với m3uPlaylist.js.
const GAVANG_MAIN = String(process.env.GAVANG_DOMAIN || process.env.GAVANG_BASE_URL || 'https://gavanglinkp.tv').replace(/\/+$/, '');
const GAVANG_ORIGINS = [...new Set([GAVANG_MAIN, 'https://gavanglinkp.tv', 'https://gavangtv.tv', 'https://gavangtvv.cc'])].map((d) => `${d}/`);

// Sao Kê dùng CHUNG 2 CDN với Chuối Chiến (hdplaylink.com, edgemaxcdn.org — xem
// saoke.service.js) nên thử domain thật của Sao Kê (SAOKE_DOMAIN) TRƯỚC, rồi mới tới
// Referer của Chuối Chiến. GIỮ ĐỒNG BỘ với REFERER_CANDIDATES_BY_SOURCE.saoke
// trong src/utils/m3uPlaylist.js.
const SAOKE_SITE = String(process.env.SAOKE_DOMAIN || process.env.SAOKE_BASE_URL || 'https://vip3.saoketv40.xyz').replace(/\/+$/, '');
// FIX (24/09/2026): Referer/Origin THẬT mà trình duyệt gửi tới CDN là domain player nhúng
// sk.mediastation.live (bắt từ DevTools), KHÔNG phải SAOKE_SITE.
const SAOKE_PLAYER = String(process.env.SAOKE_PLAYER_DOMAIN || 'https://sk.mediastation.live').replace(/\/+$/, '');

// FIX (25/09/2026 — "muốn proxy sống (hls.js) cũng hưởng Referer tự dò,
// không chỉ playlist tĩnh"): saoke.service.js tự dò Referer THẬT bằng
// trình duyệt headless (xem detectPlayerReferer() ở đó), nhưng route ĐÓ
// chạy trong serverless function CỦA /api/playlist — KHÁC hẳn function của
// route NÀY (hls.js) trên Vercel, không chia sẻ bộ nhớ (globalThis) với
// nhau. Không thể gọi thẳng qua lại giữa 2 route.
//
// Cầu nối: scripts/generate-playlists.js (chạy mỗi 2 phút qua GitHub
// Actions, xem .github/workflows/validate-and-generate.yml) đã gọi
// /api/playlist để sinh public/playlists/source-saoke.m3u — nó ĐỌC LẠI
// đúng dòng #EXTVLCOPT:http-referrer=... vừa được m3uPlaylist.js nhúng vào
// (dùng chính Referer tự dò được đó, xem FIX 25/09/2026 trong
// m3uPlaylist.js), rồi ghi RIÊNG ra public/playlists/<nguồn>-referer.json.
// File này được commit + deploy cùng repo như mọi file tĩnh khác trong
// public/ — vì vậy ĐỌC ĐƯỢC (read-only) từ BẤT KỲ serverless function nào,
// kể cả route này, dù chạy tách biệt. Không có file (lần deploy đầu, trước
// khi CI chạy lần nào, hoặc site đó chưa từng có trận live lúc CI chạy) hoặc
// đọc/parse lỗi -> coi như chưa có, rơi về danh sách hardcode như cũ, không
// throw. Áp dụng chung cho MỌI nguồn có bật tự dò (hiện tại: saoke,
// chuoichientv — xem detectPlayerReferer() trong service tương ứng).
const DETECTED_REFERER_FILE_CACHE_MS = 60 * 1000; // đọc lại tối đa 1 lần/phút/instance — file do CI ghi mỗi 2 phút, không cần đọc lại mỗi request
const detectedRefererFileCache = new Map(); // source -> { value, readAt }

// FIX (27/09/2026 — "proxy.m3u nhiều nguồn không xem được, riêng Gà Vàng
// vẫn được"): trước đây chỉ đọc field "referer" (1 giá trị DUY NHẤT, lấy từ
// trận ĐẦU TIÊN lúc generate-playlists chạy) — trong khi wrapper domain của
// Chuối Chiên/Bông Lau đổi NGẪU NHIÊN theo từng trận/phiên (xem chú thích ở
// REFERER_CANDIDATES_BY_SOURCE bên dưới), nên referer đúng của trận đang
// phát rất có thể KHÁC referer đã ghi (vốn thuộc 1 trận khác). Giờ đọc thêm
// field "referers" (mảng MỌI referer thật đã dò được trong lần quét gần
// nhất, xem generate-playlists-standalone.mjs) — trả về CẢ mảng để phía gọi
// (refererCandidatesFor) thử lần lượt từng giá trị thật này, thay vì chỉ 1.
function readDetectedReferers(source) {
  const cached = detectedRefererFileCache.get(source);
  if (cached && Date.now() - cached.readAt < DETECTED_REFERER_FILE_CACHE_MS) {
    return cached.value;
  }
  let value = [];
  try {
    const filePath = path.join(process.cwd(), 'public', 'playlists', `${source}-referer.json`);
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed?.referers) && parsed.referers.length) {
      value = parsed.referers.filter((r) => typeof r === 'string' && r);
    } else if (typeof parsed?.referer === 'string' && parsed.referer) {
      // File cũ (trước FIX 27/09/2026) chỉ có field "referer" đơn — vẫn đọc được.
      value = [parsed.referer];
    }
  } catch {
    value = [];
  }
  detectedRefererFileCache.set(source, { value, readAt: Date.now() });
  return value;
}

const REFERER_BY_SOURCE = {
  phaohoa: process.env.PHAOHOA_DOMAIN || process.env.PHAOHOA_BASE_URL || 'https://phaohoa1.live',
  giovang: process.env.GIOVANG_DOMAIN || 'https://giovang.blog', // giovang.city đã redirect sang giovang.blog (30/09/2026)
  khandaitv: process.env.KHANDAITV_DOMAIN || process.env.KHANDAITV_BASE_URL || 'https://khandai3.link',
  // FIX (25/09/2026 — bắt được request THẬT từ DevTools, xem chú thích ở
  // REFERER_CANDIDATES_BY_SOURCE bên dưới): domain player CHUẨN không phải
  // live05.chuoichientv.me/chuoichientv.link như đoán trước đây, mà là
  // fhd-01.cctvsignal.xyz — 1 domain nhúng player HOÀN TOÀN khác, y hệt
  // kiểu Sao Kê dùng sk.mediastation.live thay vì domain trang chính.
  chuoichientv: 'https://fhd-01.cctvsignal.xyz',
  // FIX (18/09/2026 — "trận có tên BLV kiểu '... (Server 1)' của Phá Làng
  // không xem được, còn trận 'Server 1' trơn thì xem được"): trận có tên
  // kèm BLV là trận lấy link qua getStreamLinks() (/match/{id}/live, CDN
  // pull.digitalcdn.net) — thiếu hẳn entry 'phalang' ở đây nên rơi vào
  // REFERER_FALLBACK (domain Pháo Hoa, SAI) -> bị CDN digitalcdn.net chặn
  // hotlink. Trận "Server 1" trơn lấy link thẳng từ source_live có sẵn
  // trong danh sách (CDN khác, không kiểm tra Referer) nên vẫn phát được dù
  // Referer sai — không liên quan gì tới việc thiếu entry này.
  phalang: String(process.env.PHALANG_DOMAIN || 'https://phalang.live').replace(/\/+$/, ''),
  // FIX (24/09/2026 — "nguồn Gà Vàng có trận xem được, có trận lỗi không xem
  // được"): thiếu hẳn entry 'gavang' ở đây (chỉ được thêm vào bản sao
  // REFERER_CANDIDATES_BY_SOURCE trong m3uPlaylist.js) nên mọi link Gà Vàng
  // phát qua web/proxy rơi vào REFERER_FALLBACK (domain Pháo Hoa, SAI). Trận
  // nào nằm trên CDN không kiểm tra Referer thì vẫn xem được, trận nào nằm
  // trên CDN chống hotlink (Tencent/Alibaba...) thì bị 403 -> đúng triệu
  // chứng "trận được trận không" — cùng bệnh với Phá Làng ngày 18/09/2026.
  gavang: GAVANG_ORIGINS[0],
  // FIX (24/09/2026): thiếu entry 'saoke' -> rơi vào REFERER_FALLBACK (Pháo
  // Hoa, SAI) khi phát qua web/proxy, cùng lỗi với Gà Vàng/Phá Làng.
  saoke: SAOKE_PLAYER,
  // Xôi Lạc TV (03/10/2026) — xem xoilac.service.js.
  xoilac: String(process.env.XOILAC_DOMAIN || process.env.XOILAC_BASE_URL || 'https://xoilacxc.tv').replace(/\/+$/, ''),
  // Xoigac TV (04/10/2026) — xem xoigac.service.js.
  xoigac: String(process.env.XOIGAC_DOMAIN || process.env.XOIGAC_BASE_URL || 'https://xoigac.live').replace(/\/+$/, '')
};
const REFERER_FALLBACK = REFERER_BY_SOURCE.phaohoa;

// FIX 2 (17/09/2026 — vẫn 403 Forbidden dù đã chọn đúng Referer theo
// nguồn ở trên, riêng CDN hdplaylink.com của Chuối Chiên):
// Chuối Chiên có 2 domain khác nhau — "domain chính" chuoichientv.link
// (xem chú thích đầu file src/services/chuoichientv.service.js) và domain
// PHỤ live05.chuoichientv.me là nơi trình duyệt thật sự chạy player. Trước
// đây route này đoán CDN hdplaylink.com kiểm tra Referer khớp domain PHỤ
// (live05...) — đoán sai, hoặc CDN đổi cách kiểm tra/đổi domain hợp lệ,
// nên header đó vẫn bị từ chối (403). Vì không có quyền đăng nhập backend
// CDN để biết CHÍNH XÁC domain nào được chấp nhận, và giá trị này có thể
// tự đổi bất cứ lúc nào phía CDN, KHÔNG đoán cứng 1 giá trị nữa — thử LẦN
// LƯỢT nhiều ứng viên hợp lý (domain chính, domain phụ, có/không dấu "/"
// cuối, gắn kèm Origin cùng cặp vì 1 số CDN đòi Origin thay vì/thêm vào
// Referer, và cuối cùng thử bỏ hẳn Referer/Origin — một số CDN chỉ chặn
// Referer SAI chứ không chặn Referer RỖNG) cho tới khi có 1 ứng viên được
// CDN chấp nhận (status không phải 401/403/451). Ứng viên nào thắng sẽ
// được nhớ lại trong bộ nhớ (theo hostname CDN) để các request sau (segment
// .ts kế tiếp của CÙNG 1 trận, dồn dập hàng chục request/phút) dùng thẳng,
// không phải thử lại từ đầu mỗi lần — tránh làm chậm phát video.
const REFERER_CANDIDATES_BY_SOURCE = {
  // FIX (25/09/2026 — "làm giống Sao Kê, lấy link chuẩn từ domain gốc và
  // Referer chuẩn, không đoán mò"): bắt được request THẬT bằng DevTools —
  // domain player fhd-01.cctvsignal.xyz. Link CDN thật đi qua 1 lớp wrapper
  // domain ngẫu nhiên trên 100ycdn.com, path chứa gckc0525.edgemaxcdn.org,
  // kèm query ký session (wsSession/wsIPSercert/wsBindIP/wsserid) — CHÚ Ý:
  // các tham số này trông giống bị RÀNG BUỘC theo phiên/IP người gọi
  // (wsBindIP), khác hẳn Sao Kê (link không có token). Nếu link do server
  // (route /api/matches, gọi API bằng IP máy chủ) lấy về rồi đưa thẳng cho
  // VLC/app phát bằng IP người xem (KHÁC IP máy chủ) thì token có thể bị
  // CDN từ chối dù Referer đã đúng — lúc đó phải phát qua CHÍNH route proxy
  // này (hls.js gọi CDN bằng IP máy chủ, giống lúc lấy token) thay vì phát
  // thẳng link .m3u8 trong app.
  //
  // FIX (26/09/2026 — "vẫn lỗi" sau khi set override = live.chuoichien.tv):
  // bắt THÊM 1 lần DevTools nữa (trận khác, BLV "Trốc Tru") — lần này
  // Referer/Origin THẬT lại là https://live.chuoichien.tv/, KHÔNG phải
  // fhd-01.cctvsignal.xyz. Tức là domain player nhúng CHO TỪNG PHIÊN không
  // cố định — 100ycdn.com là "wrapper domain ngẫu nhiên" (đúng như ghi chú
  // gốc bên dưới), nên domain embed phát sinh token cũng đổi theo phiên.
  // KHÔNG có 1 giá trị "chuẩn" cố định cho nguồn này — set cứng 1 giá trị
  // (kể cả bằng override env) CHỈ đúng cho phiên lúc bắt request, phiên sau
  // đổi domain là lại lỗi. Thêm cả 2 giá trị đã xác nhận thật vào danh sách
  // ứng viên (route này tự thử tuần tự nên không sao), còn override env
  // var CHUOICHIENTV_IPTV_REFERER thì KHÔNG NÊN dùng cho nguồn này nữa —
  // xem ghi chú tương ứng ở FIX_APPLIED.md.
  chuoichientv: [
    'https://live.chuoichien.tv/',
    'https://fhd-01.cctvsignal.xyz/',
    'https://live05.chuoichientv.me/',
    'https://chuoichientv.link/',
    null
  ],
  // Bông Lau TV — chung CDN với Chuối Chiên (xem bonglau.service.js).
  bonglau: [
    'https://live.chuoichien.tv/',
    'https://fhd-01.cctvsignal.xyz/',
    'https://live05.chuoichientv.me/',
    'https://chuoichientv.link/',
    null
  ],
  phaohoa: [REFERER_BY_SOURCE.phaohoa, null],
  giovang: [`${REFERER_BY_SOURCE.giovang}/`, REFERER_BY_SOURCE.giovang, null], // có "/" cuối trước, giống trình duyệt thật
  khandaitv: [REFERER_BY_SOURCE.khandaitv, null],
  // domain hiển thị thật của Phá Làng là phalang.live (xem FIX 18/09/2026 ở
  // phalang.service.js) — thử kèm/không dấu "/" cuối rồi mới tới không gửi
  // Referer, theo đúng khuôn mẫu các nguồn khác ở trên.
  //
  // GHI CHÚ (18/09/2026 — "vẫn bị" sau khi thêm 3 ứng viên trên): đã xác
  // minh bằng debug JSON thật từ production — CẢ 3 ứng viên (có Referer,
  // có Referer kèm "/", KHÔNG gửi Referer) đều bị CDN pull.digitalcdn.net
  // trả về 403 GIỐNG HỆT NHAU (cùng 1 trang lỗi mặc định của nginx, không
  // phải trang lỗi tuỳ biến kiểu "sai domain/hotlink"). Nếu CDN chặn theo
  // Referer, request KHÔNG kèm Referer thường sẽ LỌT QUA (hotlink filter
  // kiểu đó chỉ so khớp khi header có tồn tại) — 403 y hệt ở cả 3 trường
  // hợp gần như loại bỏ khả năng đây là chặn theo Referer/Origin. Nhiều khả
  // năng hơn: CDN chặn theo DẢI IP máy chủ (datacenter/Vercel) — giống hệt
  // trường hợp Khán Đài TV bị Cloudflare chặn IP máy chủ đã ghi ở
  // playlistBuilder.service.js. KHÔNG có header nào phía server sửa được
  // việc này (cần đổi hẳn IP gọi ra, ví dụ qua proxy IP dân dụng — ngoài
  // phạm vi route này) — KHÔNG đoán thêm Referer khác nữa nếu chưa có bằng
  // chứng mới, tránh lặp lại vòng dò mù đã từng tốn công ở Chuối Chiên.
  phalang: [`${REFERER_BY_SOURCE.phalang}/`, REFERER_BY_SOURCE.phalang, null], // có "/" cuối trước, giống trình duyệt thật (29/09/2026)
  gavang: [...GAVANG_ORIGINS, null],
  xoilac: ['https://xl365.domainkqt.cc/', `${REFERER_BY_SOURCE.xoilac}/`, 'https://xoilacxcw.tv/', null],
  // Xoigac: request m3u8 thật (04/10/2026) tới AWS IVS (*.playlist.live-video.net) KHÔNG gửi Referer -> thử không Referer trước.
  xoigac: [null, `${REFERER_BY_SOURCE.xoigac}/`],
  // FIX (24/09/2026 — "Sao Kê các trận lỗi không xem được" dù link .m3u8 có
  // #EXTVLCOPT Referer chuoichientv): trang Sao Kê tự phát bằng Referer LÀ
  // CHÍNH DOMAIN CỦA NÓ, nên Referer đúng phải là SAOKE_SITE — đặt LÊN ĐẦU.
  // Referer Chuối Chiến chỉ còn là ứng viên dự phòng.
  saoke: [`${SAOKE_PLAYER}/`, `${SAOKE_SITE}/`, 'https://live05.chuoichientv.me/', 'https://chuoichientv.link/', null]
};

// Nhớ lại (trong bộ nhớ container, theo hostname CDN) ứng viên Referer nào
// vừa thắng gần nhất, để không phải thử lại tuần tự mỗi request.
const workingRefererByHost = new Map();

function refererCandidatesFor(source, target) {
  const preset = REFERER_CANDIDATES_BY_SOURCE[source];
  let list = preset && preset.length ? preset.slice() : [REFERER_BY_SOURCE[source] || REFERER_FALLBACK, null];

  // FIX (25/09/2026, mở rộng 27/09/2026): chèn MỌI Referer tự dò được (xem
  // readDetectedReferers() ở trên) lên ĐẦU danh sách — đáng tin hơn ứng viên
  // hardcode vì đây là Referer trình duyệt THẬT đã dùng để phát thành công,
  // không phải đoán. Trước đây chỉ chèn 1 giá trị (referer của trận đầu tiên
  // dò được) — giờ chèn CẢ mảng (mỗi trận Chuối Chiên/Bông Lau có thể có
  // wrapper domain khác nhau) để tăng cơ hội trúng đúng referer của CHÍNH
  // trận đang phát, không chỉ trận nào đó dò được lúc quét.
  const detectedList = readDetectedReferers(source);
  if (detectedList.length) {
    list = [...detectedList, ...list.filter((r) => !detectedList.includes(r))];
  }

  let host = '';
  try {
    host = new URL(target).hostname;
  } catch {
    // target không parse được thì bỏ qua bước ưu tiên theo cache, vẫn thử
    // tuần tự các ứng viên còn lại như bình thường.
  }
  const remembered = host && workingRefererByHost.has(host) ? workingRefererByHost.get(host) : undefined;
  if (remembered !== undefined && list.includes(remembered)) {
    // Đẩy ứng viên đã từng thắng lên đầu danh sách để thử trước tiên.
    return [remembered, ...list.filter((r) => r !== remembered)];
  }
  return list;
}

function rememberWorkingReferer(target, referer) {
  try {
    const host = new URL(target).hostname;
    if (host) workingRefererByHost.set(host, referer);
  } catch {
    // bỏ qua nếu không parse được URL
  }
}

// Nguồn phát chặn hotlink (Referer/Origin sai) luôn trả 401/403, một số nơi
// dùng 451 — coi các mã này là "ứng viên hiện tại chưa đúng, thử tiếp",
// khác với lỗi thật (404 hết hạn link, 5xx server nguồn lỗi...) là dừng
// ngay không thử thêm (thử thêm Referer khác cũng không cứu được các lỗi
// này, chỉ tốn thời gian).
function isHotlinkBlockStatus(status) {
  return status === 401 || status === 403 || status === 451;
}

// FIX 3 (17/09/2026 — ĐÃ deploy bản thử nhiều Referer/Origin ở FIX 2,
// người dùng xác nhận VẪN 403 y hệt): ứng viên cuối cùng ở FIX 2 là "không
// gửi Referer/Origin" — CDN vẫn chặn ngay cả khi không gửi Referer nào cả.
// Điều này gần như loại bỏ khả năng đây là chặn theo Referer/Origin (nếu
// chặn theo Referer, request KHÔNG có Referer thường sẽ lọt qua, vì hotlink
// filter kiểu đó chỉ so khớp khi header tồn tại). Nhiều khả năng hơn: CDN
// chặn theo IP/dải mạng của Vercel (nhiều site phim/thể thao "lậu" ở VN cấu
// hình chặn thẳng dải IP datacenter — AWS/Vercel/GCP — chỉ cho phép IP dân
// dụng thật, không header nào sửa được việc này từ phía server), hoặc yêu
// cầu 1 cơ chế xác thực khác hẳn (cookie phiên, token ký kèm theo link mà
// list API chưa trả về...). Không có quyền truy cập trực tiếp CDN này để
// kiểm chứng giả thuyết nào đúng, nên KHÔNG đoán thêm mù mờ nữa — thay vào
// đó, khi mọi ứng viên đều thất bại, gói lại toàn bộ chi tiết từng lần thử
// (mã trạng thái, vài header quan trọng CDN trả về, đoạn đầu nội dung body
// nếu có — nhiều CDN chặn bot trả kèm trang lỗi HTML/JSON nêu rõ lý do) và
// đính kèm thẳng vào JSON lỗi trả về trình duyệt (KHÔNG chỉ log phía server
// — vì không chắc người dùng có quyền xem Vercel function logs), để chỉ
// cần mở tab Network, xem Response của request bị lỗi là có ngay bằng
// chứng thật, thay vì tiếp tục đoán mò.
async function describeFailedAttempt(referer, response, error) {
  if (error) {
    return { referer: referer || '(không gửi)', error: error.message || String(error) };
  }
  let bodySnippet = '';
  try {
    bodySnippet = (await response.text()).slice(0, 300);
  } catch {
    bodySnippet = '(không đọc được body)';
  }
  const headerKeys = ['server', 'cf-ray', 'cf-mitigated', 'via', 'x-cache', 'www-authenticate', 'content-type'];
  const headers = {};
  for (const key of headerKeys) {
    const value = response.headers.get(key);
    if (value) headers[key] = value;
  }
  return { referer: referer || '(không gửi)', status: response.status, headers, bodySnippet };
}

async function fetchUpstreamWithRefererFallback(target, source, rangeHeader) {
  const candidates = refererCandidatesFor(source, target);
  let lastResponse = null;
  let lastError = null;
  const attempts = [];

  for (const referer of candidates) {
    const upstreamHeaders = {
      'User-Agent': DEFAULT_UA,
      Accept: '*/*'
    };
    if (referer) {
      upstreamHeaders.Referer = referer;
      try {
        upstreamHeaders.Origin = new URL(referer).origin;
      } catch {
        // referer không phải URL hợp lệ (không nên xảy ra) -> bỏ qua Origin
      }
    }
    if (rangeHeader) upstreamHeaders.Range = rangeHeader;

    try {
      const response = await fetch(target, { headers: upstreamHeaders, redirect: 'follow' });
      if (!isHotlinkBlockStatus(response.status)) {
        rememberWorkingReferer(target, referer);
        return response;
      }
      // Đọc + lưu chi tiết TRƯỚC khi mất response (clone để không phá luồng
      // body gốc, dù ở đây response này sẽ bị bỏ qua nên clone hay không
      // không ảnh hưởng logic thử tiếp).
      attempts.push(await describeFailedAttempt(referer, response.clone()));
      lastResponse = response;
    } catch (err) {
      attempts.push(await describeFailedAttempt(referer, null, err));
      lastError = err;
    }
  }

  console.error('[api/proxy/hls] Mọi Referer đều thất bại | target:', target, '| chi tiết:', JSON.stringify(attempts));

  if (lastResponse) {
    const debugError = new Error(`Nguồn phát chặn tất cả ${attempts.length} kiểu Referer đã thử`);
    debugError.blockedResponse = lastResponse;
    debugError.debugAttempts = attempts;
    throw debugError;
  }
  const finalError = lastError || new Error('Không có Referer nào gọi được tới nguồn phát');
  finalError.debugAttempts = attempts;
  throw finalError;
}

function buildProxyPath(absoluteUrl, source) {
  const qs = new URLSearchParams({ url: absoluteUrl });
  if (source) qs.set('source', source);
  return `/api/proxy/hls?${qs.toString()}`;
}

function resolveAbsolute(baseUrl, maybeRelative) {
  try {
    return new URL(maybeRelative, baseUrl).toString();
  } catch {
    return maybeRelative;
  }
}

// Viết lại URI="..." trong các dòng thẻ như #EXT-X-KEY, #EXT-X-MEDIA để
// cũng đi qua proxy (nếu không, trình duyệt sẽ tự tải thẳng key/audio phụ
// từ CDN gốc và lại dính đúng lỗi CORS y như link .m3u8 chính).
function rewriteUriAttr(line, baseUrl, source) {
  return line.replace(/URI="([^"]+)"/i, (match, uri) => {
    const abs = resolveAbsolute(baseUrl, uri);
    return `URI="${buildProxyPath(abs, source)}"`;
  });
}

function rewriteM3u8(text, baseUrl, source) {
  const lines = text.split(/\r?\n/);
  const rewritten = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed) return line;

    if (trimmed.startsWith('#')) {
      return /URI="/i.test(trimmed) ? rewriteUriAttr(line, baseUrl, source) : line;
    }

    // Dòng không bắt đầu bằng "#" -> link segment (.ts/.aac/...) hoặc link
    // playlist con (sau #EXT-X-STREAM-INF) — cả 2 trường hợp đều cần bọc
    // qua proxy, kể cả khi link vốn đã là URL tuyệt đối.
    const abs = resolveAbsolute(baseUrl, trimmed);
    return buildProxyPath(abs, source);
  });
  return rewritten.join('\n');
}

export default async function handler(req, res) {
  // Gắn CORS ngay từ đầu, kể cả khi lỗi bên dưới, để không rơi vào tình
  // huống ẩn: proxy trả lỗi 4xx/5xx nhưng vẫn thiếu header CORS khiến
  // trình duyệt lại hiện đúng lỗi CORS thay vì lỗi thật (dễ chẩn đoán sai).
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.status(405).json({ success: false, message: 'Method Not Allowed' });
    return;
  }

  const target = String(req.query.url || '');
  const source = String(req.query.source || '');
  if (!/^https?:\/\//i.test(target)) {
    res.status(400).json({ success: false, message: 'Thiếu hoặc sai tham số "url" (phải là link http/https đầy đủ).' });
    return;
  }

  try {
    const upstream = await fetchUpstreamWithRefererFallback(target, source, req.headers.range);

    if (!upstream.ok && upstream.status !== 206) {
      res.status(upstream.status || 502).json({
        success: false,
        message: `Nguồn phát trả về lỗi ${upstream.status} khi tải: ${target}`
      });
      return;
    }

    const contentType = upstream.headers.get('content-type') || '';
    // upstream.url là URL SAU CÙNG sau khi theo hết redirect — dùng làm base
    // để quy đổi link tương đối bên trong playlist cho đúng, tránh trường
    // hợp link .m3u8 ban đầu 302 sang domain CDN khác.
    const finalUrl = upstream.url || target;
    const looksLikeManifest =
      /mpegurl/i.test(contentType) || /\.m3u8(\?|$)/i.test(finalUrl) || /\.m3u8(\?|$)/i.test(target);

    if (looksLikeManifest) {
      const text = await upstream.text();
      // Nếu nội dung tải về không thực sự là playlist (vd trang lỗi HTML do
      // link đã hết hạn/sign sai) thì KHÔNG cố parse tiếp, trả lỗi rõ ràng
      // thay vì đẩy HTML rác vào hls.js khiến lỗi càng khó hiểu.
      if (!/^#EXTM3U/m.test(text)) {
        res.status(502).json({
          success: false,
          message: 'Link nguồn đã hết hạn hoặc không còn hợp lệ (không phải nội dung m3u8 thật).'
        });
        return;
      }
      const rewritten = rewriteM3u8(text, finalUrl, source);
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).send(rewritten);
      return;
    }

    // Nhị phân (segment .ts, .key, .aac...) — stream thẳng, không buffer cả
    // file vào bộ nhớ, giữ nguyên header liên quan tới phát video/seek.
    res.status(upstream.status);
    if (contentType) res.setHeader('Content-Type', contentType);
    const contentLength = upstream.headers.get('content-length');
    if (contentLength) res.setHeader('Content-Length', contentLength);
    const contentRange = upstream.headers.get('content-range');
    if (contentRange) res.setHeader('Content-Range', contentRange);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'no-store');

    if (req.method === 'HEAD' || !upstream.body) {
      res.end();
      return;
    }

    const reader = upstream.body.getReader();
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
    res.end();
  } catch (err) {
    console.error('[api/proxy/hls]', err?.message, '| target:', target);
    const status = err?.blockedResponse?.status || 502;
    res.status(status).json({
      success: false,
      message: 'Không lấy được dữ liệu từ nguồn phát: ' + (err?.message || 'lỗi không xác định'),
      // Chi tiết từng lần thử Referer/Origin — mở tab Network, xem Response
      // của request /api/proxy/hls bị lỗi để đọc trực tiếp, không cần vào
      // Vercel function logs.
      debug: err?.debugAttempts || undefined
    });
  }
}

export const config = {
  api: { responseLimit: false },
  maxDuration: 30
};
