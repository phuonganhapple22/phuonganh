# Domain các nguồn: khai báo trong 1 biến + tự quét domain chết (Check Domains)

## 0g. Domain cũ chuyển hướng / bị 403 nhưng Generate vẫn quét domain cũ (31/10/2026)
**Triệu chứng:** Xôi Lạc quét được danh sách trận nhưng MẤT các trận đang live; log có
`[xoilac] lỗi mở trang nhúng https://xl365.domainkqt.cc/... (Referer https://xoilacvbx.tv): Request failed with status code 403`;
chỉ khi chạy `Check Domains` tay rồi lưu domain mới thì trận live mới hiện lại.

**Nguyên nhân:** (1) `xoilac.service.js` đọc domain 1 lần lúc khởi động rồi dùng mãi, kể cả làm Referer/Origin gửi cho trang nhúng — trang nhúng
chỉ nhận Referer là domain MỚI nên domain cũ bị 403; (2) trong code còn cứng domain cũ (`xoilacxyc.io`, `xoilacxcw.tv`) trong danh sách Referer/Origin;
(3) `Check Domains` coi domain cũ "còn sống" (vẫn mở được trang chủ) hoặc "bị chặn bot" (403) nên không bao giờ tìm domain mới; Generate chỉ
gọi Check Domains khi domain cũ REDIRECT.

**Đã sửa (không cần chạy tay nữa):**
- **Service tự theo domain thật lúc chạy** (`src/services/xoilac.service.js` + file mới `src/utils/liveDomains.js`): theo redirect của trang chủ và dùng
  domain đích làm domain chính; Referer/Origin gửi trang nhúng + API tỉ số = domain đang sống (không còn domain cũ cứng trong code, kể cả
  `m3uPlaylist.js`, `pages/api/proxy/hls.js`). Domain lỗi (403/mạng/trang nhái) bị bỏ qua 10 phút rồi thử lại.
- **Trang nhúng 403 với mọi Referer** → service tự dò domain dự phòng (`XOILAC_FALLBACK_DOMAINS`, lịch sử `data/source-domains.json`, domain thấy trong link
  trang chủ) và CHỈ nhận domain mà trang nhúng thật sự chấp nhận làm Referer. Không có domain nào dùng được → tự gọi workflow `Check Domains`
  (`force_discover` + loại các domain đã bị từ chối), tối đa 1 lần/45 phút/nguồn. Tắt: biến `DOMAIN_RECHECK=off`.
- **Generate báo domain đang dùng bị lỗi** (`unhealthy_keys` ở bước Expand): DNS/kết nối chết, 404/410, hoặc 403/Cloudflare với nguồn gọi HTTP thuần
  (`plainHttp`: xoilac, gavang, gavang33). Nguồn có trình duyệt headless (giovang, saoke, bonglau, phalang, xoigac, xoiche...) bị 403 khi gọi thẳng
  KHÔNG bị coi là hỏng (tránh đổi nhầm domain đang chạy tốt). Các nguồn lỗi → tự gọi `Check Domains` với `restart_generator=true`.
- **Check Domains**: ô mới `force_discover` (bắt buộc dò domain mới dù domain hiện tại nhìn "sống") và `exclude_domains` (domain không được chọn).
  Nguồn `plainHttp` bị 403 giờ tự tìm domain thay thế; ứng viên phải qua đủ `verifyRedirectTarget` (gọi lại 2 lần, bằng chứng mạnh, cấu trúc trang thật),
  KHÔNG dùng phương án "chưa xác minh". Biến `BLOCKED_AUTO_SWITCH`: `plain` (mặc định) / `all` / `off`. Nguồn ghim (`# pin`) vẫn không bao giờ tự đổi.
- Biến tuỳ chọn cho Xôi Lạc: `XOILAC_FALLBACK_DOMAINS=d1,d2`, `XOILAC_EXTRA_REFERERS=d1,d2`, `XOILAC_BAD_DOMAIN_TTL_MS`, `XOILAC_STALE_PROBE_GAP_MS`.
- Cần secret `GH_VARIABLES_TOKEN` (mục 2) để Check Domains GHI được domain mới vào biến; không có thì service vẫn tự dùng domain thật trong lúc chạy.


## 0f. Tự chạy MỖI NGÀY + tự ghi domain mới khi redirect (24/10/2026)
- **Lịch:** workflow `Check Domains` chạy lại tự động mỗi ngày lúc **03:00 giờ VN** (cron `0 20 * * *` = giờ UTC), quét **tất cả** nguồn. Tắt: xoá khối `schedule:` trong `.github/workflows/check-domains.yml`; đổi tần suất: sửa cron (vd `0 */12 * * *`).
- **Domain cũ đang chuyển hướng sang domain mới → tự ghi vào biến `SOURCE_DOMAINS`** (rồi chạy lại Generate Playlists), áp dụng cho cả 9 nguồn trang web: `giovang, gavang, gavang33, saoke, bonglau, xoilac, xoigac, xoiche, phalang`.
- **Chỉ ghi khi domain đích qua đủ các bước kiểm tra** (`verifyRedirectTarget` trong `scripts/check-domains.mjs`), thiếu 1 bước là KHÔNG ghi, chỉ báo ⚠️ trong Summary kèm dòng `tên=domain` để bạn tự quyết:
  1. `https`, không phải IP trần, không thuộc nhóm không tin cậy (Facebook/Telegram/Zalo/YouTube, rút gọn link, blog miễn phí, nhà bán tên miền...).
  2. Tên miền đích phân giải được DNS và kết nối TLS hợp lệ (chứng chỉ sai là lỗi).
  3. Gọi lại domain đích **độc lập**: HTTP 2xx, không phải trang đỗ/rao bán, không phải trang cá cược/nhà cái, có từ khoá nguồn + từ khoá thể thao. Xôi Lạc còn phải có cấu trúc trang thật: đủ `main-grid-match` + `data-fid` (đúng thứ `xoilac.service.js` đọc), **hoặc** ít nhất 5 link trận dạng thật `/truc-tiep/<tên-trận>-luc-HHMM-ngay-DD-MM-YYYY` (đã đối chiếu trên trang xoilacxcb.tv) — chống trang nhái.
  4. Đích **không tiếp tục chuyển hướng** sang host khác (không nhận chuỗi redirect chưa ổn định).
  5. **Bằng chứng mạnh:** tên miền đích chứa tên nguồn, hoặc tiêu đề trang nhắc tên nguồn (chỉ có chữ trong footer thì không đủ).
  6. **Gọi lại lần 2** sau vài giây (env `CONFIRM_MOVE_DELAY_MS`, mặc định 5000) vẫn đạt y như lần 1 — loại trang chập chờn.
  7. Đích bị Cloudflare/WAF chặn khi gọi lại → không xác minh được nội dung → không tự ghi.
- Nguồn **ghim** (`# pin` / `PINNED_SOURCES`) không bao giờ tự đổi. `chuoichientv` (code tự dò `liveNN`), các domain `*-player` và `*-api` chỉ được báo cáo, không tự ghi (không có nội dung trang để xác minh, hoặc ghi cố định sẽ làm mất cơ chế tự dò).
- **Chuối Chiên** tự dò `liveNN.chuoichientv.me` trong code, nên Check Domains chỉ báo ℹ️ (không tính là lỗi chưa xử lý). Nếu dòng `chuoichientv=https://liveNN...` đang BẬT trong biến `SOURCE_DOMAINS` thì nó ÉP cứng domain đó: hãy xoá hoặc comment (`#`) dòng này để code luôn tự dò. (24/10/2026) `chuoichientv.service.js` cũng đã sửa: domain bị ép mà chết thì bỏ qua và tự dò `liveNN`.
- Lúc chạy Generate vẫn có bước tự theo redirect (không ghi biến); nay bước đó cũng từ chối đích thuộc nhóm không tin cậy.
- **CẦN 1 LẦN:** secret `GH_VARIABLES_TOKEN` (xem mục 2) — không có thì workflow vẫn quét/báo cáo nhưng không ghi được biến.

### Xôi Lạc: dò domain đổi chữ cái
Xôi Lạc xoay domain bằng cách **đổi chữ cái sau `xoilacx`** (đã thấy `xoilacxc.tv → xoilacxcw.tv → xoilacxyc.io → xoilacxbn.tv → xoilacxbr.tv`), kiểu này bộ dò chung (đổi số/đuôi/hậu tố) không đoán được. Khi domain Xôi Lạc chết hẳn (không còn redirect), `Check Domains` thử `xoilacx` + 1-2 chữ cái trên 12 đuôi (~8.400 tên), rồi nếu chưa ra mới thử 3 chữ cái trên đuôi `tv`/`io` (~35.000 tên). Bỏ qua đuôi có DNS wildcard; ứng viên chỉ được nhận khi đủ cấu trúc trang thật (mục 3 ở trên). Ứng viên bị Cloudflare chặn không được dùng làm phương án dự phòng (quá dễ là trang nhái). Thời gian tìm tối đa 240 giây (env `DISCOVER_BUDGET_MS`).

## 0c. Cải tiến Check Domains (08/10/2026)
- **Quét song song** (mặc định 3 nguồn cùng lúc, đổi bằng env `CHECK_CONCURRENCY`) — trước đây tuần tự nên nhiều nguồn chết mất rất lâu.
- **Xác nhận lại trước khi kết luận CHẾT:** nguồn báo chết được kiểm tra lại sau 15 giây (env `CONFIRM_DOWN_DELAY_MS`) để loại lỗi mạng thoáng qua của runner, tránh đổi nhầm domain còn sống.
- **Thử lại domain từng dùng:** domain hay xoay vòng quay lại nên các domain trong lịch sử (`data/source-domains.json`) được thử TRƯỚC khi dò biến thể tên/đuôi.
- **Hiện tiêu đề trang** trong bảng kết quả + log, và liệt kê các ứng viên bị LOẠI kèm lý do (vd trang đỗ tên miền, trang cá cược mạo danh) để biết vì sao không chọn.
- **Lọc trang cá cược mạo danh nhưng không loại nhầm trang xem bóng đá:** chỉ loại khi tiêu đề không nói về xem trực tiếp, nhắc "trực tiếp/xem bóng đá/lịch thi đấu/BLV" rất ít (<= 3 lần) và có đủ từ khoá cá cược (tiêu đề cá cược + >= 2 từ khoá, hoặc >= 4 từ khoá). Trang xem bóng đá thật dù có quảng cáo nhà cái vẫn được giữ.

## 0d. Ghim domain + chặn đổi nhầm (08/10/2026)
Sự cố: `giovang.rent` (trang xem bóng đá thật) bị báo nhầm là trang cá cược → Check Domains đi tìm "domain thay thế" và TỰ GHI `giovang.io` (bị Cloudflare chặn, chưa xác minh) vào `SOURCE_DOMAINS`. Đã chặn từ gốc:
- **Ghim nguồn (không bao giờ tự đổi):** thêm `# pin` (hoặc `# ghim`) cuối dòng trong biến `SOURCE_DOMAINS`, vd `giovang=https://giovang.rent   # pin`; hoặc đặt biến GitHub `PINNED_SOURCES` = `giovang,saoke`. Nguồn ghim chỉ được BÁO CÁO (📌), không tự đổi domain ở Check Domains và không tự theo redirect lúc chạy Generate.
- **Domain chưa xác minh (bị Cloudflare chặn bot) chỉ được dùng khi domain hiện tại đã CHẾT HẲN.** Domain hiện tại còn trả nội dung (nghi ngờ/đã chuyển) thì không đổi sang domain chưa xác minh. Muốn nới: biến `DISCOVER_ACCEPT_BLOCKED=always`; muốn tắt hẳn: `0`.

## 0b. Sửa biến SOURCE_DOMAINS thì Generate tự chạy lại (05/10/2026)
GitHub không có sự kiện "biến Actions vừa đổi", nên workflow `Watch SOURCE_DOMAINS` (`.github/workflows/watch-source-domains.yml`) canh thay thế:
- Workflow này CHẠY THỦ CÔNG (đã bỏ lịch tự chạy 5 phút): sửa biến xong thì bấm Run workflow. Nó so mã băm nội dung biến với mã lưu ở `data/source-domains.hash`.
- Khác nhau → lưu mã mới rồi chạy lại `Generate Playlists` (run cũ bị huỷ nhờ `cancel-in-progress`). Giống nhau → không làm gì.
- Đổi dấu cách thừa / xuống dòng CRLF không tính là thay đổi.
- Lần chạy đầu tiên chỉ ghi mã, không chạy lại Generate.
- Cách dùng: Actions > Watch SOURCE_DOMAINS > Run workflow. Ô `force` mặc định BẬT = luôn chạy lại Generate; tắt ô này thì chỉ chạy lại khi biến đã đổi.
- Khi `Check Domains` tự sửa biến, Generate có thể bị khởi động lại 2 lần (1 từ Check Domains, 1 từ Watch) — vô hại.

## 0. Nguồn domain mà Generate đọc (cập nhật 05/10/2026)
**Thứ tự ưu tiên:** biến GitHub `SOURCE_DOMAINS` → file git `data/source-domains.txt` (hoặc `source-domains.txt`) → biến riêng lẻ cũ → domain mặc định trong code.
- Sửa domain trong **biến `SOURCE_DOMAINS`** là có tác dụng ngay ở lần chạy sau; file git cũ KHÔNG đè lên biến (nếu khác nhau, Summary chỉ cảnh báo file git đã cũ).
- File git (do `Check Domains` tự lưu) chỉ điền cho nguồn nào biến chưa khai báo — dùng để khôi phục khi biến bị xoá/trống.
- Code `xoigac.service.js` không còn cứng `xoigac.live` / `xoigac.top`: chỉ dùng domain đã cấu hình. Muốn thêm domain dự phòng thì đặt biến môi trường `XOIGAC_MIRRORS=domain1,domain2`.

### Check Domains tìm domain mới tốt hơn (FIX 05/10/2026)
- Domain cũ còn trả HTTP 200 nhưng nội dung không còn là nguồn (bị bán/đổi chủ) → trạng thái `suspect` giờ cũng kích hoạt tìm domain mới (trước đây chỉ `down` / `moved`).
- Ứng viên bị Cloudflare chặn IP GitHub nhưng tên miền chứa tên nguồn (vd `xoigacN.xxx`) và phân giải được DNS: nếu không có ứng viên nào xác minh được thì dùng tạm, ghi rõ "CHƯA xác minh nội dung". Tắt bằng biến môi trường `DISCOVER_ACCEPT_BLOCKED=0`.
- Thử thêm `xoigac1…10`, `xoigac24…26` và mirror đã biết (`xoigac.top`).
- Domain đổi sang tên hoàn toàn khác thì script không đoán được: chạy tay `Check Domains` với ô `extra_candidates` (domain bạn biết).

## 1. Khai báo TẤT CẢ domain trong 1 biến `SOURCE_DOMAINS`
Repo → **Settings → Secrets and variables → Actions → tab Variables → New repository variable**
- Name: `SOURCE_DOMAINS`
- Value: mỗi dòng `tên=domain` (dòng bắt đầu bằng `#` là ghi chú). Copy mẫu bên dưới (cũng có trong file `source-domains.example.txt`) rồi sửa domain cần đổi:

```
# Mỗi dòng: tên=domain. Dòng bắt đầu bằng # là ghi chú. Xoá/để trống 1 dòng = dùng domain mặc định trong code.
# Quét tự động: workflow "Check Domains" sẽ tự sửa dòng nào có domain chết.
giovang=https://giovang.blog
gavang=https://gavanglinkp.tv
gavang33=https://gavang33.me
xoilac=https://xoilacxc.tv
xoigac=https://xoigac.live
saoke=https://vip3.saoketv40.xyz
bonglau=https://lau05.bonglautv1.pro
phalang=https://phalang.live
# chuoichientv=https://live05.chuoichientv.me   # tuỳ chọn: bỏ # sẽ ÉP cố định domain này (mặc định code tự dò liveNN.chuoichientv.me)
chuoichientv-player=https://live.chuoichien.tv
saoke-player=https://sk.mediastation.live
bonglau-player=https://live.chuoichien.tv
giovang-api=https://live-api.keonhacaitp.one
saoke-api=https://skapi.66887979.xyz
gavang33-api=https://gavangtv-api.adviceme.io
xoilac-api=https://fb-api.sportliveapiz.com
phalang-api=https://api.plapi202624081158.com
chuoichientv-api=https://api-v2.chuoichientv.net/v2
bonglau-api=https://api-v2.chuoichientv.net/v2
```

- Muốn đổi domain 1 nguồn: **sửa dòng đó** rồi lưu — lần chạy `Generate Playlists` kế tiếp (hoặc bấm Run workflow) dùng domain mới. Không cần sửa code.
- Xoá/để trống 1 dòng = nguồn đó dùng domain mặc định trong code. Không cần khai báo đủ — chỉ khai báo nguồn nào cần đổi.
- "tên" là key ngắn ở bảng trên **hoặc** đúng tên biến cũ (`GIOVANG_DOMAIN`, `SAOKE_BASE_URL`...), không phân biệt hoa thường. Gõ sai tên thì bị bỏ qua và hiện cảnh báo (kèm gợi ý, vd *"ý bạn là giovang?"*) ở mục Summary của lần chạy.
- Có thể viết dạng JSON thay cho dòng: `{"giovang":"https://giovang.blog","saoke":"https://vip3.saoketv40.xyz"}`.
- Giá trị thiếu `https://` sẽ tự thêm; dấu `/` cuối tự bỏ. Với domain API có đường dẫn (vd `.../v2`) thì giữ nguyên đường dẫn.
- **Thứ tự ưu tiên** từng nguồn: dòng trong `SOURCE_DOMAINS` → biến riêng lẻ cũ (nếu bạn đã tạo, vd `GIOVANG_DOMAIN`) → domain mặc định trong code.
- Dòng `chuoichientv` (trang xem) để dạng ghi chú: code **tự dò** `liveNN.chuoichientv.me`; khai báo sẽ ÉP cố định 1 domain.
- **Tự theo redirect:** nếu domain trang web của một nguồn (khai báo hoặc mặc định) đang **chuyển hướng sang domain khác** (vd `giovang.city → giovang.blog`) và trang đích đúng là nguồn đó, bước **Expand source domains** dùng luôn domain mới cho lần chạy này (link, Referer, Origin trong playlist) — bạn không phải sửa gì. Bảng Summary ghi `tự theo redirect (khai báo: ...)` và có cảnh báo kèm dòng `tên=domain-mới` nên cập nhật vào `SOURCE_DOMAINS` (hoặc bấm `Check Domains` để nó tự cập nhật + lưu vào git).
  - Chỉ áp dụng cho domain **trang web** của: `giovang`, `gavang`, `gavang33`, `xoilac`, `xoigac`, `saoke`, `bonglau`, `phalang`. Domain API, player/Referer và Chuối Chiên (tự dò `liveNN`) không bị đụng tới.
  - An toàn: chỉ tin domain mới khi trang đích **không phải trang rao bán/hết hạn** và (nội dung có tên nguồn **hoặc** tên miền mới chứa tên nguồn như `khandai`, `giovang`...). Chuyển hướng sang trang lạ thì bị bỏ qua + cảnh báo, vẫn dùng domain bạn khai báo.
  - Chỉ có tác dụng khi domain cũ **còn redirect**. Domain cũ chết hẳn thì dùng `Check Domains` để tìm domain mới.
  - Domain theo redirect chỉ dùng trong lần chạy đó, không tự ghi vào biến. Vòng lặp 2 phút của một lần chạy dùng domain đã chọn lúc bắt đầu; domain mới hơn sẽ được nhận ở lần chạy workflow kế tiếp.
  - Tắt: đặt biến GitHub `FOLLOW_REDIRECTS` = `0`.
- Mỗi lần chạy `Generate Playlists`, bước **Expand source domains** in bảng "Domain các nguồn đang dùng" ở mục Summary để bạn kiểm tra.

## 2. Quét domain chết & tự cập nhật (workflow `Check Domains`, tự chạy mỗi ngày + chạy tay)
Workflow `Check Domains` quét xem domain của từng nguồn còn sống không. Domain nào chết hoặc đã chuyển
hướng → tự tìm domain mới → **sửa đúng dòng đó trong `SOURCE_DOMAINS`** (giữ nguyên các dòng/ghi chú khác) →
chạy lại `Generate Playlists` để dùng ngay.

### Thiết lập 1 lần
1. GitHub → **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**
   - Repository access: chọn đúng repo này
   - Repository permissions → **Variables: Read and write**
2. Repo → **Settings → Secrets and variables → Actions → Secrets → New repository secret**
   - Name: `GH_VARIABLES_TOKEN`, Value: token vừa tạo.

Không có secret này workflow vẫn quét và báo cáo, nhưng **không ghi được biến** (GITHUB_TOKEN mặc
định của GitHub không có quyền ghi Variables). Khi đó bảng kết quả cho biết dòng `tên=domain` cần tự thêm/sửa vào `SOURCE_DOMAINS`.

### Tự chạy mỗi ngày
Workflow có sẵn lịch chạy **mỗi ngày lúc 03:00 giờ Việt Nam** (cron `0 20 * * *` tính theo UTC). Muốn đổi giờ hoặc tần suất thì sửa dòng `- cron: ...` trong `.github/workflows/check-domains.yml` (ví dụ `0 */6 * * *` = mỗi 6 giờ).
- Lần chạy theo lịch dùng giá trị mặc định: **tự sửa** `SOURCE_DOMAINS` khi tìm được domain mới (cần secret `GH_VARIABLES_TOKEN`), quét **tất cả** nguồn, lưu bản domain vào git, rồi tự chạy lại `Generate Playlists` nếu có đổi.
- Còn nguồn chưa xử lý được thì lần chạy báo **đỏ** và GitHub gửi email cho bạn.
- GitHub có thể chạy trễ vài phút đến vài chục phút so với giờ hẹn. Lịch chỉ chạy trên nhánh mặc định của repo.
- Tắt lịch: xoá khối `schedule:` trong file workflow (vẫn chạy tay được).

### Cách chạy
Tab **Actions → Check Domains → Run workflow**. Các ô:
- `auto_fix`: bật = tự ghi biến khi tìm được domain mới; tắt = chỉ quét.
- `sources`: `all` hoặc danh sách key, ví dụ `giovang,saoke` (gồm cả domain API/player của nguồn đó).
- `extra_candidates`: domain mới bạn **biết** (cách nhau dấu phẩy) — được thử đầu tiên cho nguồn nào chết.
- `extra_tlds`: đuôi tên miền muốn thử thêm (cách nhau dấu phẩy, vd `lat,wiki`) — được thử **trước** danh sách có sẵn.
- `restart_generator`: đổi biến xong thì chạy lại `Generate Playlists`.
- `save_snapshot`: lưu danh sách domain hiện tại vào file trong git (xem mục "Bản lưu domain trong git" bên dưới).

Kết quả hiện ở mục **Summary** của lần chạy (bảng: nguồn, biến, domain hiện tại, trạng thái, domain mới, hành động).

### Bản lưu domain trong git
Sau mỗi lần quét, workflow lưu **domain hiện tại của tất cả nguồn** vào 2 file rồi commit lên git:
- `data/source-domains.txt` — cùng định dạng biến `SOURCE_DOMAINS`. **Dán nguyên nội dung vào biến `SOURCE_DOMAINS` là khôi phục lại được** (hoặc dùng làm bản sao lưu khi lỡ xoá biến).
- `data/source-domains.json` — domain hiện tại, nguồn gốc (`SOURCE_DOMAINS` / biến riêng lẻ / mặc định), trạng thái lần quét gần nhất và **lịch sử đổi domain** (từ → sang, lý do, thời điểm; giữ 200 mục gần nhất).

Quy tắc ghi file:
- Chỉ ghi và commit khi **domain thật sự thay đổi** so với lần lưu trước (lần đầu chưa có file thì tạo luôn). Chỉ đổi trạng thái 🟢/🟡 thì không commit, nên không sinh commit thừa.
- Lưu theo **thực tế đang dùng**: tìm thấy domain mới nhưng ghi biến thất bại (thiếu token...) thì file vẫn giữ domain cũ.
- Bạn tự sửa tay `SOURCE_DOMAINS` rồi bấm Check Domains thì file cũng theo kịp và ghi vào lịch sử.
- Commit do `github-actions` đẩy lên, nội dung `chore: cap nhat danh sach domain nguon [skip ci]`; không tự kích hoạt workflow khác. Workflow Generate cũng commit liên tục nên bước này tự `pull --rebase` và thử lại tối đa 5 lần.
- Tắt bằng cách bỏ tick `save_snapshot`.
- Nếu bước commit báo `Permission denied` hoặc bị từ chối: vào repo **Settings → Actions → General → Workflow permissions** chọn **Read and write permissions**; nếu nhánh chính có bảo vệ (branch protection) cho phép `github-actions` đẩy trực tiếp.

### Trạng thái
| Trạng thái | Ý nghĩa | Có tự đổi biến? |
|---|---|---|
| 🟢 sống | trả 2xx/3xx và nội dung đúng tên nguồn | không |
| 🟠 đã chuyển | trang tự chuyển hướng sang domain khác (vd `giovang.city → giovang.blog`) | **có** (nếu nội dung đúng nguồn) |
| 🔴 chết | không phân giải/kết nối được, timeout, 404 ở trang chủ, hoặc là trang rao bán/hết hạn | **có** — tự tìm domain thay thế |
| 🟡 bị chặn bot | Cloudflare/WAF chặn IP máy chủ GitHub — **không kết luận được** | không |
| 🟡 nghi ngờ / lỗi tạm | trang 200 nhưng nội dung lạ, hoặc 5xx | không (chỉ cảnh báo) |

Lỗi mạng/5xx luôn được thử lại 1 lần trước khi kết luận.

### Cách tìm domain mới (theo thứ tự ưu tiên, nhóm nào có kết quả hợp lệ thì dừng)
1. `extra_candidates` bạn nhập.
2. Biến ứng viên riêng của nguồn: `<TÊN_BIẾN>_CANDIDATES` (đặt trong env của bước quét), ví dụ `GIOVANG_DOMAIN_CANDIDATES=giovang.tv,giovang.me`.
3. Mirror đã biết trong `scripts/check-domains.mjs` (mảng `candidates`).
4. Biến thể tự sinh (tối đa khoảng 270–420 ứng viên cho mỗi nguồn):
   - **đổi số** trong tên: `khandai3 → khandai4`, `lau05 → lau06`, `saoketv40 → saoketv41` (±1, ±2, ±3, +4, +5, ±10); tên không có số thì thử gắn số 1–5;
   - **đổi đuôi** giữ tên: hơn **100 đuôi** (`.com .net .tv .live .link .cc .xyz .top .vip .me .site .online .club .pro ... .asia .vn .com.vn .net.vn ...`; đuôi nhiều tầng như `.com.vn` được tách đúng), đuôi phổ biến thử trước. Thêm đuôi riêng bằng ô `extra_tlds`;
   - **đổi số + đổi đuôi** cùng lúc (14 đuôi phổ biến);
   - **ghép tên nguồn với hậu tố**: `giovang → giovangtv / giovanglive / giovangvip / giovanghd / giovangvn / giovangplus / giovang1..3` trên 13 đuôi phổ biến.

Các ứng viên được lọc DNS trước (chỉ domain tồn tại mới bị mở trang). **Giới hạn thời gian: 150 giây cho mỗi nguồn** (đổi bằng biến môi trường `DISCOVER_BUDGET_MS`); hết giờ thì dừng và ghi rõ trong kết quả. Ứng viên tự sinh không được thử lại khi lỗi mạng để tiết kiệm thời gian.

Domain mới chỉ được nhận khi: phân giải DNS được, trả 2xx/3xx, **không** phải trang đỗ tên miền,
và trong nội dung có tên nguồn (chống domain bị người khác mua lại). Thêm bộ lọc **trang lạ**: trang có nhiều chữ mà không có từ khoá thể thao nào (trực tiếp, bóng đá, kèo, lịch thi đấu, ...) bị loại dù có nhắc tên nguồn. Trang SPA rỗng (ít chữ) thì không áp dụng bộ lọc này.

### Nguồn nào tự sửa, nguồn nào chỉ báo cáo
- **Tự sửa dòng** khi domain chết/chuyển: `giovang`, `gavang`, `gavang33`, `xoilac`, `xoigac`, `saoke`, `bonglau`, `phalang`.
- **Chỉ báo cáo** (tự sửa dòng trong `SOURCE_DOMAINS` nếu cần): `chuoichientv` (code **tự dò** `liveNN.chuoichientv.me`), các domain player (`*-player`) và domain API (`*-api`).
- Ứng viên riêng cho 1 nguồn (tuỳ chọn): đặt biến môi trường `<TÊN_BIẾN_CŨ>_CANDIDATES` cho bước quét, vd `GIOVANG_DOMAIN_CANDIDATES=giovang.tv,giovang.me`.
- Thêm nguồn mới vào danh sách: thêm 1 dòng vào mảng `SOURCES` trong `scripts/source-domains.mjs`, rồi thêm biến tương ứng vào bước `Expand source domains` của `validate-and-generate.yml` và bước quét của `check-domains.yml`.

### Giới hạn cần biết
- Không tìm được nếu nguồn đổi **hẳn tên** (không còn giống tên cũ) → nhập domain mới vào `extra_candidates`.
- Một số trang chặn IP máy chủ GitHub → hiện 🟡 "bị chặn bot", script không tự đổi để tránh sửa nhầm.
- Domain **API** và **player/Referer** chỉ báo cáo, vì không thể đoán an toàn từ tên.
- Nếu `SOURCE_DOMAINS` là JSON hỏng thì toàn bộ biến bị bỏ qua (có cảnh báo) và không tự gộp được — sửa tay lại cho đúng.

## Lưu file khi tìm thấy domain mới (bản sửa 03/10/2026)
- Trước đây file `data/source-domains.*` chỉ được ghi khi GHI BIẾN `SOURCE_DOMAINS` thành công. Nếu thiếu secret `GH_VARIABLES_TOKEN`, `auto_fix` tắt hoặc ghi biến lỗi thì domain mới tìm được bị bỏ, không có file.
- Giờ domain mới tìm được luôn được lưu vào file (trường `found` trong `.json`, dòng `# TÌM THẤY domain mới ...` trong `.txt`), kể cả khi chưa áp dụng được.
- File còn được tải lên mục Artifacts `source-domains` của lần chạy (dự phòng nếu commit lên git lỗi).

## Biến SOURCE_DOMAINS luôn có sẵn đủ dòng (bản sửa 03/10/2026)
- Nếu biến `SOURCE_DOMAINS` chưa có hoặc đang trống, mỗi lần chạy Check Domains (cần `GH_VARIABLES_TOKEN`, `auto_fix` bật) sẽ tự điền sẵn domain hiện tại của TẤT CẢ nguồn, nên bấm sửa biến là thấy đủ dòng `tên=domain`.
- Khi tìm được domain mới mà biến đang trống, script cũng ghi đủ các dòng (không chỉ dòng đổi).
- Chưa có token: mở `data/source-domains.txt` trong git, copy nguyên nội dung dán vào biến.
- Lần đầu: bấm Run workflow "Check Domains" 1 lần để biến được điền sẵn.
