import { createHttpClient } from '@/src/utils/httpClient';
import { getBrowser } from '@/src/utils/browserFetch';

// Phá Làng TV — domain hiển thị đã đổi sang phalang.live (trước đây dò ra là
// phalang.tv, ĐÃ SAI — xem FIX 18/09/2026 bên dưới). API thật nằm trên
// domain RIÊNG do người dùng cung cấp qua tab Network của trình duyệt.
//   - POST /matches/graph  (BẮT BUỘC có body, kể cả body rỗng {} — GET trả
//     405, POST không kèm body trả 422 "Field required") -> { data: [...], total }
//     Trả về TOÀN BỘ trận (không chỉ live) — is_live là boolean có sẵn
//     ngay trong từng phần tử, tự lọc live/upcoming ở code bên dưới.
//   - GET  /match/{id}/live -> { type, source, hd_1, hd_2, ... } (link phát)
//     Trận CHƯA có link (chưa live) trả 404 "EntityNotFound" — đây là phản
//     hồi HỢP LỆ của API (không phải lỗi/bị chặn), KHÔNG log ra console.error
//     như lỗi thật để tránh làm ồn log Vercel mỗi lần quét.
//
// FIX (18/09/2026 — "nguồn Phá Làng không hiển thị trận live"): bắt được
// request THẬT từ trình duyệt (tab Network trang phalang.live/trang-chu) và
// phát hiện 2 chỗ sai so với code cũ:
//   1) Referer cũ trỏ nhầm sang phalang.tv (domain cũ/không còn đúng) — trang
//      thật đang chạy ở phalang.live, kèm Origin cross-site
//      "https://phalang.live" mà code cũ không hề gửi.
//   2) Body cũ gửi {} (rỗng hoàn toàn). API vẫn nhận (không lỗi) nhưng khi đó
//      rơi vào limit/sắp xếp MẶC ĐỊNH của server — không có gì đảm bảo mặc
//      định đó liệt kê đủ toàn bộ trận (đặc biệt trận đang live, đá từ trước
//      đó lâu, dễ bị rơi khỏi trang đầu nếu mặc định sort khác
//      order_asc=start_date). Request thật của trình duyệt LUÔN kèm
//      limit/page/order_asc/queries tường minh — nay gửi đúng cấu trúc đó
//      (queries: [] để lấy tất cả, không lọc is_hot như tab "Hot" trên web),
//      dùng limit lớn (200) + tự phân trang qua `total` trả về để chắc chắn
//      lấy hết mọi trận trong 1 lần quét, không chỉ trang đầu.
const PHALANG_API_BASE = process.env.PHALANG_API_BASE || 'https://api.plapi202624081158.com';
// Đổi domain qua biến PHALANG_DOMAIN (GitHub Variables) — workflow "Check Domains" tự cập nhật khi domain chết.
const PHALANG_SITE_ORIGIN = String(process.env.PHALANG_DOMAIN || 'https://phalang.live').replace(/\/+$/, '');
const PHALANG_LIST_PAGE_SIZE = 200;
// FIX (24/09/2026 — "bị mất các trận International Friendly, UEFA Nations
// League... có trên trang chủ Phá Làng mà danh sách nguồn không có"): log thật
// từ GitHub Actions cho thấy: API báo total=4925 nhưng CHỈ TRẢ 50 trận/trang
// (bỏ qua limit=200 mình gửi lên). Vòng lặp cũ dừng ngay khi "batch <
// PHALANG_LIST_PAGE_SIZE" (50 < 200) nên chỉ lấy đúng 1 trang đầu = 50 trận
// sớm nhất -> mất gần hết trận còn lại. Cách sửa (xem fetchList()):
//   - Dùng số trận/trang THỰC TẾ API trả (không giả định = limit đã gửi).
//   - Danh sách sắp theo start_date TĂNG DẦN và rất dài (~4900 trận, ~100
//     trang) -> KHÔNG kéo hết; tìm nhị phân trang bắt đầu của "cửa sổ thời
//     gian" [bây giờ - 12h, bây giờ + 48h] rồi chỉ kéo các trang trong cửa sổ.
//   - Gộp 2 lần gọi live/upcoming trong cùng 1 lượt quét dùng chung 1 lần lấy.
const PHALANG_WINDOW_PAST_MS = 12 * 60 * 60 * 1000; // trận đang live có thể đã bắt đầu tới ~12h trước (tennis/bóng rổ...)
const PHALANG_WINDOW_FUTURE_MS = 48 * 60 * 60 * 1000; // playlist chỉ dùng 24h tới, dư ra để an toàn
const PHALANG_FULL_FETCH_MAX_PAGES = 10; // tổng nhỏ (<= 10 trang) thì kéo hết, khỏi tìm nhị phân
const PHALANG_WINDOW_MAX_PAGES = 40; // trần an toàn số trang kéo trong cửa sổ
const PHALANG_LIST_CACHE_MS = 30 * 1000;

function phalangStartMs(m) {
  const t = m?.start_date ? Date.parse(`${m.start_date}Z`) : NaN; // start_date là UTC không kèm 'Z' (xem normalizeMatch)
  return Number.isFinite(t) ? t : NaN;
}

const SPORT_INFO = {
  football: { name: 'BÓNG ĐÁ', icon: 'fa-futbol' },
  volleyball: { name: 'BÓNG CHUYỀN', icon: 'fa-volleyball' },
  basketball: { name: 'BÓNG RỔ', icon: 'fa-basketball' },
  tennis: { name: 'TENNIS', icon: 'fa-baseball-bat-ball' },
  badminton: { name: 'CẦU LÔNG', icon: 'fa-shuttlecock' }
};

// desc trả về dạng chữ hoa tiếng Anh (FOOTBALL, VOLLEYBALL...) — map thẳng
// sang key sportAliases đã có trong playerGet.js (normalizeSport).
function mapSport(desc) {
  return String(desc || 'football').toLowerCase();
}

// FIX (24/09/2026 — "nguồn Phá Làng nhiều trận giải bé, giải cỏ quá, các nguồn
// khác OK rồi"): /matches/graph trả TOÀN BỘ trận (kể cả giải trẻ/dự bị/hạng
// thấp/ảo), trong khi các nguồn khác đã tự lọc sẵn.
// ĐỔI HƯỚNG (24/09/2026 — "muốn hướng 2"): bản đầu dùng danh sách giải LỚN
// (allowlist) nên liên tục loại nhầm giải thật (Nations League, Gulf Cup...).
// Giờ ngược lại: GIỮ TẤT CẢ, chỉ LOẠI trận bóng đá thuộc giải nhỏ rõ ràng
// (blocklist MINOR_LEAGUE_RE: giải trẻ U15-U23/youth, dự bị/reserve, hạng 3+,
// giải nghiệp dư/khu vực/hạng dưới Đức, bóng đá ảo/esoccer...). Các môn khác
// giữ nguyên. Một trận bóng đá luôn được GIỮ nếu:
//   1) API đánh dấu is_hot, HOẶC
//   2) là giao hữu (kiểm tra cả tên giải + tiêu đề), HOẶC
//   3) liên quan Việt Nam (đội tuyển/SEA Games/AFF/V-League...) — giữ cả U23/hạng dưới, HOẶC
//   4) tên giải chứa từ khoá trong PHALANG_KEEP_LEAGUES.
// Tinh chỉnh (đều dùng từ khoá KHÔNG DẤU, chữ thường, cách nhau bằng dấu phẩy):
//   - PHALANG_LEAGUE_FILTER=off      -> tắt lọc, lấy hết như cũ
//   - PHALANG_FILTER_MODE=block     -> chế độ nhẹ: giữ hết, chỉ loại giải nhỏ (mặc định 'major': chỉ giữ giải nổi bật)
//   - PHALANG_BLOCK_LEAGUES=a,b      -> thêm từ khoá giải muốn LOẠI
//   - PHALANG_KEEP_LEAGUES=a,b       -> thêm từ khoá giải luôn GIỮ (ưu tiên hơn blocklist)
// Mỗi lần quét in log số trận bị bỏ + tên các giải bị bỏ để dễ tinh chỉnh.
const MINOR_LEAGUE_RE = new RegExp([
  // giải trẻ / dự bị
  '\\bu-?(1\\d|2[0-3])\\b', '\\bunder ?(1\\d|2[0-3])\\b', 'youth', 'junior', 'juvenil', 'primavera', 'reserve', 'academy', '\\bdu bi\\b', '\\btre\\b',
  'premier league 2', 'development league',
  // nghiệp dư / hạng thấp / khu vực
  'amateur', 'regional', 'oberliga', 'landesliga', 'kreisliga', 'verbandsliga', 'serie d',
  '\\bhang (3|4|5|ba|tu|nam)\\b', '\\bdivision [3-9]\\b', '\\bleague (two|2)\\b',
  // bóng đá ảo / giải giả lập
  'esoccer', 'e-?soccer', 'e-?football', 'efootball', 'cyber', 'virtual', 'simulated', 'fifa ?2\\d', 'fc ?2\\d', 'battle'
].join('|'));

// CHẾ ĐỘ MẶC ĐỊNH "major" (24/09/2026 — "nguồn Phá Làng nhiều trận quá", log thật:
// 141/240 trận trong playlist là Phá Làng, đa số giải cỏ kiểu Bhutan Premier
// League, Malaysian President Cup, Finnish Kolmonen...). Sau khi sửa lỗi phân
// trang (chỉ lấy 50/4925 trận), lượng trận thật lộ ra rất lớn nên chỉ loại giải
// trẻ là KHÔNG đủ. Vì vậy quay lại danh sách giải nổi bật (MAJOR) nhưng dùng
// TÊN CÓ QUỐC GIA như Phá Làng trả về (vd "English Premier League" — khác với
// "Bhutan Premier League"), cộng với các luật GIỮ: is_hot, giao hữu, liên quan
// Việt Nam, PHALANG_KEEP_LEAGUES. Lỗi mất International Friendly / Nations
// League trước đó là do phân trang, KHÔNG phải do bộ lọc — 2 giải này vẫn giữ.
// Chế độ "block" (PHALANG_FILTER_MODE=block) = hành vi cũ: giữ hết, chỉ loại giải nhỏ.
const MAJOR_LEAGUE_RE = new RegExp([
  // Anh
  'women.?s super league', '\\bwsl\\b', '\\bnwsl\\b', 'liga f\\b', 'ngoai hang anh', 'cup c1', 'cup c2', '^(english |england )?premier league$', '^(english |england )?(efl )?championship$', '\\bfa cup\\b', 'efl cup', 'carabao', 'league cup', 'community shield',
  // Tây Ban Nha / Ý / Đức / Pháp
  'la ?liga', 'copa del rey', 'supercopa', 'serie a', 'coppa italia', 'supercoppa', 'bundesliga', 'dfb', 'ligue 1', 'coupe de france', 'trophee des champions',
  // châu Âu / thế giới / châu lục
  'champions league', 'europa', 'conference league', 'uefa', 'nations league', '\\beuro\\b', 'euro 20', 'world cup', 'wcq', 'qualif', 'vong loai',
  'asian cup', '\\bafc\\b', 'fifa', 'conmebol', 'concacaf', 'copa america', 'libertadores', 'sudamericana', 'olympic', 'super cup',
  'gulf cup', 'waff', 'arab cup', 'cup of nations', 'afcon', 'cecafa', 'cosafa', 'baltic', 'kirin', 'gold cup', 'intercontinental',
  // VĐQG lớn khác
  'eredivisie', 'primeira liga', 'liga portugal', 'super lig', 'saudi pro league', 'saudi professional', '\\bj[-. ]?[123]? ?league', '\\bj1\\b', 'k ?league 1', '^k ?league$',
  '\\bmls\\b', 'major league soccer', 'a-league', 'liga mx', 'brasileir', 'liga profesional', 'scottish premiership', 'jupiler', 'belgian pro league',
  'russian premier league', 'chinese super league', 'china super league', 'thai league 1', 'greek super league', 'swiss super league', 'ukrainian premier league'
].join('|'));

const FILTER_MODE = String(process.env.PHALANG_FILTER_MODE || 'major').toLowerCase();

// Trận giao hữu luôn được giữ, kiểm tra trên CẢ tên giải lẫn tiêu đề trận và
// bỏ qua luật loại giải trẻ (xem FIX "bị mất các trận giao hữu").
const FRIENDLY_RE = /giao huu|giao luu|friendl|\bclub friendly\b|\bint(?:ernational)? ?cf\b|quoc te|international/;

const VIETNAM_RE = /viet ?nam|sea games|\baff\b|asean|v-?league/;

function stripDiacritics(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/gi, 'd')
    .toLowerCase();
}

function envKeywordsRe(name) {
  const words = String(process.env[name] || '')
    .split(',')
    .map((w) => stripDiacritics(w).trim())
    .filter(Boolean)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return words.length ? new RegExp(words.join('|')) : null;
}

const KEEP_LEAGUES_RE = envKeywordsRe('PHALANG_KEEP_LEAGUES') || envKeywordsRe('PHALANG_MAJOR_LEAGUES'); // MAJOR: tên biến cũ, giữ để tương thích
const BLOCK_LEAGUES_RE = envKeywordsRe('PHALANG_BLOCK_LEAGUES');

// FIX (24/09/2026 — "nguồn Phá Làng vẫn còn nhiều trận giải cỏ: U15, U17, U19...
// nữ giải cỏ"): trước đây luật GIỮ (is_hot, giao hữu, Việt Nam, tên giải rỗng)
// chạy TRƯỚC luật loại nên giải trẻ lọt qua (vd "International Friendly U19",
// trận is_hot, hoặc tên giải rỗng mà U19 nằm ở tiêu đề). Giờ luật loại giải
// trẻ (U10-U20, youth, reserve...), bóng đá ảo và bóng đá NỮ nhỏ chạy TRƯỚC,
// kể cả trận is_hot/giao hữu. Chỉ trận liên quan Việt Nam được miễn luật trẻ.
const YOUTH_RE = new RegExp([
  '\\bu-?(1\\d|20)\\b', '\\bunder ?(1\\d|20)\\b', 'youth', 'junior', 'juvenil', 'primavera', 'reserve', 'academy', '\\bdu bi\\b', '\\btre\\b'
].join('|'));

const VIRTUAL_RE = /esoccer|e-?soccer|e-?football|efootball|cyber|virtual|simulated|fifa ?2\d|fc ?2\d|battle/;

const WOMEN_RE = /women|woman|femin|femenin|frauen|damallsvenskan|ladies|girls|\bnu\b|\(w\)|\bnwsl\b/;
// Bóng đá nữ chỉ giữ khi là giải lớn / đội tuyển / giao hữu (hoặc is_hot, Việt Nam).
const WOMEN_KEEP_RE = /uefa|fifa|world cup|olympic|asian cup|\bafc\b|champions league|nations league|\beuro\b|copa america|concacaf|gold cup|qualif|\bwsl\b|\bnwsl\b|women.?s super league|liga f\b/;

// DANH SÁCH GIẢI BỊ LOẠI HẲN (24/09/2026 — "lọc bỏ các giải nguồn Phá Làng"):
// so khớp CHÍNH XÁC theo tên giải Phá Làng trả về (không phân biệt hoa/thường,
// dấu, khoảng trắng) nên KHÔNG ảnh hưởng giải cùng họ (vd giữ German Bundesliga,
// Japanese J1 League, UEFA Champions League...). Chạy TRƯỚC mọi luật giữ
// (is_hot, giao hữu, Việt Nam, PHALANG_KEEP_LEAGUES) và không bị PHALANG_LEAGUE_FILTER=off tắt.
// Muốn loại thêm giải: thêm vào mảng dưới, hoặc đặt env PHALANG_EXCLUDE_LEAGUES=a,b
// (khớp chứa từ khoá, không dấu, chữ thường).
const EXCLUDED_LEAGUE_NAMES = [
  'German Bundesliga 5',
  'CONCACAF Nations League',
  'Japanese J3 League',
  'Japanese J2 League',
  'Northern Ireland Women\'s Super League',
  'Belgian Women\'s Super League',
  'Mexico Liga MX',
  'Greek Women\'s Super League',
  'Turkish Women\'s Super League',
  'CFA Member Champions League',
  'CFA Team China International Tournament',
  'Guatemala Liga Nacional',
  'UEFA European U21 Championship qualification',
  'Japanese Nadeshiko League 2',
  'Chinese Hong Kong League Cup',
  'English FA Women\'s Super League'
];

function normalizeLeagueName(name) {
  return stripDiacritics(name).replace(/[\u2018\u2019`]/g, "'").replace(/\s+/g, ' ').trim();
}

const EXCLUDED_LEAGUE_SET = new Set(EXCLUDED_LEAGUE_NAMES.map(normalizeLeagueName));
const EXCLUDE_LEAGUES_RE = envKeywordsRe('PHALANG_EXCLUDE_LEAGUES');

function isExcludedLeague(match) {
  if (match?.sport !== 'football') return false;
  const league = normalizeLeagueName(match?.competition?.name || '');
  if (!league) return false;
  if (EXCLUDED_LEAGUE_SET.has(league)) return true;
  return !!(EXCLUDE_LEAGUES_RE && EXCLUDE_LEAGUES_RE.test(league));
}

function isNotableMatch(match) {
  if (match?.sport !== 'football') return true; // chỉ lọc bóng đá

  const league = stripDiacritics(match?.competition?.name || '');
  const text = `${league} | ${stripDiacritics(match?.title || '')}`;
  const vietnam = VIETNAM_RE.test(text);

  // 1) LUẬT LOẠI chạy trước mọi luật giữ (trừ Việt Nam với giải trẻ).
  if (VIRTUAL_RE.test(text)) return false;
  if (YOUTH_RE.test(text) && !vietnam) return false;
  if (WOMEN_RE.test(text) && !match?.isHot && !vietnam && !WOMEN_KEEP_RE.test(text) && !FRIENDLY_RE.test(text)) return false;

  // 2) LUẬT GIỮ.
  if (match?.isHot) return true;
  if (!league) return true; // API không trả tên giải -> không đủ cơ sở để loại, giữ lại
  if (FRIENDLY_RE.test(text)) return true;
  if (vietnam) return true;
  if (KEEP_LEAGUES_RE && KEEP_LEAGUES_RE.test(league)) return true;

  // 3) Còn lại: giải trẻ U21-U23, hạng thấp, nghiệp dư... (MINOR) -> loại; rồi tới chế độ.
  if (MINOR_LEAGUE_RE.test(text)) return false;
  if (BLOCK_LEAGUES_RE && BLOCK_LEAGUES_RE.test(league)) return false;
  if (FILTER_MODE === 'block') return true; // chế độ nhẹ: giữ hết, chỉ loại giải nhỏ rõ ràng
  return MAJOR_LEAGUE_RE.test(league); // chế độ mặc định 'major': chỉ giữ giải nổi bật
}

export function filterPhalangMatches(matches = []) {
  const filterOff = String(process.env.PHALANG_LEAGUE_FILTER || '').toLowerCase() === 'off';
  const kept = [];
  const dropped = [];
  for (const m of matches) {
    // Giải nằm trong danh sách loại hẳn -> bỏ, kể cả khi tắt bộ lọc chung.
    if (isExcludedLeague(m)) { dropped.push(m); continue; }
    if (filterOff || isNotableMatch(m)) kept.push(m);
    else dropped.push(m);
  }
  return { kept, dropped };
}

// FIX (29/09/2026 — "link Phá Làng đều lỗi"): DevTools thật cho thấy link phát
// KHÔNG phải link trần API trả về, mà là link BỌC qua domain ngẫu nhiên
// *.100ycdn.com + token, dạng
//   https://<host>.100ycdn.com/pull.digitalcdn.net/live/<id>/index.m3u8?wsSession=..&wsIPSercert=..&wsBindIP=2&wsserid=..
// (giống Chuối Chiên/Bông Lau). API /match/{id}/live chỉ có hd_1/hd_2 trần
// nên phải mở TRANG XEM TRẬN (https://phalang.live/truc-tiep/<slug>-<id>)
// bằng trình duyệt headless và bắt request .m3u8 thật mà player gửi đi. Segment
// .ts cũng gửi Referer = chính URL trang xem trận + Origin https://phalang.live,
// nên URL trang xem được dùng làm Referer của link.
//   - PHALANG_BROWSER_RESOLVE=off : tắt bước này (quay về link trần như cũ)
//   - PHALANG_TOKEN_TTL_MS        : thời gian dùng lại link đã bắt (mặc định 3 phút)
// KẾT LUẬN từ log CI (29/09/2026): player của trang CŨNG chỉ gọi link trần
// pull.digitalcdn.net/... và bị 403 từ IP datacenter (GitHub Actions). Link
// bọc 100ycdn + token (wsBindIP) là do CDN 302 riêng cho IP NGƯỜI XEM, máy chủ
// CI không lấy được -> MẶC ĐỊNH TẮT (tốn ~13s/trận mà luôn thất bại).
// Bật lại thử bằng PHALANG_BROWSER_RESOLVE=on.
const PHALANG_BROWSER_RESOLVE = String(process.env.PHALANG_BROWSER_RESOLVE || 'off').toLowerCase() === 'on';
const PHALANG_DEBUG = String(process.env.PHALANG_DEBUG || '').toLowerCase() === '1';
const PHALANG_TOKEN_TTL_MS = Number(process.env.PHALANG_TOKEN_TTL_MS) || 3 * 60 * 1000;
const PHALANG_BROWSER_TIMEOUT_MS = 13000; // tổng thời gian tối đa cho 1 trận (builder cho phép 18s cả API + bắt link)
const tokenCache = globalThis.__phalangTokenCache || new Map(); // matchId -> { url, referer, at }
globalThis.__phalangTokenCache = tokenCache;

/** URL trang xem trận — trình duyệt thật gửi CHÍNH URL này làm Referer (kèm Origin https://phalang.live) khi gọi CDN. */
function phalangWatchUrl(id, home, away) {
  const slug = home && away ? `${slugifyName(home)}-vs-${slugifyName(away)}-` : '';
  return `${PHALANG_SITE_ORIGIN}/truc-tiep/${slug}${id}`;
}

function slugifyName(text) {
  return stripDiacritics(text).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

class PhalangService {
  constructor() {
    this.client = createHttpClient({
      baseURL: PHALANG_API_BASE,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'application/json, text/plain, */*',
        'Content-Type': 'application/json',
        Origin: PHALANG_SITE_ORIGIN,
        Referer: `${PHALANG_SITE_ORIGIN}/trang-chu`
      }
    });
  }

  detectCdn(url) {
    const u = String(url || '').toLowerCase();
    if (u.includes('digitalcdn')) return 'DIGITALCDN';
    if (u.includes('cloudflare')) return 'CLOUDFLARE';
    return 'HLS';
  }

  normalizeMatch(m) {
    const sport = mapSport(m.desc);
    const sportInfo = SPORT_INFO[sport] || { name: String(m.desc || 'BÓNG ĐÁ').toUpperCase(), icon: 'fa-futbol' };

    // FIX (18/09/2026 — "thời gian các trận bị lệch 7h"): start_date trả về
    // dạng "YYYY-MM-DDTHH:mm:ss" KHÔNG có múi giờ. Lần trước ĐOÁN đây là giờ
    // Việt Nam sẵn (gán '+07:00') — SAI, thực tế API trả giờ UTC, cộng thêm
    // +07:00 khi hiển thị (qua timeZone: 'Asia/Ho_Chi_Minh' bên dưới) làm giờ
    // bị cộng dồn 2 lần -> lệch hẳn 7 tiếng so với giờ thật. Đổi lại đúng như
    // ghi chú đã lường trước: coi start_date là UTC (gán 'Z') rồi mới quy đổi
    // sang giờ VN lúc format.
    const matchDate = m.start_date ? new Date(`${m.start_date}Z`) : new Date();
    const timeStr = matchDate.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Ho_Chi_Minh' });
    const dateStr = matchDate.toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });
    const dd = String(matchDate.getDate()).padStart(2, '0');
    const mm = String(matchDate.getMonth() + 1).padStart(2, '0');

    const homeName = m.team_1 || 'Home';
    const awayName = m.team_2 || 'Away';
    const isLive = !!m.is_live;
    // Trận LIVE có source_live là link digitalcdn TRẦN (không token) thì không dùng
    // được — bỏ để getStreamLinks() lấy link bọc có token qua trình duyệt.
    const skipBareLive = PHALANG_BROWSER_RESOLVE && isLive && m.source_live
      && this.detectCdn(m.source_live) === 'DIGITALCDN' && !String(m.source_live).includes('?');

    return {
      matchId: `pl_${m.id}`,
      originalId: m.id,
      streamKey: m.stream_key,
      source: 'phalang',
      sport,
      sportName: sportInfo.name,
      sportIcon: sportInfo.icon,
      title: m.title || `${homeName} - ${awayName}`,
      competition: { name: m.league || '', logo: '', icon: '' },
      homeTeam: { name: homeName, logo: m.team_1_logo || '' },
      awayTeam: { name: awayName, logo: m.team_2_logo || '' },
      score: { home: m.team_1_score ?? 0, away: m.team_2_score ?? 0 },
      status: {
        isLive,
        isFinished: false,
        isHalfTime: false,
        isUpcoming: !isLive,
        name: isLive ? 'LIVE' : 'Sắp diễn ra',
        text: isLive ? 'LIVE' : 'Sắp diễn ra',
        elapsedTime: '',
        minutes: ''
      },
      matchTime: matchDate.getTime(),
      matchTimeTimestamp: matchDate.getTime(),
      timeFormatted: `${timeStr} - ${dd}/${mm}`,
      dateStr,
      timeStr,
      isHot: !!m.is_hot,
      // source_live đôi khi đã có sẵn link .m3u8 thẳng trong danh sách (trận
      // chưa live) — giữ lại làm phương án nhanh, nhưng KHÔNG đảm bảo đúng
      // cho trận đang live thật (đã thấy trường hợp is_live=true mà
      // source_live vẫn null) — trận live luôn phải gọi getStreamLinks().
      streamUrl: skipBareLive ? '' : (m.source_live || ''),
      commentators: (m.source_live && !skipBareLive)
        ? [{ id: `${m.id}_0`, name: m.blv || 'Server 1', avatar: '', streamUrl: m.source_live, isLive: true, cdn: this.detectCdn(m.source_live), referer: phalangWatchUrl(m.id, homeName, awayName) }]
        : [],
      // FIX (23/09/2026 — "nguồn Phá Làng: trận chưa thi đấu không xuất
      // hiện trong all.m3u"): trước đây liveUrl luôn để '' (rỗng). Ở chế độ
      // build tĩnh (không server, xem FIX 20/09/2026 trong m3uPlaylist.js),
      // matchesToPlaylistEntries() dùng đúng field này làm giá trị TẠM cho
      // trận chưa có link phát — rỗng thì bị coi là "không có gì để ghi" và
      // BỎ QUA hẳn (continue), nên mọi trận Phá Làng chưa live (gần như
      // luôn thiếu source_live) biến mất khỏi playlist, dù có giờ đá rõ
      // ràng. Phá Làng không trả về link trang riêng cho từng trận trong
      // /matches/graph, nên dùng tạm trang chủ (không phải link phát thật —
      // chỉ cần KHÁC RỖNG để không bị continue; đúng như comment ở
      // matchesToPlaylistEntries: giá trị này chỉ để hiển thị/tham khảo cho
      // tới khi trận live thật và có source_live).
      stream: { liveUrl: `${PHALANG_SITE_ORIGIN}/trang-chu#${m.id}`, streamerName: m.blv || null, streamerAvatar: null },
      odds: null
    };
  }

  mapStreams(match) {
    return (match?.commentators || []).map((c) => ({
      id: c.id,
      streamerId: c.id,
      name: c.name,
      streamerName: c.name,
      avatar: c.avatar,
      streamerAvatar: c.avatar,
      link: c.streamUrl,
      m3u8Url: c.streamUrl,
      playUrl: c.streamUrl,
      format: 'hls',
      cdn: c.cdn,
      quality: 'HD'
    }));
  }

  /** Body giống hệt trình duyệt thật gửi lên /matches/graph (xem FIX 18/09/2026
   *  ở đầu file) — queries rỗng = không lọc theo is_hot/… như tab "Hot" trên
   *  web, lấy TOÀN BỘ trận để tự lọc live/upcoming ở code bên dưới. */
  buildListBody(page) {
    return {
      limit: PHALANG_LIST_PAGE_SIZE,
      page,
      order_asc: 'start_date',
      queries: []
    };
  }

  async fetchPage(page) {
    const { data } = await this.client.post(
      '/matches/graph',
      this.buildListBody(page),
      { params: { _t: Date.now() } }
    );
    const batch = Array.isArray(data?.data) ? data.data : [];
    const total = Number.isFinite(data?.total) ? data.total : batch.length;
    return { batch, total };
  }

  /** Lấy danh sách trận (dùng chung 30s giữa các lần gọi live/upcoming trong 1 lượt quét). */
  fetchList() {
    const now = Date.now();
    if (this._listCache && now - this._listCache.at < PHALANG_LIST_CACHE_MS) return this._listCache.promise;
    const promise = this.fetchListUncached().then((list) => {
      if (!list.length) this._listCache = null; // lỗi/rỗng -> không cache, lần sau thử lại
      return list;
    });
    this._listCache = { at: now, promise };
    return promise;
  }

  async fetchListUncached() {
    try {
      const pages = new Map(); // cache trang đã kéo trong lần này (tránh gọi lại khi tìm nhị phân)
      let requests = 0;
      const getPage = async (n) => {
        if (!pages.has(n)) {
          requests += 1;
          pages.set(n, await this.fetchPage(n));
        }
        return pages.get(n);
      };

      const first = await getPage(1);
      const total = first.total;
      const pageSize = first.batch.length; // số trận/trang THỰC TẾ (API có thể bỏ qua limit đã gửi)
      if (!pageSize) return [];
      const totalPages = Math.max(1, Math.ceil(total / pageSize));

      // Tổng nhỏ -> kéo hết như cũ.
      if (totalPages <= PHALANG_FULL_FETCH_MAX_PAGES) {
        const all = [...first.batch];
        for (let n = 2; n <= totalPages; n++) all.push(...(await getPage(n)).batch);
        console.log(`[phalang] API total=${total}, ${pageSize} trận/trang -> kéo hết ${all.length} trận (${requests} request)`);
        return all;
      }

      const lastTimeOf = (page) => phalangStartMs(page.batch[page.batch.length - 1]);
      const firstTimeOf = (page) => phalangStartMs(page.batch[0]);
      const nowMs = Date.now();
      const lo = nowMs - PHALANG_WINDOW_PAST_MS;
      const hi = nowMs + PHALANG_WINDOW_FUTURE_MS;

      // Kiểm tra danh sách có thật sự sắp TĂNG DẦN theo giờ (trang đầu <= trang cuối).
      const lastPage = await getPage(totalPages);
      const ascending = firstTimeOf(first) <= lastTimeOf(lastPage);

      let startPage = 1;
      if (ascending) {
        // Tìm nhị phân trang NHỎ NHẤT có trận cuối >= lo (mọi trang trước đó toàn trận cũ hơn cửa sổ).
        let left = 1;
        let right = totalPages;
        while (left < right) {
          const mid = Math.floor((left + right) / 2);
          const t = lastTimeOf(await getPage(mid));
          if (Number.isFinite(t) && t < lo) left = mid + 1;
          else right = mid;
        }
        startPage = left;
      } else {
        console.warn('[phalang] CẢNH BÁO: danh sách API không sắp tăng dần theo giờ — kéo tuần tự từ trang 1, có thể sót trận.');
      }

      const all = [];
      let n = startPage;
      for (; n <= totalPages && n < startPage + PHALANG_WINDOW_MAX_PAGES; n++) {
        const page = await getPage(n);
        all.push(...page.batch);
        if (ascending) {
          const t = lastTimeOf(page);
          if (Number.isFinite(t) && t > hi) { n += 1; break; } // đã vượt cửa sổ tương lai
        }
      }
      const truncated = n <= totalPages && !(all.length && ascending && lastTimeOf({ batch: [all[all.length - 1]] }) > hi);
      console.log(
        `[phalang] API total=${total}, ${pageSize} trận/trang, ${totalPages} trang -> lấy trang ${startPage}-${n - 1} ` +
        `(${all.length} trận trong cửa sổ, ${requests} request)`
      );
      if (truncated) {
        console.warn(`[phalang] CẢNH BÁO: chạm trần ${PHALANG_WINDOW_MAX_PAGES} trang trong cửa sổ — có thể sót trận sắp đá.`);
      }
      return all;
    } catch (error) {
      console.error('Error fetching Phalang list:', error.message);
      return [];
    }
  }

  /** Interface giống các nguồn khác: gộp mọi type thành 1 danh sách, tự lọc theo tab ở code. */
  async getAllMatchesByTab(tab) {
    const raw = await this.fetchList();
    const normalized = raw.map((m) => this.normalizeMatch(m));
    // Lọc giải bé/giải cỏ (bóng đá) — xem filterPhalangMatches() phía trên.
    const { kept: all, dropped } = filterPhalangMatches(normalized);
    console.log(`[phalang] tab=${tab}: API trả ${raw.length} trận, sau lọc giải bé còn ${all.length}`);
    if (tab === 'live') {
      const bySport = {};
      for (const m of all) bySport[m.sport] = (bySport[m.sport] || 0) + 1;
      console.log(`[phalang] sau lọc, theo môn: ${Object.entries(bySport).map(([k, v]) => `${k}=${v}`).join(', ')}`);
      const byLeague = {};
      for (const m of all) if (m.sport === 'football') byLeague[m.competition?.name || '(không rõ giải)'] = (byLeague[m.competition?.name || '(không rõ giải)'] || 0) + 1;
      const keptTop = Object.entries(byLeague).sort((x, y) => y[1] - x[1]).slice(0, 40).map(([k, v]) => `${k}(${v})`);
      if (keptTop.length) console.log(`[phalang] bóng đá được GIỮ, theo giải: ${keptTop.join(' | ')}`);
    }
    if (dropped.length) {
      const leagues = [...new Set(dropped.map((m) => m.competition?.name || '(không rõ giải)'))].slice(0, 40);
      console.log(`[phalang] tab=${tab}: bỏ ${dropped.length}/${normalized.length} trận giải bé — ${leagues.join(' | ')}`);
    }

    let matches = all;
    if (tab === 'live') matches = all.filter((m) => m.status.isLive);
    else if (tab === 'upcoming') matches = all.filter((m) => m.status.isUpcoming);

    return { matches, hasMore: false, totalCount: matches.length };
  }

  /**
   * FIX (29/09/2026 — "link Phá Làng đều lỗi, không xem được, hình như thiếu
   * nguồn bóc và token"): link phát bị lấy TRẦN, dạng
   * https://pull.digitalcdn.net/live/<id>/index.m3u8 (không có query) — CDN
   * từ chối vì thiếu chữ ký/token. Trước đây chỉ đọc đúng hd_N và source,
   * BỎ QUA mọi trường khác của /match/{id}/live (token, query, sign...).
   * Giờ:
   *   1) mở lớp bọc `data` nếu API bọc kết quả trong đó;
   *   2) lấy hd_N (theo số), rồi source, rồi mọi trường khác chứa link
   *      m3u8/flv/mp4 (hd, sd, url, link, play_url...);
   *   3) nếu response có trường token/chữ ký (token, auth_key, sign,
   *      txSecret/txTime, query...) và link chưa có query -> gắn vào link.
   * Link đã có query sẵn thì giữ nguyên, không đụng.
   */
  unwrapDetail(detail) {
    if (detail && typeof detail === 'object' && detail.data && typeof detail.data === 'object' && !Array.isArray(detail.data)) {
      return detail.data;
    }
    return detail;
  }

  buildTokenQuery(detail) {
    const RAW_QUERY_KEYS = /^(query|params|qs|token_query|auth_query)$/i;
    const CREDENTIAL_KEYS = /^(token|access_token|auth|auth_key|authkey|sign|signature|sig|txsecret|txtime|wssecret|wstime)$/i;
    const EXPIRY_KEYS = /^(expire|expires|expiry|exp)$/i;
    const parts = [];
    let hasCredential = false;
    for (const [k, v] of Object.entries(detail || {})) {
      if (v === null || v === undefined || typeof v === 'object') continue;
      const val = String(v).trim();
      if (!val || /^https?:\/\//i.test(val)) continue;
      if (RAW_QUERY_KEYS.test(k) && val.includes('=')) {
        parts.push(val.replace(/^[?&]+/, ''));
        hasCredential = true;
      } else if (CREDENTIAL_KEYS.test(k)) {
        parts.push(`${k}=${encodeURIComponent(val)}`);
        hasCredential = true;
      } else if (EXPIRY_KEYS.test(k)) {
        parts.push(`${k}=${encodeURIComponent(val)}`);
      }
    }
    return hasCredential ? parts.join('&') : '';
  }

  /** Bỏ giá trị query khi log, tránh lộ token thật trong log CI. */
  maskUrl(url) {
    const s = String(url || '');
    const i = s.indexOf('?');
    if (i < 0) return `${s} (KHÔNG có query/token)`;
    return `${s.slice(0, i)}?${s.slice(i + 1).replace(/=([^&]*)/g, '=***')}`;
  }

  extractStreamUrls(rawDetail) {
    const detail = this.unwrapDetail(rawDetail);
    if (!detail || typeof detail !== 'object') return [];
    const isUrl = (v) => typeof v === 'string' && /^https?:\/\//i.test(v.trim());
    const looksStream = (v) => /\.(m3u8|flv|mp4)(\?|#|$)/i.test(v) || /\/live\//i.test(v);
    const urls = [];
    const hdKeys = Object.keys(detail)
      .filter((k) => /^hd_\d+$/i.test(k))
      .sort((a, b) => Number(a.split('_')[1]) - Number(b.split('_')[1]));
    for (const k of hdKeys) {
      if (isUrl(detail[k])) urls.push(detail[k].trim());
    }
    if (isUrl(detail.source)) urls.push(detail.source.trim());
    for (const [k, v] of Object.entries(detail)) {
      if (/^hd_\d+$/i.test(k) || k === 'source') continue;
      if (isUrl(v) && looksStream(v)) urls.push(v.trim());
    }

    const tokenQuery = this.buildTokenQuery(detail);
    const finalUrls = urls.map((u) => {
      if (!tokenQuery || u.includes('?')) return u; // đã có query -> giữ nguyên
      return `${u}?${tokenQuery}`;
    });
    return [...new Set(finalUrls)].filter(Boolean);
  }

  /**
   * Mở trang xem trận bằng trình duyệt headless (UA Chrome thường, không phải
   * "HeadlessChrome"), thử bấm Play vài lần và chờ request .m3u8 có token
   * (?ws...= hoặc host *.100ycdn.com). Thất bại thì log CHẨN ĐOÁN: mã HTTP
   * trang, tiêu đề, số video/iframe, các request m3u8/ts/digitalcdn đã thấy,
   * lỗi console — để biết trang bị chặn hay player không chịu phát.
   */
  async captureTokenizedM3u8(watchUrl, timeoutMs) {
    const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
    const INTEREST = /\.m3u8|\.ts(\?|$)|100ycdn|digitalcdn|wsSession/i;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const browser = await getBrowser();
    const page = await browser.newPage();
    const seen = [];
    const notes = [];
    let mainStatus = null;
    let found = null;
    try {
      await page.setUserAgent(UA);
      await page.setExtraHTTPHeaders({ 'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8' });
      page.on('console', (m) => { try { if (m.type() === 'error' && notes.length < 4) notes.push(`console: ${m.text().slice(0, 100)}`); } catch { /* bỏ qua */ } });
      page.on('pageerror', (e) => { if (notes.length < 4) notes.push(`pageerror: ${String(e?.message || e).slice(0, 100)}`); });
      page.on('requestfailed', (r) => { try { if (INTEREST.test(r.url()) && seen.length < 10) seen.push(`FAILED ${this.maskUrl(r.url()).slice(0, 110)}`); } catch { /* bỏ qua */ } });
      page.on('response', (r) => {
        try {
          if (mainStatus === null && r.request().resourceType() === 'document') mainStatus = r.status();
          if (INTEREST.test(r.url()) && seen.length < 10) seen.push(`${r.status()} ${this.maskUrl(r.url()).slice(0, 110)}`);
        } catch { /* bỏ qua */ }
      });
      page.on('request', (req) => {
        try {
          const u = req.url();
          if (!found && /\.m3u8(\?|$)/i.test(u) && (/[?&]ws\w+=/i.test(u) || /100ycdn\.com/i.test(u))) {
            found = { url: u, headers: req.headers() };
          }
        } catch { /* bỏ qua */ }
      });

      const started = Date.now();
      await page.goto(watchUrl, { waitUntil: 'domcontentloaded', timeout: Math.min(8000, timeoutMs) })
        .catch((e) => notes.push(`goto: ${String(e.message).slice(0, 80)}`));

      let tick = 0;
      while (!found && Date.now() - started < timeoutMs) {
        if (tick === 2 || tick === 8 || tick === 16) await this.tryStartPlayer(page);
        tick += 1;
        await sleep(500);
      }
      if (found) return found;

      const info = await page.evaluate(() => ({
        title: document.title,
        text: (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 120),
        videos: document.querySelectorAll('video').length,
        iframes: [...document.querySelectorAll('iframe')].slice(0, 3).map((f) => (f.src || '').slice(0, 80))
      })).catch(() => ({}));
      console.warn(
        `[phalang][browser] KHÔNG bắt được | HTTP trang: ${mainStatus} | title: "${info.title || ''}" | ` +
        `video: ${info.videos ?? '?'} | iframe: ${JSON.stringify(info.iframes || [])} | nội dung: "${info.text || ''}" | ` +
        `request thấy: ${seen.length ? seen.join(' ; ') : '(không có m3u8/ts/digitalcdn nào)'} | ${notes.join(' | ')}`
      );
      return null;
    } finally {
      await page.close().catch(() => {});
    }
  }

  /** Thử khởi động player: play() mọi <video>, bấm các nút play phổ biến, rồi bấm giữa màn hình. */
  async tryStartPlayer(page) {
    await page.evaluate(() => {
      const playIn = (doc) => {
        try {
          doc.querySelectorAll('video').forEach((v) => { v.muted = true; v.play?.().catch(() => {}); });
          doc.querySelectorAll('.vjs-big-play-button, .jw-icon-display, .plyr__control--overlaid, [class*="play" i], [aria-label*="play" i], [title*="play" i]')
            .forEach((el) => { try { el.click(); } catch { /* bỏ qua */ } });
        } catch { /* bỏ qua */ }
      };
      playIn(document);
      document.querySelectorAll('iframe').forEach((f) => { try { playIn(f.contentDocument); } catch { /* khác origin */ } });
    }).catch(() => {});
    await page.mouse.click(683, 384).catch(() => {});
  }

  /** Bắt link .m3u8 có token thật cho trận. Trả { url, referer } hoặc null. */
  async resolveTokenizedUrl(cleanId, bareUrls, teams) {
    if (!PHALANG_BROWSER_RESOLVE || !bareUrls.length) return null;
    const cached = tokenCache.get(cleanId);
    if (cached && Date.now() - cached.at < PHALANG_TOKEN_TTL_MS) return cached;

    const watchUrl = phalangWatchUrl(cleanId, teams?.home, teams?.away);
    try {
      const found = await this.captureTokenizedM3u8(watchUrl, PHALANG_BROWSER_TIMEOUT_MS);
      if (!found?.url) {
        console.warn(`[phalang] ${watchUrl}: mở trang xong nhưng không bắt được request .m3u8 có token — dùng link trần`);
        return null;
      }
      const value = { url: found.url, referer: found.headers?.referer || watchUrl, at: Date.now() };
      tokenCache.set(cleanId, value);
      console.log(`[phalang] bắt được link có token (${cleanId}): ${this.maskUrl(found.url)} | referer: ${value.referer}`);
      return value;
    } catch (error) {
      console.error(`[phalang] bắt link token bằng trình duyệt thất bại (${cleanId}):`, error.message);
      return null;
    }
  }

  async probeCdn(url) {
    const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
    const combos = [
      ['Referer+Origin', { Referer: `${PHALANG_SITE_ORIGIN}/`, Origin: PHALANG_SITE_ORIGIN }],
      ['chỉ Referer', { Referer: PHALANG_SITE_ORIGIN }],
      ['không header', {}]
    ];
    for (const [label, extra] of combos) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 6000);
      try {
        const r = await fetch(url, { headers: { 'User-Agent': UA, ...extra }, signal: ctrl.signal, redirect: 'manual' });
        const body = (await r.text()).slice(0, 160).replace(/\s+/g, ' ');
        // Nếu CDN trả 3xx (chuyển sang link bọc 100ycdn có token) -> log đích, che giá trị query.
        const loc = r.headers.get('location');
        const locInfo = loc ? ` | Location: ${this.maskUrl(loc)}` : '';
        console.log(`[phalang][probe] ${label}: HTTP ${r.status} | ${r.headers.get('content-type') || '?'}${locInfo} | ${body}`);
      } catch (e) {
        console.log(`[phalang][probe] ${label}: lỗi ${e.name === 'AbortError' ? 'timeout 6s' : e.message}`);
      } finally {
        clearTimeout(timer);
      }
    }
  }

  async getStreamLinks(matchId, blvName, match) {
    const cleanId = String(matchId || '').replace(/^pl_/, '');
    if (!cleanId) return [];
    try {
      const { data } = await this.client.get(`/match/${cleanId}/live`, { params: { _t: Date.now() } });
      const urls = this.extractStreamUrls(data);
      // Log chẩn đoán (tối đa 5 lần/tiến trình): cho biết response /live có
      // những trường nào và link có kèm token hay không — để lần sau biết
      // chính xác Phá Làng đang trả gì nếu link vẫn lỗi. Token được che.
      this._diagLogged = (this._diagLogged || 0);
      if (this._diagLogged < 5) {
        this._diagLogged += 1;
        const d = this.unwrapDetail(data) || {};
        console.log(
          `[phalang] /match/${cleanId}/live -> trường: [${Object.keys(d).join(', ')}] | ` +
          `${urls.length} link | token/query ghép thêm: ${this.buildTokenQuery(d) ? 'CÓ' : 'không'} | ` +
          `mẫu: ${urls[0] ? this.maskUrl(urls[0]) : '(không có link)'}`
        );
      }
      // Thử trực tiếp link đầu tiên với vài kiểu header (tối đa 3 lần/tiến
      // trình) và log kết quả — để biết CDN từ chối vì Referer/Origin, IP hay
      // link hết hạn. Chỉ để chẩn đoán, không ảnh hưởng playlist.
      if (PHALANG_DEBUG && urls[0] && (this._probeLogged || 0) < 3) {
        this._probeLogged = (this._probeLogged || 0) + 1;
        this.probeCdn(urls[0]).catch(() => {}); // không chờ: tránh làm chậm/quá hạn việc lấy link
      }
      // Bắt link BỌC có token thật (xem resolveTokenizedUrl) — đặt LÊN ĐẦU danh
      // sách, thay đúng link trần cùng đường dẫn; lỗi thì giữ nguyên link trần.
      const tokenized = await this.resolveTokenizedUrl(
        cleanId,
        urls,
        { home: match?.homeTeam?.name, away: match?.awayTeam?.name }
      );
      let finalUrls = urls;
      if (tokenized) {
        let tokenPath = '';
        try { tokenPath = new URL(tokenized.url).pathname; } catch { /* bỏ qua */ }
        const rest = urls.filter((u) => { try { return !tokenPath.endsWith(new URL(u).pathname); } catch { return true; } });
        finalUrls = [tokenized.url, ...rest];
      }
      return finalUrls.map((url, i) => ({
        referer: tokenized && url === tokenized.url ? tokenized.referer : phalangWatchUrl(cleanId, match?.homeTeam?.name, match?.awayTeam?.name),
        id: `${cleanId}_${i}`,
        streamerId: `${cleanId}_${i}`,
        name: blvName ? `${blvName} (Server ${i + 1})` : `Server ${i + 1}`,
        streamerName: blvName ? `${blvName} (Server ${i + 1})` : `Server ${i + 1}`,
        link: url,
        m3u8Url: url,
        playUrl: url,
        format: 'hls',
        cdn: this.detectCdn(url),
        quality: 'HD'
      }));
    } catch (error) {
      // 404 EntityNotFound = trận chưa có link phát (chưa live/nguồn chưa
      // cập nhật) — phản hồi HỢP LỆ của API, không phải lỗi thật, không log
      // ồn console mỗi lần quét. Chỉ log các lỗi khác (mạng, 5xx...).
      if (error.response?.status !== 404) {
        console.error('Error fetching Phalang stream links:', error.message);
      }
      return [];
    }
  }
}

const phalangService = new PhalangService();
export default phalangService;
