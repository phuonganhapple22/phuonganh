// Dùng khi site chặn thẳng request kiểu axios/cheerio (403 ở tầng WAF trước
// khi chạm tới nội dung thật) — mở 1 trình duyệt Chromium headless thật để
// site không phân biệt được với người dùng thường, rồi đọc HTML đã render
// hoặc bắt response của 1 API call cụ thể phát sinh trong lúc load trang.
//
// Trên Vercel dùng @sparticuz/chromium-min (bản Chromium NÉN SẴN CÓ trong
// gói npm KHÔNG đủ dùng — xem lý do ở FIX 10/09/2026 bên dưới) + puppeteer-
// core (không kèm chromium riêng, nhẹ hơn nhiều so với puppeteer đầy đủ).
// Máy dev local không có sẵn chromium kiểu này thì tự tải Chrome hệ thống
// qua biến CHROME_EXECUTABLE_PATH (xem README/env.example).
//
// FIX (10/09/2026 — lỗi "error while loading shared libraries: libnss3.so:
// cannot open shared object file"): đã tự kiểm tra trực tiếp trên Vercel
// (route debug-env.js) và xác nhận: bản @sparticuz/chromium ĐẦY ĐỦ (gói
// thường, không phải -min) khi chạy trên Node.js 20/22/24 của Vercel tự cho
// rằng hệ điều hành nền (Amazon Linux 2023) đã có sẵn NSS nên KHÔNG đóng gói
// kèm libnss3.so trong gói npm — nhưng môi trường Vercel thực tế lại không
// có sẵn, và Vercel không cho tự cài thêm gói hệ thống (dnf/apt) như máy chủ
// tự quản để bù vào. Đây không phải lỗi đường dẫn — file đó THỰC SỰ không
// tồn tại ở đâu cả trong trường hợp này.
// Giải pháp: dùng bản "-min" của gói này — bản này KHÔNG đóng gói sẵn
// chromium trong node_modules, mà TỰ TẢI 1 gói .tar nén Brotli đầy đủ (kèm
// mọi thư viện .so cần thiết, tự chứa, không phụ thuộc hệ điều hành) từ
// GitHub Releases của chính dự án @sparticuz/chromium ngay lần chạy đầu
// tiên (cold start), giải nén vào /tmp, các lần chạy sau (còn "ấm") dùng
// lại luôn không tải lại. Cần khớp ĐÚNG version release với version cài
// trong package.json (không tự ý đổi version 1 bên mà quên bên kia).
const CHROMIUM_PACK_VERSION = '131.0.1';
const CHROMIUM_PACK_URL = `https://github.com/Sparticuz/chromium/releases/download/v${CHROMIUM_PACK_VERSION}/chromium-v${CHROMIUM_PACK_VERSION}-pack.tar`;

const path = require('path');
const fs = require('fs');
const zlib = require('zlib');

let chromiumPromise;

async function loadChromium() {
  if (!chromiumPromise) {
    chromiumPromise = (async () => {
      const chromium = (await import('@sparticuz/chromium-min')).default;
      // FIX (10/09/2026 — lỗi "Attempted to use detached Frame" lặp lại
      // liên tục khi đọc dữ liệu, dù đã qua được bước tải trang): Cloudflare
      // không chỉ kiểm tra navigator.webdriver mà còn dò thêm nhiều dấu
      // hiệu khác của trình duyệt tự động/máy chủ (renderer đồ hoạ giả lập
      // SwiftShader, chrome.runtime thiếu, danh sách plugin trống...),
      // khiến trang cứ liên tục bắt giải lại challenge, không bao giờ qua
      // hẳn — mỗi lần code định đọc dữ liệu lại đúng lúc trang đang tải lại
      // giữa chừng. Đổi từ puppeteer-core thuần sang puppeteer-extra + plugin
      // stealth (bộ vá ~17 dấu hiệu nhận diện bot được cộng đồng dùng rộng
      // rãi cho đúng loại vấn đề này) thay vì tự vá tay từng dấu hiệu một.
      const { addExtra } = await import('puppeteer-extra');
      const puppeteerCore = await import('puppeteer-core');
      const StealthPlugin = (await import('puppeteer-extra-plugin-stealth')).default;
      const puppeteer = addExtra(puppeteerCore.default ?? puppeteerCore);
      puppeteer.use(StealthPlugin());
      return { chromium, puppeteer };
    })();
  }
  return chromiumPromise;
}

// Tự giải nén định dạng .tar (USTAR/POSIX) bằng tay — KHÔNG gọi lệnh `tar`
// bên ngoài, vì môi trường function của Vercel không chắc có sẵn lệnh này
// trong PATH (đã tự kiểm chứng: gọi execFileSync('tar', ...) chạy không ra
// lỗi rõ ràng nhưng cũng không tạo ra file nào — nghi là lệnh không tồn
// tại/không hoạt động như trên máy thường). Định dạng tar khá đơn giản: mỗi
// file là 1 block header 512 byte (tên ở byte 0-100, kích thước dạng bát
// phân ở byte 124-136, cờ loại ở byte 156) theo sau là nội dung file, đệm
// thêm cho đủ bội số 512 byte. Đã tự tải file thật của bản 131.0.1 về test
// bằng đúng đoạn code này trước khi đưa vào đây — ra đúng kích thước file
// gốc, chạy đúng.
function extractTarBuffer(buffer, destDir) {
  let offset = 0;
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break; // 2 block toàn số 0 = hết file

    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const sizeOctal = header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim();
    const size = parseInt(sizeOctal, 8) || 0;
    const typeFlag = String.fromCharCode(header[156]);

    offset += 512;
    if (!name) continue;

    const destPath = path.join(destDir, name);
    if (typeFlag === '5' || name.endsWith('/')) {
      fs.mkdirSync(destPath, { recursive: true });
    } else {
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.writeFileSync(destPath, buffer.subarray(offset, offset + size));
    }

    offset += Math.ceil(size / 512) * 512; // nội dung đệm về bội số 512
  }
}

// FIX (10/09/2026 — vẫn thiếu libnss3.so ngay cả sau khi đổi sang -min):
// đã tự kiểm tra qua route debug-env.js và phát hiện: chromium.executable
// Path(url) có tải đúng gói .tar về thư mục "chromium-pack" cạnh file thực
// thi, NHƯNG bên trong đó các file thư viện hệ thống vẫn còn nguyên dạng
// nén Brotli (al2023.tar.br) — KHÔNG được tự động giải nén ra .so như kỳ
// vọng (khả năng do gói này chủ yếu được test trên các runtime chính thức
// của AWS Lambda, còn runtime Node.js 24 mà Vercel dùng không hoàn toàn
// giống hệt). Tự giải nén tay bằng zlib (đã có sẵn trong Node.js, không cần
// cài thêm gì) + extractTarBuffer() ở trên (thuần JS, không gọi lệnh `tar`
// ngoài — xem lý do ngay phía trên hàm đó).
function ensureSharedLibsExtracted(execDir) {
  // FIX: đã tự tải + giải nén thử file thật để kiểm chứng — libnss3.so nằm
  // trong 1 thư mục con "lib/" SAU KHI giải nén (không nằm trực tiếp cùng
  // cấp với file chromium như đoán ban đầu).
  const libDir = path.join(execDir, 'lib');
  const nssPath = path.join(libDir, 'libnss3.so');
  if (fs.existsSync(nssPath)) return; // đã có sẵn, khỏi làm gì thêm

  const packDir = path.join(execDir, 'chromium-pack');
  if (!fs.existsSync(packDir)) return;

  // Ưu tiên al2023 (môi trường Amazon Linux 2023 — dùng cho Node.js 20 trở
  // lên), al2 chỉ để dự phòng nếu vì lý do gì đó al2023 không có/không giải
  // nén được.
  const candidates = ['al2023.tar.br', 'al2.tar.br'];
  for (const name of candidates) {
    const brPath = path.join(packDir, name);
    if (!fs.existsSync(brPath)) continue;
    try {
      const compressed = fs.readFileSync(brPath);
      const decompressed = zlib.brotliDecompressSync(compressed);
      extractTarBuffer(decompressed, execDir);
      if (fs.existsSync(nssPath)) return; // giải nén xong, có file cần rồi
    } catch (error) {
      console.error(`Không giải nén được ${name}:`, error.message);
      // thử file tiếp theo trong danh sách candidates
    }
  }
}

// Giữ 1 browser instance dùng lại giữa các lần gọi trong cùng 1 lambda còn
// "ấm" (warm) — mở Chromium mất 2-4s (chưa tính lần đầu phải tải thêm gói
// pack.tar ở trên, có thể lâu hơn), không muốn trả giá đó ở mọi request.
//
// FIX (08/10/2026 — "Failed to launch the browser process!" ở Khán Đài/Sao Kê trên GitHub Actions):
// 3 lỗi cộng lại làm Chrome rò rỉ dần rồi không khởi chạy nổi nữa trong job chạy hàng giờ:
//  (1) hết hạn 5 phút thì mở trình duyệt MỚI nhưng KHÔNG đóng cái cũ -> mỗi 5 phút bỏ lại 1 Chrome
//      (cả chục tiến trình con) chạy mãi, ~vài chục phút là cạn RAM -> launch thất bại;
//  (2) `browserPromise` chỉ được gán SAU khi await loadChromium() -> nhiều nguồn gọi getBrowser() cùng
//      lúc (Khán Đài, Sao Kê, Giờ Vàng, Phá Làng...) đều thấy chưa có và MỖI nơi mở 1 Chrome riêng;
//  (3) cờ `--single-process` (có trong chromium.args của @sparticuz, dành cho Lambda) làm cả trình
//      duyệt chết khi mở nhiều tab với Chrome thường tải qua CHROME_EXECUTABLE_PATH.
// Giờ: chỉ 1 lượt khởi chạy tại một thời điểm (khoá đồng bộ), trình duyệt cũ được ĐÓNG sau khi hết hạn
// (chờ OLD_BROWSER_GRACE_MS cho các tab đang dùng dở), khởi chạy lỗi thì thử lại tối đa 3 lần.
let browserPromise = null;
let browserOpenedAt = 0;
const BROWSER_MAX_AGE_MS = 5 * 60 * 1000;
const OLD_BROWSER_GRACE_MS = 90 * 1000;

function retireBrowser(oldPromise) {
  if (!oldPromise) return;
  setTimeout(() => {
    Promise.resolve(oldPromise)
      .then((b) => b && b.close().catch(() => {}))
      .catch(() => {});
  }, OLD_BROWSER_GRACE_MS).unref?.();
}

async function launchBrowserOnce() {
  const { chromium, puppeteer } = await loadChromium();
  const executablePath = process.env.CHROME_EXECUTABLE_PATH || (await chromium.executablePath(CHROMIUM_PACK_URL));
  const usingExternalChrome = !!process.env.CHROME_EXECUTABLE_PATH;

  if (!usingExternalChrome) {
    const execDir = path.dirname(executablePath);
    ensureSharedLibsExtracted(execDir);

    // Thư viện .so giải nén ra nằm trong execDir/lib (xem
    // ensureSharedLibsExtracted) — trỏ LD_LIBRARY_PATH vào ĐÚNG thư mục đó,
    // không phải execDir gốc.
    const libDir = path.join(execDir, 'lib');
    process.env.LD_LIBRARY_PATH = process.env.LD_LIBRARY_PATH
      ? `${libDir}:${execDir}:${process.env.LD_LIBRARY_PATH}`
      : `${libDir}:${execDir}`;
  }

  // Chrome thường (CHROME_EXECUTABLE_PATH) không chịu được --single-process/--no-zygote của gói Lambda.
  const baseArgs = usingExternalChrome
    ? chromium.args.filter((a) => !/^--(single-process|no-zygote)$/.test(a))
    : chromium.args;

  return puppeteer.launch({
    args: [
      ...baseArgs,
      '--disable-blink-features=AutomationControlled',
      // FIX (10/09/2026 — lỗi "Navigating frame was detached"): /dev/shm bị
      // giới hạn quá nhỏ trên môi trường container/serverless khiến
      // Chromium crash giữa chừng — cờ này bắt Chromium dùng file tạm trên
      // đĩa thay vì /dev/shm.
      '--disable-dev-shm-usage',
      // Runner Ubuntu 24.04 chặn user namespace không đặc quyền (AppArmor) -> Chrome cần tắt sandbox.
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-gpu'
    ],
    defaultViewport: { width: 1366, height: 768 },
    executablePath,
    headless: chromium.headless ?? true,
    dumpio: process.env.BROWSER_DEBUG === '1' // BROWSER_DEBUG=1: in toàn bộ log stderr của Chrome để chẩn đoán
  });
}

async function launchBrowserWithRetry() {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      // eslint-disable-next-line no-await-in-loop
      return await launchBrowserOnce();
    } catch (error) {
      lastError = error;
      // Chỉ lấy dòng đầu của lỗi (phần crashpad/cpufreq phía sau chỉ là nhiễu vô hại trên runner)
      console.error(`[browserFetch] Mở trình duyệt thất bại (lần ${attempt}/3): ${String(error.message).split('\n')[0]}`);
      // eslint-disable-next-line no-await-in-loop
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
    }
  }
  throw lastError;
}

async function getBrowser() {
  if (browserPromise && Date.now() - browserOpenedAt < BROWSER_MAX_AGE_MS) {
    try {
      const browser = await browserPromise;
      if (browser.isConnected()) return browser;
    } catch {
      // lượt khởi chạy trước lỗi — rơi xuống mở lại bên dưới
    }
  }

  // Trình duyệt cũ (hết hạn / mất kết nối / khởi chạy lỗi): đóng để khỏi rò rỉ tiến trình Chrome.
  // Nếu đã có lượt khác vừa mở lại trong lúc mình đang await ở trên thì dùng luôn lượt đó.
  if (browserPromise && Date.now() - browserOpenedAt < 5000) {
    try {
      const fresh = await browserPromise;
      if (fresh.isConnected()) return fresh;
    } catch {
      // bỏ qua
    }
  }
  const old = browserPromise;
  // Gán ĐỒNG BỘ (trước mọi await) để các lời gọi đồng thời dùng chung đúng 1 lượt khởi chạy.
  browserOpenedAt = Date.now();
  const launching = launchBrowserWithRetry();
  browserPromise = launching;
  launching.catch(() => {
    if (browserPromise === launching) {
      browserPromise = null;
      browserOpenedAt = 0;
    }
  });
  retireBrowser(old);
  return launching;
}

/**
 * Mở 1 trang bằng trình duyệt thật, chờ load xong, trả về HTML cuối cùng
 * (đã chạy JS) — dùng khi chỉ cần đọc DOM render sẵn.
 *
 * @param {string} url
 * @param {{ waitForSelector?: string, timeoutMs?: number, userAgent?: string }} [opts]
 */
async function fetchRenderedHtml(url, opts = {}) {
  const { waitForSelector, timeoutMs = 20000, userAgent } = opts;
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    if (userAgent) await page.setUserAgent(userAgent);
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8' });
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    if (waitForSelector) {
      await page.waitForSelector(waitForSelector, { timeout: timeoutMs }).catch(() => {});
    }
    const html = await page.content();
    return { html, status: response?.status() || 0 };
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * Mở trang và bắt response JSON của 1 (hoặc nhiều) API call khớp
 * `matchUrl` (string con hoặc RegExp) phát sinh trong lúc trang tự load —
 * dùng khi trang gọi API bằng JS (fetch/XHR) mà request thẳng bị site chặn,
 * nhưng nếu để trình duyệt tự gọi (kèm cookie/JS challenge đã qua) thì được.
 *
 * @param {string} url trang để mở
 * @param {string|RegExp} matchUrl phần URL cần bắt response
 * @param {{ timeoutMs?: number, triggerClick?: string, onMatch?: (url: string) => void }} [opts] onMatch: nhận URL thật của API call khớp; triggerClick: selector để click sau khi trang load (một số trang chỉ gọi API khi tương tác)
 * @returns {Promise<any[]>} danh sách JSON body của mọi response khớp
 */
async function fetchApiViaBrowser(url, matchUrl, opts = {}) {
  const { timeoutMs = 20000, triggerClick, onMatch } = opts; // onMatch(url): gọi mỗi khi có response khớp matchUrl (để biết URL API thật mà trang gọi)
  const browser = await getBrowser();
  const page = await browser.newPage();
  const captured = [];
  try {
    page.on('response', async (response) => {
      try {
        const reqUrl = response.url();
        const isMatch = matchUrl instanceof RegExp ? matchUrl.test(reqUrl) : reqUrl.includes(matchUrl);
        if (!isMatch) return;
        if (typeof onMatch === 'function') { try { onMatch(reqUrl); } catch { /* callback lỗi không được làm hỏng việc bắt response */ } }
        const ct = response.headers()['content-type'] || '';
        if (!ct.includes('json')) return;
        captured.push(await response.json());
      } catch {
        // response không parse được thành JSON — bỏ qua, không phải cái cần bắt
      }
    });

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    if (triggerClick) {
      await page.click(triggerClick).catch(() => {});
      await page.waitForNetworkIdle({ idleTime: 800, timeout: timeoutMs }).catch(() => {});
    }
    return captured;
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * Liên tục thử page.evaluate(expr) mỗi `intervalMs` cho tới khi ra kết quả
 * khác rỗng hoặc hết `overallTimeoutMs` — thay vì đoán chính xác lúc nào
 * trang chuyển hướng xong (khó đoán khi Cloudflare có thể tự chuyển trang
 * nhiều lần liên tiếp), cứ bỏ qua MỌI lỗi giữa chừng (kể cả "Execution
 * context was destroyed" do đang chuyển trang) và thử lại đến khi nào được
 * thì thôi, trong giới hạn thời gian cho phép.
 */
async function pollPageEvaluate(page, expr, overallTimeoutMs, intervalMs = 1000) {
  const deadline = Date.now() + overallTimeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const val = await page.evaluate((e) => {
        try {
          // eslint-disable-next-line no-eval
          const v = eval(e);
          return v === undefined ? null : JSON.parse(JSON.stringify(v));
        } catch {
          return null;
        }
      }, expr);
      if (val) return val;
    } catch (error) {
      lastError = error; // context bị huỷ do đang chuyển trang — bỏ qua, thử lại
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  if (lastError) console.error('pollPageEvaluate: hết giờ, lỗi cuối cùng:', lastError.message);
  return null;
}

/**
 * Mở trang bằng trình duyệt thật rồi đọc 1 biến global trên window (sau khi
 * đã hydrate/chạy xong JS của trang) — dùng cho các site Nuxt/Next nhúng
 * sẵn dữ liệu (window.__NUXT__, window.__NEXT_DATA__...) nhưng ở dạng đã
 * mã hoá riêng (devalue...) trong HTML nguồn, rất khó tự parse tay. Nhờ
 * chính trình duyệt (đã tự giải mã xong để chạy app) trả lại giá trị JS
 * THẬT SỰ đã dựng xong, khỏi phải viết lại bộ giải mã đó.
 *
 * @param {string} url
 * @param {{ evalExpr?: string, timeoutMs?: number, userAgent?: string }} [opts]
 */
async function fetchPageGlobal(url, opts = {}) {
  const { evalExpr = 'window.__NUXT__', timeoutMs = 25000, userAgent, autoUserAgent = false, bailOnTitle = null } = opts;
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    if (userAgent) {
      await page.setUserAgent(userAgent);
    } else if (autoUserAgent) {
      // FIX (06/10/2026 — khandaitv "url=about:blank, title=''": trang KHÔNG hề điều hướng được):
      // UA cứng "Chrome/120" lệch với Chromium thật đang chạy (131) -> User-Agent và client hints
      // (sec-ch-ua) mâu thuẫn nhau, Cloudflare dễ cắt kết nối ngay từ đầu nên page.goto lỗi và tab
      // kẹt ở about:blank. Lấy UA THẬT của chính trình duyệt, chỉ bỏ chữ "Headless".
      try {
        const real = await browser.userAgent();
        await page.setUserAgent(String(real).replace(/HeadlessChrome/i, 'Chrome'));
      } catch {
        // không lấy được UA thật thì để mặc định của trình duyệt
      }
    }
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8' });

    let status = 0;
    let gotoError = '';
    const gotoOnce = async (gotoTimeoutMs) => {
      try {
        const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: gotoTimeoutMs });
        status = response?.status() || status;
        gotoError = '';
      } catch (error) {
        // "Execution context was destroyed"/timeout ngay trong lúc goto cũng có thể xảy ra nếu
        // Cloudflare tự chuyển hướng liên tục — vẫn thử đọc dữ liệu ở bước dưới. Nhớ lại lý do
        // để đưa vào chẩn đoán (net::ERR_NAME_NOT_RESOLVED, ERR_CONNECTION_*, timeout...).
        gotoError = error.message;
        console.error('fetchPageGlobal: lỗi lúc goto (bỏ qua, thử đọc tiếp):', error.message);
      }
    };

    // Giới hạn riêng bước goto ngắn hơn tổng thời gian cho phép — phần "chờ Cloudflare tự giải +
    // chuyển hướng" quan trọng hơn nằm ở bước poll ngay dưới, cần nhường phần lớn thời gian cho nó.
    await gotoOnce(Math.min(timeoutMs, 15000));

    // Cloudflare "Just a moment..." có thể tự chuyển hướng NHIỀU LẦN liên tiếp — không đoán chính
    // xác lúc nào xong, cứ thử đọc liên tục cho tới khi ra dữ liệu hoặc hết giờ.
    // FIX (06/10/2026): nếu tab vẫn ở about:blank (goto lỗi/bị cắt kết nối, KHÔNG phải kẹt thách
    // thức) thì poll mãi cũng vô ích -> điều hướng lại (tối đa 2 lần) trong thời gian còn lại.
    // FIX (08/10/2026): domain CHẾT (DNS không phân giải, từ chối kết nối, lỗi chứng chỉ) thì chờ thêm
    // cũng vô ích — bỏ qua bước chờ 28 giây, thất bại ngay để lượt quét chuyển sang domain khác.
    const deadHost = /ERR_NAME_NOT_RESOLVED|ERR_CONNECTION_REFUSED|ERR_CERT_|ERR_ADDRESS_UNREACHABLE|ERR_SSL_/i.test(gotoError);
    const deadline = deadHost ? 0 : Date.now() + timeoutMs;
    let data = null;
    let renav = 0;
    while (!data && Date.now() < deadline) {
      data = await pollPageEvaluate(page, evalExpr, Math.max(1000, Math.min(6000, deadline - Date.now())), 1000);
      if (data) break;
      // Trang đã tải nhưng là trang không liên quan (vd trang cá cược mạo danh) -> không chờ thêm.
      if (bailOnTitle) {
        const title = await page.title().catch(() => '');
        if (title && bailOnTitle.test(title)) break;
      }
      if (page.url() === 'about:blank' && renav < 2 && deadline - Date.now() > 6000) {
        renav += 1;
        console.error(`fetchPageGlobal: tab vẫn ở about:blank — điều hướng lại lần ${renav}`);
        await gotoOnce(Math.min(12000, deadline - Date.now() - 1000));
      }
    }

    // Chẩn đoán rẻ tiền khi không có dữ liệu (không tốn thêm request): còn kẹt Cloudflare? domain
    // chết/không kết nối được? hay trang tải xong nhưng evalExpr sai? `gotoError` cho biết lỗi mạng thật.
    let diagnostic = null;
    if (!data) {
      diagnostic = await page
        .evaluate(() => ({
          title: document.title || '',
          bodySnippet: (document.body?.innerText || '').slice(0, 200),
          finalUrl: location.href
        }))
        .catch(() => null);
      if (!diagnostic) diagnostic = { title: '', bodySnippet: '', finalUrl: page.url() || 'about:blank' };
      diagnostic.gotoError = gotoError;
    }

    return { data, status, diagnostic };
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * Mở 1 trang bằng trình duyệt thật, bắt request ĐẦU TIÊN khớp `matchUrl`
 * phát sinh trong lúc trang tự load (m3u8, XHR...) và trả về ĐÚNG URL +
 * header mà chính trình duyệt đã gửi (Referer, Origin...).
 *
 * Dùng để TỰ DÒ Referer/Origin "chuẩn" mà 1 CDN chống hotlink chấp nhận,
 * thay vì đoán tay/hardcode domain — vì domain player nhúng có thể đổi bất
 * cứ lúc nào (xem FIX 25/09/2026 trong saoke.service.js, ca cụ thể đã gặp:
 * đoán nhầm Referer là domain trang chính thay vì domain player thật).
 *
 * @param {string} url trang để mở (trang chi tiết trận đấu, hoặc trang có nhúng player)
 * @param {string|RegExp} matchUrl phần URL cần bắt (vd: /\.m3u8(\?|$)/i)
 * @param {{ timeoutMs?: number, triggerClick?: string, onMatch?: (url: string) => void }} [opts] onMatch: nhận URL thật của API call khớp; triggerClick: selector để click sau khi trang load (vd nút Play) — xem FIX 25/09/2026 dưới
 * @returns {Promise<{url: string, headers: Record<string,string>}|null>} null nếu hết giờ mà không thấy request nào khớp
 */
async function fetchFirstRequestHeaders(url, matchUrl, opts = {}) {
  const { timeoutMs = 20000, triggerClick } = opts;
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    return await new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        page.off('request', onRequest);
        resolve(value);
      };
      const onRequest = (request) => {
        try {
          const reqUrl = request.url();
          const isMatch = matchUrl instanceof RegExp ? matchUrl.test(reqUrl) : reqUrl.includes(matchUrl);
          if (isMatch) finish({ url: reqUrl, headers: request.headers() });
        } catch {
          // bỏ qua request lỗi khi đọc, chờ request khác khớp
        }
      };
      page.on('request', onRequest);
      page
        .goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs })
        .then(async () => {
          // FIX (25/09/2026 — "mở trang xong nhưng không bắt được request
          // .m3u8 nào" ở Chuối Chiên): nhiều player KHÔNG tự phát ngay khi
          // load trang (chính sách autoplay của trình duyệt chặn), chỉ gọi
          // link .m3u8 SAU KHI người xem bấm Play. Chủ động thử bấm thay
          // người dùng: ưu tiên `triggerClick` (selector cụ thể nếu có),
          // sau đó thử gọi thẳng .play() trên MỌI thẻ <video>/<audio> kể cả
          // trong iframe lồng bên trong (nhiều site nhúng player qua
          // iframe), cuối cùng bấm thử vào giữa màn hình (nút Play dạng
          // ảnh/overlay không phải thẻ <video> thật). Mọi bước đều
          // best-effort, lỗi thì bỏ qua — không có bước nào bắt buộc phải
          // thành công vì trang có thể tự phát sẵn (như Sao Kê) không cần
          // bước này.
          if (triggerClick) await page.click(triggerClick).catch(() => {});
          await page
            .evaluate(() => {
              const tryPlayIn = (doc) => {
                try {
                  doc.querySelectorAll('video, audio').forEach((el) => el.play?.().catch(() => {}));
                } catch {}
              };
              tryPlayIn(document);
              document.querySelectorAll('iframe').forEach((f) => {
                try {
                  tryPlayIn(f.contentDocument);
                } catch {}
              });
            })
            .catch(() => {});
          await page
            .mouse.click(640, 360)
            .catch(() => {});
        })
        .catch(() => {});
      setTimeout(() => finish(null), timeoutMs);
    });
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * Mở trang bằng trình duyệt thật rồi CHỜ (tới `timeoutMs`) cho tới khi trang tự gọi (fetch/XHR) 1 API trả JSON
 * mà predicate(body, url) cho là đúng cái cần lấy. Khác fetchApiViaBrowser (đọc ngay sau khi tải xong khung HTML,
 * thường chưa kịp có API nào): hàm này CHỜ API, KHÔNG phụ thuộc đường dẫn/domain API (chỉ xét hình dạng dữ liệu,
 * nên API đổi domain/đường dẫn vẫn bắt được), và nếu trang không tự gọi thì thử gọi fetch() NGAY TRONG TRANG
 * tới các URL `pageFetchUrls` (cùng Origin/cookie/TLS của Chrome thật — qua được WAF chặn axios).
 *
 * @param {string} url trang để mở
 * @param {(body:any, url:string)=>boolean} predicate nhận ra JSON cần lấy
 * @param {{ timeoutMs?: number, captureWaitMs?: number, pageFetchUrls?: string[], browser?: any }} [opts]
 *   captureWaitMs: chờ tối đa bao lâu cho trang tự gọi API trước khi chuyển sang pageFetchUrls (mặc định 12000)
 * @returns {Promise<{ found: {url:string, body:any}|null, seen: string[], navStatus: number, title: string }>}
 *   seen: các request fetch/XHR trang đã gọi (để chẩn đoán khi không bắt được); title: tiêu đề trang
 *   (vd "Just a moment..." = đang bị Cloudflare chặn)
 */
async function captureJsonViaBrowser(url, predicate, opts = {}) {
  const { timeoutMs = 40000, captureWaitMs = 12000, pageFetchUrls = [] } = opts;
  const browser = opts.browser || (await getBrowser());
  const page = await browser.newPage();
  const seen = [];
  let found = null;
  let navStatus = 0;
  const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    page.on('response', async (response) => {
      try {
        const type = response.request().resourceType();
        if (type !== 'xhr' && type !== 'fetch') return;
        const u = response.url();
        seen.push(`${response.status()} ${u.slice(0, 140)}`);
        if (found) return;
        let body;
        try { body = JSON.parse(await response.text()); } catch { return; }
        if (predicate(body, u)) found = { url: u, body };
      } catch {
        // response không đọc được — bỏ qua
      }
    });

    const startedAt = Date.now();
    try {
      const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
      navStatus = resp?.status() || 0;
    } catch {
      // goto lỗi/timeout (hay gặp khi Cloudflare tự chuyển trang) — vẫn chờ API bên dưới
    }
    const captureDeadline = Math.min(startedAt + timeoutMs, Date.now() + captureWaitMs);
    while (!found && Date.now() < captureDeadline) await sleepMs(400);

    if (!found && pageFetchUrls.length) {
      for (const target of pageFetchUrls) {
        try {
          const r = await page.evaluate(async (t) => {
            const res = await fetch(t, { credentials: 'omit', headers: { Accept: 'application/json' } });
            return { status: res.status, text: await res.text() };
          }, target);
          seen.push(`${r.status} (fetch trong trang) ${String(target).slice(0, 140)}`);
          let body;
          try { body = JSON.parse(r.text); } catch { continue; }
          if (predicate(body, target)) { found = { url: target, body }; break; }
        } catch (e) {
          seen.push(`lỗi fetch trong trang ${String(target).slice(0, 100)}: ${String(e?.message || e).slice(0, 80)}`);
        }
      }
    }
    const title = await page.title().catch(() => '');
    return { found, seen, navStatus, title };
  } finally {
    await page.close().catch(() => {});
  }
}

module.exports = {
  captureJsonViaBrowser,
  fetchRenderedHtml,
  fetchApiViaBrowser,
  fetchPageGlobal,
  fetchFirstRequestHeaders,
  getBrowser,
  ensureSharedLibsExtracted
};
