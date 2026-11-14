# FIX 14/11/2026 (lần 3) — Rerace bóng đá: KẾT LUẬN sau test thực tế

- Trình duyệt Chrome của người dùng: 200. curl từ CÙNG máy/IP, token mới, đủ header (Origin, UA, Sec-Fetch-*): nginx 403 (cả khi bỏ/đủ Origin).
  Token lấy bằng trình duyệt trên Actions: 404 ngay từ IP Actions. => link /secure/ chỉ sống trong phiên trình duyệt thật; không dùng được trong playlist tĩnh.
- Mặc định giờ: ẨN các link /secure/ (RERACE_KEEP_SECURE=1 để ghi lại) và không mở Chromium cho trận bóng đá (đỡ tốn thời gian Actions).
  F1 Rerace (weelo.live) không đổi. Bóng đá xem ở các nguồn khác (Xoilac, Giờ Vàng, Phá Làng...).
- Chưa kiểm chứng được: có phải do HTTP/2 hay dấu vân tay TLS (curl Windows của người dùng chỉ có HTTP/1.1); app IPTV dùng HTTP/2 có thể khác.

# FIX 14/11/2026 — Rerace: debug báo "⚠️404(CI)" (Kosovo vs Israel, cả Server 1 và 2)

- 404 xảy ra NGAY TỪ IP máy chạy Actions (chính máy lấy token) => KHÔNG phải token gắn IP người xem. Nghĩa là CDN không có luồng đó
  (chưa phát / token bị thu hồi sau khi trình duyệt đóng trang / phiên phát đã đóng). Gợi ý debug cũ "nghi gắn IP" chỉ còn áp dụng cho 401/403.
- `browserFetch.js`: trình duyệt giờ ghi lại HTTP status thật của request m3u8 và chờ tới khi có link mở được (2xx/3xx).
- `rerace.service.js`: link mà CHÍNH trình duyệt nhận 4xx/5xx bị bỏ (không ghi ra playlist), thử server kế tiếp; ghi chú vào kênh "🔧 DEBUG Rerace"
  (vd "trình duyệt nhận HTTP 404 từ netanyahu.indianservers.st", "trình duyệt bắt ... status=200 header=[origin,...]").
- `streamDebug.js`: 404 trên link /secure/ cũng dò biến thể header; thêm đoạn đầu nội dung lỗi (body="...") vào dòng "# [debug]".
- Cách đọc: nếu trình duyệt status=200 nhưng CI thử lại sau đó 404 => token chỉ sống khi trang player còn mở (phiên gắn trình duyệt) -> không dùng được trong playlist tĩnh.
  Nếu trình duyệt cũng 404 => luồng chưa có trên CDN lúc đó (thử lại ở chu kỳ sau).

# FIX 13/11/2026 (lần 2) — Rerace: trận live bóng đá (/secure/<token>/) không xem được

- Nghi vấn (CHƯA kiểm chứng): token `*.indianservers.st/secure/<token>/...` gắn IP máy chạy GitHub Actions -> IP khác bị từ chối.
- Vì playlist tĩnh không đổi được token theo IP người xem, cách làm được chỉ bằng file Git là CHO NHIỀU SERVER / TRẬN:
  `rerace.service.js`: RERACE_MAX_SERVERS_OTHER mặc định 1 -> 3, RERACE_BROWSER_TRIES 2 -> 3 (lượt 3 mở embed của server kế tiếp);
  `playlistBuilder.service.js`: timeout resolve rerace 40s -> 60s. Người xem thử "Server 1/2/3" để chọn server chạy được.
- `m3uPlaylist.js`: link /secure/ VẪN được ghi (RERACE_KEEP_SECURE mặc định bật; đặt 0 để ẩn các link này).
- Nếu cả 3 server vẫn lỗi => token đúng là gắn IP; cần server lấy link lúc bấm xem (api/playlist/resolve), không làm được chỉ với Git.
- DEBUG Rerace (mặc định BẬT, tắt: RERACE_DEBUG=off hoặc PLAYLIST_DEBUG=off): mỗi kênh Rerace được thử mở từ máy chạy Actions
  đúng như app (chỉ Origin taifood-blog.asia, không Referer) rồi gắn vào TÊN KÊNH + dòng "# [debug]" trong file .m3u:
    ✅                         mở được từ IP máy chạy Actions (kèm IP-CI=<ip>) -> nếu bạn vẫn không xem được: token gắn IP, hoặc app của bạn không gửi header Origin
    ⚠️403(CI)·mọi-header-đều-chặn   CDN chặn mọi kiểu header -> token hết hạn/bị thu hồi/chặn IP
    ⚠️403(CI)·đổi-header-được(X)    lỗi do header; X là kiểu header mở được
    ⚠️token-hết-hạn(CI) / ⚠️timeout(CI) / ⚠️không-phải-video(CI)  tương ứng
  Mở file all.m3u trên GitHub (dạng text) để đọc các dòng "# [debug]"; cuối mỗi nguồn có kênh "🔧 DEBUG Rerace: ..." tóm tắt.
- Chỉ sửa file, không xóa file nào. Không cần sửa .github/workflows.

# ✅ FIX ĐÃ ÁP DỤNG - Chuối Chiên Override Referer

## 🎯 Fix Được Áp Dụng

Project này **ĐÃ CÓ FIX** cho lỗi Chuối Chiên không xem được trên app IPTV.

### **3 File Đã Sửa:**

1. ✅ **src/utils/m3uPlaylist.js**
   - Thêm hàm `getOverrideReferer()`
   - Call hàm trong `resolveIptvReferer()`
   - Thêm log warning khi fallback

2. ✅ **.github/workflows/validate-and-generate.yml**
   - Thêm 2 env var:
     - `CHUOICHIENTV_IPTV_REFERER`
     - `CHUOICHIENTV_PLAYER_DOMAIN`

3. ✅ **env.example**
   - Thêm hướng dẫn + biến referer override

---

## 🚀 Quick Deploy (2 Bước)

### **Bước 1: Install Dependencies**
```bash
npm install
# hoặc
npm ci
```

### **Bước 2: Set GitHub Secrets**

**Settings** → **Secrets and variables** → **Actions** → **New repository secret**

Thêm **2 secrets:**

| Name | Value |
|------|-------|
| `CHUOICHIENTV_IPTV_REFERER` | `https://live.chuoichien.tv/` |
| `CHUOICHIENTV_PLAYER_DOMAIN` | `https://live.chuoichien.tv/` |

---

### **Bước 3: Push & Trigger**

```bash
git add .
git commit -m "Deploy: Fixed Chuối Chiên referer"
git push
```

Sau đó:
- GitHub → **Actions** → **Generate Playlists** → **Run workflow**
- Chờ 2-5 phút

---

## ✅ Kiểm Tra Fix Hoạt Động

**Log workflow:**
- Actions > workflow > step "Generate playlists"
- Tìm: `[m3uPlaylist] Dùng override referer từ CHUOICHIENTV_IPTV_REFERER`

**File .m3u8:**
```bash
curl -s https://raw.githubusercontent.com/.../all.m3u | grep -B2 -A2 "Chuối Chiên"
```

Expected:
```
#EXTVLCOPT:http-referrer=https://live.chuoichien.tv/
#EXTVLCOPT:http-user-agent=Mozilla/5.0...
https://gckc0525.edgemaxcdn.org/live/chuoichao/playlist.m3u8
```

**Test app IPTV:**
- Import file .m3u8
- Play trận Chuối Chiên
- Nên phát được ✅

---

## ⚠️ Lưu Ý (cập nhật 26/09/2026 — QUAN TRỌNG)

- **Referer nguồn Chuối Chiên KHÔNG cố định, đổi theo TỪNG PHIÊN** (đã xác
  nhận 2 lần bằng DevTools ra 2 domain khác hẳn nhau: `live.chuoichien.tv`
  và `fhd-01.cctvsignal.xyz`) — vì link CDN thật đi qua 1 domain wrapper
  ngẫu nhiên (`*.100ycdn.com`), domain player nhúng phát sinh token cũng
  đổi theo. **Set cứng 1 giá trị vào `CHUOICHIENTV_IPTV_REFERER` chỉ đúng
  cho phiên lúc bạn lấy DevTools, phiên sau rất dễ lại lỗi y hệt.**
- **Khuyến nghị: KHÔNG set `CHUOICHIENTV_IPTV_REFERER`/`CHUOICHIENTV_PLAYER_DOMAIN`
  nữa — xoá 2 secret này đi.** Code đã tự dò Referer thật bằng trình duyệt
  headless mỗi lần workflow chạy (mỗi 2 phút), đúng theo phiên hiện tại,
  đáng tin hơn hẳn 1 giá trị hardcode. Nếu tự dò thất bại (site chặn IP CI),
  code tự rơi về thử lần lượt danh sách ứng viên đã biết (gồm cả 2 domain
  nêu trên) — xem `REFERER_CANDIDATES_BY_SOURCE` trong
  `src/utils/m3uPlaylist.js` và `pages/api/proxy/hls.js`.
- Chỉ nên set override 2 biến này khi cần ép tạm 1 giá trị để debug, và nhớ
  xoá lại sau khi xong.

---

## 📝 Các File Gốc (Tham Khảo)

Nếu muốn hiểu chi tiết:
- `QUICK_START.md` - Giải pháp nhanh gọn
- `PATCH_INSTRUCTIONS.md` - Chi tiết code từng chỗ

---

## 🎉 Chúc Bạn Thành Công!

Nếu vẫn có lỗi:
1. Kiểm tra GitHub Secrets đã set đúng chưa
2. Kiểm tra workflow log có message override referer chưa
3. Kiểm tra referer mới từ DevTools (có thể đã đổi)


---

## 27/10/2026 — Phá Làng: trận live (lilive1.eu.cc / pull.digitalcdn.net) không xem được

- `src/services/phalang.service.js`: Referer mặc định của link = `https://phalang.live/` (đúng thứ trình duyệt gửi cho CDN khác domain), không dùng URL trang xem trận tự ghép nữa. Với link không phải digitalcdn (vd lilive1.eu.cc) xuất thêm bản dự phòng `Server N-B` KHÔNG gửi Referer/Origin (chỉ User-Agent) để 1 trong 2 kiểu chắc chắn khớp CDN. Tắt bằng `PHALANG_NOREFERER_VARIANT=off`.
- `src/utils/m3uPlaylist.js`: bản `noReferer` thật sự không ghi Referer/Origin (bỏ qua cả override/dò); số server tối đa/trận Phá Làng mặc định 3 -> 5 (`PHALANG_MAX_SERVERS`).
- Không xoá file nào.

### Cập nhật 27/10/2026 (lần 2)
- lilive1.eu.cc trả `{"error":"Stream not found"}` -> link chết, không phải lỗi header. Bỏ bản `Server N-B` (mặc định tắt, bật lại bằng `PHALANG_NOREFERER_VARIANT=on`).
- `phalang.service.js`: dò link (trừ digitalcdn) và bỏ link chắc chắn chết (404 / không phải m3u8); lỗi mạng/403/5xx thì giữ. Tắt: `PHALANG_PROBE_ALIVE=off`.
- `playlistBuilder.service.js`: trận Phá Làng live không còn link sống thì không rơi về link chết trong danh sách.

### Cập nhật 27/10/2026 (lần 3)
- Curl DevTools thật: Referer = URL đầy đủ trang xem trận + Origin phalang2.live -> `phalang.service.js` dùng lại URL trang xem trận làm Referer (không còn dùng `https://phalang2.live/`).

### Cập nhật 27/10/2026 (lần 4)
- Mỗi trận Phá Làng chỉ xuất tối đa 2 server (Server 1, Server 2) — `PHALANG_MAX_SERVERS` mặc định 2 (đặt 1 nếu chỉ muốn 1 kênh/trận).

### Cập nhật 27/10/2026 (lần 5)
- Mỗi trận Phá Làng chỉ xuất 1 kênh — `PHALANG_MAX_SERVERS` mặc định 1 (đặt 2 nếu muốn Server 1 + Server 2).

### Cập nhật 27/10/2026 (lần 6)
- `m3uPlaylist.js`: tên kênh Phá Làng bỏ đuôi "Server N" khi chỉ xuất 1 kênh/trận (không còn ngoặc trống nếu không có tên BLV).

---

## 31/10/2026 — Domain cũ đã chuyển hướng/bị 403 nhưng Generate vẫn quét domain cũ (Xôi Lạc mất trận live)
- Log: `[xoilac] lỗi mở trang nhúng https://xl365.domainkqt.cc/... (Referer https://xoilacvbx.tv): ... 403`.
- Gốc lỗi: domain Xôi Lạc chỉ đọc 1 lần lúc khởi động + Referer cứng domain cũ; Check Domains không đổi khi domain cũ "còn sống"/403.
- `src/utils/liveDomains.js` (MỚI): nhớ domain thật học lúc chạy, đọc lịch sử domain, nhờ Check Domains dò lại.
- `src/services/xoilac.service.js`: theo redirect + domain dự phòng, Referer/Origin = domain đang sống, bỏ domain cũ cứng, tự dò khi trang nhúng 403.
- `src/utils/m3uPlaylist.js`, `pages/api/proxy/hls.js`: bỏ `xoilacxcw.tv` cứng.
- `scripts/resolve-redirects.mjs`, `scripts/expand-source-domains.mjs`, `scripts/source-domains.mjs`: báo `unhealthy_keys` (cờ `plainHttp`).
- `scripts/check-domains.mjs`: `FORCE_DISCOVER`, `EXCLUDE_DOMAINS`, `BLOCKED_AUTO_SWITCH`; ứng viên phải xác minh đủ.
- `.github/workflows/validate-and-generate.yml`: gọi Check Domains cả khi domain bị lỗi/403 (restart_generator=true).
- `.github/workflows/check-domains.yml`: thêm ô `force_discover`, `exclude_domains`.
- Chi tiết: CHECK_DOMAINS.md mục 0g. Không xoá file nào.


---
## 08/11/2026 — Thêm nguồn Rerace F1 (rerace.net)
- MỚI: `src/services/rerace.service.js`, `pages/api/rerace/live.js`, `pages/api/rerace/stream.js`.
- Đăng ký thêm (chỉ thêm dòng, không xoá): `playerGet.js`, `playlistBuilder.service.js`, `pages/api/playlist/resolve.js`, `pages/api/proxy/hls.js`, `m3uPlaylist.js`, `env.example`, `source-domains.example.txt`, `scripts/source-domains.mjs`.
- Parser trang chủ đã test trên file `nguon_F1.txt` thật (6 session F1 + thẻ trận).
- ĐÃ XÁC NHẬN schema (mẫu user gửi 08/11/2026): `weelo.live/feed/events.json` (events[].sessions[startsAt,endsAt], streams[]), `api.ppv.st/api/streams` (iframe + substreams, embed taifood-blog.asia). Mặc định chỉ series f1 (RERACE_SERIES).
- Header thật (curl DevTools): feed/ppv gửi Origin+Referer rerace.net; trang player weelo.live/<hash>/index.html gửi Origin+Referer weellz.live (RERACE_PLAYER_ORIGIN). Có thêm https://www.rerace.net/data/f1-schedule.json (chưa dùng).
- CHƯA XÁC NHẬN: phần tử của `events[].streams[]` (mẫu đều rỗng), `players/state.json` và Referer CDN. Link m3u8 được quét chịu lỗi; không thấy thì trả rỗng.
- (08/11/2026, theo app JS của rerace) Luồng phát: events[].streams[] = {id:"...-srcNNN", label, language, url:<iframe weellz.live>, kind:"iframe"} -> iframe gọi weelo.live/<token a-p>/index.html (Origin/Referer weellz.live), nhiều khả năng là playlist HLS đặt tên .html.
- Rerace xuất TẤT CẢ server của 1 trận (RERACE_MAX_SERVERS, mặc định 24), mỗi server 1 kênh "Server N - <label>". Chỉ áp dụng cho nguồn rerace, các nguồn khác giữ nguyên.
- Thêm: playerGet.knownCdn 'weelo.live'; proxy HLS nhận diện weelo.live/<token>/index.html là playlist.
- CHƯA XÁC NHẬN: token có xuất hiện trong HTML iframe hay do JS sinh động (nếu JS sinh thì cần thêm bước), và Referer CDN của segment .ts.
- (08/11/2026) Rerace lấy thêm BÓNG ĐÁ từ api.ppv.st/api/streams: mỗi trận = [chính, ...substreams] (iframe taifood-blog.asia/embed/...), nhãn server = source_tag ("HD | Movistar"), sắp xếp 4K/FHD/HD/SD. Mặc định RERACE_SPORTS=f1,motor-sports,football; bỏ bóng rổ + kênh 24/7; môn ngoài F1 chỉ lấy trận trong RERACE_UPCOMING_HOURS=24h tới.
- CHƯA XÁC NHẬN: trang embed taifood-blog.asia có để lộ .m3u8 trong HTML hay phải chạy JS/đòi header riêng.
- (08/11/2026) Bóng đá/môn khác trên rerace: mỗi trận chỉ 1 link chất lượng tốt nhất (RERACE_MAX_SERVERS_OTHER=1); F1 vẫn lấy tất cả server.
- (08/11/2026) Link bóng đá thật có dạng bharat.indianservers.st/secure/<token>/<start>/<end>/.../mono.ts.m3u8 (token ký sẵn). stream.referer = origin trang iframe của từng server.
- (08/11/2026) XÁC NHẬN bằng DevTools: m3u8 bóng đá (bharat.indianservers.st) gửi Origin=https://taifood-blog.asia, Referer=https://taifood-blog.asia/ -> thêm RERACE_EMBED_ORIGIN vào danh sách Referer. Còn mở: token /secure/ có gắn IP không; link có nằm sẵn trong HTML embed không.
- (08/11/2026) ppv cũng có F1 (category Motorsports, tag "Formula 1", ~16 server theo ngôn ngữ, uri f1/2026/brazil/race): server ppv được gộp vào session weelo cùng giờ (±45 phút), bỏ bản trùng. Embed bóng đá dạng https://taifood-blog.asia/embed/<league>/<yyyy-mm-dd>/<home>-<away> (+ _540p là bản SD).

---

# Rerace (08/11/2026) — hoàn thiện nguồn bóng đá

- `src/services/rerace.service.js`: thêm `extractM3u8()` + `scanEmbed()` quét trang embed `taifood-blog.asia/embed/<giải>/<ngày>/<nhà>-<khách>`:
  m3u8 tuyệt đối / `\/` / tương đối, base64 (`atob(...)`, `"aHR0c..."`), `<iframe src>`, `<script src>` cùng site, endpoint `fetch()`/api trong script;
  thử lần lượt Referer rerace.net -> taifood-blog.asia -> weellz.live. Luồng F1 (weelo.live/<token>/index.html) giữ nguyên.
- `pages/api/rerace/debug.js` (MỚI): `GET /api/rerace/debug?id=<matchId>` trả trace từng bước (HTTP status, số byte, m3u8 tìm được).
  Nếu trận bóng đá vẫn ra 0 link, mở endpoint này để biết trang embed trả 403 (chặn Referer), trang trống, hay link nằm trong JS/API khác.
- Chưa xác nhận được mã nguồn thật của trang embed (site chặn bot) -> nếu cần, dán kết quả `/api/rerace/debug` để chỉnh tiếp.

---

# Rerace F1 (08/11/2026) — hoàn thiện luồng weelo.live (từ DevTools)

Chuỗi thật: `events.json -> streams[].url = https://weellz.live/beta?stream=<token>&r=1`
-> master `https://weelo.live/<token>/index.html` (#EXTM3U, không có đuôi .m3u8)
-> playlist con/âm thanh đặt tên giả `<token>/tracks-v3a1|v2a1|a1/style.css`
-> segment đặt tên giả `https://weelo.live/ingest/<uuid>/IMG_xxxx.jpg|png|webp`
-> key AES `https://rewnd.live/k/<token>-<time>?t=...`. Mọi request mang Origin/Referer = https://weellz.live.

- `src/services/rerace.service.js`: `weeloTokenOf()` lấy token ngay từ `?stream=` của iframe, tự dựng `weelo.live/<token>/index.html`, kiểm tra `#EXTM3U`
  (404/410 = chưa phát -> bỏ; lỗi mạng/403 vẫn giữ link). Không cần đọc HTML trang iframe nữa. Bước quét embed/bóng đá giữ nguyên làm dự phòng.
- `pages/api/proxy/hls.js`:
  1. nhận diện playlist đặt tên `*/tracks-*/style.css` (trước đây bị coi là CSS nhị phân -> hls.js lỗi);
  2. segment `/ingest/<uuid>/IMG_*.jpg|png|webp` trả `Content-Type: video/mp2t` + cắt "header ảnh" nếu có trước dữ liệu TS (không có/đã mã hoá AES -> giữ nguyên);
  3. host weelo.live / weellz.live / rewnd.live (kể cả key AES) ưu tiên Referer+Origin = weellz.live.

---

# Rerace — theo dõi domain (09/11/2026)

- `scripts/source-domains.mjs`: thêm 4 domain phụ vào danh sách quét (chỉ quét + báo cáo, không tự đổi): `rerace-weelo` (weelo.live), `rerace-player` (weellz.live), `rerace-embed` (taifood-blog.asia), `rerace-ppv-api` (api.ppv.st). Trang `rerace` đã có từ trước.
- `source-domains.example.txt`: thêm 4 dòng tương ứng. Dán vào biến GitHub SOURCE_DOMAINS để workflow Check Domains báo cáo 4 domain này.
- KHÔNG cần sửa `.github/workflows`: `expand-source-domains.mjs` mở mọi nguồn trong SOURCES thành biến môi trường chung.

---

# Rerace — cho bằng các nguồn cũ (09/11/2026)

- `scripts/source-domains.mjs`: bật `autoFix` cho `rerace` (candidates: www.rerace.net, rerace.net). Domain đổi/chuyển hướng sang domain đúng nguồn (nội dung có "rerace" hoặc tên miền chứa "rerace") thì Generate Playlists tự dùng ngay, Check Domains tự ghi vào SOURCE_DOMAINS. Trang đỗ tên miền/rao bán/cá cược bị từ chối. Không đặt `plainHttp` nên 403 Cloudflare từ IP runner KHÔNG bị coi là hỏng.
- `pages/api/static-playlist/[file].js` + `scripts/generate-playlists.js`: thêm `rerace` vào SOURCE_KEYS -> link tĩnh `source-rerace.m3u` dùng được qua route này.
- `pages/index.jsx`: thêm màu/biểu tượng riêng cho Rerace trong SOURCE_META.

---

# Rerace — ít trận "sắp diễn ra" trong playlist (09/11/2026)

Log: `rerace:upcoming: 19 trận` nhưng playlist chỉ có 1. Nguyên nhân: `rerace.service.js` trả TẤT CẢ session F1 còn lại của mùa (không giới hạn thời gian),
còn `playlistBuilder.service.js` chỉ giữ trận bắt đầu trong 72h tới -> các session chặng xa bị lọc (đúng thiết kế, nhưng cửa sổ cứng và không có log lý do).
- `src/services/playlistBuilder.service.js`: cửa sổ tách theo môn — F1 `RERACE_F1_UPCOMING_HOURS` (mặc định 168h), môn khác `RERACE_UPCOMING_HOURS` (mặc định 24h); thêm log
  `[playlist-builder] rerace upcoming: giữ X/Y (ngoài cửa sổ..., loại môn..., loại giải..., trùng...)` kèm trận sớm nhất nằm ngoài cửa sổ.
- `env.example`: thêm `RERACE_F1_UPCOMING_HOURS`.

## 09/11/2026 — Rerace: playlist chỉ còn 1 trận dù quét được 19 trận upcoming
- Nguyên nhân: `playlistBuilder.service.js` cắt session F1 ở 168h (7 ngày) -> chặng F1 kế tiếp cách >7 ngày bị loại hết, chỉ sót 1 trận bóng đá.
- Sửa: `RERACE_F1_UPCOMING_HOURS` mặc định 168h (đặt vd 2160 nếu muốn lấy hết session F1 còn lại); bóng đá giữ `RERACE_UPCOMING_HOURS` (mặc định 24h).
- Đổi tên nhóm/nhãn nguồn từ "Rerace F1" -> "Rerace" (`playerGet.js` SOURCE_LABELS/SOURCE_SHORT/SOURCE_TOGGLE_LIST, `scripts/source-domains.mjs`).

## 09/11/2026 — Xôi Chè: quét OK 36+10 trận nhưng playlist 0 trận
- Log: bộ lọc giải bỏ 11/13 trận bóng đá upcoming (Friendlies, giải nữ, J-League Cup...), còn 2 trận (AFCON Qualification, UEFA Nations League); rồi `playlistBuilder.service.js` loại nốt 2 trận này vì cửa sổ 48h + yêu cầu giờ bóng lăn phải ở tương lai.
- Sửa: cửa sổ xoiche mặc định 72h (`XOICHE_UPCOMING_HOURS`), giữ trận quá giờ tối đa 180 phút mà site còn "scheduled" (`XOICHE_UPCOMING_GRACE_MIN`).
- Thêm log `[playlist-builder] <nguồn> upcoming: giữ x/y (ngoài cửa sổ, loại môn, loại giải, trùng) + trận sớm nhất ngoài cửa sổ` cho MỌI nguồn để lần sau thấy ngay trận bị loại ở bước nào.
- Muốn giữ cả "Friendlies" (giao hữu): đặt `LEAGUE_ALLOW=friendlies` (hoặc thêm `,friendlies` nếu đã có giá trị).
