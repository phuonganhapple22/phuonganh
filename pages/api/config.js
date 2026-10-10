// Cấu hình đọc ở phía SERVER lúc có request (KHÔNG phải lúc build) — khác
// với biến NEXT_PUBLIC_* (bị "đóng cứng" vào bundle JS ngay lúc `next
// build`, đổi env sau đó phải build lại mới có hiệu lực). Dùng route này để
// đổi GITHUB_REPO/GITHUB_BRANCH trên VPS chỉ cần sửa .env rồi restart
// container (`docker compose up -d`, KHÔNG cần `--build` lại), không phải
// build lại image — quan trọng vì đây là thứ có thể đổi độc lập theo từng
// VPS (mỗi VPS có thể trỏ tới repo/nhánh GitHub khác nhau).
//
// FIX (19/09/2026 — "muốn file .m3u tĩnh lưu trên git, nhưng vẫn hiển thị
// link git trên web VPS"): file playlists tĩnh (public/playlists/*.m3u,
// xem scripts/generate-playlists.js) được GitHub Actions commit thẳng lên
// GitHub mỗi 2 phút — trên Vercel thì mỗi lần commit đó TỰ kích hoạt 1 bản
// deploy mới (Vercel theo dõi nhánh main), nên file cục bộ Vercel đang phục
// vụ luôn là bản mới nhất. Trên VPS/Docker thì KHÔNG có cơ chế tự deploy
// lại khi GitHub Actions commit — file trong image Docker chỉ mới tính từ
// lúc `docker compose up -d --build` gần nhất, đứng yên cho tới lần build
// kế tiếp (xem DEPLOY_VPS.md, mục "Cập nhật code khi có bản mới"). Thay vì
// bắt VPS tự rebuild mỗi 2 phút (nặng, không cần thiết), trỏ link playlist
// tĩnh thẳng ra bản mới nhất trên GitHub (raw.githubusercontent.com) — luôn
// mới theo đúng nhịp GitHub Actions, không phụ thuộc lúc nào VPS build lại.
export default function handler(req, res) {
  const repo = process.env.GITHUB_REPO; // dạng "chu-so-huu/ten-repo"
  const branch = process.env.GITHUB_BRANCH || 'main';

  const staticPlaylistBase = repo
    ? `https://raw.githubusercontent.com/${repo}/${branch}/public/playlists`
    : null; // chưa khai báo GITHUB_REPO -> client tự dùng link cục bộ /playlists/... như cũ

  res.setHeader('Cache-Control', 'public, max-age=60');
  res.status(200).json({ staticPlaylistBase });
}
