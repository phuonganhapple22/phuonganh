# FIX SPORTLINKTV KHONG GHI DUOC LINK TRAN VAO PLAYLIST — 22/11/2026

Loi: tran SportlinkTV tra ra sai form so voi cac nguon khac nen bi rot o playlistBuilder/m3uPlaylist.

## Nguyen nhan
- `homeTeam`/`awayTeam` la chuoi (cac nguon khac la `{ name, logo }`) -> ten tran thanh "Home", logo/loc giai hong.
- Thieu `matchTimeTimestamp`/`dateStr`/`timeStr` -> tran sap da bi loai khoi cua so 24h, gio trong, sort sai.
- Stream DASH (.mpd) khong co field `link` va .mpd khong nam trong `isPlayableStreamUrl` -> bi loc het, tran khong co link.
- Phan `|Referer=...&User-Agent=...` sau link bi cat bo roi vut -> CDN chan hotlink.
- Goi `buildMatchSlug` sai chu ky (3 tham so thay vi 1 object) -> slug sai.

## Da sua (de len git, ghi de) — co ban sao trong folder `changed-files/`
- `src/services/sportlinktv.service.js`: dung form tran chung (homeTeam/awayTeam object, matchTimeTimestamp, dateStr, timeStr, competition, status.isFinished); giu Referer/Origin tu link; link DASH xep truoc HLS; ho tro timestamp epoch; gom code stream thanh 1 ham dung chung cho danh sach + getStreamLinks; khong ghi kenh gia khi tran khong co link.
- `src/utils/playerGet.js`: them `isMpdUrl`, `isPlayableStreamUrl` nhan .mpd, `normalizeStreamList` nhan `playUrl` va dat format `dash`.
- `src/utils/m3uPlaylist.js`: link DASH kem ClearKey ghi them `#KODIPROP` (manifest_type/license_type/license_key); SportlinkTV uu tien DASH neu tran co ca DASH lan HLS.

- Cap nhat 22/11 (lan 2): uu tien DASH hon HLS; tran SAP DA chua co link van duoc ghi vao playlist (set `stream.liveUrl` cho tran chua live + chua co link — truoc do bi loai vi thieu liveUrl).

- Cap nhat 22/11 (lan 3): cua so tran SAP DA cua SportlinkTV 36h (sportlinktv.service.js + playlistBuilder.service.js; doi bang bien moi truong SPORTLINKTV_UPCOMING_HOURS).

- Cap nhat 22/11 (lan 4, CHI ap dung SportlinkTV): tran chua co link hien nhan dem nguoc `⏳ Con N phut` / `⏳ Dang cho link` thay cho "Chua co link — cho cap nhat"; tran vua bong lan ma link chua ve duoc GIU trong playlist toi da 30 phut sau gio da (doi bang SPORTLINKTV_WAIT_MINUTES) roi moi bo. Sua o m3uPlaylist.js (sportlinktvWaitLabel) + sportlinktv.service.js (liveUrl). Nguon khac khong doi.

## Luu y
- Da chay thu pipeline (service -> playlistBuilder util -> m3uPlaylist) bang esbuild + du lieu gia, ca file vlc lan -app: ghi du tran live/sap da. Chua test voi JSON that (sandbox khong truy cap duoc sonujson-v6.pages.dev).
- Khong xoa file nao.
- Nhip tao playlist giu nguyen 2 phut/chu ky (khong quet day hon de tranh pham gioi han cron/commit cua GitHub Actions); link tran SportlinkTV vao playlist o chu ky ke tiep sau khi nguon co link.

---

# GO NGUON RERACE — 21/11/2026

Yeu cau: go bo hoan toan nguon Rerace (rerace.net / weelo / strmfree) khoi project.

## Da sua (de len git, ghi de)
- `src/services/playlistBuilder.service.js`: bo import + goi reraceService (live / upcoming / getStreamLinks), cua so upcoming rieng cua Rerace, timeout resolve, log rieng.
- `src/utils/m3uPlaylist.js`: bo Referer ung vien rerace, che do Origin-only (indianservers), loc link /secure/, gioi han server Rerace, nhanh debug Origin.
- `src/utils/playerGet.js`: bo ten nguon, SOURCE_GROUP_ORDER, cong tac bat/tat nguon, knownCdn weelo.live, nhanh `match.source === 'rerace'`.
- `src/utils/streamDebug.js`: bo che do mac dinh bat debug rieng cho Rerace.
- `src/utils/browserFetch.js`: bo regex bat link weelo.live/<token>/index.html (chi con .m3u8).
- `pages/api/proxy/hls.js`: bo REFERER_BY_SOURCE.rerace, ung vien Referer, uu tien Referer weellz, xoa Referer cho indianservers, nhan dien playlist weelo (index.html / style.css).
- `pages/api/playlist/resolve.js`: bo nhanh `source === 'rerace'`.
- `pages/index.jsx`: bo mau/icon Rerace trong SOURCE_META.
- `pages/api/static-playlist/[file].js`, `scripts/generate-playlists.js`: bo 'rerace' khoi SOURCE_KEYS (khong con source-rerace.m3u).
- `scripts/source-domains.mjs`, `source-domains.example.txt`: bo 5 domain Rerace (rerace, weelo, weellz, taifood-blog, api.ppv.st).
- `env.example`: bo toan bo bien RERACE_*.

## Da XOA (phai xoa tay tren git — xem DELETE_ON_GIT.txt)
- `pages/api/rerace/live.js`, `stream.js`, `debug.js`
- `src/services/rerace.service.js`
- `README_RERACE_FIX.txt`, `README_DEPLOY.txt` (ghi chu rieng cua Rerace)

## Luu y
- Chua chay `next build` / test tren site that (sandbox khong co node_modules, khong co mang). Da kiem tra cu phap (`node --check`) tat ca file .js/.mjs va grep: khong con tham chieu rerace/weelo/weellz/taifood/strmfree/indianservers trong code.
- Bien RERACE_* neu dang dat trong Vercel/Render/GitHub Variables thi co the xoa (khong con tac dung).
- Neu repo con file `public/playlists/source-rerace*.m3u` thi xoa di (project ban dau khong co file nay).
- Cac muc FIX cu ben duoi nhac toi Rerace chi la lich su, khong con dung.

---

# FIX 21/11/2026 — Rerace: "live 0/4 có link" + "events.json 404"

- Từ file curl (HAR): bóng đá giờ phát qua https://strmfree.st/embed/soccer/<slug><res> -> /api/v1/sources/<slug> -> /live-externalcdn/<slug><res>/index.m3u8?_t&_ta&_e&_s&_sa (Referer = trang embed, không Origin).
- `rerace.service.js`: thêm resolveStrmfree() (đọc embed + sources API + script cùng site, tự ghép URL nếu API chỉ trả token rời); referer trả về = URL embed; bật trình duyệt dự phòng cho iframe strmfree.st dù RERACE_KEEP_SECURE không bật.
- events.json 404 (weelo.live gỡ feed F1) không còn báo lỗi; đổi URL mới bằng RERACE_EVENTS_URL.
- `m3uPlaylist.js` + `pages/api/proxy/hls.js`: thêm strmfree.st vào Referer ứng viên (không gửi Origin cho host này).
- CHƯA test trên site thật (sandbox chặn mạng). Nếu vẫn 0 link: GET /api/rerace/debug?id=rr_<id> và gửi trace "strmfree".
# FIX 16/11/2026 (lần 2) — Gà Vàng đổi domain sang https://gavang13.live

- Đổi domain mặc định trong `gavang.service.js`, `scripts/source-domains.mjs`, danh sách Referer ở `m3uPlaylist.js`.
- Thêm log "[gavang] trang chủ ... KHÔNG có .match-card nào ..." để biết nếu domain mới đổi cấu trúc / là SPA render bằng JS.

# FIX 16/11/2026 — Gà Vàng: trận đang live mất link (trước giờ đá vẫn hiện danh sách)

- Triệu chứng khớp code: danh sách trận (trang chủ / API) vẫn đọc được, nhưng trận live không lấy được link thì BỊ BỎ HẲN khỏi playlist.
- `gavang.service.js` (gavangz.net, đọc HTML): (1) href trận tuyệt đối trỏ domain cũ -> dựng lại trên domain đang dùng; (2) đọc link trang chi tiết
  nhiều tầng: cấu trúc cũ -> mọi thuộc tính data-* chứa .m3u8/.flv -> quét regex cả trang (giải mã &quot; \u0026 \/); (3) vẫn không có -> mở bằng
  trình duyệt headless (tối đa GAVANG_BROWSER_MAX=8 trận/lần chạy; tắt GAVANG_BROWSER_FALLBACK=off); (4) log "[gavang] trận live: N, lấy được link: M"
  và "[gavang] KHÔNG lấy được link trận live ..." (HTTP status, tiêu đề, có grid không, số lần thấy m3u8/flv). Domain mặc định gavang13.live (domain mới theo SOURCE_DOMAINS trên git; trước đó gavangz.net).
- `gavang33.service.js`: KHÔNG thay đổi (người dùng xác nhận Gà Vàng 33 vẫn chạy tốt).
- Chỉ sửa file, không xóa file nào.

# FIX 15/11/2026 (lần 7) — Giờ Vàng: đọc BLV trong trang bị hỏng + bỏ luồng của trận khác

- Log "[chọn-link] ... BLV trong trang: (không đọc được)": JSON trong trang viết bằng &quot; nên regex đọc BLV (cả nhãn "Giovang 1 - <BLV>") chưa từng khớp.
  Giờ đọc trên bản đã giải mã. Trận gán BLV X mà trang chỉ có luồng BLV khác (vd trận cũ đã hết giờ, BLV chuyển sang phát môn khác nhưng
  danh sách vẫn ghi tên trận cũ) -> BỎ trận (không ghi kênh phát nhầm). Tắt: GIOVANG_STRICT_BLV=off.
- Môn 'bongchay' (bóng chày) có icon ⚾ thay vì ⚽.

# FIX 15/11/2026 (lần 6) — Giờ Vàng: thêm dòng log chẩn đoán "[giovang][chọn-link]"

- Mỗi trận in 1 dòng: môn, BLV được gán (từ live.json/all.json), danh sách BLV=id luồng có trong trang, link số 1 được chọn, URL trang trận.
  "BLV gán=[TRỐNG]" nghĩa là danh sách trận không có field "blv" -> cần cách khác để biết BLV của trận.

# FIX 15/11/2026 (lần 5) — fixture-detail KHÔNG có link phát

- JSON thật của /api/fixture-detail/<id> chỉ gồm thông tin trận (đội, tỷ số, giải, trạng thái), không có .m3u8/BLV -> bước lần 4 tắt mặc định
  (bật lại: GIOVANG_FIXTURE_API=on). Link phát vẫn nằm trong HTML trang trận (khối blv-xxx / pc_stream_url).

# FIX 15/11/2026 (lần 4) — Giờ Vàng: lấy link từ API fixture-detail

- DevTools: trang trận gọi GET https://live-api.keonhacaitp.one/api/fixture-detail/<id> (id chuỗi, vd en7upowohmwm; Origin/Referer giovang.cam).
  Link trong HTML có thể là bản cache cũ -> `giovang.service.js` gọi thêm API này, ưu tiên link tươi của ĐÚNG BLV được gán, link HTML làm dự phòng.
  Cấu trúc JSON chưa biết chắc nên đọc tổng quát; log "[giovang] fixture-detail <id>: HTTP ..., N link .m3u8, BLV: ...; trường: ..." để chỉnh tiếp.

# FIX 15/11/2026 (lần 3) — Giờ Vàng: tắt mặc định bước trình duyệt bắt link bóng đá

- Log thật: "mở trang bằng trình duyệt xong nhưng không bắt được request .m3u8 nào" -> headless không bắt được link player của trang này, chỉ tốn ~14s/trận.
  Mặc định TẮT (bật lại: GIOVANG_FOOTBALL_BROWSER=on). Bản sửa chính là chọn link theo BLV được gán cho trận (lần 2).

# FIX 15/11/2026 (lần 2) — Giờ Vàng: chọn đúng link theo BLV được gán cho trận

- Log thật: trang trận liệt kê link của NHIỀU BLV (blv-cay, blv-sun, blv-can, blv-mason...), mỗi BLV 1 id luồng. Trước đây code lấy link
  mới nhất/chất lượng cao nhất trong cả trang => trận bóng đá dễ lấy nhầm link của BLV khác (BLV đó không phát trận này) -> lỗi.
- `giovang.service.js`: đọc cặp {key BLV -> link} trong trang, lấy key BLV của trận từ live.json/all.json (field "blv", vd ["blv-can"]) và
  đặt link của ĐÚNG BLV đó lên đầu (trước cả link trình duyệt bắt được). Không tìm thấy BLV trong trang thì giữ thứ tự cũ.
- Log: "[giovang] ...: BLV được gán blv-can -> ưu tiên link ..." hoặc "BLV được gán (...) không có trong trang (trang có: ...)".

# FIX 15/11/2026 — Giờ Vàng: bóng đá không xem được, bóng rổ/bóng chuyền vẫn xem bình thường

- Nguyên nhân (suy ra từ code + playlist, CHƯA test được trên site thật): cùng CDN vcdn.cloud, cùng Referer https://giovang.cam/, chỉ bóng đá hỏng
  => không phải lỗi Referer/domain mà là LINK bóng đá đọc từ HTML trang trận không phải link player thật đang phát.
- `giovang.service.js`: bóng đá mở trang trận bằng trình duyệt, bấm Play, bắt link .m3u8 thật (kèm Referer thật + status); link mở được (status < 400)
  lên đầu (Giovang 1), link đọc từ HTML làm server dự phòng (Giovang 2, 3). Môn khác giữ nguyên cách cũ.
  Domain mặc định giovang.love -> giovang.cam. Tắt: GIOVANG_FOOTBALL_BROWSER=off; chỉnh: GIOVANG_BROWSER_CAPTURE_MS, GIOVANG_FOOTBALL_MAX_SERVERS.
- `m3uPlaylist.js`: bóng đá giữ tới 3 server/trận (môn khác 1); thêm giovang.cam vào danh sách Referer.
- `playlistBuilder.service.js`: timeout resolve Giờ Vàng 18s -> 45s. `scripts/source-domains.mjs`: default giovang.cam.
- Cách đọc log: tìm dòng "[giovang] ... trình duyệt bắt được N link thật" hoặc "KHÔNG bắt được link .m3u8 mở được".
- Chỉ sửa file, không xóa file nào.

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

## FIX 16/11/2026 — Gà Vàng không hiện trận live (domain gavang13.live)
- Nguyên nhân: trang chi tiết trận đổi cấu trúc. Link phát không còn nằm trong `#commentators-grid .commentator-card[data-stream-url]`
  mà nằm trong iframe `https://playyyz4.cc/e?hls=<m3u8 đã mã hóa %3A%2F>&flv=<flv>&cdn=tencent...`. Regex cũ tìm `.m3u8` thô nên không thấy
  => trận live không có link bị loại hết.
- Sửa `src/services/gavang.service.js`: đọc hls/flv từ iframe (giải mã %), quét thêm chuỗi đã giải mã %, lấy thêm các server BLV ở
  `/truc-tiep/<slug>/link/N/`, nhận cả link `/basketball/`, đổi selector của trình duyệt headless.
- Log gọn: chỉ in 1 dòng "[gavang] N trận chưa có BLV (bị bỏ), X/Y trận live có link". Muốn xem chi tiết từng trận: đặt GAVANG_DEBUG=on.
- Giảm tải (log timeout 8000ms / "quá 90s không phản hồi"): chỉ vào trang chi tiết các trận live ĐÃ có BLV trên trang chủ, bỏ trận trùng lặp,
  tối đa 4 trang /link/N/ mỗi trận, headless tối đa 3 trận/lần (GAVANG_BROWSER_MAX), hết 60s thì dừng và giữ kết quả đã lấy.

## FIX 16/11/2026 (lần 3) — Gà Vàng (gavang13.live) vẫn không hiện link trận đang live
(Chỉ Gà Vàng — KHÔNG đụng Gà Vàng 33 / gavang33.service.js.)
- API `seo.alpro-api-service.com/v1/match-details?uuid=...` chỉ trả tỉ số/odds/thống kê, KHÔNG chứa link phát. Link nằm ở iframe player
  `https://playyyz4.cc/e?hls=<m3u8>&flv=<flv>` -> CDN `playback.livetl004.com/live/<id>.m3u8|.flv`.
- `gavang.service.js`:
  1. Quét link: giải mã TỪNG token `%3A%2F` (bản cũ decodeURIComponent cả trang, gặp "%" lẻ là hỏng -> không bắt được link mã hóa), bỏ URL trang player.
  2. Trang chi tiết gửi kèm Referer; nếu iframe player không kèm hls=/flv= thì mở thẳng iframe và quét link trong đó.
  3. Không còn bỏ qua trận live không có ảnh BLV trên thẻ (trước đây có 1 trận có BLV là các trận kia bị bỏ hẳn). `GAVANG_ONLY_BLV=on` để quay lại kiểu cũ.
  4. Nhận trận live rộng hơn (class có "live", trạng thái 1H/2H/HT/ET..., có phút thi đấu).
  5. `getStreamLinks()` (builder gọi sau) đặt lại hạn 25s + ngân sách headless và dùng cache 3 phút (trước đây scanDeadline cũ đã hết hạn nên trả rỗng).
  6. Log chẩn đoán mặc định BẬT cho tối đa 3 trận không lấy được link (kèm URL iframe).
- Referer/Origin phát link: thêm `https://playyyz4.cc/` (origin iframe thật, đổi bằng `GAVANG_PLAYER_DOMAIN`) lên đầu ở `m3uPlaylist.js` và `pages/api/proxy/hls.js`;
  link lấy từ iframe còn gắn sẵn `referer` đúng origin iframe.
- `playlistBuilder.service.js`: timeout resolve cho gavang 25s (mặc định 4,5s không đủ khi phải tải lại trang chi tiết).

## FIX 19/11/2026 — Xôi Chè (xoiche.live) không lấy được link các trận live
- Trang trận hiện có bộ chọn chất lượng FHD/HD/SD và nạp luồng SAU khi tải ("Đang tải luồng phát..."), nên link không còn chắc nằm ở field `stream_url`.
  Bản cũ chỉ đọc `stream_url` -> trận live không có link bị chuyển thành "Chờ BLV" rồi mất khỏi tab live.
- Sửa `src/services/xoiche.service.js`:
  1. Quét SÂU mọi field của BLV tìm link .m3u8/.flv (hls_url, fhd/hd/sd, object/mảng lồng nhau...), ưu tiên FHD > HD > SD, bỏ rtmp/backup/push.
  2. Cờ `is_live=false` của BLV: nếu trận site báo 'live' mà không còn link nào thì thử lại bỏ qua cờ (đặt `XOICHE_STRICT_LIVE=on` để tắt).
  3. Trận live mà danh sách không có link: thử vài API chi tiết `/api/matches/<id>/...` (quét sâu), rồi mở trang trận bằng trình duyệt headless
     (kèm `?blv=`) và bắt request .m3u8 player gọi. Giới hạn: `XOICHE_BROWSER_MAX` (mặc định 4 trận/lượt), `XOICHE_RESOLVE_BUDGET_SEC` (mặc định 55s),
     `XOICHE_BROWSER=0` để tắt trình duyệt. Kết quả nhớ 3 phút (thất bại nhớ 1 phút).
  4. Log chẩn đoán "[xoiche] KHÔNG lấy được link trận live ..." (HTTP của từng API đã thử, keys + mẫu field BLV) tối đa 3 trận/lượt.
- (19/11/2026, bổ sung sau khi có HTML trang trận thật) Link nằm trong `__NUXT_DATA__` của TRANG TRẬN: `data['match-detail-<slug>'].match.commentator_streams[].stream_url`
  = `https://livecdn321.cdnfastter.xyz/live/live_xxx/index.m3u8?token=...&expires=...` (CDN mới cdnfastter.xyz, có token). Danh sách trang chủ/lịch không kèm link này.
  -> `xoiche.service.js` giờ GET thẳng trang trận (axios, không cần trình duyệt), giải mã `__NUXT_DATA__` và lấy link; API đoán + trình duyệt chỉ còn là dự phòng.
  Player của site đặt `referrerpolicy="no-referrer"` nên link xoiche KHÔNG còn bị ép Referer cứng (m3uPlaylist tự dò [không Referer, site]).
- (19/11/2026) Log "Quét nguồn xoiche:live: 0 trận" dù có trận live: `leagueName()` lấy country của đội nhà = 'intl' (Corinthians) nên Serie A Brazil bị đổi thành
  "Serie A (giai khac)" và bị bộ lọc giải nhỏ loại. Sửa: lấy country KHÁC 'intl' của bất kỳ đội nào; Serie A id 99 = "Brazilian Serie A" (được giữ).

## 19/11/2026 — Tổng kết trạng thái từng nguồn khi generate (CHỈ log, không đụng playlist)
- `scripts/generate-playlists-standalone.mjs`: cuối mỗi lượt quét in bảng từng nguồn: ✅ OK / ⚠️ CẢNH BÁO / ❌ LỖI / ⚪ TRỐNG, kèm số trận live có link/tổng, sắp đá và LÝ DO
  (lấy từ chính các dòng log lỗi của nguồn đó, vd "0 trận live có link", "quá 90s không phản hồi", "KHÔNG lấy được link trận live ...").
- Hiện cả trong GitHub Step Summary (ghi khi số liệu đổi) và annotation ::error/::warning trên trang chạy workflow (chỉ khi trạng thái ĐỔI, không spam mỗi 2 phút).
- KHÔNG ghi bất cứ thông báo nào vào file .m3u / tên kênh / link trận — app IPTV không thấy gì thêm.

## 19/11/2026 — Ghi chú quy tắc (FILE MỚI)
- `HUONG_DAN_DEPLOY.md` (file mới): ghi chú ngắn — mỗi lần fix xong tự tạo folder `changed-files/` chứa file sửa + file mới (giữ nguyên đường dẫn), không xóa file, đóng gói zip.
- (19/11/2026) Bảng tổng kết: giữ tới 600 ký tự mỗi dòng lỗi (trước 220) để không cắt mất phần chẩn đoán như "HTTP 200...".

## FIX 19/11/2026 — Xôi Chè bị lọc mất trận ASEAN Club Championship (vd Công an Hà Nội vs Johor DT)
- `src/utils/leagueFilter.js`: tên giải có chữ "championship" dính BLOCK_LEAGUE (để chặn English Championship = hạng 2 Anh) nên bị loại
  TRƯỚC khi tới bước ALLOW ("bỏ N trận giải nhỏ: ASEAN Club Championship"). Thêm `FORCE_ALLOW` (ASEAN Club Championship / Shopee Cup / ASEAN Championship):
  bỏ qua bước chặn giải nhưng VẪN áp bước chặn đội nữ/trẻ (U21, B, II...). English Championship vẫn bị chặn như cũ; bản nữ của ASEAN Club vẫn bị loại.
- Áp dụng chung cho các nguồn đang bật lọc giải (mặc định xoilac, xoigac, xoiche).

## FIX 19/11/2026 (lần 3) — Gà Vàng bị lọc mất trận Công an Hà Nội vs Johor DT (gavangz.link/truc-tiep/cong-an-ha-noi-fc-vs-johor-darul-tazim-fc-ngay-19-11-2026)
- Bộ lọc giải (`src/utils/leagueFilter.js`) áp cho Gà Vàng khi `LEAGUE_FILTER_SOURCES` có `gavang` hoặc `all`. Gà Vàng đặt tên giải khác Xôi Chè
  (vd \"AFC Champions League Two\" dính luật `league two`, tên có \"Championship\"...) nên trận bị loại ở bước CHẶN trước khi tới ALLOW.
- Mở rộng `FORCE_ALLOW`: ASEAN Club*/ACCC/AFF Club/Cúp C1-C2 Đông Nam Á/Cúp C1-C2 châu Á/AFC Champions League Two|2|Elite/ACL2/AFC Cup/Cúp CLB châu Á.
- Sửa thêm: FORCE_ALLOW trước đây bỏ qua cả luật nữ/trẻ trong tên giải (\"... Women\" lọt) -> thêm `BLOCK_ALWAYS` luôn loại nữ/trẻ/futsal/esports.
- English Championship, League Two, Hạng 2, Serie C... vẫn bị chặn như cũ (đã chạy thử).
- Nếu vẫn mất trận: xem log `[leagueFilter:gavang] bỏ N trận giải nhỏ: <tên giải> [lý do]`, rồi thêm tên giải vào biến `LEAGUE_ALLOW` (không cần sửa code).

## 19/11/2026 (lần 4) — Gà Vàng: loại cả trận sắp đá chưa có BLV (theo yêu cầu)
- `src/services/gavang.service.js`: trận live không có BLV/link vốn đã bị bỏ; giờ trận SẮP ĐÁ mà thẻ trận chưa có ảnh BLV cũng bị bỏ.
  Nếu không trận sắp đá nào có ảnh BLV thì giữ nguyên + log cảnh báo (tránh mất sạch khi site đổi giao diện). Tắt: `GAVANG_UPCOMING_NEED_BLV=off`.
- Lưu ý: tên giải \"Asean Club Championship Shopee Cup\" đã test -> bộ lọc giải GIỮ (FORCE_ALLOW). Nếu trận Công an Hà Nội vs Johor DT vẫn mất, nguyên nhân
  không phải bộ lọc giải: xem log `[gavang] ... trận chưa có BLV (bị bỏ)` / `bỏ ... trận \"live\" đã quá giờ` / `KHÔNG lấy được link trận live`.
