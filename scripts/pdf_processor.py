#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Xử lý file PDF trước khi upload lên Google Drive SCHOOL:
1. Mở khóa PDF bị đặt mật khẩu quyền in/sửa (/Encrypt).
2. Xóa sạch watermark của bên cũ (QuickPDF / TaiLieuOnThi / tlot.cc) ở cả 2 dạng:
   - Dạng A (Vector Content Stream): Xóa các stream /QuickPDFGS... chứa:
     + Đầu trang ("Tài Liệu Ôn Thi Group")
     + Cuối trang ("https://TaiLieuOnThi.Net")
     + Chéo góc phải ("TAILIEUONTHI.NET")
   - Dạng B (Raster Flattened Image /QuickPDFIm...): Xử lý trực tiếp trên mảng pixel
     để xóa sạch 3 cụm watermark bị ép phẳng vào ảnh trang mà vẫn giữ nguyên chữ & bảng biểu.
3. Xóa các hyperlink quảng cáo ẩn (tlot.cc, tailieuonthi.net...) trên từng trang.
4. Chèn logo watermark school.unizvn.com (assets/watermark.png) vào góc dưới bên phải
   theo đúng tọa độ chuẩn của tool cũ (103 x 118.875 pt, tâm tại 0.85*W, 0.875*H).
5. Làm sạch metadata của file PDF.
"""
import sys
import os
import re
import io
import json
import fitz  # PyMuPDF

try:
    fitz.TOOLS.mupdf_display_errors(False)
    fitz.TOOLS.mupdf_display_warnings(False)
except Exception:
    pass

try:
    import numpy as np
    from PIL import Image
    HAS_IMAGE_LIBS = True
except ImportError:
    HAS_IMAGE_LIBS = False


WATERMARK_KEYWORDS_BYTES = [
    b"QuickPDF",
    b"TaiLieuOnThi",
    b"TAILIEUONTHI",
    b"tailieuonthi",
    b"tlot.cc",
    b"T\xe0i Li\xffu \xd4n Thi",
    b"Tai Lieu On Thi",
]

SPAM_URI_PATTERNS = [
    "tlot.cc",
    "tailieuonthi",
    "facebook.com/groups/tailieu",
    "zalo.me",
]


def is_watermark_stream(raw_bytes: bytes) -> bool:
    if not raw_bytes:
        return False
    for kw in WATERMARK_KEYWORDS_BYTES:
        if kw in raw_bytes:
            return True
    return False


_WM_TEMPLATES_CACHE = None


def _get_quickpdf_templates():
    global _WM_TEMPLATES_CACHE
    if _WM_TEMPLATES_CACHE is not None:
        return _WM_TEMPLATES_CACHE
    tpl_path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "assets", "quickpdf_wm_templates.npz")
    if HAS_IMAGE_LIBS and os.path.exists(tpl_path):
        try:
            _WM_TEMPLATES_CACHE = dict(np.load(tpl_path))
        except Exception:
            _WM_TEMPLATES_CACHE = {}
    else:
        _WM_TEMPLATES_CACHE = {}
    return _WM_TEMPLATES_CACHE


def _unblend_template_patch(arr: "np.ndarray", y1: int, y2: int, x1: int, x2: int, tpl: "np.ndarray", search_shift: bool = True) -> tuple:
    h, w, _ = arr.shape
    th, tw = tpl.shape
    if y1 < 2 or x1 < 2 or y2 > h - 2 or x2 > w - 2 or (y2 - y1) != th or (x2 - x1) != tw:
        return (False, 0, 0)
    wm_mask = tpl < 254.5
    if not np.any(wm_mask):
        return (False, 0, 0)
    wm_dil = wm_mask.copy()
    for s_y in (-2, -1, 0, 1, 2):
        for s_x in (-2, -1, 0, 1, 2):
            wm_dil |= np.roll(np.roll(wm_mask, s_y, axis=0), s_x, axis=1)
    ring_mask = wm_dil & ~wm_mask
    core_mask = tpl < (np.min(tpl) + 15.0)
    patch0 = arr[y1:y2, x1:x2, :3].astype(np.float32)
    if np.any(core_mask) and np.mean(patch0[:, :, 0][core_mask]) > 251.5:
        return (False, 0, 0)
    if np.any(core_mask) and np.any(ring_mask):
        row_diffs = []
        for ry in range(th):
            c_m = core_mask[ry]
            r_m = ring_mask[ry]
            if np.sum(c_m) >= 5 and np.sum(r_m) >= 5:
                row_diffs.append(float(np.median(patch0[ry, r_m, :]) - np.median(patch0[ry, c_m, :])))
        if row_diffs and float(np.median(row_diffs)) < 10.0:
            return (False, 0, 0)

    # Cộng bù +0.35 cho sai số làm tròn xuống (127.5 -> 127) của template QuickPDF
    t = np.maximum(np.where(wm_mask, tpl + 0.35, 255.0)[:, :, None], 50.0) / 255.0

    best_dy, best_dx = 0, 0
    if search_shift:
        best_score = 1e18
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                p = arr[y1 + dy:y2 + dy, x1 + dx:x2 + dx, :3].astype(np.float32)
                rec = np.clip(p / t, 0, 255)
                score = float(np.abs(np.diff(rec, axis=1)).mean() + np.abs(np.diff(rec, axis=0)).mean())
                if score < best_score:
                    best_score = score
                    best_dy, best_dx = dy, dx

    yy1, yy2 = y1 + best_dy, y2 + best_dy
    xx1, xx2 = x1 + best_dx, x2 + best_dx
    patch = arr[yy1:yy2, xx1:xx2, :3].astype(np.float32)

    # Nếu xung quanh chữ watermark 100% là giấy trắng tinh (không có bất kỳ nét chữ, dấu câu hay màu nền nào)
    # và bên trong chữ watermark không giao với nét chữ đen (min >= 118, độ lệch màu <= 5),
    # làm sạch tuyệt đối về 255 để triệt tiêu cả sai số dịch pha 0.5px trên các khổ trang lẻ (2245x3131, 2482x3507)
    chroma = np.max(patch, axis=2) - np.min(patch, axis=2)
    if (
        np.all(chroma <= 6.0)
        and np.min(patch) >= 118.0
        and np.any(~wm_dil)
        and np.min(patch[~wm_dil]) >= 250.0
    ):
        arr[yy1:yy2, xx1:xx2, :3] = 255
        return (True, best_dy, best_dx)

    restored = np.clip(np.round(patch / t), 0, 255).astype(np.uint8)
    # Khử viền răng cưa bán điểm ảnh (sub-pixel anti-aliasing fringe 246..254 -> 255)
    res_chroma = np.max(restored, axis=2) - np.min(restored, axis=2)
    near_white_fringe = wm_mask & (res_chroma <= 4) & (restored[:, :, 0] >= 246)
    restored[near_white_fringe] = 255

    for c in range(3):
        ch = arr[yy1:yy2, xx1:xx2, c]
        ch[wm_mask] = restored[:, :, c][wm_mask]
        # Dọn thêm viền 1px ngoài wm_mask nếu là điểm xám nhạt >= 246 trên nền trắng
        outer_fringe = (wm_dil & ~wm_mask) & (chroma <= 4.0) & (patch[:, :, 0] >= 246.0)
        ch[outer_fringe] = 255

    # Khôi phục liền mạch đường kẻ ngang mảnh (như đường kẻ khung RGB=240 hoặc RGB=229) nếu đi xuyên qua watermark
    out_patch = arr[yy1:yy2, xx1:xx2, :3]
    for ry in range(th):
        outside_row = out_patch[ry, ~wm_dil[ry], 0]
        if outside_row.size > 20:
            med = int(np.median(outside_row))
            if 210 <= med <= 245 and np.all(np.abs(outside_row.astype(np.int32) - med) <= 3):
                row_wm = wm_dil[ry] & (np.abs(out_patch[ry, :, 0].astype(np.int32) - med) <= 8)
                out_patch[ry, row_wm, :] = med

    return (True, best_dy, best_dx)


def _unblend_white_box(arr: "np.ndarray", y_rows: list, x_edge_alphas: list, x_full_start: int, dy: int = 0, dx: int = 0):
    h, w, _ = arr.shape
    xs_full = x_full_start + dx
    for yy_base, alpha_y in y_rows:
        yy = yy_base + dy
        if 0 <= yy < h:
            for xx_base, alpha_x in x_edge_alphas:
                xx = xx_base + dx
                if 0 <= xx < w:
                    a = alpha_y * (alpha_x / 0.50)
                    px = arr[yy, xx, :3].astype(np.float32)
                    arr[yy, xx, :3] = np.clip(np.round((px - a * 255.0) / (1.0 - a)), 0, 255).astype(np.uint8)
            if xs_full < w:
                row = arr[yy, xs_full:, :3].astype(np.float32)
                arr[yy, xs_full:, :3] = np.clip(np.round((row - alpha_y * 255.0) / (1.0 - alpha_y)), 0, 255).astype(np.uint8)


def clean_quickpdf_raster_image(doc: fitz.Document, page: fitz.Page, xref: int, w: int, h: int) -> bool:
    """
    Làm sạch ảnh trang bị QuickPDF phẳng hóa (/QuickPDFIm<hex>) bằng phương pháp
    Inverse Alpha Unblending (khôi phục chính xác màu chữ, công thức Toán, đường kẻ bảng
    và banner màu nằm dưới lớp watermark bán trong suốt):
    1. Đầu trang: Khôi phục chữ 'Tài Liệu Ôn Thi Group' (alpha=0.5) + hộp phủ trắng 50%
    2. Cuối trang: Khôi phục chữ 'https://TaiLieuOnThi.Net' (alpha=0.5) + hộp phủ trắng 50%
    3. Chéo góc phải dưới: Khôi phục chữ 'TAILIEUONTHI.NET' (alpha=0.1) đè lên công thức/bảng biểu
    """
    if not HAS_IMAGE_LIBS or w < 800 or h < 800:
        return False
    pix = fitz.Pixmap(doc, xref)
    if pix.n < 3:
        return False

    arr = np.frombuffer(pix.samples, dtype=np.uint8).reshape(h, w, pix.n).copy()
    modified = False
    tpls = _get_quickpdf_templates()

    # Nếu ảnh đúng chuẩn 300 DPI của QuickPDF (w ~ 2200..2600, h ~ 3000..3600) và có template
    if tpls and 2100 <= w <= 2650 and 2900 <= h <= 3650:
        is_letter = w >= 2520
        is_2245 = abs(w - 2245) <= 40
        if is_2245 and "t_top_2245" in tpls:
            t_top = tpls.get("t_top_2245")
            t_bot = tpls.get("t_bot_2245")
            t_diag = tpls.get("t_diag_2245")
        else:
            t_top = tpls.get("t_top_let" if is_letter else "t_top_a4")
            t_bot = tpls.get("t_bot_let" if is_letter else "t_bot_a4")
            t_diag = tpls.get("t_diag_let" if is_letter else "t_diag_a4")

        # 1. Đầu trang: Unblend chữ đen "Tài Liệu Ôn Thi Group" + hộp phủ trắng 50%
        if t_top is not None:
            ok_top, dy_t, dx_t = _unblend_template_patch(arr, 20, 80, w // 2 - 202, w // 2 + 315, t_top, search_shift=True)
            if ok_top:
                modified = True
                if is_letter:
                    top_y = [(16, 0.128)] + [(y_i, 0.50) for y_i in range(17, 83)] + [(83, 0.255)]
                    _unblend_white_box(arr, top_y, [], w // 2 - 200, dy_t, dx_t)
                elif is_2245:
                    top_y = [(15, 0.25)] + [(y_i, 0.50) for y_i in range(16, 81)]
                    _unblend_white_box(arr, top_y, [(w // 2 - 202, 0.0625)], w // 2 - 201, dy_t, dx_t)
                else:
                    top_y = [(16, 0.128)] + [(y_i, 0.50) for y_i in range(17, 84)]
                    _unblend_white_box(arr, top_y, [(w // 2 - 199, 0.125)], w // 2 - 198, dy_t, dx_t)

        # 2. Cuối trang: Unblend chữ đen "https://TaiLieuOnThi.Net" + hộp phủ trắng 50%
        if t_bot is not None:
            ok_bot, dy_b, dx_b = _unblend_template_patch(arr, h - 66, h - 18, w // 2 - 232, w // 2 + 336, t_bot, search_shift=True)
            if ok_bot:
                modified = True
                if is_letter:
                    bot_y = [(h - 83, 0.25)] + [(y_i, 0.50) for y_i in range(h - 82, h - 16)]
                    _unblend_white_box(arr, bot_y, [(w // 2 - 230, 0.06)], w // 2 - 229, dy_b, dx_b)
                elif is_2245:
                    bot_y = [(y_i, 0.50) for y_i in range(h - 81, h - 15)]
                    _unblend_white_box(arr, bot_y, [(w // 2 - 232, 0.25)], w // 2 - 231, dy_b, dx_b)
                else:
                    bot_y = [(h - 83, 0.375)] + [(y_i, 0.50) for y_i in range(h - 82, h - 16)]
                    _unblend_white_box(arr, bot_y, [(w // 2 - 232, 0.312)], w // 2 - 231, dy_b, dx_b)

        # 3. Chéo góc phải dưới: Unblend "TAILIEUONTHI.NET"
        if t_diag is not None:
            ok_diag, _, _ = _unblend_template_patch(arr, h - 768, h - 223, w - 706, w - 236, t_diag, search_shift=True)
            if ok_diag:
                modified = True
    else:
        # Fallback cho kích thước trang khác chuẩn 300 DPI
        y1, y2 = int(0.002 * h), int(0.025 * h)
        x1, x2 = int(0.410 * w), int(0.660 * w)
        sub_top = arr[y1:y2, x1:x2, :3]
        top_mask = (np.max(sub_top, axis=2) - np.min(sub_top, axis=2) <= 6) & (sub_top[:, :, 0] >= 100) & (sub_top[:, :, 0] < 252)
        if np.any(top_mask):
            sub_top[top_mask] = 255
            modified = True

        y1, y2 = int(0.980 * h), h
        x1, x2 = int(0.405 * w), int(0.660 * w)
        sub_bot = arr[y1:y2, x1:x2, :3]
        bot_mask = (np.max(sub_bot, axis=2) - np.min(sub_bot, axis=2) <= 6) & (sub_bot[:, :, 0] >= 100) & (sub_bot[:, :, 0] < 252)
        if np.any(bot_mask):
            sub_bot[bot_mask] = 255
            modified = True

        y1, y2 = int(0.745 * h), int(0.955 * h)
        x1, x2 = int(0.695 * w), int(0.955 * w)
        sub_diag = arr[y1:y2, x1:x2, :3]
        diag_mask = (np.max(sub_diag, axis=2) - np.min(sub_diag, axis=2) <= 5) & (sub_diag[:, :, 0] >= 175) & (sub_diag[:, :, 0] < 252)
        if np.any(diag_mask):
            sub_diag[diag_mask] = 255
            modified = True

    if not modified:
        return False

    pil_img = Image.fromarray(arr[:, :, :3])
    buf = io.BytesIO()
    pil_img.save(buf, format="PNG", optimize=False)
    page.replace_image(xref, stream=buf.getvalue())
    return True


def process_pdf(
    input_path: str,
    output_path: str,
    watermark_path: str = "",
    remove_old_wm: bool = True,
    add_uni_wm: bool = True,
) -> dict:
    if not os.path.exists(input_path):
        raise FileNotFoundError(f"Không tìm thấy file PDF đầu vào: {input_path}")

    doc = fitz.open(input_path)
    if doc.is_encrypted:
        try:
            doc.authenticate("")
        except Exception:
            pass

    wm_pix = None
    if add_uni_wm:
        if not watermark_path or not os.path.exists(watermark_path):
            default_wm = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "assets", "watermark.png")
            if os.path.exists(default_wm):
                watermark_path = default_wm
        if watermark_path and os.path.exists(watermark_path):
            wm_pix = fitz.Pixmap(watermark_path)

    removed_streams = 0
    cleaned_raster_pages = 0
    removed_links = 0
    stamped_pages = 0
    cleaned_xrefs = set()
    wm_xref = 0

    for page in doc:
        if remove_old_wm:
            # 1. Xóa các content stream chứa watermark QuickPDF / TaiLieuOnThi
            contents = page.get_contents()
            for xref in contents:
                try:
                    raw = doc.xref_stream(xref)
                except Exception:
                    continue
                if not raw:
                    continue
                if is_watermark_stream(raw):
                    # Lưu ý: Nếu là trang ảnh phẳng '/QuickPDFIm... Do' thì không xóa stream vẽ ảnh mà xử lý ở bước 2
                    if b"QuickPDFIm" in raw and len(raw) < 120:
                        continue
                    if len(raw) < 16384 and (
                        b"QuickPDF" in raw
                        or b"TaiLieuOnThi" in raw
                        or b"TAILIEUONTHI" in raw
                        or b"tlot.cc" in raw
                    ):
                        doc.update_stream(xref, b"")
                        removed_streams += 1
                    else:
                        cleaned = re.sub(
                            rb"q\s*/QuickPDFGS[A-Za-z0-9_]+\s+gs.*?Q\s*Q",
                            b"",
                            raw,
                            flags=re.DOTALL,
                        )
                        if cleaned != raw:
                            doc.update_stream(xref, cleaned)
                            removed_streams += 1

            # 2. Xử lý trường hợp trang bị QuickPDF làm phẳng thành ảnh (/QuickPDFIm<hex>)
            try:
                page_raw_streams = b"".join(doc.xref_stream(cx) or b"" for cx in page.get_contents())
                for img_info in page.get_images(full=True):
                    img_xref = img_info[0]
                    img_w, img_h = img_info[2], img_info[3]
                    img_name = str(img_info[7] or "")
                    if img_name.startswith("QuickPDFIm") and img_xref not in cleaned_xrefs:
                        if page_raw_streams and (img_name.encode("ascii", "ignore") not in page_raw_streams):
                            continue
                        cleaned_xrefs.add(img_xref)
                        if clean_quickpdf_raster_image(doc, page, img_xref, img_w, img_h):
                            cleaned_raster_pages += 1
            except Exception:
                pass

            # 3. Xóa các hyperlink ẩn trỏ tới tlot.cc / tailieuonthi.net
            try:
                for lnk in list(page.get_links()):
                    uri = str(lnk.get("uri") or "").lower()
                    if any(pat in uri for pat in SPAM_URI_PATTERNS):
                        page.delete_link(lnk)
                        removed_links += 1
            except Exception:
                pass

        # 4. Chèn watermark school.unizvn.com vào góc dưới bên phải (chống đóng đè 2 lần nếu trang đã có logo 824x951)
        if wm_pix is not None:
            already_has_uni_wm = False
            try:
                for img_info in page.get_images(full=True):
                    if img_info[2] == wm_pix.width and img_info[3] == wm_pix.height:
                        already_has_uni_wm = True
                        break
            except Exception:
                pass

            if not already_has_uni_wm:
                r = page.rect
                scale = min(r.width / 595.32, r.height / 841.92) if (r.width > 0 and r.height > 0) else 1.0
                scale = max(0.6, min(1.4, scale))
                w_pt = 103.0 * scale
                h_pt = 118.875 * scale

                # Tọa độ tâm chuẩn của tool cũ: (0.85 * W, 0.875 * H)
                cx = r.x0 + r.width * 0.85
                cy = r.y0 + r.height * 0.875
                x0 = cx - w_pt / 2.0
                y0 = cy - h_pt / 2.0
                target_rect = fitz.Rect(x0, y0, x0 + w_pt, y0 + h_pt)
                if wm_xref:
                    page.insert_image(target_rect, xref=wm_xref, overlay=True)
                else:
                    wm_xref = page.insert_image(target_rect, pixmap=wm_pix, overlay=True)
            stamped_pages += 1

    try:
        doc.set_metadata({
            "title": "",
            "author": "school.unizvn.com",
            "subject": "",
            "keywords": "",
            "creator": "UNI School",
            "producer": "school.unizvn.com",
        })
    except Exception:
        pass

    total_pages = len(doc)
    tmp_out = output_path + ".tmp.pdf"
    if doc.xref_length() > 4000:
        doc.save(tmp_out, garbage=1, deflate=False)
    else:
        doc.save(tmp_out, garbage=2, deflate=True)
    doc.close()
    os.replace(tmp_out, output_path)

    return {
        "ok": True,
        "pages": total_pages,
        "stampedPages": stamped_pages,
        "removedStreams": removed_streams,
        "cleanedRasterPages": cleaned_raster_pages,
        "removedLinks": removed_links,
        "outputSize": os.path.getsize(output_path),
    }


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print(json.dumps({"ok": False, "error": "Usage: pdf_processor.py <input.pdf> <output.pdf> [watermark.png] [remove_old=1] [add_uni=1]"}))
        sys.exit(1)

    in_pdf = sys.argv[1]
    out_pdf = sys.argv[2]
    wm_png = sys.argv[3] if len(sys.argv) > 3 else ""
    rm_old = (sys.argv[4] != "0") if len(sys.argv) > 4 else True
    add_uni = (sys.argv[5] != "0") if len(sys.argv) > 5 else True

    try:
        res = process_pdf(in_pdf, out_pdf, wm_png, rm_old, add_uni)
        print(json.dumps(res))
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)}))
        sys.exit(1)
