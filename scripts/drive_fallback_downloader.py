#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
drive_fallback_downloader.py
----------------------------
Hỗ trợ tải các file Google Drive gặp sự cố khi gọi API chuẩn:
  1. Bị chủ sở hữu chặn nút Tải xuống / Sao chép (Chế độ Chỉ xem - viewersCanCopyContent=false):
     - Trích xuất luồng phát `videoplayback` (1080p/720p/480p/360p) qua endpoint
       `get_video_info?docid=<ID>&drive_originator_app=303` hoặc `yt-dlp` với Cookie trình duyệt Chrome.
  2. Link tải trực tiếp domain mới:
     - `https://drive.usercontent.google.com/download?id=<ID>&export=download&confirm=t`
  3. Vượt giới hạn băng thông 24h (Quota Exceeded):
     - Sử dụng `gdown --fuzzy` kết hợp cookie.

Cách gọi:
  python3 scripts/drive_fallback_downloader.py <file_id> <dest_path> [kind]
Trả về JSON trên stdout:
  {"ok": true, "method": "...", "size": 123456, "itag": "37"}
"""

import concurrent.futures
import http.cookiejar
import json
import os
import re
import socket
import subprocess
import sys
import time
import urllib.parse
import urllib.request
import warnings

warnings.filterwarnings("ignore")


def wait_for_network(max_wait=120):
    """Nếu Wi-Fi/DNS bị rớt tạm thời (Errno 8), tự động chờ tới khi kết nối mạng khôi phục."""
    deadline = time.time() + max_wait
    while time.time() < deadline:
        try:
            socket.getaddrinfo("drive.google.com", 443)
            return True
        except Exception:
            time.sleep(3.0)
    return False

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(BASE_DIR, "data")
COOKIE_CACHE_FILE = os.path.join(DATA_DIR, ".chrome_drive_cookies.txt")
COOKIE_TTL_SECONDS = 1800  # Cache cookie 30 phút để không phải quét lại ổ cứng mỗi file

USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)

# Thứ tự ưu tiên chất lượng video trên Google Drive:
# 37: 1080p MP4, 22: 720p MP4, 59: 480p MP4, 18: 360p MP4
PREFERRED_ITAGS = ["37", "22", "59", "18"]


def get_chrome_cookie_jar(force_refresh=False):
    """Lấy CookieJar từ trình duyệt Chrome (có cache ra file Netscape 30 phút)."""
    os.makedirs(DATA_DIR, exist_ok=True)
    if not force_refresh and os.path.exists(COOKIE_CACHE_FILE):
        age = time.time() - os.path.getmtime(COOKIE_CACHE_FILE)
        if age < COOKIE_TTL_SECONDS and os.path.getsize(COOKIE_CACHE_FILE) > 100:
            try:
                jar = http.cookiejar.MozillaCookieJar(COOKIE_CACHE_FILE)
                jar.load(ignore_discard=True, ignore_expires=True)
                return jar
            except Exception:
                pass

    from yt_dlp.cookies import extract_cookies_from_browser

    jar = extract_cookies_from_browser("chrome")
    try:
        jar.save(COOKIE_CACHE_FILE, ignore_discard=True, ignore_expires=True)
    except Exception:
        pass
    return jar


def build_opener(jar):
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    opener.addheaders = [
        ("User-Agent", USER_AGENT),
        ("Referer", "https://drive.google.com/"),
    ]
    return opener


def download_stream_parallel(opener, url, dest_path, num_threads=12):
    """Tải luồng videoplayback bằng các đoạn Range 8MB song song để luôn nằm trong vùng burst tốc độ cao của Google CDN."""
    probe_req = urllib.request.Request(url, headers={"Range": "bytes=0-0"})
    with opener.open(probe_req, timeout=20) as resp:
        content_range = resp.headers.get("Content-Range", "")
        content_type = resp.headers.get("Content-Type", "")
        if "text/html" in content_type.lower():
            raise RuntimeError("Luồng trả về HTML thay vì dữ liệu nhị phân")
        m = re.search(r"/(\d+)$", content_range)
        total_size = int(m.group(1)) if m else int(resp.headers.get("Content-Length", "0") or 0)

    if total_size <= 0:
        # Tải tuần tự nếu server không báo tổng dung lượng
        with opener.open(urllib.request.Request(url), timeout=120) as resp, open(dest_path, "wb") as f:
            while True:
                chunk = resp.read(1024 * 1024)
                if not chunk:
                    break
                f.write(chunk)
        return os.path.getsize(dest_path)

    # Pre-allocate file
    with open(dest_path, "wb") as f:
        f.truncate(total_size)

    # Chia cố định mỗi Range ~8MB để tận dụng initial burst buffer của Google videoplayback CDN
    chunk_size = 8 * 1024 * 1024
    ranges = []
    start = 0
    while start < total_size:
        end = min(total_size - 1, start + chunk_size - 1)
        ranges.append((start, end))
        start = end + 1

    def fetch_range(byte_range):
        b_start, b_end = byte_range
        for attempt in range(3):
            try:
                req = urllib.request.Request(url, headers={"Range": f"bytes={b_start}-{b_end}"})
                with opener.open(req, timeout=60) as r:
                    pos = b_start
                    with open(dest_path, "r+b") as out_f:
                        out_f.seek(pos)
                        while True:
                            buf = r.read(512 * 1024)
                            if not buf:
                                break
                            out_f.write(buf)
                return True
            except Exception as exc:
                if attempt == 2:
                    raise exc
                time.sleep(1.0 * (attempt + 1))

    with concurrent.futures.ThreadPoolExecutor(max_workers=num_threads) as pool:
        futures = [pool.submit(fetch_range, rg) for rg in ranges]
        for fut in concurrent.futures.as_completed(futures):
            fut.result()

    return os.path.getsize(dest_path)


def try_videoplayback_stream(file_id, dest_path, force_refresh_cookies=False):
    """
    Cách 1: Lấy luồng `videoplayback` trực tiếp từ `get_video_info?docid=...&drive_originator_app=303`
    dành cho Video bị khóa nút Tải xuống (Chế độ Chỉ xem).
    """
    jar = get_chrome_cookie_jar(force_refresh=force_refresh_cookies)
    opener = build_opener(jar)

    info_url = f"https://drive.google.com/get_video_info?docid={file_id}&drive_originator_app=303"
    body = ""
    for attempt in range(3):
        try:
            with opener.open(info_url, timeout=30) as resp:
                body = resp.read().decode("utf-8", "ignore")
            if body:
                break
        except Exception as exc:
            if attempt == 2:
                raise exc
            time.sleep(2.0 * (attempt + 1))

    qs = urllib.parse.parse_qs(body)
    fmt_stream_map = (qs.get("fmt_stream_map") or [""])[0]
    if not fmt_stream_map:
        reason = (qs.get("reason") or ["Không tìm thấy fmt_stream_map"])[0]
        raise RuntimeError(f"get_video_info không có fmt_stream_map: {reason}")

    streams = {}
    for entry in fmt_stream_map.split(","):
        parts = entry.split("|")
        if len(parts) >= 2:
            streams[parts[0]] = parts[1]

    if not streams:
        raise RuntimeError("Không phân tích được luồng videoplayback từ fmt_stream_map")

    chosen_itag = None
    chosen_url = None
    for itag in PREFERRED_ITAGS:
        if itag in streams:
            chosen_itag = itag
            chosen_url = streams[itag]
            break

    if not chosen_url:
        chosen_itag, chosen_url = next(iter(streams.items()))

    size = download_stream_parallel(opener, chosen_url, dest_path, num_threads=12)
    if size < 1024:
        raise RuntimeError(f"File tải về quá nhỏ ({size} bytes)")
    return {
        "ok": True,
        "method": f"videoplayback_stream_itag_{chosen_itag}",
        "itag": chosen_itag,
        "size": size,
    }


def try_usercontent_direct(file_id, dest_path):
    """
    Cách 2: Tải qua cấu trúc link trực tiếp mới của Google:
    https://drive.usercontent.google.com/download?id=<ID>&export=download&confirm=t
    Hỗ trợ bóc tách đầy đủ các trường ẩn (id, export, confirm, uuid, at, authuser)
    từ form cảnh báo quét virus cho các file > 100 MB.
    """
    jar = get_chrome_cookie_jar(force_refresh=False)
    opener = build_opener(jar)
    direct_url = f"https://drive.usercontent.google.com/download?id={file_id}&export=download&confirm=t"

    with opener.open(direct_url, timeout=45) as resp:
        ctype = resp.headers.get("Content-Type", "")
        if "text/html" in ctype.lower():
            html = resp.read(65536).decode("utf-8", "ignore")
            inputs = dict(re.findall(r'<input[^>]+name="([^"]+)"[^>]+value="([^"]*)"', html))
            if inputs.get("uuid") or inputs.get("at"):
                inputs.setdefault("id", file_id)
                inputs.setdefault("export", "download")
                inputs.setdefault("confirm", "t")
                confirm_url = "https://drive.usercontent.google.com/download?" + urllib.parse.urlencode(inputs)
                with opener.open(confirm_url, timeout=60) as resp2:
                    if "text/html" in (resp2.headers.get("Content-Type") or "").lower():
                        html2 = resp2.read(8192).decode("utf-8", "ignore")
                        if "uc-error-caption" in html2 or "vượt quá hạn mức" in html2.lower() or "quota" in html2.lower():
                            raise RuntimeError("drive.usercontent.google.com báo vượt quá hạn mức tải 24h (Quota Exceeded)")
                        raise RuntimeError("drive.usercontent.google.com vẫn trả về trang HTML (bị chặn tải trực tiếp)")
                    with open(dest_path, "wb") as f:
                        while True:
                            chunk = resp2.read(1024 * 1024)
                            if not chunk:
                                break
                            f.write(chunk)
            else:
                raise RuntimeError("drive.usercontent.google.com trả về HTML (file khóa tải trực tiếp)")
        else:
            with open(dest_path, "wb") as f:
                while True:
                    chunk = resp.read(1024 * 1024)
                    if not chunk:
                        break
                    f.write(chunk)

    size = os.path.getsize(dest_path)
    if size < 1024:
        raise RuntimeError(f"File tải từ usercontent quá nhỏ ({size} bytes)")
    return {
        "ok": True,
        "method": "drive_usercontent_confirm_t",
        "size": size,
    }


def try_drive_api_make_copy(file_id, dest_path):
    """
    Cách 3b (Giải pháp nhân bản file vượt lỗi Vượt quá giới hạn tải xuống 24h - Quota Exceeded):
    Tương đương DriveApp.getFileById(FILE_ID).makeCopy() trong Google Apps Script:
    Tạo bản sao tạm thời về Drive cá nhân (hung264656@gmail.com), tải bản sao xuống, rồi xóa bản sao tạm.
    """
    school_env_path = "/Users/quochung/Project/School/school.unizvn/.env"
    tool_cfg_path = os.path.join(ROOT_DIR, "data", "tool-config.json")
    env = {}
    if os.path.exists(school_env_path):
        with open(school_env_path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip().strip("'\"")
    client_id = env.get("GDRIVE_CLIENT_ID", "")
    client_secret = env.get("GDRIVE_CLIENT_SECRET", "")
    if not client_id or not client_secret:
        raise RuntimeError("Thiếu GDRIVE_CLIENT_ID / GDRIVE_CLIENT_SECRET")

    rts = []
    if os.path.exists(tool_cfg_path):
        try:
            with open(tool_cfg_path, "r", encoding="utf-8") as f:
                cfg = json.load(f)
                rts.extend(cfg.get("writeRefreshTokens") or [])
        except Exception:
            pass
    rts.extend([s.strip() for s in (env.get("GDRIVE_REFRESH_TOKENS") or "").split(",") if s.strip()])

    access_token = None
    for rt in rts:
        body = urllib.parse.urlencode({
            "client_id": client_id,
            "client_secret": client_secret,
            "refresh_token": rt,
            "grant_type": "refresh_token",
        }).encode("utf-8")
        req = urllib.request.Request(
            "https://oauth2.googleapis.com/token",
            data=body,
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=15) as r:
                tdata = json.loads(r.read().decode("utf-8", "ignore"))
            tok = tdata.get("access_token")
            scope = tdata.get("scope", "")
            if not tok or "https://www.googleapis.com/auth/drive" not in scope.split():
                continue
            about_req = urllib.request.Request(
                "https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)",
                headers={"Authorization": f"Bearer {tok}"},
            )
            with urllib.request.urlopen(about_req, timeout=15) as r2:
                adata = json.loads(r2.read().decode("utf-8", "ignore"))
            if (adata.get("user", {}).get("emailAddress") or "").lower() == "hung264656@gmail.com":
                access_token = tok
                break
        except Exception:
            continue

    if not access_token:
        raise RuntimeError("Không tìm thấy OAuth write token của hung264656@gmail.com")

    copy_id = None
    try:
        copy_req = urllib.request.Request(
            f"https://www.googleapis.com/drive/v3/files/{file_id}/copy?supportsAllDrives=true&fields=id,name,size",
            data=json.dumps({"name": f"_tmp_quota_bypass_{file_id}"}).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {access_token}",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        with urllib.request.urlopen(copy_req, timeout=30) as r:
            cdata = json.loads(r.read().decode("utf-8", "ignore"))
        copy_id = cdata.get("id")
        if not copy_id:
            raise RuntimeError("files.copy không trả về id")

        dl_req = urllib.request.Request(
            f"https://www.googleapis.com/drive/v3/files/{copy_id}?alt=media&supportsAllDrives=true",
            headers={"Authorization": f"Bearer {access_token}"},
        )
        with urllib.request.urlopen(dl_req, timeout=120) as r_dl:
            with open(dest_path, "wb") as f_out:
                while True:
                    chunk = r_dl.read(1024 * 1024)
                    if not chunk:
                        break
                    f_out.write(chunk)
    finally:
        if copy_id:
            try:
                del_req = urllib.request.Request(
                    f"https://www.googleapis.com/drive/v3/files/{copy_id}?supportsAllDrives=true",
                    headers={"Authorization": f"Bearer {access_token}"},
                    method="DELETE",
                )
                urllib.request.urlopen(del_req, timeout=15).close()
            except Exception:
                pass

    size = os.path.getsize(dest_path)
    if size < 1024:
        raise RuntimeError(f"File tải từ bản sao makeCopy quá nhỏ ({size} bytes)")
    return {
        "ok": True,
        "method": "drive_api_make_copy_bypass",
        "size": size,
    }


def try_yt_dlp_cli(file_id, dest_path):
    """
    Cách 3: Gọi yt-dlp trực tiếp với cookie đã trích xuất.
    """
    get_chrome_cookie_jar(force_refresh=False)
    yt_dlp_bin = os.path.join(os.path.dirname(sys.executable), "yt-dlp")
    if not os.path.exists(yt_dlp_bin):
        yt_dlp_bin = "yt-dlp"

    if os.path.exists(dest_path):
        os.remove(dest_path)

    url = f"https://drive.google.com/file/d/{file_id}/view"
    cmd = [
        yt_dlp_bin,
        "--no-warnings",
        "--no-playlist",
        "--cookies",
        COOKIE_CACHE_FILE,
        "-o",
        dest_path,
        url,
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
    if proc.returncode != 0 or not os.path.exists(dest_path) or os.path.getsize(dest_path) < 1024:
        raise RuntimeError(proc.stderr.strip() or proc.stdout.strip() or "yt-dlp failed")
    return {
        "ok": True,
        "method": "yt_dlp_chrome_cookies",
        "size": os.path.getsize(dest_path),
    }


def try_gdown_fuzzy(file_id, dest_path):
    """
    Cách 4: Sử dụng gdown --fuzzy để vượt lỗi giới hạn tải 24h (Quota Exceeded).
    """
    import gdown

    if os.path.exists(dest_path):
        os.remove(dest_path)
    url = f"https://drive.google.com/file/d/{file_id}/view"
    out = gdown.download(url=url, output=dest_path, quiet=True, fuzzy=True, use_cookies=True)
    if not out or not os.path.exists(dest_path) or os.path.getsize(dest_path) < 1024:
        raise RuntimeError("gdown không tải được file")
    return {
        "ok": True,
        "method": "gdown_fuzzy",
        "size": os.path.getsize(dest_path),
    }


def try_pdf_viewerng_pages(file_id, dest_path, force_refresh_cookies=False):
    """
    Cách 5 (Dành riêng cho PDF / Tài liệu bị khóa nút Tải xuống - Chế độ Chỉ xem):
    Trích xuất token `viewer/upload?ds=...` từ trang xem trước của Google Drive,
    gọi `viewerng/meta` để lấy tổng số trang và tải song song toàn bộ ảnh trang `viewerng/img`
    độ phân giải cao (w=1600), sau đó đóng gói thành file PDF chuẩn bằng PyMuPDF.
    """
    import fitz

    jar = get_chrome_cookie_jar(force_refresh=force_refresh_cookies)
    opener = build_opener(jar)

    view_url = f"https://drive.google.com/file/d/{file_id}/view"
    with opener.open(view_url, timeout=25) as resp:
        html = resp.read().decode("utf-8", "ignore")

    unesc = (
        html.replace("\\u003d", "=")
        .replace("\\u0026", "&")
        .replace("\\u002f", "/")
        .replace("\\/", "/")
    )
    m = re.search(r"https://drive\.google\.com/viewer/upload\?ds=([^\"'\s\\<>]+)", unesc)
    if not m:
        raise RuntimeError("Không tìm thấy endpoint viewer/upload?ds=... trong trang xem trước PDF")

    upload_url = m.group(0)
    with opener.open(upload_url, timeout=25) as resp:
        raw_upload = resp.read().decode("utf-8", "ignore")

    upload_json = json.loads(raw_upload.split("\n", 1)[1] if "\n" in raw_upload else raw_upload)
    meta_rel = upload_json.get("meta")
    img_rel = upload_json.get("img") or upload_json.get("page")
    if not meta_rel or not img_rel:
        raise RuntimeError("viewer/upload JSON thiếu trường meta hoặc img")

    meta_url = f"https://drive.google.com/viewerng/{meta_rel}"
    with opener.open(meta_url, timeout=25) as resp:
        raw_meta = resp.read().decode("utf-8", "ignore")
    meta_json = json.loads(raw_meta.split("\n", 1)[1] if "\n" in raw_meta else raw_meta)
    num_pages = int(meta_json.get("pages") or 0)
    if num_pages <= 0:
        raise RuntimeError(f"Số trang viewerng/meta không hợp lệ: {meta_json}")

    def fetch_page_img(page_idx):
        img_url = f"https://drive.google.com/viewerng/{img_rel}&page={page_idx}&w=1600"
        for attempt in range(3):
            try:
                with opener.open(img_url, timeout=30) as r:
                    data = r.read()
                if len(data) < 500:
                    raise RuntimeError(f"Ảnh trang {page_idx} quá nhỏ ({len(data)} bytes)")
                return page_idx, data
            except Exception as exc:
                if attempt == 2:
                    raise exc
                time.sleep(0.8 * (attempt + 1))

    page_images = [None] * num_pages
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        futures = [pool.submit(fetch_page_img, i) for i in range(num_pages)]
        for fut in concurrent.futures.as_completed(futures):
            idx, img_bytes = fut.result()
            page_images[idx] = img_bytes

    doc = fitz.open()
    for img_bytes in page_images:
        pix = fitz.Pixmap(img_bytes)
        # Chuẩn hóa kích thước trang về chiều rộng chuẩn A4 (595.28 pt) giữ nguyên tỷ lệ khung hình
        page_w = 595.28
        page_h = round(page_w * (pix.height / max(1, pix.width)), 2)
        page = doc.new_page(width=page_w, height=page_h)
        page.insert_image(page.rect, stream=img_bytes)

    doc.save(dest_path, garbage=3, deflate=True)
    doc.close()

    size = os.path.getsize(dest_path)
    if size < 1024:
        raise RuntimeError("File PDF ghép từ viewerng/img quá nhỏ")
    return {
        "ok": True,
        "method": "viewerng_img_pdf_reconstruct",
        "pages": num_pages,
        "size": size,
    }


def main():
    if len(sys.argv) < 3:
        print(json.dumps({"ok": False, "error": "Thiếu tham số: <file_id> <dest_path> [kind]"}))
        sys.exit(1)

    file_id = sys.argv[1].strip()
    dest_path = sys.argv[2].strip()
    kind = (sys.argv[3].strip().lower() if len(sys.argv) >= 4 else "auto")

    errors = []

    # Nếu là video (hoặc auto), ưu tiên luồng videoplayback cho các file bị chặn tải (Chế độ Chỉ xem)
    methods = []
    if kind == "pdf":
        methods.extend([
            ("drive_usercontent", lambda: try_usercontent_direct(file_id, dest_path)),
            ("drive_make_copy", lambda: try_drive_api_make_copy(file_id, dest_path)),
            ("viewerng_pdf", lambda: try_pdf_viewerng_pages(file_id, dest_path, False)),
            ("viewerng_pdf_fresh_cookie", lambda: try_pdf_viewerng_pages(file_id, dest_path, True)),
            ("gdown_fuzzy", lambda: try_gdown_fuzzy(file_id, dest_path)),
        ])
    elif kind == "video":
        methods.extend([
            ("videoplayback_stream", lambda: try_videoplayback_stream(file_id, dest_path, False)),
            ("videoplayback_stream_fresh_cookie", lambda: try_videoplayback_stream(file_id, dest_path, True)),
            ("drive_usercontent", lambda: try_usercontent_direct(file_id, dest_path)),
            ("drive_make_copy", lambda: try_drive_api_make_copy(file_id, dest_path)),
            ("yt_dlp", lambda: try_yt_dlp_cli(file_id, dest_path)),
            ("gdown_fuzzy", lambda: try_gdown_fuzzy(file_id, dest_path)),
        ])
    else:
        methods.extend([
            ("drive_usercontent", lambda: try_usercontent_direct(file_id, dest_path)),
            ("drive_make_copy", lambda: try_drive_api_make_copy(file_id, dest_path)),
            ("videoplayback_stream", lambda: try_videoplayback_stream(file_id, dest_path, False)),
            ("viewerng_pdf", lambda: try_pdf_viewerng_pages(file_id, dest_path, False)),
            ("gdown_fuzzy", lambda: try_gdown_fuzzy(file_id, dest_path)),
        ])

    for name, fn in methods:
        try:
            wait_for_network(120)
            res = fn()
            if res and res.get("ok"):
                print(json.dumps(res, ensure_ascii=False))
                return
        except Exception as e:
            errors.append(f"{name}: {str(e)}")
            if os.path.exists(dest_path):
                try:
                    os.remove(dest_path)
                except Exception:
                    pass

    print(
        json.dumps(
            {
                "ok": False,
                "error": " | ".join(errors[:3]),
            },
            ensure_ascii=False,
        )
    )
    sys.exit(1)


if __name__ == "__main__":
    main()
