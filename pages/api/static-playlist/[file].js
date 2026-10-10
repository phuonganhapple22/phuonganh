// FIX (22/09/2026 — "link all.m3u tổng hợp khi add vào app IPTV bị hiện ra
// dạng file text"): trước đây link playlist TĨNH (public/playlists/*.m3u)
// khi đã khai báo GITHUB_REPO (xem pages/api/config.js) trỏ THẲNG ra
// raw.githubusercontent.com/.../all.m3u. GitHub raw luôn trả cứng
// "Content-Type: text/plain; charset=utf-8" cho MỌI file bất kể đuôi .m3u
// hay .m3u8 (đã tự kiểm tra: curl -I raw.githubusercontent.com/... luôn ra
// text/plain), lại còn kèm "X-Content-Type-Options: nosniff" chặn app tự
// đoán loại file qua nội dung (#EXTM3U). Nhiều app IPTV (đặc biệt trên
// TV/Android/GSE Smart IPTV...) chỉ dựa vào header Content-Type để quyết
// định nạp làm playlist hay hiển thị/tải về như 1 file .txt thường —
// GitHub trả sai header nên bị hiểu nhầm là file text.
//
// Không thể sửa header mà GitHub trả về (không kiểm soát được raw.
// githubusercontent.com). Cách fix: KHÔNG đưa thẳng link GitHub ra ngoài
// nữa — mọi link playlist tĩnh (kể cả "all.m3u" tổng hợp) giờ trỏ vào route
// này trên chính domain của mình. Route tự tải nội dung thật (từ GitHub raw
// nếu đã set GITHUB_REPO — giữ đúng cơ chế "luôn mới theo GitHub Actions,
// không phụ thuộc lúc nào VPS/Vercel build lại" như comment cũ trong
// pages/api/config.js; hoặc đọc file cục bộ trong public/playlists/ nếu
// chưa set) rồi TỰ trả lại với Content-Type chuẩn playlist (audio/x-mpegurl
// — giống hệt route động pages/api/playlist.js) bất kể nguồn thật lấy từ
// đâu. Client (web hiển thị link, app IPTV dán link) chỉ cần biết đúng 1
// dạng link duy nhất trên domain của chính mình.
import fs from 'fs/promises';
import path from 'path';

// Khớp với SPORT_TABS (src/utils/playerGet.js) + SOURCE_KEYS
// (scripts/generate-playlists.js) — danh sách TRẮNG các file được phép,
// vừa để chặn path traversal (../../…) vừa để chặn lợi dụng param `file`
// làm SSRF sang file bất kỳ trên GitHub.
const SPORT_IDS = ['all', 'football', 'basketball', 'volleyball', 'badminton', 'tennis', 'f1'];
const SOURCE_KEYS = ['giovang', 'khandaitv', 'chuoichientv', 'phalang', 'gavang', 'saoke'];
const ALLOWED_FILES = new Set([
  ...SPORT_IDS.map((s) => `${s}.m3u`),
  ...SOURCE_KEYS.map((s) => `source-${s}.m3u`)
]);

const LOCAL_DIR = path.join(process.cwd(), 'public', 'playlists');

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, message: 'Method Not Allowed' });
  }

  const file = String(req.query.file || '');
  if (!ALLOWED_FILES.has(file)) {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.status(404).send('#EXTM3U\n# Not found\n');
  }

  const repo = process.env.GITHUB_REPO;
  const branch = process.env.GITHUB_BRANCH || 'main';

  let content;
  try {
    if (repo) {
      const url = `https://raw.githubusercontent.com/${repo}/${branch}/public/playlists/${file}`;
      const upstream = await fetch(url, { headers: { 'User-Agent': 'nguonvip-static-playlist-proxy' } });
      if (!upstream.ok) throw new Error(`HTTP ${upstream.status} khi tải ${url}`);
      content = await upstream.text();
    } else {
      content = await fs.readFile(path.join(LOCAL_DIR, file), 'utf8');
    }
  } catch (error) {
    console.error('[static-playlist] failed:', error?.stack || error);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.status(502).send('#EXTM3U\n# Error: ' + (error.message || 'Khong tai duoc playlist tinh') + '\n');
  }

  // Header y hệt pages/api/playlist.js — đảm bảo mọi link .m3u trên trang
  // (động lẫn tĩnh) luôn ra cùng 1 kiểu Content-Type nhất quán.
  res.setHeader('Content-Type', 'audio/x-mpegurl');
  res.setHeader('Content-Disposition', `inline; filename="${file}"`);
  // Cache ngắn — nguồn thật (GitHub Actions) giờ chạy tối đa 2 phút/lần mới
  // đổi (xem .github/workflows/validate-and-generate.yml), không cần giữ
  // cache lâu hơn ở tầng proxy này.
  res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=30, stale-while-revalidate=60');
  return res.status(200).send(content);
}

export const config = { maxDuration: 30 };
