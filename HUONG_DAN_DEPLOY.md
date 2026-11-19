# Ghi chú cho người/AI sửa project này

Mỗi khi fix xong một lỗi (hoặc thêm tính năng), **tự động tạo folder `changed-files/`** chứa các file đã thay đổi hoặc file mới,
giữ nguyên đường dẫn như trong repo (vd `changed-files/src/services/xoiche.service.js`), kèm `FIX_APPLIED.md` ghi lại sửa gì.

- Không xóa file nào của project; đóng gói lại `nguonvip-fixed.zip` (cả project) và `changed-files.zip` (riêng folder file thay đổi).
- Không ghi thông báo/debug vào file `.m3u`, tên kênh hay link trận (app IPTV sẽ hiện, rối mắt); chẩn đoán chỉ để trong log/Step Summary.
