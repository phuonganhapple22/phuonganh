// Bản KHÔNG CẦN SERVER của scripts/generate-playlists.js — tự quét trực
// tiếp mọi nguồn (gọi thẳng buildAggregatedMatches(), y hệt logic
// /api/playlist đang dùng) NGAY TRONG tiến trình Node đang chạy, không gọi
// HTTP ra bất kỳ trang nào đã deploy (Vercel/Render/VPS) — vì theo yêu cầu
// (20/09/2026): "không deploy VPS nào cả, chỉ up lên GitHub, link playlist
// tổng hợp các nguồn ở trên git".
//
// TRƯỚC ĐÂY (scripts/generate-playlists.js) phải gọi qua HTTP tới 1 trang
// ĐÃ DEPLOY vì 2 lý do (xem chú thích đầu file đó):
//   1) Các service dùng alias "@/..." — chỉ Next.js/webpack hiểu, Node chạy
//      trực tiếp 1 file .js không hiểu alias này.
//   2) 1 số nguồn (Giovang, Khán Đài) cần mở Chromium headless.
// Bản này giải quyết cả 2:
//   1) KHÔNG chạy trực tiếp file .mjs này bằng `node` — phải BUNDLE trước
//      bằng esbuild (đọc alias "@/..." thẳng từ jsconfig.json, đã tự kiểm
//      chứng chạy đúng) ra 1 file .cjs độc lập rồi mới `node` file đó (xem
//      package.json script "generate-playlists:standalone" và bước
//      "Bundle standalone playlist generator" trong
//      .github/workflows/validate-and-generate.yml).
//   2) Cài Chromium thật + trỏ biến CHROME_EXECUTABLE_PATH (xem bước
//      "Install Chromium" trong workflow) — src/utils/browserFetch.js đã
//      tự ưu tiên biến này từ trước (dùng chung với hướng dẫn VPS/Docker,
//      xem DEPLOY_VPS.md), không cần sửa gì thêm ở đó.
//
// FIX (22/09/2026 — "cron phải chạy đều 2 phút/lần liên tục, không giãn
// cách khi ít/không có trận"): TRƯỚC ĐÂY script tự "giãn" chu kỳ làm mới ra
// (x2 mỗi lần, tối đa 2 tiếng) mỗi khi không thấy trận live nào, và các lần
// cron "gõ cửa" trong lúc chưa tới giờ hẹn sẽ bị BỎ QUA (không quét, không
// ghi file gì cả) — xem lịch sử qua git nếu cần đối chiếu logic cũ. Theo
// yêu cầu mới: bỏ hẳn phần giãn/bỏ-qua đó — mọi lần cron gọi tới (đều đặn
// mỗi 2 phút, khớp `.github/workflows/validate-and-generate.yml`) đều CHẠY
// THẬT (generateOnce()) 100%, bất kể đang có bao nhiêu trận live. File
// .refresh-state.json vẫn được ghi lại nhưng CHỈ để log/tham khảo
// (lastRunAt, liveMatchCount) — không còn trường nextCheckAt/intervalMin
// nào được dùng để quyết định bỏ qua lần chạy nữa.

// FIX (20/09/2026 — "utils.forOwn is not a function" khi chạy qua bundle
// esbuild, riêng Khán Đài — nguồn cần trình duyệt headless ngay từ bước lấy
// DANH SÁCH trận): ĐÃ XÁC ĐỊNH ĐƯỢC nguyên nhân — esbuild cố BUNDLE LUÔN cả
// puppeteer-extra-plugin-stealth vào 1 file, nhưng gói này (qua clone-deep)
// dùng `require()` ĐỘNG (tính toán tên module lúc chạy, không tĩnh) mà
// esbuild không phân tích/đóng gói đúng được — tự kiểm chứng: chạy KHÔNG
// qua bundle thì đăng ký plugin bình thường, bundle bằng esbuild thông
// thường thì lỗi ngay ("Cannot find module 'kind-of'" hoặc "utils.forOwn is
// not a function" tuỳ đúng chỗ nào bị đóng gói sai). Cách sửa: KHÔNG bundle
// các gói puppeteer-* + @sparticuz/chromium-min — đánh dấu "--external" cho
// chúng (xem package.json, script "generate-playlists:standalone:build") để
// esbuild chỉ lo phần alias "@/..." (lý do duy nhất cần bundle), còn các gói
// này giữ nguyên `require()` bình thường, tự resolve qua node_modules lúc
// chạy thật (luôn có sẵn vì `npm ci` chạy trước, xem workflow) — đã tự
// kiểm chứng chạy sạch sau khi thêm --external, không còn lỗi.
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { buildAggregatedMatches } from '@/src/services/playlistBuilder.service';
import { filterBySportTab, filterBySource, getSourceKey, getSourceLabel, SOURCE_GROUP_ORDER } from '@/src/utils/playerGet';
import { matchesToPlaylistEntries, buildM3uPlaylist } from '@/src/utils/m3uPlaylist';

// FIX (20/09/2026 — "OUTPUT_DIR sai đường dẫn sau khi bundle"): trước đây
// dùng path.dirname(fileURLToPath(import.meta.url)) để tự dò thư mục chứa
// chính file này (kiểu ESM chuẩn) — CHẠY ĐÚNG lúc còn là file .mjs nguồn,
// nhưng SAI hẳn sau khi esbuild đóng gói ra CJS (--format=cjs, xem
// package.json): "import.meta" KHÔNG tồn tại trong CJS, esbuild tự cảnh
// báo và để giá trị rỗng — fileURLToPath(undefined) ném lỗi ngay khi chạy.
// Dùng process.cwd() thay thế — kịch bản chạy DUY NHẤT của file này là qua
// `npm run generate-playlists:standalone` (xem package.json), luôn thực thi
// từ gốc repo, nên process.cwd() luôn đúng, không phụ thuộc ESM/CJS gì cả.
const __dirname = process.cwd();

// Khớp với SPORT_TABS trong src/utils/playerGet.js (bỏ 'esports' vì cũng bị lọc bỏ ở đó).
const SPORT_TABS = ['all', 'football', 'basketball', 'volleyball', 'badminton', 'tennis', 'f1'];
// Khớp với SOURCE_GROUP_ORDER trong src/utils/playerGet.js.
// FIX (20/09/2026): trước đây tự khai báo lại danh sách nguồn ở đây (dễ
// quên đồng bộ mỗi khi thêm/bớt nguồn, như vừa xảy ra khi loại Pháo Hoa) —
// giờ dùng thẳng SOURCE_GROUP_ORDER đã import từ playerGet.js (nguồn định
// nghĩa DUY NHẤT), chỉ cần sửa 1 chỗ đó khi danh sách nguồn thay đổi.
const SOURCE_KEYS = SOURCE_GROUP_ORDER;

const OUTPUT_DIR = path.join(__dirname, 'public', 'playlists');
const STATE_PATH = path.join(OUTPUT_DIR, '.refresh-state.json');

const BASE_INTERVAL_MIN = 2; // 1 job GitHub Actions "watch" liên tục cách nhau 2 phút/chu kỳ (xem FIX 22/09/2026 bên dưới) — khi chạy `--watch` ở local cũng dùng chu kỳ này.
const WATCH_INTERVAL_MS = BASE_INTERVAL_MIN * 60 * 1000;

// FIX (22/09/2026 — "cần cron chạy đều 2 phút LIÊN TỤC nhưng GitHub Actions
// không cho lịch `schedule` mịn hơn ~5 phút và job tối đa chỉ 6 tiếng"):
// TRƯỚC ĐÂY workflow dùng `schedule: '*/2 * * * *'` gọi 1 job MỚI mỗi 2
// phút, chạy generateOnce() 1 lần rồi thoát — nhưng GitHub KHÔNG đảm bảo
// lịch */2 chạy đúng giờ (hàng đợi runner có thể trễ vài phút, thậm chí bỏ
// lượt khi tải cao). Cách chắc chắn "2 phút liên tục" hơn: dùng 1 job DUY
// NHẤT, tự lặp bên trong bằng `--watch` (đã có sẵn khung này từ trước) —
// mỗi chu kỳ tự generateOnce() + tự commit/push luôn (xem commitAndPush()),
// rồi `sleep` 2 phút, lặp lại — không phụ thuộc runner nhận lịch mới mỗi
// lần. Vì 1 job GitHub Actions có giới hạn cứng 6 tiếng (360 phút), vòng
// lặp tự dừng trước mốc đó (xem MAX_RUNTIME_MS) rồi tự gọi API
// `workflow_dispatch` kích hoạt lại chính workflow này (xem
// triggerSelfRestart()) để có 1 job MỚI tiếp tục ngay, không gián đoạn.
// Lịch `schedule` trong workflow vẫn giữ lại nhưng chỉ còn vai trò DỰ
// PHÒNG (giãn ra vài tiếng/lần) — phòng khi triggerSelfRestart() thất bại
// (hết hạn token, lỗi mạng, v.v.) thì vẫn có người bắt lại, không "chết"
// hẳn dây chuyền.
const MAX_RUNTIME_MIN = Number(process.env.MAX_RUNTIME_MINUTES || 345); // để dư ~15 phút đệm trước giới hạn 360 phút/job của GitHub Actions (cho commit/push + gọi API cuối cùng kịp hoàn tất)
const MAX_RUNTIME_MS = MAX_RUNTIME_MIN * 60 * 1000;

// FIX (06/10/2026 — "Generate Playlists không tự kích hoạt job kế tiếp"): trước đây mốc
// MAX_RUNTIME tính từ lúc SCRIPT bắt đầu, chưa tính vài phút cài đặt của job (npm ci,
// Chromium...) và chỉ kiểm tra SAU KHI một chu kỳ chạy xong (có thể vài phút) -> dễ chạm
// timeout-minutes của job, bị GitHub giết TRƯỚC khi kịp gọi triggerSelfRestart(). Giờ mốc tính
// từ lúc JOB bắt đầu (workflow truyền JOB_STARTED_AT = github.run_started_at) và script dừng sớm
// nếu chu kỳ kế tiếp có nguy cơ vượt mốc. Không có/không hợp lệ thì dùng lúc script bắt đầu như cũ.
const JOB_STARTED_MS = (() => {
  const t = Date.parse(process.env.JOB_STARTED_AT || '');
  const now = Date.now();
  return Number.isFinite(t) && t <= now && now - t < 7 * 3600 * 1000 ? t : null;
})();

// Chỉ bật commit/push tự động bên trong vòng lặp khi chạy trong job GitHub
// Actions thật (workflow tự set biến này ở bước "Generate playlists") —
// tránh việc lỡ tay chạy `--watch` ở máy local rồi tự commit/push nhầm vào
// repo của người dùng.
const AUTO_COMMIT = process.env.GENERATE_AUTO_COMMIT === '1';

// FIX (27/09/2026 — "app IPTV không đọc được header, cần proxy sống"): địa
// chỉ server ĐANG CHẠY SỐNG (Vercel/Render/VPS, có route /api/proxy/hls) —
// để trống thì KHÔNG sinh file "-proxy.m3u" nào cả (đúng model cũ, GitHub-
// only, không giả định có server). Set trong GitHub Secrets (repo >
// Settings > Secrets and variables > Actions), ví dụ:
// PROXY_BASE_URL=https://ten-project-cua-ban.vercel.app
const PROXY_BASE_URL = String(process.env.PROXY_BASE_URL || '').trim();

// FIX (26/09/2026 — lưới an toàn cuối cùng, xem chú thích try/catch trong
// vòng lặp while ở main()): phòng trường hợp cực hiếm 1 lỗi ném ra từ 1
// Promise KHÔNG được await đúng cách (unhandledRejection) hoặc lỗi đồng bộ
// lọt ra ngoài mọi try/catch (uncaughtException) — mặc định Node sẽ crash
// cả tiến trình ngay lập tức. Chỉ LOG rồi cho tiến trình sống tiếp, để
// job không bị dừng oan giữa chừng vì 1 lỗi lẻ tẻ.
process.on('unhandledRejection', (err) => {
  console.error('[generate-playlists] unhandledRejection (đã chặn, không crash job):', err);
});
process.on('uncaughtException', (err) => {
  console.error('[generate-playlists] uncaughtException (đã chặn, không crash job):', err);
});

function isWatchMode() {
  return process.argv.includes('--watch');
}

function ensureGitIdentity() {
  if (!AUTO_COMMIT) return;
  try {
    execSync('git config user.email "actions@github.com"');
    execSync('git config user.name "GitHub Actions"');
  } catch (err) {
    console.warn('[generate-playlists] Không set được git identity:', err.message);
  }
}

// Commit + push ngay sau MỖI chu kỳ (không đợi tới lúc job kết thúc) — đây
// là điểm mấu chốt để "2 phút/lần" là thật: nếu chỉ commit 1 lần lúc job
// thoát (sau ~5h45) thì người xem sẽ chỉ thấy playlist mới mỗi ~6 tiếng chứ
// không phải mỗi 2 phút, dù script vẫn quét đúng chu kỳ bên trong.
//
// FIX (23/09/2026 — "cron chạy 2 phút liên tục nhưng không tạo/cập nhật
// file trên GitHub"): TRƯỚC ĐÂY `git push` gọi thẳng, không hề `pull`/
// `rebase` trước. Nếu CÓ AI (kể cả chính người dùng) sửa/đổi tên file trực
// tiếp trên GitHub trong lúc job vòng-lặp này đang chạy (đã tự xác minh qua
// ảnh chụp thật của người dùng — commit gần nhất là người dùng, không phải
// bot), nhánh local của job liền bị "lùi sau" nhánh `main` trên GitHub ->
// MỌI `git push` kể từ đó bị GitHub từ chối (non-fast-forward / "fetch
// first"). Lỗi đó rơi vào catch() bên dưới -> chỉ log ra, KHÔNG dừng vòng
// lặp -> script vẫn "chạy đều 2 phút/lần" đúng như log thể hiện (không nói
// dối), nhưng không commit/push được gì lên GitHub nữa cho tới khi job này
// tự thoát (tối đa 5h45) và job kế tiếp checkout lại từ đầu — nhìn từ ngoài
// giống như "cron chết" dù thực ra nó vẫn sống, chỉ là bị khoá cứng khỏi
// remote. SỬA: fetch + rebase lên `origin/<branch>` mới nhất TRƯỚC khi
// push mỗi chu kỳ. Nếu rebase bị conflict thật (hiếm — chỉ xảy ra khi có
// người sửa tay ĐÚNG file bot đang ghi), huỷ rebase và đồng bộ cứng theo
// `origin` (`reset --hard`) — chấp nhận mất đúng 1 chu kỳ (2 phút) thay vì
// kẹt cứng nhiều giờ; chu kỳ kế tiếp sẽ tự sinh lại nội dung mới và commit
// bình thường trên nền đã đồng bộ.
function commitAndPush() {
  if (!AUTO_COMMIT) return;
  try {
    execSync('git add public/playlists/', { stdio: 'inherit' });
    const hasChanges = execSync('git status --porcelain -- public/playlists/').toString().trim().length > 0;
    if (!hasChanges) {
      console.log('[generate-playlists] Không có thay đổi mới — bỏ qua commit chu kỳ này.');
      return;
    }
    execSync('git commit -m "Generate playlists (auto, watch loop)"', { stdio: 'inherit' });
  } catch (err) {
    console.error('[generate-playlists] Lỗi khi commit:', err.message);
    return;
  }

  try {
    execSync('git push', { stdio: 'inherit' });
    console.log('[generate-playlists] Đã commit & push playlist mới.');
    return;
  } catch (err) {
    console.warn(
      '[generate-playlists] Push bị từ chối (nhánh local lùi sau remote — có thay đổi mới trên GitHub) — ' +
      'thử fetch + rebase rồi push lại:', err.message
    );
  }

  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD').toString().trim();
    execSync('git fetch origin', { stdio: 'inherit' });
    try {
      execSync(`git rebase origin/${branch}`, { stdio: 'inherit' });
    } catch (rebaseErr) {
      console.warn(
        '[generate-playlists] Rebase bị conflict thật (có ai sửa tay đúng file bot đang ghi) — ' +
        'huỷ rebase, đồng bộ cứng theo bản mới nhất trên GitHub, bỏ qua commit chu kỳ này:', rebaseErr.message
      );
      try {
        execSync('git rebase --abort', { stdio: 'inherit' });
      } catch {
        // rebase có thể đã tự huỷ một phần — bỏ qua, reset --hard bên dưới vẫn đưa nhánh về trạng thái sạch.
      }
      execSync(`git reset --hard origin/${branch}`, { stdio: 'inherit' });
      console.log('[generate-playlists] Đã đồng bộ lại theo GitHub — chu kỳ sau sẽ tự sinh & commit lại từ đầu.');
      return;
    }
    execSync('git push', { stdio: 'inherit' });
    console.log('[generate-playlists] Đã rebase + commit & push playlist mới.');
  } catch (err) {
    console.error(
      '[generate-playlists] Vẫn lỗi khi fetch/rebase/push — bỏ qua chu kỳ này, thử lại ở chu kỳ kế tiếp (2 phút sau):',
      err.message
    );
  }
}

// Tự gọi REST API của GitHub để kích hoạt lại CHÍNH workflow này
// (workflow_dispatch) ngay trước khi job hiện tại thoát vì sắp chạm giới
// hạn 6 tiếng — nhờ vậy job kế tiếp bắt đầu gần như ngay lập tức, không
// phải chờ tới lượt `schedule` dự phòng (vốn đã giãn ra vài tiếng/lần).
// Dùng thẳng GITHUB_TOKEN mặc định của job (secrets.GITHUB_TOKEN, workflow
// đã truyền vào qua biến môi trường) — token này ĐƯỢC PHÉP kích hoạt
// workflow_dispatch/repository_dispatch dù các sự kiện khác (push,...) do
// chính GITHUB_TOKEN tạo ra thường bị GitHub chặn không cho khởi chạy
// workflow mới (chống đệ quy vô hạn) — 2 loại sự kiện dispatch này là
// ngoại lệ được GitHub tài liệu hoá rõ, nên không cần Personal Access
// Token riêng.
async function triggerSelfRestart() {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY; // dạng "owner/repo", GitHub tự tiêm sẵn
  const ref = process.env.GITHUB_REF_NAME || 'main';
  const workflowFile = 'validate-and-generate.yml';

  if (!token || !repo) {
    console.warn(
      '[generate-playlists] Thiếu GITHUB_TOKEN/GITHUB_REPOSITORY (không chạy trong GitHub Actions?) — ' +
      'bỏ qua bước tự kích hoạt lại, đành chờ lịch schedule dự phòng bắt lại.'
    );
    return false;
  }

  // FIX (06/10/2026): thử lại tối đa 4 lần (lỗi mạng / 5xx / 429) thay vì bỏ cuộc ngay lần đầu.
  // Lỗi 4xx khác (401/403/404/422: sai quyền, sai tên workflow, thiếu workflow_dispatch) thử lại
  // cũng vô ích -> dừng ngay và in rõ nguyên nhân. Nếu vẫn thất bại: lịch dự phòng 6 tiếng/lần của
  // Generate sẽ bật lại (hoặc bạn bấm chạy tay Watch SOURCE_DOMAINS — bước "Canh chừng").
  const delays = [0, 4000, 10000, 20000];
  for (let attempt = 0; attempt < delays.length; attempt++) {
    if (delays[attempt]) await new Promise((r) => setTimeout(r, delays[attempt]));
    try {
      const res = await fetch(
        `https://api.github.com/repos/${repo}/actions/workflows/${workflowFile}/dispatches`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
          },
          body: JSON.stringify({ ref }),
        }
      );

      if (res.ok || res.status === 204) {
        console.log(`[generate-playlists] Đã tự gọi API kích hoạt job kế tiếp (lần thử ${attempt + 1}) — sẽ tiếp tục ngay, không chờ schedule dự phòng.`);
        return true;
      }
      const body = await res.text();
      console.error(`[generate-playlists] Gọi API tự kích hoạt lại thất bại (HTTP ${res.status}, lần ${attempt + 1}/${delays.length}): ${body}`);
      if (res.status >= 400 && res.status < 500 && res.status !== 429) break;
    } catch (err) {
      console.error(`[generate-playlists] Lỗi khi gọi API tự kích hoạt lại (lần ${attempt + 1}/${delays.length}):`, err.message);
    }
  }
  console.error('[generate-playlists] KHÔNG tự kích hoạt lại được — lịch dự phòng 6 tiếng/lần sẽ bắt lại (hoặc bấm chạy tay Watch SOURCE_DOMAINS).');
  return false;
}

// FIX (06/10/2026 — "deploy file đè lên git (có thay đổi file) mà generate-playlists bị kẹt, không tự
// chạy lượt mới"): việc chạy lại sau khi push hoàn toàn phụ thuộc sự kiện `push` của GitHub huỷ run
// cũ + tạo run mới. Nếu sự kiện đó không tới (nhánh khác `main`, run mới bị xếp hàng/huỷ nhầm, chỉ đổi
// file nằm trong paths-ignore...) thì job cũ cứ chạy mãi với code CŨ — nhìn từ ngoài là "kẹt". Lưới an
// toàn nằm NGAY TRONG vòng lặp: mỗi ~30 giây `git fetch` rồi so commit mà job này bắt đầu (START_SHA) với
// origin; có file nào ngoài public/playlists/ và các file domain do bot ghi bị thay đổi thì TỰ GỌI
// workflow_dispatch chạy lại (run mới huỷ run này nhờ cancel-in-progress và checkout code mới).
// Dùng START_SHA chứ không dùng HEAD vì commitAndPush() có thể rebase HEAD lên origin giữa chừng.
const UPSTREAM_CHECK_EVERY_MS = 30 * 1000;
const BOT_ONLY_PATHS = [':!public/playlists', ':!data/source-domains.txt', ':!data/source-domains.json', ':!data/source-domains.hash'];
let startSha = '';

function captureStartSha() {
  if (!AUTO_COMMIT) return;
  try {
    startSha = execSync('git rev-parse HEAD').toString().trim();
  } catch (err) {
    console.warn('[generate-playlists] Không đọc được commit đang chạy — tắt kiểm tra thay đổi trên GitHub:', err.message);
  }
}

// FIX (09/10/2026 — "kiểm tra tài nguyên GitHub mỗi lần bị ép chạy lại"): bản cũ có 2 điểm tốn:
//  (1) mỗi 30 giây chạy `git fetch origin` (~120 lần/giờ, ~670 lần/job) — kể cả khi chẳng có gì mới.
//      Giờ chỉ dùng `git ls-remote` (chỉ hỏi sha đầu nhánh, không tải object); CHỈ khi sha remote
//      KHÁC với HEAD local mới `git fetch`. Khi remote == HEAD (chính bot vừa push, trường hợp
//      thường gặp mỗi chu kỳ) thì so sánh hoàn toàn local, không chạm mạng thêm.
//  (2) chạy lại NGAY khi thấy file đổi, trong khi sự kiện `push` của workflow cũng đang huỷ job này
//      + tạo run mới -> 2 đường cùng bắn: job ở đường kia bị huỷ ngay sau khi vừa cài xong
//      (apt + npm ci + Chrome ~3-5 phút phí). Giờ phải thấy CÙNG 1 tập file đổi liên tục
//      ≥ UPSTREAM_RESTART_GRACE_MS (90s) mà job này vẫn còn sống (= sự kiện push KHÔNG huỷ được nó)
//      mới tự gọi chạy lại — vẫn là lưới an toàn, chỉ không còn tranh với đường chính.
const UPSTREAM_RESTART_GRACE_MS = 90 * 1000;
let pendingUpstreamChange = null; // { sig, since }

let autoRerunOffLogged = false;
function isAutoRerunOn(ref) {
  try {
    const v = execSync(`git show ${ref}:data/auto-rerun.txt`, { stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000 }).toString().trim().toLowerCase();
    return !['off', '0', 'false', 'no'].includes(v);
  } catch {
    return true; // không có file -> mặc định bật
  }
}

/** @returns {string[]} danh sách file đã đổi trên origin kể từ lúc job bắt đầu (rỗng nếu không có/không kiểm tra được) */
function detectUpstreamChanges() {
  if (!AUTO_COMMIT || !startSha) return [];
  try {
    const branch = process.env.GITHUB_REF_NAME || execSync('git rev-parse --abbrev-ref HEAD').toString().trim();
    const remoteLine = execSync(`git ls-remote origin refs/heads/${branch}`, { timeout: 20000 }).toString().trim();
    const remoteSha = remoteLine.split(/\s+/)[0] || '';
    if (!remoteSha) return [];
    const localHead = execSync('git rev-parse HEAD').toString().trim();
    let target = 'HEAD';
    if (remoteSha !== localHead) {
      // Có commit lạ trên remote (người dùng/workflow khác) -> mới cần tải về để so sánh.
      execSync(`git fetch --quiet origin ${branch}`, { stdio: 'ignore', timeout: 25000 });
      target = `origin/${branch}`;
    }
    // CÔNG TẮC (09/10/2026): data/auto-rerun.txt = "off" -> không tự chạy lại khi file đổi (đọc bản mới nhất trên remote).
    if (!isAutoRerunOn(target)) {
      if (!autoRerunOffLogged) console.log('[generate-playlists] Công tắc data/auto-rerun.txt = off — không tự chạy lại khi file đổi (đổi thành on để chạy lại).');
      autoRerunOffLogged = true;
      return [];
    }
    autoRerunOffLogged = false;
    const out = execSync(`git diff --name-only ${startSha} ${target} -- . ${BOT_ONLY_PATHS.map((p) => `'${p}'`).join(' ')}`, { timeout: 15000 }).toString();
    return out.split('\n').map((l) => l.trim()).filter(Boolean);
  } catch (err) {
    console.warn('[generate-playlists] Không kiểm tra được thay đổi trên GitHub (bỏ qua lượt này):', err.message);
    return [];
  }
}

let lastUpstreamRestartAttemptAt = 0;

/** @returns {Promise<boolean>} true nếu đã gọi chạy lại thành công (run mới sẽ huỷ run này) */
async function restartIfUpstreamChanged() {
  const changed = detectUpstreamChanges();
  if (!changed.length) {
    pendingUpstreamChange = null;
    return false;
  }
  const now = Date.now();
  const sig = changed.join('|');
  if (!pendingUpstreamChange || pendingUpstreamChange.sig !== sig) {
    pendingUpstreamChange = { sig, since: now };
    console.log(
      `[generate-playlists] Thấy ${changed.length} file đổi trên GitHub (${changed.slice(0, 5).join(', ')}${changed.length > 5 ? ', ...' : ''}) — ` +
      `chờ ${Math.round(UPSTREAM_RESTART_GRACE_MS / 1000)}s xem sự kiện push có tự huỷ/chạy lại job này không, nếu không mới tự gọi chạy lại.`
    );
    return false;
  }
  if (now - pendingUpstreamChange.since < UPSTREAM_RESTART_GRACE_MS) return false;
  if (now - lastUpstreamRestartAttemptAt < 2 * 60 * 1000) return false; // vừa thử gần đây, chờ rồi thử lại
  lastUpstreamRestartAttemptAt = now;
  console.log(
    `[generate-playlists] ${changed.length} file đã đổi trên GitHub kể từ lúc job bắt đầu ` +
    `(${changed.slice(0, 5).join(', ')}${changed.length > 5 ? ', ...' : ''}) mà job này chưa bị huỷ — tự chạy lại để dùng code/cấu hình mới.`
  );
  return await triggerSelfRestart();
}

// Nghỉ `totalMs` nhưng cứ ~30 giây lại kiểm tra thay đổi trên GitHub; trả true nếu đã kích hoạt chạy lại.
async function sleepWatchingUpstream(totalMs) {
  const end = Date.now() + totalMs;
  while (Date.now() < end) {
    const slice = Math.min(UPSTREAM_CHECK_EVERY_MS, end - Date.now());
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, slice));
    // eslint-disable-next-line no-await-in-loop
    if (await restartIfUpstreamChanged()) return true;
  }
  return false;
}

function writeState(state) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n', 'utf8');
}

// FIX (20/09/2026 — "cần debug để phát hiện từng nguồn lỗi"): trước đây
// muốn biết nguồn nào đang lỗi/trả về 0 trận phải tự đọc lẫn trong hàng
// chục dòng log lỗi rải rác (mỗi nguồn tự console.error theo kiểu riêng,
// xem các file src/services/*.service.js) — không có chỗ nào tổng kết lại
// "nguồn nào ra bao nhiêu trận" ở 1 chỗ. Hàm này in ra 1 bảng tổng kết ngay
// sau mỗi lần quét — CHỈ đọc lại kết quả trận đã có (không tự đoán lý do
// lỗi, vì lý do thật đã in chi tiết ở các dòng log phía trên rồi, xem lại
// đó để biết chính xác lỗi gì) — mục đích là chỉ thẳng NGUỒN NÀO cần xem
// log kỹ hơn, đỡ phải dò cả log dài. Khi chạy trong GitHub Actions
// (GITHUB_STEP_SUMMARY có sẵn, biến do chính GitHub tự tiêm vào, không cần
// khai báo gì thêm), in luôn ra dạng bảng markdown, hiện thẳng ngay trên
// trang tóm tắt của lượt chạy đó, khỏi cần mở log ra tìm.
let lastSummarySig = '';
function logSourceSummary(matches) {
  const counts = Object.fromEntries(SOURCE_GROUP_ORDER.map((key) => [key, 0]));
  for (const match of matches) {
    const key = getSourceKey(match);
    if (key in counts) counts[key] += 1;
  }

  console.log('[generate-playlists] Tổng kết theo nguồn:');
  const rows = SOURCE_GROUP_ORDER.map((key) => {
    const count = counts[key];
    const label = getSourceLabel(key);
    const flag = count > 0 ? '' : '  ⚠️  0 trận — xem log lỗi phía trên (nếu có) để biết vì sao';
    console.log(`  - ${label} (${key}): ${count} trận${flag}`);
    return { key, label, count };
  });

  // FIX (09/10/2026): trước đây ghi thêm 1 bảng vào Step Summary MỖI chu kỳ 2 phút (~170 bảng/job,
  // giới hạn 1MiB/step, phình log vô ích). Giờ chỉ ghi lần đầu và khi số trận theo nguồn thay đổi.
  const sig = rows.map((r) => r.count).join(',');
  const summaryPath = sig === lastSummarySig ? '' : process.env.GITHUB_STEP_SUMMARY;
  lastSummarySig = sig;
  if (summaryPath) {
    const lines = [
      '### Tổng kết theo nguồn',
      '',
      '| Nguồn | Số trận |',
      '| --- | --- |',
      ...rows.map((r) => `| ${r.label} (\`${r.key}\`) | ${r.count > 0 ? r.count : '⚠️ 0'} |`),
      ''
    ];
    try {
      fs.appendFileSync(summaryPath, lines.join('\n') + '\n');
    } catch (err) {
      console.warn('[generate-playlists] Không ghi được GITHUB_STEP_SUMMARY:', err.message);
    }
  }
}

// FIX (22/09/2026 — "all.m3u không tự đổi theo cron 2 phút/lần"): nguyên
// nhân là buildM3uPlaylist() CỐ Ý không in số phút thi đấu vào tên kênh
// (xem getLiveBadge() trong playerGet.js — tránh phá thứ tự sort theo tên),
// nên khi giữa 2 lần quét (2 phút) không có trận nào lên live/kết
// thúc/đổi giờ, nội dung .m3u ra Y HỆT lần trước — commitAndPush() ở dưới
// chỉ commit khi `git status` thấy khác, nên KHÔNG commit gì cả -> nhìn
// giống như file "đứng yên", dễ hiểu lầm là cron chết. Chèn 1 dòng comment
// giờ-quét-gần-nhất (giờ VN) ngay sau "#EXTM3U" — dòng bắt đầu bằng "#" nên
// mọi player IPTV (VLC/TiviMate/...) đều tự bỏ qua khi parse, không ảnh
// hưởng phát sóng — nhưng khiến nội dung file LUÔN khác giữa 2 lần chạy,
// nên git LUÔN có gì để commit, phản ánh đúng thật là cron 2 phút vẫn chạy.
function stampGeneratedAt(content) {
  const vnTime = new Date().toLocaleString('vi-VN', {
    timeZone: 'Asia/Ho_Chi_Minh',
    hour12: false
  });
  const stamp = `# Cập nhật lần cuối: ${vnTime} (giờ VN) — tự làm mới mỗi 2 phút`;
  return content.replace(/^#EXTM3U\n/, `#EXTM3U\n${stamp}\n`);
}

// FIX (06/10/2026 — "generate-playlists không lưu file trong 2-3 phút, hàng chục phút mới lưu"):
// buildAggregatedMatches() không có giới hạn thời gian tổng — chỉ cần vài nguồn/trận chậm (trình
// duyệt headless, CDN không phản hồi) là 1 chu kỳ kéo dài hàng chục phút, và commit chỉ diễn ra
// SAU khi cả chu kỳ xong. Giờ: quá SCAN_DEADLINE_SECONDS (mặc định 150s) mà quét chưa xong thì
// dùng kết quả quét THÀNH CÔNG gần nhất để vẫn ghi + commit playlist đúng hạn; lượt quét chậm
// tiếp tục chạy ngầm và chu kỳ sau DÙNG LẠI chính lượt đó (không mở thêm lượt quét chồng lên).
// Chưa có kết quả nào trước đó (chu kỳ đầu tiên) thì buộc phải chờ lượt quét xong.
const SCAN_DEADLINE_MS = (Number(process.env.SCAN_DEADLINE_SECONDS) > 0 ? Number(process.env.SCAN_DEADLINE_SECONDS) : 150) * 1000;
let inflightScan = null;
let lastScanMatches = null;

async function scanWithDeadline() {
  if (!inflightScan) {
    const scan = buildAggregatedMatches().then((m) => {
      lastScanMatches = m;
      return m;
    });
    inflightScan = scan;
    const clear = () => { if (inflightScan === scan) inflightScan = null; };
    scan.then(clear, clear);
  } else {
    console.warn('[generate-playlists] Lượt quét trước còn đang chạy — dùng lại, không mở lượt mới chồng lên.');
  }
  const scan = inflightScan;
  const TIMED_OUT = Symbol('scan-timeout');
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(TIMED_OUT), SCAN_DEADLINE_MS); });
  const startedAt = Date.now();
  try {
    const res = await Promise.race([scan, timeout]);
    if (res !== TIMED_OUT) return res;
    if (lastScanMatches) {
      console.warn(
        `[generate-playlists] Quét quá ${Math.round(SCAN_DEADLINE_MS / 1000)}s chưa xong — dùng kết quả quét tốt gần nhất ` +
        `(${lastScanMatches.length} trận) để ghi + commit đúng hạn; lượt quét chậm vẫn chạy ngầm.`
      );
      return lastScanMatches;
    }
    console.warn('[generate-playlists] Quét quá hạn nhưng chưa có kết quả nào trước đó — buộc phải chờ lượt quét xong.');
    return await scan;
  } finally {
    clearTimeout(timer);
    const took = Math.round((Date.now() - startedAt) / 1000);
    if (took > 60) console.warn(`[generate-playlists] Bước quét nguồn mất ${took}s (chậm).`);
  }
}

/** @returns {Promise<{ ok: boolean, liveMatchCount: number }>} */
async function generateOnce() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  console.log('[generate-playlists] Đang tự quét toàn bộ nguồn (không qua server nào)...');
  const matches = await scanWithDeadline(); // 1 lần quét DUY NHẤT, tái dùng cho mọi file bên dưới — tránh quét lại nhiều lần gây chậm/dội nguồn.
  console.log(`[generate-playlists] Quét xong — ${matches.length} trận (live + sắp đấu trong 24h).`);

  logSourceSummary(matches);

  let hasError = false;
  let liveMatchCount = 0;

  for (const sport of SPORT_TABS) {
    try {
      const bySport = filterBySportTab(matches, sport);
      const entries = await matchesToPlaylistEntries(bySport, { baseUrl: '' }); // baseUrl rỗng — không có server để trỏ link resolver, xem FIX 20/09/2026 trong m3uPlaylist.js
      const content = stampGeneratedAt(buildM3uPlaylist(entries)); // FIX 22/09/2026 — xem stampGeneratedAt() phía trên
      const filename = `${sport}.m3u`;
      fs.writeFileSync(path.join(OUTPUT_DIR, filename), content, 'utf8');
      const matchCount = (content.match(/^#EXTINF/gm) || []).length;
      if (sport === 'all') liveMatchCount = bySport.filter((m) => m?.status?.isLive).length;
      console.log(`[generate-playlists] ${filename}: ${matchCount} kênh`);

      // FIX (26/09/2026 — "VLC xem được, app IPTV điện thoại không xem
      // được"): xem chú thích format 'app' trong buildM3uPlaylist()
      // (m3uPlaylist.js) — sinh thêm bản "-app.m3u" dùng cú pháp header
      // "|Referer=...&User-Agent=..." cho app IPTV Android (ExoPlayer).
      // Dùng LẠI `entries` vừa tính ở trên (không quét/dò lại gì thêm).
      const appContent = stampGeneratedAt(buildM3uPlaylist(entries, { format: 'app' }));
      const appFilename = `${sport}-app.m3u`;
      fs.writeFileSync(path.join(OUTPUT_DIR, appFilename), appContent, 'utf8');
      console.log(`[generate-playlists] ${appFilename}: ${(appContent.match(/^#EXTINF/gm) || []).length} kênh`);

      // FIX (27/09/2026 — xem chú thích PROXY_BASE_URL phía trên): chỉ sinh
      // khi đã khai báo địa chỉ server sống, đúng model cũ khi để trống.
      if (PROXY_BASE_URL) {
        const proxyContent = stampGeneratedAt(buildM3uPlaylist(entries, { format: 'proxy', baseUrl: PROXY_BASE_URL }));
        const proxyFilename = `${sport}-proxy.m3u`;
        fs.writeFileSync(path.join(OUTPUT_DIR, proxyFilename), proxyContent, 'utf8');
        console.log(`[generate-playlists] ${proxyFilename}: ${(proxyContent.match(/^#EXTINF/gm) || []).length} kênh`);
      }
    } catch (err) {
      hasError = true;
      console.error(`[generate-playlists] Lỗi khi tạo playlist "${sport}":`, err.message);
    }
  }

  const allSports = filterBySportTab(matches, 'all');
  for (const source of SOURCE_KEYS) {
    try {
      const bySource = filterBySource(allSports, source);
      const entries = await matchesToPlaylistEntries(bySource, { baseUrl: '' });
      const content = stampGeneratedAt(buildM3uPlaylist(entries)); // FIX 22/09/2026 — xem stampGeneratedAt() phía trên
      const filename = `source-${source}.m3u`;
      fs.writeFileSync(path.join(OUTPUT_DIR, filename), content, 'utf8');
      const matchCount = (content.match(/^#EXTINF/gm) || []).length;
      console.log(`[generate-playlists] ${filename}: ${matchCount} kênh`);

      // FIX (26/09/2026): xem chú thích tương ứng ở vòng lặp SPORT_TABS phía trên.
      const appContent = stampGeneratedAt(buildM3uPlaylist(entries, { format: 'app' }));
      const appFilename = `source-${source}-app.m3u`;
      fs.writeFileSync(path.join(OUTPUT_DIR, appFilename), appContent, 'utf8');
      console.log(`[generate-playlists] ${appFilename}: ${(appContent.match(/^#EXTINF/gm) || []).length} kênh`);

      // FIX (27/09/2026 — xem chú thích PROXY_BASE_URL phía trên).
      if (PROXY_BASE_URL) {
        const proxyContent = stampGeneratedAt(buildM3uPlaylist(entries, { format: 'proxy', baseUrl: PROXY_BASE_URL }));
        const proxyFilename = `source-${source}-proxy.m3u`;
        fs.writeFileSync(path.join(OUTPUT_DIR, proxyFilename), proxyContent, 'utf8');
        console.log(`[generate-playlists] ${proxyFilename}: ${(proxyContent.match(/^#EXTINF/gm) || []).length} kênh`);
      }

      // FIX (25/09/2026 — "muốn proxy sống (hls.js) cũng hưởng Referer tự
      // dò" + "không deploy VPS/Vercel nào cả, chỉ lên GitHub"): LÚC ĐẦU
      // đoạn này được thêm nhầm vào scripts/generate-playlists.js (bản CŨ,
      // gọi qua HTTP tới server đã deploy) — nhưng theo đúng mô hình thật
      // của repo này (xem chú thích đầu file .mjs này + FIX 20/09/2026
      // trong .github/workflows/validate-and-generate.yml), KHÔNG CÓ server
      // nào chạy sống cả, script generate-playlists.js đó không còn được
      // workflow gọi tới nữa — mọi thứ chạy NGAY TRONG tiến trình Node của
      // CHÍNH file .mjs này (gọi thẳng buildAggregatedMatches() ở trên).
      // Chuyển đúng đoạn ghi <nguồn>-referer.json vào đây.
      //
      // Vì hls.js (proxy sống) không có server nào để chạy trong mô hình
      // này, file JSON này hiện KHÔNG có tác dụng thực tế nào (hls.js không
      // được deploy ở đâu để đọc nó) — chỉ còn ý nghĩa nếu sau này bạn có
      // deploy hls.js lên 1 server thật (VPS/Vercel/Render). Vẫn ghi lại vì
      // rẻ (không tốn thêm lần quét nào, chỉ đọc lại chuỗi content đã có
      // sẵn) và vô hại nếu không dùng tới.
      // FIX (27/09/2026 — "thiếu bonglau-referer.json"): bonglau.service.js
      // cũng TỰ DÒ Referer riêng bằng trình duyệt headless y hệt saoke/
      // chuoichientv (xem detectPlayerReferer() trong file đó) nhưng trước
      // đây bị bỏ sót khỏi danh sách ghi file JSON này -> route proxy sống
      // (pages/api/proxy/hls.js, hàm readDetectedReferer()) không bao giờ
      // đọc được Referer tự dò của BongLau, chỉ dùng được danh sách ứng
      // viên hardcode (kém tin cậy hơn).
      if (source === 'saoke' || source === 'chuoichientv' || source === 'bonglau') {
        // FIX (27/09/2026 — "proxy.m3u nhiều nguồn không xem được, riêng Gà
        // Vàng vẫn được"): TRƯỚC ĐÂY chỉ lấy referer của TRẬN ĐẦU TIÊN tìm
        // thấy trong file (.match() không có cờ "g") rồi ghi DUY NHẤT giá trị
        // đó vào JSON — nhưng các nguồn này (đặc biệt Chuối Chiên/Bông Lau)
        // đi qua wrapper domain NGẪU NHIÊN theo từng phiên/từng trận (xem
        // chú thích REFERER_CANDIDATES_BY_SOURCE trong pages/api/proxy/hls.js
        // và src/utils/m3uPlaylist.js) — referer đúng của trận A rất có thể
        // KHÔNG phải referer đúng của trận B, dù cùng ghi vào 1 file nguồn.
        // Ghi 1 giá trị duy nhất khiến /api/proxy/hls (readDetectedReferer())
        // áp NHẦM referer của trận khác lên MỌI trận của nguồn đó — đúng
        // triệu chứng "1 số trận/nguồn phát được, phần lớn còn lại lỗi".
        // Sửa: lấy TOÀN BỘ referer THẬT đã dò được (mỗi trận có thể khác
        // nhau) trong file, bỏ trùng, ghi thành mảng "referers" — phía đọc
        // (pages/api/proxy/hls.js) thử LẦN LƯỢT từng giá trị thật này trước
        // khi rơi về danh sách đoán tĩnh, tăng đáng kể cơ hội trúng đúng
        // referer của CHÍNH trận đang phát. Vẫn giữ trường "referer" (giá trị
        // đầu tiên) để tương thích ngược nếu có chỗ nào khác lỡ đọc field cũ.
        const refererMatches = [...content.matchAll(/^#EXTVLCOPT:http-referrer=(.+)$/gm)]
          .map((m) => m[1].trim())
          .filter(Boolean);
        const referers = [...new Set(refererMatches)];
        const jsonFilename = `${source}-referer.json`;
        if (referers.length) {
          fs.writeFileSync(
            path.join(OUTPUT_DIR, jsonFilename),
            JSON.stringify({ referer: referers[0], referers, detectedAt: new Date().toISOString() }, null, 2) + '\n',
            'utf8'
          );
          console.log(`[generate-playlists] ${jsonFilename}: ${referers.length} referer khác nhau (${referers.join(', ')})`);
        } else {
          console.log(`[generate-playlists] ${jsonFilename}: không có trận live lúc này, giữ nguyên giá trị cũ`);
        }
      }
    } catch (err) {
      hasError = true;
      console.error(`[generate-playlists] Lỗi khi tạo playlist nguồn "${source}":`, err.message);
    }
  }

  return { ok: !hasError, liveMatchCount };
}

async function runCycle() {
  const now = Date.now();

  const { ok, liveMatchCount } = await generateOnce();

  // Chỉ ghi lại để log/tham khảo — không còn nextCheckAt/intervalMin nào
  // được đọc lại để quyết định bỏ qua lần chạy kế tiếp (xem FIX 22/09/2026
  // ở đầu file).
  writeState({
    lastRunAt: new Date(now).toISOString(),
    liveMatchCount,
  });

  commitAndPush(); // commit/push NGAY sau chu kỳ này, không đợi job kết thúc — xem giải thích ở AUTO_COMMIT phía trên.

  console.log(
    `[generate-playlists] Hoàn tất — ${liveMatchCount} trận live. ` +
    `Chu kỳ kế tiếp bắt đầu cách chu kỳ này ~${BASE_INTERVAL_MIN} phút (nhịp cố định).`
  );

  return ok;
}

async function main() {
  if (isWatchMode()) {
    ensureGitIdentity();
    captureStartSha();
    const startedAt = JOB_STARTED_MS || Date.now();
    console.log(
      `[generate-playlists] Chế độ watch — chạy đều mỗi ${WATCH_INTERVAL_MS / 60000} phút, liên tục, không giãn cách. ` +
      `Tự dừng sau tối đa ${MAX_RUNTIME_MIN} phút/job rồi tự kích hoạt job kế tiếp. Ctrl+C để dừng khi chạy local.`
    );
    // eslint-disable-next-line no-constant-condition
    while (true) {
      // FIX (26/09/2026 — "chạy hết 1 chu kỳ thì dừng hẳn, không tự chạy
      // chu kỳ mới"): trước đây KHÔNG có try/catch nào bọc quanh
      // runCycle()/buildAggregatedMatches() ở đây — chỉ cần 1 lần lỗi
      // mạng/parse bất ngờ (không phải lỗi trong từng vòng for đã có
      // try/catch riêng ở generateOnce(), mà là lỗi ngay từ chính bước
      // buildAggregatedMatches() gộp dữ liệu) là ném exception CHƯA BẮT lên
      // tới đây, làm literally crash cả tiến trình Node -> GitHub Actions
      // coi cả JOB là thất bại -> dừng hẳn, không bao giờ chạm tới nhánh
      // triggerSelfRestart() lẫn vòng lặp kế tiếp. Bọc try/catch NGAY VÒNG
      // LẶP để 1 chu kỳ lỗi chỉ bị bỏ qua (giống hệt cách runCycle() đã tự
      // bảo vệ commitAndPush()), tiến trình vẫn sống tiếp tới chu kỳ sau.
      const cycleStartedAt = Date.now();
      try {
        await runCycle();
      } catch (err) {
        console.error(
          '[generate-playlists] Lỗi KHÔNG lường trước ở cả chu kỳ (không phải lỗi riêng 1 nguồn) — ' +
          'bỏ qua, thử lại ở chu kỳ kế tiếp (2 phút sau), KHÔNG dừng job:',
          err && err.stack ? err.stack : err
        );
      }

      const elapsedMs = Date.now() - startedAt;
      const lastCycleMs = Date.now() - cycleStartedAt;
      // Dừng nếu đã tới mốc, HOẶC chu kỳ kế (nghỉ + thời gian chạy của chu kỳ vừa rồi) sẽ vượt mốc —
      // để còn dư thời gian gọi API kích hoạt job kế tiếp trước khi job bị timeout.
      if (elapsedMs >= MAX_RUNTIME_MS || elapsedMs + WATCH_INTERVAL_MS + lastCycleMs >= MAX_RUNTIME_MS) {
        console.log(
          `[generate-playlists] Đã chạy ${Math.round(elapsedMs / 60000)} phút (tính từ đầu job) — dừng vòng lặp trong job này ` +
          `để tránh chạm giới hạn 6 tiếng/job của GitHub Actions.`
        );
        await triggerSelfRestart();
        break;
      }

      // Vừa xong 1 chu kỳ (có thể mất lâu): kiểm tra ngay xem GitHub có thay đổi file không.
      if (await restartIfUpstreamChanged()) {
        console.log('[generate-playlists] Đã yêu cầu chạy lại do file trên GitHub thay đổi — dừng vòng lặp của job này.');
        break;
      }

      // FIX (06/10/2026): trước đây luôn nghỉ đủ 2 phút SAU khi chu kỳ xong -> chu kỳ thật = thời gian
      // chạy + 2 phút. Giờ nhịp cố định: nghỉ phần còn thiếu để từ lúc BẮT ĐẦU chu kỳ này tới chu kỳ
      // sau đúng ~2 phút (chu kỳ chậm hơn 2 phút thì chỉ nghỉ tối thiểu MIN_PAUSE_MS rồi chạy tiếp).
      const MIN_PAUSE_MS = 10 * 1000;
      const sleepMs = Math.max(MIN_PAUSE_MS, WATCH_INTERVAL_MS - (Date.now() - cycleStartedAt));
      if (await sleepWatchingUpstream(sleepMs)) {
        console.log('[generate-playlists] Đã yêu cầu chạy lại do file trên GitHub thay đổi — dừng vòng lặp của job này.');
        break;
      }
    }
    process.exit(0); // luôn thoát 0 — job "hết giờ" theo kế hoạch không phải là lỗi.
  }

  const ok = await runCycle();
  process.exit(ok ? 0 : 1);
}

main();
