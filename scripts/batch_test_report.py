#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Tải ngẫu nhiên 2-3 file PDF từ mỗi khóa học trong Sheet, chạy qua bộ xử lý
pdf_processor.py (xóa watermark cũ + đóng dấu logo school.unizvn.com),
tạo ảnh so sánh TRƯỚC & SAU (Before vs After) và xuất báo cáo chi tiết.
"""
import os
import sys
import json
import time
import random
import urllib.request
import urllib.parse
from concurrent.futures import ThreadPoolExecutor, as_completed
import fitz
from PIL import Image, ImageDraw, ImageFont

ROOT_DIR = "/Users/quochung/.gemini/antigravity/scratch/uni-sheet-drive-tool"
sys.path.insert(0, os.path.join(ROOT_DIR, "scripts"))
from pdf_processor import process_pdf

ENV_PATH = "/Users/quochung/Project/School/school.unizvn/.env"
DB_PATH = os.path.join(ROOT_DIR, "data", "_pdf_sync_db.json")
WM_PATH = os.path.join(ROOT_DIR, "assets", "watermark.png")
ARTIFACT_DIR = "/Users/quochung/.gemini/antigravity/brain/911e72b5-4dd5-41b1-a4ed-6bfdd100a661"
TEST_TMP_DIR = os.path.join(ROOT_DIR, "tmp", "batch_test")
REPORT_JSON_PATH = os.path.join(ROOT_DIR, "data", "batch_test_results.json")

os.makedirs(TEST_TMP_DIR, exist_ok=True)
os.makedirs(ARTIFACT_DIR, exist_ok=True)


def get_access_tokens():
    env = {}
    with open(ENV_PATH, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip().strip("'\"")
    cid = env["GDRIVE_CLIENT_ID"]
    csec = env["GDRIVE_CLIENT_SECRET"]
    rts = [x.strip() for x in env.get("GDRIVE_REFRESH_TOKENS", "").split(",") if x.strip()]
    tokens = []
    for rt in rts:
        try:
            data = urllib.parse.urlencode({
                "client_id": cid,
                "client_secret": csec,
                "refresh_token": rt,
                "grant_type": "refresh_token",
            }).encode()
            req = urllib.request.Request("https://oauth2.googleapis.com/token", data=data)
            res = json.loads(urllib.request.urlopen(req, timeout=15).read())
            if res.get("access_token"):
                tokens.append(res["access_token"])
        except Exception:
            pass
    return tokens


def download_pdf(file_id: str, dest_path: str, tokens: list) -> bool:
    if os.path.exists(dest_path) and os.path.getsize(dest_path) > 1000:
        return True
    for tok in tokens:
        url = f"https://www.googleapis.com/drive/v3/files/{file_id}?alt=media&supportsAllDrives=true"
        req = urllib.request.Request(url, headers={"Authorization": f"Bearer {tok}"})
        try:
            with urllib.request.urlopen(req, timeout=25) as r:
                data = r.read()
                if len(data) > 500:
                    with open(dest_path, "wb") as out:
                        out.write(data)
                    return True
        except Exception:
            continue
    return False


def create_side_by_side_image(before_pdf: str, after_pdf: str, course_title: str, file_title: str, out_png: str):
    doc_b = fitz.open(before_pdf)
    doc_a = fitz.open(after_pdf)
    p_b = doc_b[0]
    p_a = doc_a[0]

    pix_b = p_b.get_pixmap(dpi=135)
    pix_a = p_a.get_pixmap(dpi=135)

    im_b = Image.frombytes("RGB", [pix_b.width, pix_b.height], pix_b.samples)
    im_a = Image.frombytes("RGB", [pix_a.width, pix_a.height], pix_a.samples)

    # Chuẩn hóa chiều cao 2 ảnh
    target_h = max(im_b.height, im_a.height)
    pad = 24
    header_h = 84
    canvas_w = im_b.width + im_a.width + pad * 3
    canvas_h = target_h + header_h + pad * 2

    canvas = Image.new("RGB", (canvas_w, canvas_h), (15, 23, 42))
    draw = ImageDraw.Draw(canvas)

    # Khung viền đỏ cho TRƯỚC và viền xanh lá cho SAU
    bx, by = pad, header_h + pad
    ax, ay = pad * 2 + im_b.width, header_h + pad

    draw.rectangle([bx - 3, by - 3, bx + im_b.width + 3, by + im_b.height + 3], outline=(239, 68, 68), width=3)
    draw.rectangle([ax - 3, ay - 3, ax + im_a.width + 3, ay + im_a.height + 3], outline=(16, 185, 129), width=3)

    canvas.paste(im_b, (bx, by))
    canvas.paste(im_a, (ax, ay))

    # Vẽ khung highlight vị trí watermark được xóa & đóng dấu trên ảnh để dễ quan sát
    w_b, h_b = im_b.size
    w_a, h_a = im_a.size
    # Highlight trên ảnh TRƯỚC (Mép trên, Mép dưới, Góc phải dưới)
    draw.rectangle([bx + int(w_b * 0.38), by + int(h_b * 0.002), bx + int(w_b * 0.66), by + int(h_b * 0.028)], outline=(239, 68, 68), width=2)
    draw.rectangle([bx + int(w_b * 0.38), by + int(h_b * 0.972), bx + int(w_b * 0.66), by + h_b - 2], outline=(239, 68, 68), width=2)
    draw.rectangle([bx + int(w_b * 0.70), by + int(h_b * 0.77), bx + int(w_b * 0.94), by + int(h_b * 0.95)], outline=(239, 68, 68), width=2)

    # Highlight trên ảnh SAU (Logo school.unizvn.com góc phải dưới)
    draw.rectangle([ax + int(w_a * 0.74), ay + int(h_a * 0.78), ax + int(w_a * 0.95), ay + int(h_a * 0.96)], outline=(16, 185, 129), width=3)

    try:
        font_title = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial Bold.ttf", 22)
        font_sub = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial.ttf", 17)
    except Exception:
        font_title = ImageFont.load_default()
        font_sub = ImageFont.load_default()

    draw.text((pad, 14), f"KHÓA HỌC: {course_title}", fill=(248, 250, 252), font=font_title)
    draw.text((pad, 44), f"File: {file_title}   |   TRÁI: Bản gốc (Watermark cũ)   →   PHẢI: Đã xóa WM cũ & Đóng dấu school.unizvn.com", fill=(148, 163, 184), font=font_sub)

    canvas.save(out_png, format="PNG", optimize=True)
    doc_b.close()
    doc_a.close()


def main():
    random.seed(2027)
    tokens = get_access_tokens()
    if not tokens:
        print(json.dumps({"ok": False, "error": "Không lấy được access token"}))
        sys.exit(1)

    with open(DB_PATH, "r", encoding="utf-8") as f:
        db = json.load(f)

    # Gom các file PDF bài học theo từng Khóa học / Giáo viên
    courses = {}
    for fid, info in db.get("syncedFileIds", {}).items():
        rel = str(info.get("relPath") or "")
        parts = rel.split("/")
        if len(parts) < 3:
            continue
        if parts[2].startswith("0. INFO"):
            continue
        size = int(info.get("size") or 0)
        # Ưu tiên chọn các file đề/bài tập 40KB - 900KB để tải nhanh và đa dạng
        if 40_000 <= size <= 950_000:
            course_key = f"{parts[0]} / {parts[1]}"
            courses.setdefault(course_key, []).append({
                "sourceFileId": fid,
                "subject": parts[0],
                "teacherCourse": parts[1],
                "relPath": rel,
                "fileName": parts[-1],
                "size": size,
            })

    # Chọn 2-3 file ngẫu nhiên cho MỖI khóa học
    selected_tasks = []
    for course_key, items in sorted(courses.items()):
        k = min(len(items), 2 if len(items) < 15 else 3)
        chosen = random.sample(items, k)
        for item in chosen:
            selected_tasks.append(item)

    print(f"Tổng số khóa học: {len(courses)} | Tổng số file PDF ngẫu nhiên được chọn: {len(selected_tasks)}", flush=True)

    results = []

    def worker(idx, task):
        fid = task["sourceFileId"]
        in_pdf = os.path.join(TEST_TMP_DIR, f"src_{fid}.pdf")
        out_pdf = os.path.join(TEST_TMP_DIR, f"uni_{fid}.pdf")
        t0 = time.time()
        ok_dl = download_pdf(fid, in_pdf, tokens)
        if not ok_dl:
            return {**task, "ok": False, "error": "Download failed"}
        try:
            rep = process_pdf(in_pdf, out_pdf, WM_PATH, True, True)
            elapsed = round(time.time() - t0, 2)
            uni_name = task["fileName"] if task["fileName"].upper().startswith("UNI ") else f"UNI {task['fileName']}"
            return {
                **task,
                "ok": True,
                "uniFileName": uni_name,
                "inPdf": in_pdf,
                "outPdf": out_pdf,
                "pages": rep.get("pages", 0),
                "removedStreams": rep.get("removedStreams", 0),
                "cleanedRasterPages": rep.get("cleanedRasterPages", 0),
                "removedLinks": rep.get("removedLinks", 0),
                "outputSize": rep.get("outputSize", 0),
                "elapsedSec": elapsed,
            }
        except Exception as e:
            return {**task, "ok": False, "error": str(e)}

    with ThreadPoolExecutor(max_workers=10) as ex:
        futs = [ex.submit(worker, i, t) for i, t in enumerate(selected_tasks)]
        for fut in as_completed(futs):
            res = fut.result()
            results.append(res)
            if len(results) % 20 == 0:
                print(f"  Đã xử lý {len(results)}/{len(selected_tasks)} files...", flush=True)

    # Sắp xếp lại kết quả theo môn và khóa học
    results.sort(key=lambda x: (x["subject"], x["teacherCourse"], x["fileName"]))

    # Tạo ảnh so sánh TRƯỚC & SAU cho các mẫu tiêu biểu của từng môn (ưu tiên các file có xóa watermark cũ rõ nét)
    by_subject = {}
    for r in results:
        if not r.get("ok"):
            continue
        by_subject.setdefault(r["subject"], []).append(r)

    comparison_images = []
    img_idx = 1
    for subj, list_r in by_subject.items():
        # Ưu tiên chọn mẫu từ 2 khóa học khác nhau trong môn đó có removedStreams > 0 hoặc cleanedRasterPages > 0
        with_wm = [x for x in list_r if (x.get("removedStreams", 0) > 0 or x.get("cleanedRasterPages", 0) > 0)]
        pool = with_wm if len(with_wm) >= 2 else list_r
        seen_teachers = set()
        picked = []
        for item in pool:
            if item["teacherCourse"] not in seen_teachers:
                seen_teachers.add(item["teacherCourse"])
                picked.append(item)
            if len(picked) >= 2:
                break
        for item in picked:
            img_name = f"before_after_{img_idx:02d}_{ item['sourceFileId'][:8] }.png"
            img_path = os.path.join(ARTIFACT_DIR, img_name)
            try:
                create_side_by_side_image(
                    item["inPdf"],
                    item["outPdf"],
                    f"[{item['subject']}] {item['teacherCourse']}",
                    item["fileName"],
                    img_path,
                )
                item["comparisonImage"] = img_path
                comparison_images.append({
                    "index": img_idx,
                    "subject": item["subject"],
                    "teacherCourse": item["teacherCourse"],
                    "fileName": item["fileName"],
                    "uniFileName": item["uniFileName"],
                    "pages": item["pages"],
                    "removedStreams": item["removedStreams"],
                    "cleanedRasterPages": item["cleanedRasterPages"],
                    "removedLinks": item["removedLinks"],
                    "imagePath": img_path,
                })
                img_idx += 1
            except Exception as e:
                print(f"Lỗi tạo ảnh so sánh cho {item['fileName']}: {e}", flush=True)

    summary = {
        "totalCoursesTested": len(courses),
        "totalFilesSelected": len(selected_tasks),
        "totalFilesSuccess": sum(1 for r in results if r.get("ok")),
        "totalPagesProcessed": sum(r.get("pages", 0) for r in results if r.get("ok")),
        "totalWatermarkStreamsRemoved": sum(r.get("removedStreams", 0) for r in results if r.get("ok")),
        "totalRasterPagesCleaned": sum(r.get("cleanedRasterPages", 0) for r in results if r.get("ok")),
        "totalSpamLinksRemoved": sum(r.get("removedLinks", 0) for r in results if r.get("ok")),
        "comparisonImagesCount": len(comparison_images),
        "comparisonImages": comparison_images,
        "results": [
            {k: v for k, v in r.items() if k not in ("inPdf", "outPdf")}
            for r in results
        ],
    }

    with open(REPORT_JSON_PATH, "w", encoding="utf-8") as f:
        json.dump(summary, f, ensure_ascii=False, indent=2)

    print("HOÀN TẤT!", json.dumps({k: v for k, v in summary.items() if k not in ("results", "comparisonImages")}, ensure_ascii=False))


if __name__ == "__main__":
    main()
