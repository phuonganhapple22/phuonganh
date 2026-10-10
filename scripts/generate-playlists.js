#!/usr/bin/env node
// Sinh sẵn file .m3u tĩnh cho từng môn thể thao, lưu vào public/playlists/
// để commit vào repo — dùng bởi .github/workflows/validate-and-generate.yml
// (cron kiểm tra mỗi 2 phút, hoặc khi data/sources.json thay đổi).
//
// TẠI SAO GỌI QUA HTTP TỚI TRANG ĐÃ DEPLOY THAY VÌ QUÉT LẠI TỪ ĐẦU:
// Các service quét nguồn (src/services/*.service.js) dùng alias "@/..." —
// chỉ Next.js/webpack hiểu lúc build, Node chạy trực tiếp một file .js
// không hiểu alias này (và phần lớn import trong code cũng không có đuôi
// .js, Node ESM cũng không tự suy ra được). Ngoài ra 1 số nguồn (VSC9,
// Giovang) cần mở Chromium headless mới lấy được stream — cài + chạy lại
// trong GitHub Actions mỗi 2 phút vừa nặng vừa dễ timeout.
// => Gọi thẳng /api/playlist trên chính trang đã chạy (Vercel) là chắc ăn
// nhất: tái dùng đúng 100% logic thật, không lặp code, không cần cài thêm
// gì trong CI ngoài Node.
//
// FIX (22/09/2026 — "cron phải chạy đều 2 phút/lần liên tục, không giãn
// cách khi ít/không có trận"): TRƯỚC ĐÂY script tự "giãn" chu kỳ làm mới ra
// (x2 mỗi lần, tối đa 2 tiếng) mỗi khi không thấy trận live nào, và các lần
// cron "gõ cửa" trong lúc chưa tới giờ hẹn sẽ bị BỎ QUA hoàn toàn (không gọi
// mạng, không ghi file gì cả). Theo yêu cầu mới: bỏ hẳn phần giãn/bỏ-qua đó
// — mọi lần cron gọi tới (đều đặn mỗi 2 phút, khớp
// `.github/workflows/validate-and-generate.yml`) đều CHẠY THẬT
// (generateOnce()) 100%, bất kể đang có bao nhiêu trận live. File
// public/playlists/.refresh-state.json vẫn được ghi lại nhưng CHỈ để
// log/tham khảo (lastRunAt, liveMatchCount) — không còn trường
// nextCheckAt/intervalMin nào được dùng để quyết định bỏ qua lần chạy nữa.

const fs = require('fs');
const path = require('path');

// Khớp với SPORT_TABS trong src/utils/playerGet.js (bỏ 'esports' vì cũng bị
// lọc bỏ ở đó).
const SPORT_TABS = ['all', 'football', 'basketball', 'volleyball', 'badminton', 'tennis', 'f1'];

// Khớp với SOURCE_GROUP_ORDER trong src/utils/playerGet.js — playlist tĩnh
// RIÊNG từng nguồn (source-xoilac.m3u, source-phaohoa.m3u...), song song
// với playlist theo môn ở trên. Không import trực tiếp từ playerGet.js vì
// lý do đã nêu ở đầu file (alias "@/..." chỉ Next.js/webpack hiểu).
// FIX (20/09/2026 — loại bỏ Pháo Hoa, domain phaohoa1.live đã chết hẳn):
// file này là CJS thuần (require), không dùng được alias "@/..." nên KHÔNG
// import chung được SOURCE_GROUP_ORDER từ src/utils/playerGet.js như bản
// scripts/generate-playlists-standalone.mjs — phải tự sửa tay ở đây mỗi khi
// danh sách nguồn đổi, nhớ đồng bộ với SOURCE_GROUP_ORDER bên đó.
const SOURCE_KEYS = ['giovang', 'khandaitv', 'chuoichientv', 'phalang', 'gavang', 'saoke'];

const SITE_URL = (process.env.SITE_URL || process.env.NEXT_PUBLIC_SITE_URL || 'https://nguonvip.vercel.app').replace(/\/+$/, '');
// FIX (27/09/2026 — người dùng xác nhận domain Vercel THẬT đang chạy là
// 'https://nguonvip.vercel.app' — bản trước đây ghi nhầm mặc định là
// 'https://nguonvip1.vercel.app' (thừa số "1", KHÔNG tồn tại/không phải
// domain thật). Chỉ ảnh hưởng khi biến SITE_URL trống VÀ bước "Resolve
// production URL" trong workflow cũ không tự dò được domain — script này
// (scripts/generate-playlists.js) hiện KHÔNG còn được
// .github/workflows/validate-and-generate.yml gọi tới nữa (đã chuyển hẳn
// sang scripts/generate-playlists-standalone.mjs, xem chú thích đầu file
// đó) nên fallback này gần như chỉ còn ý nghĩa khi chạy tay script này cục
// bộ — vẫn sửa lại cho đúng để tránh nhầm lẫn nếu sau này dùng lại.
// (Giữ lại phần giải thích chung về cơ chế fallback domain — chỉ phần domain
// mẫu cụ thể đã được đính chính ở trên): bước "Resolve production URL from
// latest Vercel deployment" trong workflow tự dò domain qua GitHub
// Deployments API — CHỈ hoạt động nếu repo đã tích hợp Vercel↔GitHub tạo
// Deployment record; nếu không (hoặc bước đó lỗi tạm thời), SITE_URL rỗng và
// script rơi về domain mặc định ở trên. Domain sai khiến toàn bộ
// public/playlists/*.m3u bị sinh từ 1 site khác hẳn (hoặc lỗi fetch khiến
// file .m3u tĩnh GIỮ NGUYÊN nội dung CŨ, không hề cập nhật). Domain không
// phải thông tin nhạy cảm nên đặt sẵn giá trị mặc định — không bắt buộc phải
// khai báo secret gì trên GitHub. Chỉ cần set biến SITE_URL (secret hoặc
// biến môi trường) nếu sau này đổi sang domain khác.
const OUTPUT_DIR = path.join(__dirname, '..', 'public', 'playlists');
const STATE_PATH = path.join(OUTPUT_DIR, '.refresh-state.json');

const BASE_INTERVAL_MIN = 2; // khớp lịch cron */2 trong .github/workflows/validate-and-generate.yml
const WATCH_INTERVAL_MS = BASE_INTERVAL_MIN * 60 * 1000; // dùng cho `--watch` chạy local

function isWatchMode() {
  return process.argv.includes('--watch');
}

function writeState(state) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n', 'utf8');
}

async function fetchPlaylist(sport, source, format) {
  const params = new URLSearchParams({ sport });
  if (source) params.set('source', source);
  if (format) params.set('format', format);
  const url = `${SITE_URL}/api/playlist?${params.toString()}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'generate-playlists-ci' } });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} khi gọi ${url}`);
  }
  return res.text();
}

/** @returns {Promise<{ ok: boolean, liveMatchCount: number }>} */
async function generateOnce() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  let hasError = false;
  let liveMatchCount = 0;
  for (const sport of SPORT_TABS) {
    try {
      const content = await fetchPlaylist(sport);
      const filename = `${sport}.m3u`;
      fs.writeFileSync(path.join(OUTPUT_DIR, filename), content, 'utf8');
      const matchCount = (content.match(/^#EXTINF/gm) || []).length;
      if (sport === 'all') liveMatchCount = matchCount; // playlist "all" = mọi trận đang live có stream, dùng làm chỉ số quyết định giãn/thu chu kỳ
      console.log(`[generate-playlists] ${filename}: ${matchCount} trận`);

      // FIX (26/09/2026 — "VLC được, app IPTV điện thoại không xem được"):
      // sinh thêm bản "-app.m3u" dùng cú pháp header kiểu "|Referer=..."
      // cho app IPTV Android (ExoPlayer, không hiểu #EXTVLCOPT) — xem
      // buildM3uPlaylist() trong m3uPlaylist.js. File .m3u gốc (VLC) GIỮ
      // NGUYÊN không đổi.
      const appContent = await fetchPlaylist(sport, null, 'app');
      const appFilename = `${sport}-app.m3u`;
      fs.writeFileSync(path.join(OUTPUT_DIR, appFilename), appContent, 'utf8');
      console.log(`[generate-playlists] ${appFilename}: ${(appContent.match(/^#EXTINF/gm) || []).length} trận`);
    } catch (err) {
      hasError = true;
      console.error(`[generate-playlists] Lỗi khi tạo playlist "${sport}":`, err.message);
    }
  }

  // Playlist tĩnh riêng từng nguồn (mọi môn thể thao gộp, chỉ lọc theo
  // nguồn) — không tính vào liveMatchCount vì đã tính đủ ở playlist "all"
  // phía trên, tránh đếm trùng khi quyết định giãn/thu chu kỳ.
  for (const source of SOURCE_KEYS) {
    try {
      const content = await fetchPlaylist('all', source);
      const filename = `source-${source}.m3u`;
      fs.writeFileSync(path.join(OUTPUT_DIR, filename), content, 'utf8');
      const matchCount = (content.match(/^#EXTINF/gm) || []).length;
      console.log(`[generate-playlists] ${filename}: ${matchCount} trận`);

      const appContent = await fetchPlaylist('all', source, 'app');
      const appFilename = `source-${source}-app.m3u`;
      fs.writeFileSync(path.join(OUTPUT_DIR, appFilename), appContent, 'utf8');
      console.log(`[generate-playlists] ${appFilename}: ${(appContent.match(/^#EXTINF/gm) || []).length} trận`);
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

  console.log(
    `[generate-playlists] Hoàn tất — ${liveMatchCount} trận live. ` +
    `Chạy lại đều đặn sau ${BASE_INTERVAL_MIN} phút (không giãn cách).`
  );

  return ok;
}

async function main() {
  console.log(`[generate-playlists] Dùng SITE_URL: ${SITE_URL}`);

  if (isWatchMode()) {
    console.log(`[generate-playlists] Chế độ watch (local) — chạy đều mỗi ${WATCH_INTERVAL_MS / 60000} phút, liên tục, không giãn cách. Ctrl+C để dừng.`);
    // eslint-disable-next-line no-constant-condition
    while (true) {
      await runCycle();
      await new Promise((resolve) => setTimeout(resolve, WATCH_INTERVAL_MS));
    }
  }

  const ok = await runCycle();
  process.exit(ok ? 0 : 1);
}

main();
