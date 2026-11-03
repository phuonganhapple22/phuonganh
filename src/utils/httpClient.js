const axios = require('axios');

// FIX "playlist/web load quay tròn mãi vào sáng hôm sau": khi Vercel không
// có ai gọi API qua đêm, container serverless bị thu hồi (cold) — mất hết
// cache đã lưu trong bộ nhớ. Lần gọi đầu tiên sau đó phải quét lại TOÀN BỘ
// từ đầu. Nếu đúng lúc đó domain nguồn (Pháo Hoa/Giờ Vàng — các site dạng
// này hay bị chặn/đổi domain) phản hồi chậm hoặc treo, mốc cũ (15s timeout
// × 3 lần thử) khiến MỖI request có thể "câm lặng" tới gần 47 giây — vượt
// hẳn giới hạn cứng 60s của Vercel khi cộng dồn nhiều lệnh gọi, hàm bị nền
// tảng NGẮT NGANG mà không kịp trả lời gì (không phải lỗi rõ ràng) — app
// xem playlist/trang web chỉ thấy "đang tải" mãi không dừng vì không hề
// nhận được phản hồi nào để dừng lại, dù đã có sẵn máy chủ config lại
// timeout ngắn hơn ở các lớp gọi bên trên (STREAM_RESOLVE_TIMEOUT_MS,
// AWAIT_REFRESH_TIMEOUT_MS...) — các mốc đó chỉ ĐUA (Promise.race) với
// lệnh gọi HTTP đang treo bên dưới chứ không HỦY được nó, request cũ vẫn
// tiếp tục chạy ngầm, vẫn góp phần khiến toàn bộ hàm chạm trần 60s. Giảm
// timeout + số lần thử ở gốc (tại đây, áp dụng cho MỌI service) để 1 lệnh
// gọi lỗi/treo chỉ tốn tối đa ~12.5s (6s × 2 lần thử + 500ms nghỉ giữa 2
// lần) thay vì gần 47s — đủ nhanh để không bao giờ chạm ngưỡng nào phía
// trên, dù domain nguồn có chập chờn tới đâu.
const DEFAULT_TIMEOUT = 6000;
const DEFAULT_MAX_ATTEMPTS = 2;
const DEFAULT_RETRY_DELAY_MS = 500;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableError(error) {
  if (!error) return false;

  const code = error.code || '';
  if (
    code === 'ECONNABORTED' ||
    code === 'ETIMEDOUT' ||
    code === 'ECONNRESET' ||
    code === 'ECONNREFUSED' ||
    code === 'ENOTFOUND' ||
    code === 'EAI_AGAIN' ||
    code === 'EPIPE' ||
    code === 'ERR_NETWORK'
  ) {
    return true;
  }

  if (error.message && /timeout|network|socket hang up|ECONN/i.test(error.message)) {
    return true;
  }

  // No response = network / DNS / aborted
  if (!error.response) return true;

  const status = error.response.status;
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function attachRetry(client, options = {}) {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const baseDelay = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;

  client.interceptors.response.use(
    (response) => response,
    async (error) => {
      const config = error.config;
      if (!config) return Promise.reject(error);

      config.__retryCount = config.__retryCount || 0;
      const attempt = config.__retryCount + 1;

      if (attempt >= maxAttempts || !isRetryableError(error)) {
        return Promise.reject(error);
      }

      config.__retryCount = attempt;
      const delay = baseDelay * Math.pow(2, attempt - 1);
      const method = (config.method || 'get').toUpperCase();
      const url = config.url || '';
      console.warn(
        `[http] retry ${attempt}/${maxAttempts - 1} ${method} ${url} — ${error.message} (wait ${delay}ms)`
      );

      await sleep(delay);
      return client.request(config);
    }
  );

  return client;
}

/**
 * Axios instance with timeout + automatic retry on timeout/network/5xx.
 * maxAttempts includes the first try (default 3 = 1 try + 2 retries).
 */
function createHttpClient(config = {}, retryOptions = {}) {
  const client = axios.create({
    timeout: DEFAULT_TIMEOUT,
    ...config
  });
  return attachRetry(client, retryOptions);
}

module.exports = {
  createHttpClient,
  attachRetry,
  isRetryableError,
  sleep,
  DEFAULT_TIMEOUT,
  DEFAULT_MAX_ATTEMPTS
};
