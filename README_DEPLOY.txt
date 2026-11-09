Rerace update - chi gom file MOI va file DA SUA (giu nguyen duong dan thu muc).
Cach deploy: giai nen, copy de len thu muc goc repo (chon "Replace/Ghi de"), roi commit + push.

FILE MOI
  pages/api/rerace/live.js
  pages/api/rerace/stream.js
  pages/api/rerace/debug.js
  src/services/rerace.service.js

FILE DA SUA
  pages/api/playlist/resolve.js
  pages/api/proxy/hls.js
  src/services/playlistBuilder.service.js
  src/utils/m3uPlaylist.js
  src/utils/playerGet.js
  scripts/source-domains.mjs
  source-domains.example.txt
  env.example
  FIX_APPLIED.md

Khong xoa file nao trong repo.

Cap nhat 09/11/2026: scripts/source-domains.mjs + source-domains.example.txt them 4 domain phu cua Rerace (weelo, weellz, taifood-blog, api.ppv.st).
Sau khi deploy: dan them 4 dong cuoi cua source-domains.example.txt vao bien GitHub SOURCE_DOMAINS. Khong can sua .github/workflows.

Cap nhat 09/11/2026 (lan 2): them 3 file da sua - pages/api/static-playlist/[file].js, scripts/generate-playlists.js, pages/index.jsx; scripts/source-domains.mjs bat autoFix cho rerace. Van khong can sua .github/workflows.
