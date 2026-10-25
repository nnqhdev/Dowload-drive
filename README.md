# UNI Sheet -> Drive Sync & PDF Watermark Tool (`school.unizvn.com`)

Công cụ tự động quét khóa học từ Google Sheet / Google Drive nguồn, lọc trùng đa tầng với thư mục **SCHOOL** (`1KBiUmgMtLOxlK7oJRStIP63sL_WAC1AP`), xóa sạch 100% watermark bên thứ ba (`TaiLieuOnThi.Net` / `QuickPDF`), đóng dấu logo **`school.unizvn.com`**, gắn tiền tố **`UNI `**, đồng bộ Video bài giảng và cập nhật trực tiếp sang dự án web `school.unizvn`.

## Tính năng chính
1. **Quét & Đồng bộ từ Master Sheet (56 Giáo viên / 9 Môn) hoặc Link bất kỳ:**
   - Hỗ trợ quét cây thư mục chia sẻ qua link (Anyone with link) tốc độ cao (25 luồng song song).
   - Tự động bỏ qua `.sheet`, Google Docs, `Z. EBOOK`, `🎁BONUS / Hướng dẫn học`, và Video trong `0. INFO`.
2. **Xử lý PDF & Khử Watermark Cấp độ Pixel (`scripts/pdf_processor.py`):**
   - Mở khóa `/Encrypt`, xóa sạch các lớp vector stream (`QuickPDFGS`), Form XObject, inline image và link quảng cáo ẩn (`tlot.cc`, `tailieuonthi.net`).
   - Khôi phục ảnh trang phẳng hóa (`QuickPDFIm`) bằng thuật toán **Inverse Alpha Unblending** kết hợp bộ mẫu đa khổ trang (`assets/quickpdf_wm_templates.npz`: A4 `2481x3509`, Letter `2550x3300`, `2245x3131`, `2484x3509`), bảo toàn 100% banner màu, đường kẻ bảng (`RGB=229..240`), công thức Toán và watermark gốc của giáo viên.
   - Đóng dấu `assets/watermark.png` (`school.unizvn.com`) ở góc dưới bên phải và gắn tiền tố `UNI `.
3. **Lọc trùng 3 Tầng & Dọn dẹp File cũ thông minh:**
   - Đối chiếu với `data/_pdf_sync_db.json`, `data/_video_sync_db.json`, `lessons.json` của web và kiểm tra trực tiếp thư mục đích trên Drive `SCHOOL`.
   - Tự động giữ bản `UNI <Tên bài>.pdf`, chuyển bản cũ trùng lặp vào thùng rác và tự động cập nhật ID mới vào `lessons.json`.

## Cài đặt & Khởi chạy trên macOS

```bash
# 1. Cài đặt thư viện Node.js
npm install

# 2. Tạo môi trường Python & cài đặt thư viện xử lý PDF
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt

# 3. Chạy server (mặc định tại http://127.0.0.1:4000)
node server.js
```
Hoặc nháy đúp vào file `start.command` trên macOS.
