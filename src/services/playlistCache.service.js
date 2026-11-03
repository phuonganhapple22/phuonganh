import { buildAggregatedMatches } from '@/src/services/playlistBuilder.service';

// Có trận đang live → quét lại nhanh, đủ mới cho IPTV, không spam nguồn gốc.
const ACTIVE_REFRESH_INTERVAL_MS = 15 * 60 * 1000; // 15 phút
// Không có trận nào đang live → giãn thời gian quét ra để đỡ tốn tài nguyên
// (băng thông, request tới các nguồn gốc), nhưng vẫn đủ nhanh để không bỏ lỡ
// khi có trận mới bắt đầu. Giãn dần theo số lần quét liên tiếp "trắng" và
// dừng giãn ở mức trần, quay lại 15 phút ngay khi tìm thấy trận live.
//
// QUAN TRỌNG: chạy trên Vercel serverless — KHÔNG phải 1 process sống liên
// tục — nên setTimeout tự quét nền (scheduleNext/refresh) không đảm bảo
// chạy được giữa các lần request (container có thể bị đóng băng). Vì vậy
// trần giãn + hệ số STALE_MULTIPLIER phải đủ THẤP để, kể cả khi timer nền
// không chạy, request kế tiếp (dù cách xa vài chục phút) vẫn tự ép quét lại
// đồng bộ thay vì tiếp tục phục vụ cache cũ/rỗng hàng giờ liền — đây chính
// là lỗi khiến trận mới hôm sau không lên được playlist dù người dùng đã
// bấm refresh nguồn trên app IPTV (app chỉ tải lại file, không ép server
// quét lại; server tự quyết định cache có "đủ mới" hay không).
const IDLE_REFRESH_INTERVAL_MS = 10 * 60 * 1000; // bắt đầu giãn: 10 phút
const IDLE_REFRESH_MAX_MS = 20 * 60 * 1000; // giãn tối đa: 20 phút (trước đây 2 tiếng — quá dài cho serverless)
const STALE_MULTIPLIER = 1.5; // trước đây x2 (tới 4 tiếng) — hạ để buộc quét lại sớm hơn

// Trần thời gian ĐỢI 1 lần quét (không phải trần thời gian quét — quét vẫn
// chạy tiếp ở nền dù đã hết hạn đợi). Quét lần đầu (cold start) phải gọi
// ~15-20 nguồn song song, có thể chậm nếu 1-2 nguồn đang bị chặn/timeout.
// Không giới hạn thì request từ trình duyệt (và cả hàm serverless trên
// Vercel) có thể bị treo lâu hơn giới hạn thời gian chạy của nền tảng.
// Đặt dưới mức maxDuration (60s, xem export const config trong các route
// gọi hàm này) để luôn kịp trả response trước khi Vercel tự ngắt.
//
// FIX "playlist thiếu nhiều trận so với web dù cùng 1 nguồn dữ liệu": mỗi
// route API (/api/matches, /api/playlist...) là 1 serverless function
// RIÊNG trên Vercel — KHÔNG chia sẻ cache bộ nhớ (globalThis) với nhau dù
// cùng import chung file này. Web gọi /api/matches liên tục (polling) nên
// function đó hiếm khi "nguội" — luôn có cache đầy đủ. App IPTV chỉ gọi
// /api/playlist khi bấm refresh, thưa hơn nhiều → hay bị cold-start → cache
// rỗng → phải quét lại từ đầu. Trước đây chỉ đợi 25s: quét đủ ~15-20 nguồn
// (có nguồn cần mở trình duyệt headless, chậm hơn hẳn) thường LÂU HƠN 25s
// → hết giờ đợi, trả dữ liệu cũ/rỗng ngay trong khi server vẫn quét tiếp ở
// nền → thiếu trận. Nâng lên gần trần 60s để lần cold-start có đủ thời gian
// quét xong thật sự trước khi trả kết quả.
const AWAIT_REFRESH_TIMEOUT_MS = 50000;

function delay(ms, value) {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

/** Đợi 1 promise tối đa `ms` — hết hạn thì trả `timedOut: true` NGAY, promise gốc vẫn chạy tiếp ở nền. */
async function awaitWithTimeout(promise, ms) {
  const TIMEOUT = Symbol('timeout');
  const result = await Promise.race([promise, delay(ms, TIMEOUT)]);
  return { timedOut: result === TIMEOUT };
}

// Sống trên `globalThis` để không bị tạo lại (và spawn thêm timer) mỗi lần
// Next.js hot-reload module trong dev, hoặc mỗi lần route được require lại.
const state = globalThis.__playlistCacheState || {
  matches: [],
  generatedAt: 0,
  refreshing: null, // Promise đang chạy, null nếu rảnh
  timer: null,
  consecutiveEmptyScans: 0 // số lần quét liên tiếp không thấy trận nào — dùng để giãn lịch quét
};
globalThis.__playlistCacheState = state;

/** Khoảng cách tới lần quét kế tiếp, tính theo tình trạng cache hiện tại. */
function currentIntervalMs() {
  if (state.matches.length > 0) return ACTIVE_REFRESH_INTERVAL_MS;
  const grown = IDLE_REFRESH_INTERVAL_MS * 2 ** Math.min(state.consecutiveEmptyScans, 2);
  return Math.min(grown, IDLE_REFRESH_MAX_MS);
}

function scheduleNext(delayMs) {
  if (state.timer) clearTimeout(state.timer);
  state.timer = setTimeout(() => {
    refresh();
  }, delayMs);
  // Không giữ process sống chỉ vì cái timer này (an toàn cho script/CLI).
  if (typeof state.timer.unref === 'function') state.timer.unref();
}

async function refresh() {
  if (state.refreshing) return state.refreshing;

  state.refreshing = (async () => {
    try {
      const matches = await buildAggregatedMatches();
      // FIX "a.filter is not a function": chốt chặn cuối cùng — nếu vì lý
      // do gì đó buildAggregatedMatches() không trả về mảng (không nên xảy
      // ra, nhưng phòng hờ), KHÔNG ghi đè cache bằng giá trị sai kiểu, giữ
      // nguyên cache cũ (mảng) để mọi nơi dùng .filter phía sau luôn an toàn.
      if (Array.isArray(matches)) {
        state.matches = matches;
        state.generatedAt = Date.now();
        state.consecutiveEmptyScans = matches.length > 0 ? 0 : state.consecutiveEmptyScans + 1;
      } else {
        console.error('[playlist-cache] buildAggregatedMatches() trả về không phải mảng:', matches);
      }
    } catch (err) {
      console.error('[playlist-cache] auto-refresh failed:', err.message);
    } finally {
      state.refreshing = null;
      // Luôn đặt lại lịch quét kế tiếp theo tình trạng MỚI NHẤT sau mỗi lần
      // quét — đây là chỗ tạo ra hành vi "có trận thì tự làm mới đều đặn,
      // không có trận thì giãn ra" mà không cần thêm timer thứ hai nào khác.
      scheduleNext(currentIntervalMs());
    }
  })();

  return state.refreshing;
}

function scheduleAutoRefresh() {
  if (state.timer) return; // đã có 1 chuỗi lịch quét đang chạy — refresh() tự đặt lại lịch sau mỗi lần
  scheduleNext(currentIntervalMs());
}

/**
 * Trả về danh sách trận đã resolve link, tự làm mới nền theo lịch động:
 * - Đang có trận live: làm mới mỗi 15 phút.
 * - Không có trận nào (cả ngày yên ắng): giãn dần 30' → 60' → tối đa 2h để
 *   giảm tải cho nguồn gốc, và quay lại 15 phút ngay khi có trận trở lại.
 * - Lần gọi đầu tiên (cache rỗng) sẽ đợi quét xong luôn (cold start).
 * - Các lần sau trả cache ngay lập tức; nếu cache đã quá hạn theo lịch hiện
 *   tại mà timer lỡ chưa kịp chạy, sẽ kích hoạt refresh nền và vẫn trả dữ
 *   liệu cũ ngay (stale-while-revalidate), trừ khi dữ liệu đã quá cũ (gấp đôi
 *   khoảng cách quét) thì đợi luôn.
 */
export async function getMatches({ forceRefresh = false } = {}) {
  scheduleAutoRefresh();

  const interval = currentIntervalMs();
  const staleAfterMs = interval * STALE_MULTIPLIER;
  const age = Date.now() - state.generatedAt;
  const isEmpty = state.generatedAt === 0;

  if (forceRefresh || isEmpty || age > staleAfterMs) {
    const { timedOut } = await awaitWithTimeout(refresh(), AWAIT_REFRESH_TIMEOUT_MS);
    if (timedOut) {
      // Quét vẫn đang chạy tiếp ở nền (state.refreshing giữ promise đó) —
      // request này không đợi thêm nữa, trả ngay dữ liệu đang có (có thể
      // rỗng nếu là lần quét đầu tiên) để không bao giờ bị Vercel ngắt giữa
      // chừng. Request kế tiếp (vài giây/phút sau) sẽ thấy cache đã đầy.
      console.warn('[playlist-cache] quét lần đầu quá lâu — trả dữ liệu hiện có, quét vẫn tiếp tục ở nền.');
    }
  } else if (age > interval) {
    refresh(); // nền — không đợi
  }

  const nextInterval = currentIntervalMs();
  return {
    matches: state.matches,
    generatedAt: state.generatedAt,
    nextRefreshAt: state.generatedAt ? state.generatedAt + nextInterval : 0,
    refreshIntervalMs: nextInterval
  };
}

export const PLAYLIST_REFRESH_INTERVAL_MS = ACTIVE_REFRESH_INTERVAL_MS;
export const PLAYLIST_IDLE_REFRESH_INTERVAL_MS = IDLE_REFRESH_INTERVAL_MS;
