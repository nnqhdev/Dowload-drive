#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Bộ phân tích file Google Sheet (.xlsx) khóa học:
- Đọc toàn bộ các Tab (Worksheet), giá trị ô và hyperlink ẩn trong từng ô.
- Tự động nhận diện:
  1) Master Combo Sheet (ví dụ: COMBO HS12 2027 2K9 XPS): liệt kê danh sách Giáo viên / Khóa học
     theo từng Môn học (TOÁN, NGỮ VĂN, TIẾNG ANH, VẬT LÝ, HÓA HỌC, SINH HỌC, LỊCH SỬ, ĐỊA LÝ, ĐGNL - ĐGTD...).
  2) Sub-Sheet của từng Giáo viên / Khóa học: liệt kê từng Chương / Bài học kèm link Drive Folder hoặc File.
- Áp dụng nghiêm ngặt luật bỏ qua của tool cũ:
  - Không lấy file .sheet / Google Sheets / Google Docs
  - Không lấy mục Z. EBOOK / EBOOK SÁCH KÈM KHOÁ HỌC / BONUS / HƯỚNG DẪN HỌC
  - Làm sạch tên Giáo viên / Khóa học (bỏ đuôi - XPS ..., - TaiLieuOnThi .NET✅, ký tự tab thừa).
"""
import sys
import re
import json
import zipfile
import xml.etree.ElementTree as ET


DRIVE_FOLDER_RE = re.compile(r"drive\.google\.com/(?:drive/(?:u/\d+/)?folders/|open\?id=)([A-Za-z0-9_-]{15,})", re.I)
DRIVE_FILE_RE = re.compile(r"drive\.google\.com/(?:file/d/|open\?id=|uc\?(?:export=\w+&)?id=)([A-Za-z0-9_-]{15,})", re.I)
SHEET_ID_RE = re.compile(r"docs\.google\.com/spreadsheets/d/([A-Za-z0-9_-]{15,})", re.I)

SKIP_TAB_RE = re.compile(r"^(?:z\.?\s*)?ebook\b|🎁?\s*bonus|hướng\s*dẫn\s*học|tkb|lịch\s*học|check\s*list", re.I)
SKIP_ROW_TEXT_RE = re.compile(
    r"^(?:z\.?\s*)?ebook\b|ebook\s*sách\s*kèm|full\s*ebook\s*sgk|hướng\s*dẫn\s*học|\+?\s*vote\s*hs|combo\s*hs1[012]\s*2026|0\.\s*info\s*thông\s*tin",
    re.I,
)

SUBJECT_MAP = [
    (re.compile(r"^toán\b", re.I), "TOÁN"),
    (re.compile(r"^(?:ngữ\s*)?văn\b", re.I), "NGỮ VĂN"),
    (re.compile(r"^(?:tiếng\s*)?anh\b", re.I), "TIẾNG ANH"),
    (re.compile(r"^(?:vật\s*)?l[ýí]\b", re.I), "VẬT LÝ"),
    (re.compile(r"^(?:h[óo]a|hoá)(?:\s*học)?\b", re.I), "HÓA HỌC"),
    (re.compile(r"^sinh(?:\s*học)?\b", re.I), "SINH HỌC"),
    (re.compile(r"^(?:lịch\s*)?sử\b", re.I), "LỊCH SỬ"),
    (re.compile(r"^địa(?:\s*l[ýí])?\b", re.I), "ĐỊA LÝ"),
    (re.compile(r"^(?:đgnl|hsa|tsa|v-?act|spt|h-?sca|bổ\s*trợ\s*tsa)\b", re.I), "ĐGNL - ĐGTD (HSA, TSA, V-ACT, SPT)"),
]


def clean_name(raw: str) -> str:
    s = str(raw or "").replace("\t", " ").replace("\r", " ").replace("\n", " ").strip()
    s = re.sub(r"\s*-\s*TaiLieuOnThi\s*\.?\s*NET\s*✅?\s*$", "", s, flags=re.I)
    s = re.sub(r"\s+", " ", s).strip()
    return s


def clean_teacher_folder_name(raw: str) -> str:
    s = clean_name(raw)
    # Tách bỏ phần mô tả dài sau dấu " - XPS ..." hoặc " - Flash ..." hoặc " - DPADx..." nếu phần đầu đã là tên Giáo viên/Khóa chuẩn
    # Ngoại trừ trường hợp "NỀN TẢNG 12 MÔN ... HOCMAI - Thầy ..."
    if not re.match(r"^NỀN\s+TẢNG\s+12\s+MÔN\b", s, re.I):
        m = re.match(r"^(.+?(?:2K\d|202\d))\s*-\s*.+$", s, re.I)
        if m:
            s = m.group(1).strip()
    else:
        # Với NỀN TẢNG 12 MÔN TOÁN 2027 HOCMAI - Thầy ... -> lấy tên thư mục giáo viên gốc "NỀN TẢNG 12 MÔN TOÁN 2027 HOCMAI"
        m_hm = re.match(r"^(NỀN\s+TẢNG\s+12\s+MÔN\s+.+?HOCMAI)\s*-\s*(.+)$", s, re.I)
        if m_hm:
            s = m_hm.group(1).strip()
    return s


def infer_subject(teacher_title: str, current_subject: str = "") -> str:
    t = clean_name(teacher_title)
    if re.search(r"\b(?:HSA|TSA|V-?ACT|SPT|H-?SCA|ĐGNL|ĐGTD)\b", t, re.I):
        return "ĐGNL - ĐGTD (HSA, TSA, V-ACT, SPT)"
    m_hm = re.search(r"NỀN\s+TẢNG\s+12\s+MÔN\s+([A-ZÀ-Ỹ\s]+?)(?:\s+202\d)?\s+HOCMAI", t, re.I)
    if m_hm:
        sub_part = m_hm.group(1).strip()
        for rx, canonical in SUBJECT_MAP:
            if rx.search(sub_part):
                return canonical
    for rx, canonical in SUBJECT_MAP:
        if rx.search(t):
            return canonical
    if current_subject:
        for rx, canonical in SUBJECT_MAP:
            if rx.search(current_subject):
                return canonical
    return current_subject or "KHÁC"


def parse_xlsx(xlsx_path: str) -> dict:
    ns = {
        "main": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
        "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    }
    with zipfile.ZipFile(xlsx_path, "r") as z:
        wb_xml = ET.fromstring(z.read("xl/workbook.xml"))
        rels_xml = ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))
        rid_to_target = {rel.attrib["Id"]: rel.attrib["Target"] for rel in rels_xml}

        shared_strings = []
        if "xl/sharedStrings.xml" in z.namelist():
            ss_xml = ET.fromstring(z.read("xl/sharedStrings.xml"))
            for si in ss_xml.findall("main:si", ns):
                shared_strings.append("".join(t.text or "" for t in si.findall(".//main:t", ns)))

        tabs = []
        teachers = []
        seen_teacher_folders = set()

        for s in wb_xml.findall(".//main:sheet", ns):
            tab_name = s.attrib.get("name", "").strip()
            sheet_id = s.attrib.get("sheetId", "")
            rid = s.attrib.get("{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id", "")
            target = "xl/" + rid_to_target.get(rid, "").lstrip("/")
            if target not in z.namelist():
                continue

            is_skipped_tab = bool(SKIP_TAB_RE.search(tab_name))

            rels_path = target.replace("worksheets/", "worksheets/_rels/") + ".rels"
            hl_map = {}
            if rels_path in z.namelist():
                for rel in ET.fromstring(z.read(rels_path)):
                    hl_map[rel.attrib["Id"]] = rel.attrib.get("Target", "")

            ws_xml = ET.fromstring(z.read(target))
            cell_links = {}
            for hl in ws_xml.findall(".//main:hyperlink", ns):
                ref = hl.attrib.get("ref", "")
                hrid = hl.attrib.get("{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id", "")
                loc = hl.attrib.get("location", "")
                if ref:
                    cell_links[ref] = hl_map.get(hrid, loc or "")

            tab_rows = []
            current_subject = ""

            for r in ws_xml.findall(".//main:row", ns):
                r_idx = int(r.attrib.get("r", "0"))
                row_cells = {}
                for c in r.findall("main:c", ns):
                    cref = c.attrib.get("r", "")
                    col_let = re.sub(r"\d+", "", cref)
                    ctype = c.attrib.get("t", "")
                    v_el = c.find("main:v", ns)
                    f_el = c.find("main:f", ns)
                    val = ""
                    if v_el is not None and v_el.text is not None:
                        if ctype == "s":
                            idx = int(v_el.text)
                            val = shared_strings[idx] if 0 <= idx < len(shared_strings) else v_el.text
                        else:
                            val = v_el.text
                    elif ctype == "inlineStr":
                        val = "".join(t.text or "" for t in c.findall(".//main:t", ns))

                    link = cell_links.get(cref, "")
                    if not link and f_el is not None and f_el.text and "HYPERLINK" in f_el.text.upper():
                        m_hl = re.search(r'"(https?://[^"]+)"', f_el.text)
                        if m_hl:
                            link = m_hl.group(1)

                    val_clean = clean_name(val)
                    if val_clean or link:
                        row_cells[col_let] = {"text": val_clean, "link": link.strip()}

                if not row_cells:
                    continue

                # Cập nhật môn học ở cột A nếu có
                col_a = row_cells.get("A", {}).get("text", "")
                if col_a and r_idx >= 10:
                    for rx, canonical in SUBJECT_MAP:
                        if rx.search(col_a):
                            current_subject = canonical
                            break

                # Kiểm tra xem dòng này có phải là dòng Giáo viên / Khóa học trong Master Sheet không (Cột C có link Drive Folder)
                col_c = row_cells.get("C", {})
                col_d = row_cells.get("D", {})
                col_e = row_cells.get("E", {})
                c_text = col_c.get("text", "")
                c_link = col_c.get("link", "")
                d_link = col_d.get("link", "")

                if not is_skipped_tab and r_idx >= 10 and c_text and c_link:
                    if SKIP_ROW_TEXT_RE.search(c_text):
                        continue
                    m_folder = DRIVE_FOLDER_RE.search(c_link)
                    if m_folder:
                        folder_id = m_folder.group(1)
                        teacher_folder = clean_teacher_folder_name(c_text)
                        subj = infer_subject(teacher_folder, current_subject)
                        if subj == "KHÁC" or "BONUS" in col_a.upper():
                            continue
                        m_subsheet = SHEET_ID_RE.search(d_link)
                        sub_sheet_id = m_subsheet.group(1) if m_subsheet else ""

                        if folder_id not in seen_teacher_folders:
                            seen_teacher_folders.add(folder_id)
                            teachers.append({
                                "row": r_idx,
                                "tab": tab_name,
                                "subject": subj,
                                "rawTitle": c_text,
                                "teacherFolder": teacher_folder,
                                "sourceFolderId": folder_id,
                                "sourceFolderUrl": c_link,
                                "subSheetId": sub_sheet_id,
                                "subSheetUrl": d_link if sub_sheet_id else "",
                                "note": col_e.get("text", ""),
                            })

                # Lưu các dòng có link Drive (cho trường hợp Sub-Sheet của từng giáo viên)
                row_drive_links = []
                for col_k, cell_obj in row_cells.items():
                    lnk = cell_obj.get("link", "")
                    if not lnk:
                        continue
                    # Bỏ qua link dẫn tới file .sheet / Google Sheets nếu người dùng chỉ muốn lấy folder/file bài học
                    mf = DRIVE_FOLDER_RE.search(lnk)
                    mfile = DRIVE_FILE_RE.search(lnk)
                    msheet = SHEET_ID_RE.search(lnk)
                    if mf:
                        row_drive_links.append({"col": col_k, "kind": "folder", "id": mf.group(1), "url": lnk, "label": cell_obj.get("text", "")})
                    elif mfile and not msheet:
                        row_drive_links.append({"col": col_k, "kind": "file", "id": mfile.group(1), "url": lnk, "label": cell_obj.get("text", "")})

                if row_drive_links:
                    row_title = (
                        row_cells.get("B", {}).get("text")
                        or row_cells.get("F", {}).get("text")
                        or row_cells.get("C", {}).get("text")
                        or row_cells.get("A", {}).get("text")
                        or f"Dòng {r_idx}"
                    )
                    if not SKIP_ROW_TEXT_RE.search(row_title):
                        tab_rows.append({
                            "row": r_idx,
                            "title": row_title,
                            "cells": row_cells,
                            "driveLinks": row_drive_links,
                        })

            tabs.append({
                "name": tab_name,
                "sheetId": sheet_id,
                "skippedByRule": is_skipped_tab,
                "linkedRowsCount": len(tab_rows),
                "rows": tab_rows,
            })

    return {
        "ok": True,
        "isMasterSheet": len(teachers) > 0,
        "teachersCount": len(teachers),
        "teachers": teachers,
        "tabs": tabs,
    }


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"ok": False, "error": "Usage: sheet_parser.py <file.xlsx>"}))
        sys.exit(1)
    try:
        res = parse_xlsx(sys.argv[1])
        print(json.dumps(res, ensure_ascii=False))
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)}, ensure_ascii=False))
        sys.exit(1)
