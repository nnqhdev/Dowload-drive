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
import subprocess
import sys
import time
import urllib.parse
import urllib.request
import warnings

warnings.filterwarnings("ignore")

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
    with opener.open(info_url, timeout=20) as resp:
        body = resp.read().decode("utf-8", "ignore")

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
    """
    jar = get_chrome_cookie_jar(force_refresh=False)
    opener = build_opener(jar)
    direct_url = f"https://drive.usercontent.google.com/download?id={file_id}&export=download&confirm=t"

    with opener.open(direct_url, timeout=45) as resp:
        ctype = resp.headers.get("Content-Type", "")
        if "text/html" in ctype.lower():
            html = resp.read(65536).decode("utf-8", "ignore")
            # Tìm form confirm / uuid nếu có
            uuid_m = re.search(r'name="uuid"\s+value="([^"]+)"', html)
            if uuid_m:
                confirm_url = f"{direct_url}&uuid={uuid_m.group(1)}"
                with opener.open(confirm_url, timeout=60) as resp2:
                    if "text/html" in (resp2.headers.get("Content-Type") or "").lower():
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
    if kind in ("video", "auto"):
        methods.extend([
            ("videoplayback_stream", lambda: try_videoplayback_stream(file_id, dest_path, False)),
            ("videoplayback_stream_fresh_cookie", lambda: try_videoplayback_stream(file_id, dest_path, True)),
            ("drive_usercontent", lambda: try_usercontent_direct(file_id, dest_path)),
            ("yt_dlp", lambda: try_yt_dlp_cli(file_id, dest_path)),
            ("gdown_fuzzy", lambda: try_gdown_fuzzy(file_id, dest_path)),
        ])
    else:
        methods.extend([
            ("drive_usercontent", lambda: try_usercontent_direct(file_id, dest_path)),
            ("gdown_fuzzy", lambda: try_gdown_fuzzy(file_id, dest_path)),
            ("videoplayback_stream", lambda: try_videoplayback_stream(file_id, dest_path, False)),
        ])

    for name, fn in methods:
        try:
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
