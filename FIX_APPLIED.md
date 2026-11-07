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

