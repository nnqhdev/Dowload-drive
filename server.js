#!/usr/bin/env node
/**
 * UNI Sheet -> Drive Sync & Watermark Tool (macOS Rebuild)
 * Kết nối trực tiếp với dự án: /Users/quochung/Project/School/school.unizvn
 * Phục hồi đầy đủ cơ sở dữ liệu lọc trùng (_pdf_sync_db.json) và watermark chuẩn school.unizvn.com
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { spawn, execFile } = require('child_process');
const multer = require('multer');
const ffmpegPath = require('ffmpeg-static');

const PORT = Number(process.env.PORT || 4000);
const OAUTH_CALLBACK_PORT = 53682;
const OAUTH_REDIRECT_URI = `http://127.0.0.1:${OAUTH_CALLBACK_PORT}/callback`;

const ROOT_DIR = __dirname;
const DATA_DIR = path.join(ROOT_DIR, 'data');
const TMP_DIR = path.join(ROOT_DIR, 'tmp');
const ASSETS_DIR = path.join(ROOT_DIR, 'assets');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const PYTHON_BIN = path.join(ROOT_DIR, '.venv', 'bin', 'python');
const PDF_PROCESSOR_PY = path.join(ROOT_DIR, 'scripts', 'pdf_processor.py');
const SHEET_PARSER_PY = path.join(ROOT_DIR, 'scripts', 'sheet_parser.py');
const DRIVE_FALLBACK_PY = path.join(ROOT_DIR, 'scripts', 'drive_fallback_downloader.py');
const WATERMARK_PNG = path.join(ASSETS_DIR, 'watermark.png');

const SCHOOL_PROJECT_DIR = '/Users/quochung/Project/School/school.unizvn';
const SCHOOL_ENV_PATH = path.join(SCHOOL_PROJECT_DIR, '.env');
const SCHOOL_LESSONS_PATH = path.join(SCHOOL_PROJECT_DIR, 'data', 'lessons.json');
const SCHOOL_JSON_PATH = path.join(SCHOOL_PROJECT_DIR, 'data', 'school.json');

const PDF_SYNC_DB_PATH = path.join(DATA_DIR, '_pdf_sync_db.json');
const VIDEO_SYNC_DB_PATH = path.join(DATA_DIR, '_video_sync_db.json');
const TOOL_CONFIG_PATH = path.join(DATA_DIR, 'tool-config.json');
const MASTER_SHEET_XLSX_PATH = path.join(DATA_DIR, 'master_sheet_2027.xlsx');

const DEFAULT_MASTER_SHEET_ID = '18_CKgfmrRhBB32cxIOEfrZLukjwJJ7kES2X-IK3NsHc';
const DEFAULT_SCHOOL_ROOT_ID = '1KBiUmgMtLOxlK7oJRStIP63sL_WAC1AP';
const REMOTE_PDF_SYNC_DB_ID = '1dL004WRVkYE3y-vp_yQGsRB-6xWVGKvh';

const SUBJECT_ROOT_FOLDERS = {
  'TOÁN': '1OTcXbv8XQhxmzH4SdGOMfTB7QrBGRKfv',
  'NGỮ VĂN': '1fVL76Gun8lhkVVuJGKsZPq5PhjFs8icg',
  'TIẾNG ANH': '133bqJOVcH8CbiFthleGmiK9Xl3cNbBVF',
  'VẬT LÝ': '1TfZ3TSwYBoFbMt017Hdf_b9CpuEqYfnd',
  'HÓA HỌC': '18FvxWlgkNTGKL9JDu_e9pVzf3UUFZsXz',
  'SINH HỌC': '1dinJrXT7p7gm9azZQPtnqWxnEPGxegz8',
  'LỊCH SỬ': '1vFJf7gojOvG6cNGOOwtwwqR2R6DFQW6v',
  'ĐỊA LÝ': '1JMAooyuSFP0RudkN0yQNmxwmVahdLs0e',
  'ĐGNL - ĐGTD (HSA, TSA, V-ACT, SPT)': '1Qv-8rSivXCiWwe-T9R8e9e8hUisLAObs',
};

for (const d of [DATA_DIR, TMP_DIR, ASSETS_DIR, PUBLIC_DIR]) {
  fs.mkdirSync(d, { recursive: true });
}

// ---------------------------------------------------------------------------
// 1. Quản lý cấu hình & Database Lọc trùng (_pdf_sync_db.json + _video_sync_db.json)
// ---------------------------------------------------------------------------
function loadEnvFile(filePath) {
  const out = {};
  if (!fs.existsSync(filePath)) return out;
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const k = trimmed.slice(0, eq).trim();
    const v = trimmed.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
    out[k] = v;
  }
  return out;
}

const defaultConfig = {
  masterSheetId: DEFAULT_MASTER_SHEET_ID,
  schoolRootFolderId: DEFAULT_SCHOOL_ROOT_ID,
  remotePdfSyncDbFileId: REMOTE_PDF_SYNC_DB_ID,
  rules: {
    skipGoogleSheetsAndDocs: true,
    skipEbookFolders: true,
    skipBonusAndGuide: true,
    skipInfoFolderForVideo: true,
    skipInfoFolderForPdf: false,
    cleanFolderNames: true,
    pdfRemoveOldWatermark: true,
    pdfStampUniWatermark: true,
    pdfAddUniPrefix: true,
    replaceLegacyNonUniPdf: false,
    cleanCoexistingLegacyPdf: true,
    videoMode: 'remux_or_copy', // 'server_copy' | 'remux_upload' | 'remux_or_copy'
    autoTriggerSchoolSync: false,
  },
  autoSync: {
    enabled: false,
    intervalMinutes: 180,
    lastRunAt: null,
  },
  customSheets: [],
  writeRefreshTokens: [],
};

function loadToolConfig() {
  try {
    if (fs.existsSync(TOOL_CONFIG_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(TOOL_CONFIG_PATH, 'utf8'));
      return {
        ...defaultConfig,
        ...parsed,
        rules: { ...defaultConfig.rules, ...(parsed.rules || {}) },
        autoSync: { ...defaultConfig.autoSync, ...(parsed.autoSync || {}) },
      };
    }
  } catch (e) {
    console.error('Lỗi đọc tool-config.json:', e.message);
  }
  return JSON.parse(JSON.stringify(defaultConfig));
}

function saveToolConfig(cfg) {
  fs.writeFileSync(TOOL_CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
}

let toolConfig = loadToolConfig();

let pdfSyncDb = {
  version: 2,
  updatedAt: new Date().toISOString(),
  syncedFileIds: {},
  syncedNormPaths: {},
  dstFolderCache: {},
  completedTeachers: {},
};

function loadPdfSyncDb() {
  try {
    if (fs.existsSync(PDF_SYNC_DB_PATH)) {
      const raw = JSON.parse(fs.readFileSync(PDF_SYNC_DB_PATH, 'utf8'));
      pdfSyncDb = {
        version: raw.version || 2,
        updatedAt: raw.updatedAt || new Date().toISOString(),
        syncedFileIds: raw.syncedFileIds || {},
        syncedNormPaths: raw.syncedNormPaths || {},
        dstFolderCache: raw.dstFolderCache || {},
        completedTeachers: raw.completedTeachers || {},
      };
    }
  } catch (e) {
    console.error('Lỗi đọc _pdf_sync_db.json:', e.message);
  }
  // Đảm bảo 9 thư mục môn học gốc luôn có trong dstFolderCache
  for (const [subj, fid] of Object.entries(SUBJECT_ROOT_FOLDERS)) {
    const k = normSegV2(subj, false);
    if (!pdfSyncDb.dstFolderCache[k]) {
      pdfSyncDb.dstFolderCache[k] = fid;
    }
  }
}

function savePdfSyncDb() {
  pdfSyncDb.updatedAt = new Date().toISOString();
  const tmp = `${PDF_SYNC_DB_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(pdfSyncDb, null, 2), 'utf8');
  fs.renameSync(tmp, PDF_SYNC_DB_PATH);
}

let videoSyncDb = {
  version: 1,
  updatedAt: new Date().toISOString(),
  syncedFileIds: {},
  syncedNormPaths: {},
};

function loadVideoSyncDb() {
  try {
    if (fs.existsSync(VIDEO_SYNC_DB_PATH)) {
      const raw = JSON.parse(fs.readFileSync(VIDEO_SYNC_DB_PATH, 'utf8'));
      videoSyncDb = {
        version: 1,
        updatedAt: raw.updatedAt || new Date().toISOString(),
        syncedFileIds: raw.syncedFileIds || {},
        syncedNormPaths: raw.syncedNormPaths || {},
      };
    }
  } catch (e) {
    console.error('Lỗi đọc _video_sync_db.json:', e.message);
  }
}

function saveVideoSyncDb() {
  videoSyncDb.updatedAt = new Date().toISOString();
  const tmp = `${VIDEO_SYNC_DB_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(videoSyncDb, null, 2), 'utf8');
  fs.renameSync(tmp, VIDEO_SYNC_DB_PATH);
}

// Đọc danh sách ID bài học đang sử dụng trên web school.unizvn
let schoolStats = {
  lessonsCount: 0,
  videoIds: new Set(),
  pdfIds: new Set(),
  webLessonDriveIds: new Set(),
  allUsedDriveIds: new Set(),
};

function extractDriveIdFromToken(str) {
  if (!str) return '';
  const m = String(str).match(/^drive:([A-Za-z0-9_-]{15,})/i);
  return m ? m[1] : '';
}

function loadSchoolWebData() {
  const videoIds = new Set();
  const pdfIds = new Set();
  let lessonsCount = 0;
  try {
    if (fs.existsSync(SCHOOL_LESSONS_PATH)) {
      const coursesObj = JSON.parse(fs.readFileSync(SCHOOL_LESSONS_PATH, 'utf8'));
      for (const courseData of Object.values(coursesObj || {})) {
        const list = Array.isArray(courseData?.lessons) ? courseData.lessons : [];
        lessonsCount += list.length;
        for (const l of list) {
          const vid = extractDriveIdFromToken(l.video);
          if (vid) videoIds.add(vid);
          for (const vObj of l.videos || []) {
            const vid2 = extractDriveIdFromToken(vObj?.url || vObj);
            if (vid2) videoIds.add(vid2);
          }
          const pid = extractDriveIdFromToken(l.doc);
          if (pid) pdfIds.add(pid);
          for (const dObj of l.docs || []) {
            const pid2 = extractDriveIdFromToken(dObj?.url || dObj);
            if (pid2) pdfIds.add(pid2);
          }
        }
      }
    }
  } catch (e) {
    console.error('Lỗi đọc school.unizvn/data/lessons.json:', e.message);
  }
  const webLessonDriveIds = new Set([...videoIds, ...pdfIds]);
  const allUsed = new Set(webLessonDriveIds);
  for (const info of Object.values(pdfSyncDb.syncedFileIds || {})) {
    if (info && info.dstFileId) allUsed.add(info.dstFileId);
  }
  schoolStats = {
    lessonsCount,
    videoIds,
    pdfIds,
    webLessonDriveIds,
    allUsedDriveIds: allUsed,
  };
}

// Tự động thay thế Drive ID của bản PDF cũ bằng Drive ID của bản UNI mới trong lessons.json & school.json
function replaceDriveIdsInSchoolLessons(replacementsMap) {
  if (!replacementsMap || Object.keys(replacementsMap).length === 0) return 0;
  let replacedCount = 0;
  for (const filePath of [SCHOOL_LESSONS_PATH, SCHOOL_JSON_PATH]) {
    try {
      if (!fs.existsSync(filePath)) continue;
      let raw = fs.readFileSync(filePath, 'utf8');
      let changed = false;
      for (const [oldId, newId] of Object.entries(replacementsMap)) {
        if (!oldId || !newId || oldId === newId) continue;
        const tokenOld = `drive:${oldId}`;
        if (raw.includes(tokenOld)) {
          raw = raw.split(tokenOld).join(`drive:${newId}`);
          changed = true;
          replacedCount++;
        }
      }
      if (changed) {
        const tmp = `${filePath}.tmp`;
        fs.writeFileSync(tmp, raw, 'utf8');
        fs.renameSync(tmp, filePath);
      }
    } catch (e) {
      console.error(`Lỗi cập nhật ID trong ${filePath}:`, e.message);
    }
  }
  if (replacedCount > 0) {
    loadSchoolWebData();
  }
  return replacedCount;
}

// ---------------------------------------------------------------------------
// 2. Chuẩn hóa tên & Luật lọc (Exclusion Rules) của Tool cũ
// ---------------------------------------------------------------------------
function cleanDisplayName(raw) {
  let s = String(raw || '').normalize('NFC').replace(/[\t\r\n]+/g, ' ').trim();
  s = s.replace(/\s*-\s*TaiLieuOnThi\s*\.?\s*NET\s*✅?\s*$/i, '').trim();
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

function isUniFileName(name) {
  return /^(?:UNI[\s_.:-]+)+/i.test(String(name || '').trim());
}

function normSegV2(seg, isFile = false) {
  let s = cleanDisplayName(seg);
  if (isFile) {
    s = s.replace(/^(?:UNI[\s_.:-]+)+/i, '').trim();
  }
  return s.toLowerCase();
}

function normSegV1(seg, isFile = false) {
  return normSegV2(seg, isFile)
    .replace(/[:*?"<>|_]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildNormPaths(relPathParts) {
  const v2 = relPathParts
    .map((p, idx) => normSegV2(p, idx === relPathParts.length - 1))
    .join('/');
  const v1 = relPathParts
    .map((p, idx) => normSegV1(p, idx === relPathParts.length - 1))
    .join('/');
  return { v2, v1 };
}

const EBOOK_FOLDER_RE = /^(?:z\.?\s*)?ebook\b|ebook\s*sách\s*kèm|full\s*ebook\s*sgk|sách\s*ebook/i;
const BONUS_GUIDE_FOLDER_RE = /^🎁?\s*bonus\b|hướng\s*dẫn\s*học|\+?\s*vote\s*hs/i;
const INFO_FOLDER_RE = /^0\.\s*info\b|thông\s*tin\s*và\s*hướng\s*dẫn\s*khoá\s*học/i;

function shouldSkipFolder(folderName, rules = toolConfig.rules) {
  const clean = cleanDisplayName(folderName);
  if (!clean) return { skip: true, reason: 'Tên thư mục rỗng' };
  if (rules.skipEbookFolders && EBOOK_FOLDER_RE.test(clean)) {
    return { skip: true, reason: 'Luật bỏ qua Z. EBOOK / Sách kèm khóa học' };
  }
  if (rules.skipBonusAndGuide && BONUS_GUIDE_FOLDER_RE.test(clean)) {
    return { skip: true, reason: 'Luật bỏ qua BONUS / Hướng dẫn học' };
  }
  return { skip: false, cleanName: clean };
}

function classifyDriveItem(item, parentRelParts, rules = toolConfig.rules) {
  const mime = String(item.mimeType || '');
  const rawName = String(item.name || '');
  const clean = cleanDisplayName(rawName);
  const lower = clean.toLowerCase();

  // 1. Bỏ qua tuyệt đối file .sheet / Google Docs / Google Sheets / Shortcut
  if (mime.startsWith('application/vnd.google-apps.')) {
    if (mime === 'application/vnd.google-apps.folder') {
      return { kind: 'folder', cleanName: clean };
    }
    return { kind: 'skip', reason: `Bỏ qua Google Apps (${mime.split('.').pop()})` };
  }
  if (
    lower.endsWith('.sheet') ||
    lower.endsWith('.gsheet') ||
    lower.endsWith('.gdoc') ||
    lower.endsWith('.xlsx') ||
    lower.endsWith('.xls') ||
    lower.endsWith('.csv')
  ) {
    return { kind: 'skip', reason: 'Luật bỏ qua file bảng tính (.sheet / .xlsx)' };
  }

  // Kiểm tra nếu nằm trong mục Z.EBOOK mà lọt xuống file
  if (rules.skipEbookFolders && EBOOK_FOLDER_RE.test(clean)) {
    return { kind: 'skip', reason: 'Luật bỏ qua file Z. EBOOK' };
  }

  const inInfoFolder = parentRelParts.some((seg) => INFO_FOLDER_RE.test(seg));

  const isPdf = mime === 'application/pdf' || lower.endsWith('.pdf');
  if (isPdf) {
    if (inInfoFolder && rules.skipInfoFolderForPdf) {
      return { kind: 'skip', reason: 'Bỏ qua PDF trong 0. INFO' };
    }
    return { kind: 'pdf', cleanName: clean };
  }

  const isVideo =
    mime.startsWith('video/') ||
    /\.(mp4|mov|mkv|webm|ts|m4v|avi|flv)$/i.test(lower);
  if (isVideo) {
    if (inInfoFolder && rules.skipInfoFolderForVideo) {
      return { kind: 'skip', reason: 'Bỏ qua Video trong 0. INFO' };
    }
    const fSize = Number(item.size || 0);
    if (fSize > 0 && fSize < 65536) {
      return { kind: 'skip', reason: `Bỏ qua Video rỗng/lỗi trên Drive gốc (${fSize} bytes < 64KB)` };
    }
    return { kind: 'video', cleanName: clean };
  }

  return { kind: 'skip', reason: `Định dạng không lấy (${mime || path.extname(lower) || 'unknown'})` };
}

// ---------------------------------------------------------------------------
// 3. Google Drive OAuth2 Token Pool (Đọc + Ghi) & Luồng Cấp quyền 1-Click
// ---------------------------------------------------------------------------
let tokenPool = []; // [{ refreshToken, accessToken, email, canWrite, scopes, expiresAt }]
let readIdx = 0;
let writeIdx = 0;

function getCredentials() {
  const env = loadEnvFile(SCHOOL_ENV_PATH);
  const clientId = env.GDRIVE_CLIENT_ID || process.env.GDRIVE_CLIENT_ID || '';
  const clientSecret = env.GDRIVE_CLIENT_SECRET || process.env.GDRIVE_CLIENT_SECRET || '';
  const envTokens = (env.GDRIVE_REFRESH_TOKENS || env.GDRIVE_REFRESH_TOKEN || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const extraWriteTokens = (toolConfig.writeRefreshTokens || [])
    .map((s) => String(s || '').trim())
    .filter(Boolean);

  // Ưu tiên đặt writeRefreshTokens lên trước để nếu cùng email thì bản có quyền ghi được giữ
  const allRefreshTokens = [...new Set([...extraWriteTokens, ...envTokens])];
  return { clientId, clientSecret, allRefreshTokens };
}

async function refreshSingleToken(refreshToken, clientId, clientSecret) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  const data = await res.json();
  if (!data.access_token) {
    throw new Error(data.error_description || data.error || 'Không lấy được access_token');
  }
  const scopeStr = String(data.scope || '');
  const scopes = scopeStr.split(/\s+/).filter(Boolean);
  const canWrite =
    scopes.includes('https://www.googleapis.com/auth/drive') ||
    scopes.includes('https://www.googleapis.com/auth/drive.file');

  let email = 'unknown';
  try {
    const aboutRes = await fetch('https://www.googleapis.com/drive/v3/about?fields=user(emailAddress,displayName)', {
      headers: { Authorization: `Bearer ${data.access_token}` },
    });
    const aboutData = await aboutRes.json();
    if (aboutData?.user?.emailAddress) {
      email = aboutData.user.emailAddress;
    }
  } catch {}

  return {
    refreshToken,
    accessToken: data.access_token,
    email,
    canWrite,
    scopes,
    expiresAt: Date.now() + Number(data.expires_in || 3500) * 1000,
  };
}

const ALLOWED_GDRIVE_EMAIL = 'hung264656@gmail.com';

async function initTokenPool() {
  const { clientId, clientSecret, allRefreshTokens } = getCredentials();
  if (!clientId || !clientSecret) {
    console.warn('Chưa tìm thấy GDRIVE_CLIENT_ID / GDRIVE_CLIENT_SECRET trong .env');
    return [];
  }
  const byEmail = new Map();
  for (const rt of allRefreshTokens) {
    try {
      const info = await refreshSingleToken(rt, clientId, clientSecret);
      const emailKey = String(info.email || '').toLowerCase();
      // Chỉ giữ tài khoản đọc chính hung264656@gmail.com hoặc tài khoản có quyền ghi (canWrite) để dự phòng khi vượt hạn mức upload 750GB/ngày
      if (emailKey !== ALLOWED_GDRIVE_EMAIL && !info.canWrite) {
        continue;
      }
      const existing = byEmail.get(emailKey);
      if (!existing || (!existing.canWrite && info.canWrite)) {
        byEmail.set(emailKey, info);
      }
    } catch (e) {
      console.warn('Refresh token lỗi:', e.message);
    }
  }
  // Đưa tài khoản chính hung264656@gmail.com lên vị trí đầu tiên
  tokenPool = Array.from(byEmail.values()).sort((a, b) => {
    const aIsPrimary = String(a.email || '').toLowerCase() === ALLOWED_GDRIVE_EMAIL ? 0 : 1;
    const bIsPrimary = String(b.email || '').toLowerCase() === ALLOWED_GDRIVE_EMAIL ? 0 : 1;
    return aIsPrimary - bIsPrimary;
  });
  return tokenPool;
}

function markTokenUploadQuotaExhausted(accessToken) {
  const entry = tokenPool.find((t) => t.accessToken === accessToken);
  if (entry) {
    entry.uploadQuotaExhaustedUntil = Date.now() + 60 * 60 * 1000;
    console.warn(`[QUOTA] Tài khoản ${entry.email} chạm hạn mức upload 750GB/24h của Google Drive, tự động chuyển lượt upload sang tài khoản ghi dự phòng.`);
  }
}

let preferredReadIdx = 0;
let preferredReadIdxConfirmed = false;

async function ensureFreshTokens() {
  const now = Date.now();
  const { clientId, clientSecret } = getCredentials();
  if (!tokenPool.length) {
    await initTokenPool();
  }
  for (let i = 0; i < tokenPool.length; i++) {
    if (tokenPool[i].expiresAt - now < 120_000) {
      try {
        const prevExhausted = tokenPool[i].uploadQuotaExhaustedUntil || 0;
        const refreshed = await refreshSingleToken(tokenPool[i].refreshToken, clientId, clientSecret);
        refreshed.uploadQuotaExhaustedUntil = prevExhausted;
        tokenPool[i] = refreshed;
      } catch {}
    }
  }
}

async function getToken({ requireWrite = false } = {}) {
  await ensureFreshTokens();
  if (requireWrite) {
    const now = Date.now();
    const allWriters = tokenPool.filter((t) => t.canWrite);
    if (!allWriters.length) {
      throw new Error(
        'Các tài khoản hiện tại trong .env mới chỉ có quyền ĐỌC (drive.readonly). Vui lòng bấm nút "Cấp quyền Ghi Google Drive (1-Click)" ở thanh trên cùng hoặc tab Tài khoản để upload/tạo thư mục.'
      );
    }
    const activeWriters = allWriters.filter((t) => !t.uploadQuotaExhaustedUntil || now > t.uploadQuotaExhaustedUntil);
    const pool = activeWriters.length > 0 ? activeWriters : allWriters;
    // Ưu tiên tài khoản chính hung264656@gmail.com nếu chưa hết hạn mức upload 750GB/ngày
    const primaryWriter = pool.find((t) => String(t.email || '').toLowerCase() === ALLOWED_GDRIVE_EMAIL);
    if (primaryWriter) return primaryWriter.accessToken;
    const chosen = pool[writeIdx % pool.length];
    writeIdx++;
    return chosen.accessToken;
  }
  if (!tokenPool.length) {
    throw new Error('Không có token Google Drive nào hoạt động.');
  }
  // Mọi thao tác ĐỌC/QUÉT thư mục nguồn đều khóa cứng vào hung264656@gmail.com
  const primaryReader = tokenPool.find((t) => String(t.email || '').toLowerCase() === ALLOWED_GDRIVE_EMAIL) || tokenPool[0];
  return primaryReader.accessToken;
}

// ---------------------------------------------------------------------------
// 4. Các hàm gọi Google Drive API (Quét BFS tốc độ cao, Tải file, Tạo folder, Upload)
// ---------------------------------------------------------------------------
async function driveJson(url, options = {}, requireWrite = false, retries = 8) {
  let lastErr = null;
  const maxAttempts = Math.max(retries, tokenPool.length + 1);
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const token = await getToken({ requireWrite });
    try {
      const res = await fetch(url, {
        ...options,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(options.headers || {}),
        },
      });
      if (res.status === 429 || res.status >= 500) {
        await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
        continue;
      }
      const data = await res.json();
      if (data.error) {
        const errMsg = data.error.message || JSON.stringify(data.error);
        lastErr = new Error(errMsg);
        if (requireWrite && /userRateLimitExceeded|User rate limit exceeded/i.test(errMsg)) {
          markTokenUploadQuotaExhausted(token);
          if (attempt < maxAttempts - 1) continue;
        }
        // Nếu 404/403 do tài khoản hiện tại chưa được share file nguồn, thử sang tài khoản tiếp theo trong pool
        if ((data.error.code === 404 || data.error.code === 403 || data.error.code === 429) && attempt < maxAttempts - 1) {
          continue;
        }
        throw lastErr;
      }
      return data;
    } catch (err) {
      lastErr = err;
      if (attempt === maxAttempts - 1) throw err;
      const isNetErr = /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND/i.test(String(err.message || ''));
      await new Promise((r) => setTimeout(r, isNetErr ? 3000 * (attempt + 1) : 400));
    }
  }
  throw lastErr || new Error('Drive API request failed');
}

async function listSingleFolderWithToken(folderId, accessToken) {
  const q = `'${folderId}' in parents and trashed = false`;
  const items = [];
  let pageToken = '';
  do {
    const params = new URLSearchParams({
      q,
      pageSize: '1000',
      fields: 'nextPageToken, files(id, name, mimeType, parents, size, md5Checksum, modifiedTime, shortcutDetails)',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
    });
    if (pageToken) params.set('pageToken', pageToken);
    const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (res.status === 429 || res.status >= 500) {
      await new Promise((r) => setTimeout(r, 500));
      const retryRes = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const retryData = await retryRes.json().catch(() => ({}));
      if (retryData.files) items.push(...retryData.files);
      pageToken = retryData.nextPageToken || '';
      continue;
    }
    const data = await res.json().catch(() => ({}));
    if (data.error) {
      throw new Error(data.error.message || JSON.stringify(data.error));
    }
    if (data.files) items.push(...data.files);
    pageToken = data.nextPageToken || '';
  } while (pageToken);

  return items.map((it) => {
    if (
      it.mimeType === 'application/vnd.google-apps.shortcut' &&
      it.shortcutDetails?.targetId &&
      it.shortcutDetails?.targetMimeType
    ) {
      return {
        ...it,
        shortcutId: it.id,
        id: it.shortcutDetails.targetId,
        mimeType: it.shortcutDetails.targetMimeType,
        parents: [folderId],
      };
    }
    return {
      ...it,
      parents: [folderId],
    };
  });
}

async function listSingleFolderChildren(folderId) {
  const token = await getToken({ requireWrite: false });
  return listSingleFolderWithToken(folderId, token);
}

async function listFolderChildrenBatch(folderIds) {
  if (!folderIds.length) return [];
  // Lưu ý quan trọng với Google Drive API:
  // Các thư mục khóa học nguồn được share qua link (Anyone with link) sẽ trả về 0 kết quả nếu gộp nhiều ID bằng toán tử OR.
  // Do đó cần truy vấn từng folderId đơn lẻ song song (concurrency = 25) để lấy đủ 100% thư mục con & bài học với tốc độ cao nhất.
  const allItems = [];
  const concurrency = 25;
  for (let i = 0; i < folderIds.length; i += concurrency) {
    const slice = folderIds.slice(i, i + concurrency);
    const results = await Promise.all(slice.map((fid) => listSingleFolderChildren(fid)));
    for (const arr of results) {
      allItems.push(...arr);
    }
  }
  return allItems;
}

// Truy vấn theo lô bằng OR dành riêng cho các thư mục thuộc Drive SCHOOL của người dùng (nhanh gấp 30 lần ở Tầng 2)
async function listOwnDriveFoldersBatch(folderIds) {
  if (!folderIds.length) return [];
  const allItems = [];
  const batchSize = 35;
  for (let i = 0; i < folderIds.length; i += batchSize) {
    const slice = folderIds.slice(i, i + batchSize);
    const p = slice.map((id) => `'${id}' in parents`).join(' or ');
    const q = `(${p}) and trashed = false`;
    let pageToken = '';
    do {
      const params = new URLSearchParams({
        q,
        pageSize: '1000',
        fields: 'nextPageToken, files(id, name, mimeType, parents, size, md5Checksum, modifiedTime)',
        supportsAllDrives: 'true',
        includeItemsFromAllDrives: 'true',
      });
      if (pageToken) params.set('pageToken', pageToken);
      const data = await driveJson(`https://www.googleapis.com/drive/v3/files?${params}`, {}, false);
      if (data.files) allItems.push(...data.files);
      pageToken = data.nextPageToken || '';
    } while (pageToken);
  }
  return allItems;
}

async function downloadDriveFile(fileId, destPath, kind = 'auto') {
  let lastStatus = 0;
  let lastTxt = '';
  const attempts = Math.max(2, tokenPool.length + 1);
  for (let i = 0; i < attempts; i++) {
    try {
      const token = await getToken({ requireWrite: false });
      const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok && res.body) {
        await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(destPath));
        return fs.statSync(destPath).size;
      }
      lastStatus = res.status;
      lastTxt = await res.text().catch(() => '');

      // Thử ngay link tải trực tiếp domain mới drive.usercontent.google.com (&confirm=t)
      try {
        const directUrl = `https://drive.usercontent.google.com/download?id=${fileId}&export=download&confirm=t`;
        const resDirect = await fetch(directUrl, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const ctype = resDirect.headers.get('content-type') || '';
        if (resDirect.ok && resDirect.body && !ctype.toLowerCase().includes('text/html')) {
          await pipeline(Readable.fromWeb(resDirect.body), fs.createWriteStream(destPath));
          const sz = fs.statSync(destPath).size;
          if (sz > 1024) return sz;
        }
      } catch {}

      // Nếu bị khóa quyền tải xuống (cannotDownloadFile / viewersCanCopyContent=false) hoặc vượt Quota 24h,
      // chuyển ngay sang trình tải dự phòng (videoplayback stream + Cookie Chrome / yt-dlp / gdown)
      if (
        lastStatus === 403 &&
        /cannotDownloadFile|cannot be downloaded by the user|downloadQuotaExceeded|quotaExceeded/i.test(lastTxt)
      ) {
        break;
      }
    } catch (netErr) {
      lastTxt = netErr.message || 'fetch failed';
      await new Promise((r) => setTimeout(r, 1500));
    }
  }

  // Fallback: Trích xuất luồng videoplayback / viewerng PDF / yt-dlp / gdown bằng Cookie Chrome
  try {
    const fbRes = await runPythonJson(DRIVE_FALLBACK_PY, [fileId, destPath, kind]);
    if (fbRes && fbRes.ok && fs.existsSync(destPath)) {
      return fs.statSync(destPath).size;
    }
  } catch (fbErr) {
    throw new Error(
      `Tải file ${fileId} thất bại (API HTTP ${lastStatus}, Fallback: ${fbErr.message.slice(0, 180)})`
    );
  }

  throw new Error(`Tải file ${fileId} thất bại (HTTP ${lastStatus}): ${lastTxt.slice(0, 200)}`);
}

async function exportGoogleSheetXlsx(sheetId, destPath) {
  const attempts = Math.max(2, tokenPool.length);
  for (let i = 0; i < attempts; i++) {
    const token = await getToken({ requireWrite: false });
    const url = `https://www.googleapis.com/drive/v3/files/${sheetId}/export?mimeType=application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      const ab = await res.arrayBuffer();
      fs.writeFileSync(destPath, Buffer.from(ab));
      return;
    }
    const pubUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=xlsx`;
    const res2 = await fetch(pubUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res2.ok) {
      const ab2 = await res2.arrayBuffer();
      fs.writeFileSync(destPath, Buffer.from(ab2));
      return;
    }
  }
  throw new Error(`Không thể tải file Sheet ${sheetId}`);
}

async function ensureDestinationFolder(relFolderParts) {
  const normKeyV2 = relFolderParts.map((p) => normSegV2(p, false)).join('/');
  const normKeyV1 = relFolderParts.map((p) => normSegV1(p, false)).join('/');

  if (pdfSyncDb.dstFolderCache[normKeyV2]) return pdfSyncDb.dstFolderCache[normKeyV2];
  if (pdfSyncDb.dstFolderCache[normKeyV1]) return pdfSyncDb.dstFolderCache[normKeyV1];

  let currentParentId = toolConfig.schoolRootFolderId || DEFAULT_SCHOOL_ROOT_ID;
  const builtParts = [];

  for (const part of relFolderParts) {
    const cleanPart = cleanDisplayName(part);
    builtParts.push(cleanPart);
    const k2 = builtParts.map((p) => normSegV2(p, false)).join('/');
    const k1 = builtParts.map((p) => normSegV1(p, false)).join('/');

    if (pdfSyncDb.dstFolderCache[k2]) {
      currentParentId = pdfSyncDb.dstFolderCache[k2];
      continue;
    }
    if (pdfSyncDb.dstFolderCache[k1]) {
      currentParentId = pdfSyncDb.dstFolderCache[k1];
      pdfSyncDb.dstFolderCache[k2] = currentParentId;
      continue;
    }

    // Tìm trong thư mục cha trên Drive trước khi tạo mới
    const parentPrefixParts = builtParts.slice(0, -1).map((p) => normSegV2(p, false));
    const children = await listOwnDriveFoldersBatch([currentParentId]);
    const filesInParent = [];
    for (const c of children) {
      if (c.mimeType === 'application/vnd.google-apps.folder') {
        const subKey2 = [...parentPrefixParts, normSegV2(c.name, false)].join('/');
        pdfSyncDb.dstFolderCache[subKey2] = c.id;
      } else {
        filesInParent.push(c);
      }
    }
    if (!dstFolderFilesCache.has(currentParentId)) {
      dstFolderFilesCache.set(currentParentId, filesInParent);
    }

    const targetNorm2 = normSegV2(cleanPart, false);
    const targetNorm1 = normSegV1(cleanPart, false);
    const existingFolder = children.find(
      (c) =>
        c.mimeType === 'application/vnd.google-apps.folder' &&
        (normSegV2(c.name, false) === targetNorm2 || normSegV1(c.name, false) === targetNorm1)
    );

    if (existingFolder) {
      currentParentId = existingFolder.id;
      pdfSyncDb.dstFolderCache[k2] = currentParentId;
      continue;
    }

    // Tạo thư mục mới trên Drive SCHOOL
    const created = await driveJson(
      'https://www.googleapis.com/drive/v3/files?supportsAllDrives=true',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: cleanPart,
          mimeType: 'application/vnd.google-apps.folder',
          parents: [currentParentId],
        }),
      },
      true
    );
    currentParentId = created.id;
    pdfSyncDb.dstFolderCache[k2] = currentParentId;
  }

  return currentParentId;
}

const missingDstFoldersCache = new Set();

async function resolveExistingDestinationFolder(relFolderParts) {
  const normKeyV2 = relFolderParts.map((p) => normSegV2(p, false)).join('/');
  const normKeyV1 = relFolderParts.map((p) => normSegV1(p, false)).join('/');

  if (pdfSyncDb.dstFolderCache[normKeyV2]) return pdfSyncDb.dstFolderCache[normKeyV2];
  if (pdfSyncDb.dstFolderCache[normKeyV1]) return pdfSyncDb.dstFolderCache[normKeyV1];
  if (missingDstFoldersCache.has(normKeyV2)) return null;

  let currentParentId = toolConfig.schoolRootFolderId || DEFAULT_SCHOOL_ROOT_ID;
  const builtParts = [];

  for (const part of relFolderParts) {
    const cleanPart = cleanDisplayName(part);
    builtParts.push(cleanPart);
    const k2 = builtParts.map((p) => normSegV2(p, false)).join('/');
    const k1 = builtParts.map((p) => normSegV1(p, false)).join('/');

    if (pdfSyncDb.dstFolderCache[k2]) {
      currentParentId = pdfSyncDb.dstFolderCache[k2];
      continue;
    }
    if (pdfSyncDb.dstFolderCache[k1]) {
      currentParentId = pdfSyncDb.dstFolderCache[k1];
      pdfSyncDb.dstFolderCache[k2] = currentParentId;
      continue;
    }
    if (missingDstFoldersCache.has(k2)) {
      return null;
    }

    const parentPrefixParts = builtParts.slice(0, -1).map((p) => normSegV2(p, false));
    const children = await listOwnDriveFoldersBatch([currentParentId]);
    const filesInParent = [];
    for (const c of children) {
      if (c.mimeType === 'application/vnd.google-apps.folder') {
        const subKey2 = [...parentPrefixParts, normSegV2(c.name, false)].join('/');
        pdfSyncDb.dstFolderCache[subKey2] = c.id;
      } else {
        filesInParent.push(c);
      }
    }
    if (!dstFolderFilesCache.has(currentParentId)) {
      dstFolderFilesCache.set(currentParentId, filesInParent);
    }

    const targetNorm2 = normSegV2(cleanPart, false);
    const targetNorm1 = normSegV1(cleanPart, false);
    const existingFolder = children.find(
      (c) =>
        c.mimeType === 'application/vnd.google-apps.folder' &&
        (normSegV2(c.name, false) === targetNorm2 || normSegV1(c.name, false) === targetNorm1)
    );

    if (existingFolder) {
      currentParentId = existingFolder.id;
      pdfSyncDb.dstFolderCache[k2] = currentParentId;
      continue;
    }

    missingDstFoldersCache.add(k2);
    return null;
  }

  return currentParentId;
}

async function uploadLocalFileToDrive(localPath, fileName, parentFolderId, mimeType) {
  const fileSize = fs.statSync(localPath).size;
  let lastErr = null;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const token = await getToken({ requireWrite: true });

      // Khởi tạo Resumable Upload session (an toàn cho cả PDF và Video lớn > 2 GiB)
      const initRes = await fetch(
        'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true&fields=id,name,size,md5Checksum',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json; charset=UTF-8',
            'X-Upload-Content-Type': mimeType,
            'X-Upload-Content-Length': String(fileSize),
          },
          body: JSON.stringify({
            name: fileName,
            parents: [parentFolderId],
          }),
        }
      );

      if (!initRes.ok) {
        const errText = await initRes.text().catch(() => '');
        if (/userRateLimitExceeded|User rate limit exceeded/i.test(errText)) {
          markTokenUploadQuotaExhausted(token);
          if (attempt < 2) continue;
        }
        throw new Error(`Khởi tạo upload thất bại (${initRes.status}): ${errText.slice(0, 200)}`);
      }

      const uploadUrl = initRes.headers.get('location');
      if (!uploadUrl) {
        throw new Error('Không nhận được Resumable Upload Location từ Google Drive');
      }

      const readStream = fs.createReadStream(localPath, { highWaterMark: 4 * 1024 * 1024 });
      const putRes = await fetch(uploadUrl, {
        method: 'PUT',
        headers: {
          'Content-Length': String(fileSize),
          'Content-Type': mimeType,
        },
        body: Readable.toWeb(readStream),
        duplex: 'half',
      });

      if (!putRes.ok) {
        const errText = await putRes.text().catch(() => '');
        if (/userRateLimitExceeded|User rate limit exceeded/i.test(errText)) {
          markTokenUploadQuotaExhausted(token);
          if (attempt < 2) continue;
        }
        throw new Error(`Upload dữ liệu thất bại (${putRes.status}): ${errText.slice(0, 200)}`);
      }

      return await putRes.json();
    } catch (err) {
      lastErr = err;
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, 2500 * (attempt + 1)));
      }
    }
  }
  throw lastErr;
}

async function copyDriveFileServerSide(sourceFileId, targetFileName, parentFolderId) {
  return await driveJson(
    `https://www.googleapis.com/drive/v3/files/${sourceFileId}/copy?supportsAllDrives=true&fields=id,name,size,md5Checksum`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: targetFileName,
        parents: [parentFolderId],
      }),
    },
    true
  );
}

// ---------------------------------------------------------------------------
// 5. Gọi Python xử lý PDF Watermark & Phân tích Sheet (.xlsx) + FFmpeg Video
// ---------------------------------------------------------------------------
function runPythonJson(scriptPath, args = []) {
  return new Promise((resolve, reject) => {
    execFile(PYTHON_BIN, [scriptPath, ...args], { maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        return reject(new Error(stderr || stdout || err.message));
      }
      try {
        const parsed = JSON.parse(stdout.trim());
        if (!parsed.ok) return reject(new Error(parsed.error || 'Python script error'));
        resolve(parsed);
      } catch (e) {
        reject(new Error(`Lỗi parse JSON từ Python: ${stdout.slice(0, 200)}`));
      }
    });
  });
}

function processPdfWithWatermark(inputPdfPath, outputPdfPath, rules = toolConfig.rules) {
  const rmOld = rules.pdfRemoveOldWatermark !== false ? '1' : '0';
  const addUni = rules.pdfStampUniWatermark !== false ? '1' : '0';
  return runPythonJson(PDF_PROCESSOR_PY, [inputPdfPath, outputPdfPath, WATERMARK_PNG, rmOld, addUni]);
}

function remuxVideoFaststart(inputVideoPath, outputMp4Path) {
  return new Promise((resolve, reject) => {
    execFile(
      ffmpegPath,
      [
        '-y',
        '-i',
        inputVideoPath,
        '-map',
        '0',
        '-c',
        'copy',
        '-bsf:a',
        'aac_adtstoasc',
        '-movflags',
        '+faststart',
        outputMp4Path,
      ],
      { maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          // Thử lại không dùng aac_adtstoasc nếu audio không phải ADTS AAC
          execFile(
            ffmpegPath,
            ['-y', '-i', inputVideoPath, '-c', 'copy', '-movflags', '+faststart', outputMp4Path],
            { maxBuffer: 16 * 1024 * 1024 },
            (err2, _so2, se2) => {
              if (err2) return reject(new Error(se2 || stderr || err2.message));
              resolve({ ok: true, size: fs.statSync(outputMp4Path).size });
            }
          );
          return;
        }
        resolve({ ok: true, size: fs.statSync(outputMp4Path).size });
      }
    );
  });
}

// ---------------------------------------------------------------------------
// 6. Quản lý Master Sheet (56 Giáo viên / 9 Môn) & Custom Sheet
// ---------------------------------------------------------------------------
let masterSheetCache = {
  sheetId: DEFAULT_MASTER_SHEET_ID,
  loadedAt: null,
  teachers: [],
  tabs: [],
};

async function loadMasterSheetFromDisk() {
  if (!fs.existsSync(MASTER_SHEET_XLSX_PATH)) {
    return masterSheetCache;
  }
  const parsed = await runPythonJson(SHEET_PARSER_PY, [MASTER_SHEET_XLSX_PATH]);
  const enrichedTeachers = (parsed.teachers || []).map((t) => {
    const completedInfo = pdfSyncDb.completedTeachers?.[t.sourceFolderId] || null;
    const dstTeacherKeyV2 = `${normSegV2(t.subject, false)}/${normSegV2(t.teacherFolder, false)}`;
    const dstTeacherKeyV1 = `${normSegV1(t.subject, false)}/${normSegV1(t.teacherFolder, false)}`;
    const dstFolderId =
      pdfSyncDb.dstFolderCache?.[dstTeacherKeyV2] ||
      pdfSyncDb.dstFolderCache?.[dstTeacherKeyV1] ||
      null;
    return {
      ...t,
      dstFolderId,
      completedInfo,
    };
  });
  masterSheetCache = {
    sheetId: DEFAULT_MASTER_SHEET_ID,
    loadedAt: new Date(fs.statSync(MASTER_SHEET_XLSX_PATH).mtime).toISOString(),
    teachers: enrichedTeachers,
    tabs: (parsed.tabs || []).map((tb) => ({
      name: tb.name,
      sheetId: tb.sheetId,
      skippedByRule: tb.skippedByRule,
      linkedRowsCount: tb.linkedRowsCount,
    })),
  };
  return masterSheetCache;
}

// ---------------------------------------------------------------------------
// 7. Tiến trình Đồng bộ & Lọc trùng Đa tầng (Sync Job Runner)
// ---------------------------------------------------------------------------
const syncJob = {
  running: false,
  stopRequested: false,
  mode: 'dry_run', // 'dry_run' | 'pdf_only' | 'video_only' | 'both'
  startedAt: null,
  finishedAt: null,
  currentTeacher: '',
  currentAction: '',
  progress: {
    teachersDone: 0,
    teachersTotal: 0,
    scannedFolders: 0,
    scannedFiles: 0,
    skippedByRule: 0,
    duplicatePdf: 0,
    duplicateVideo: 0,
    newPdfFound: 0,
    newVideoFound: 0,
    syncedPdf: 0,
    syncedVideo: 0,
    errors: 0,
  },
  newItemsPreview: [], // Tối đa 500 mục mới tìm thấy để người dùng xem chi tiết
  logs: [],
};

function addJobLog(msg, level = 'info') {
  const line = {
    time: new Date().toLocaleTimeString('vi-VN', { hour12: false }),
    level,
    msg,
  };
  syncJob.logs.push(line);
  if (syncJob.logs.length > 600) {
    syncJob.logs.splice(0, syncJob.logs.length - 600);
  }
  console.log(`[${line.time}] [${level.toUpperCase()}] ${msg}`);
}

function isEntryUniPdf(entry) {
  if (!entry) return false;
  if (entry.isUni === true) return true;
  if (entry.title && isUniFileName(entry.title)) return true;
  if (entry.relPath) {
    const base = String(entry.relPath).split('/').pop() || '';
    if (isUniFileName(base)) return true;
  }
  return false;
}

function updateSyncDbsAfterFileReplacement(repMap, keepMetaMap = {}) {
  const oldIds = Object.keys(repMap || {});
  if (!oldIds.length) return { pdfUpdated: 0, videoUpdated: 0 };
  let pdfUpdated = 0;
  let videoUpdated = 0;

  for (const entry of Object.values(pdfSyncDb.syncedFileIds || {})) {
    if (entry && entry.dstFileId && repMap[entry.dstFileId]) {
      const newId = repMap[entry.dstFileId];
      entry.dstFileId = newId;
      const meta = keepMetaMap[newId];
      if (meta?.name) {
        entry.title = meta.name;
        entry.isUni = isUniFileName(meta.name);
      } else if (meta?.isUni !== undefined) {
        entry.isUni = !!meta.isUni;
      }
      pdfUpdated++;
    }
  }
  for (const entry of Object.values(pdfSyncDb.syncedNormPaths || {})) {
    if (entry && entry.dstFileId && repMap[entry.dstFileId]) {
      const newId = repMap[entry.dstFileId];
      entry.dstFileId = newId;
      const meta = keepMetaMap[newId];
      if (meta?.name) {
        const parts = String(entry.relPath || '').split('/');
        if (parts.length > 0) {
          parts[parts.length - 1] = meta.name;
          entry.relPath = parts.join('/');
        }
        entry.isUni = isUniFileName(meta.name);
      } else if (meta?.isUni !== undefined) {
        entry.isUni = !!meta.isUni;
      }
      pdfUpdated++;
    }
  }
  for (const entry of Object.values(videoSyncDb.syncedFileIds || {})) {
    if (entry && entry.dstFileId && repMap[entry.dstFileId]) {
      entry.dstFileId = repMap[entry.dstFileId];
      videoUpdated++;
    }
  }
  for (const entry of Object.values(videoSyncDb.syncedNormPaths || {})) {
    if (entry && entry.dstFileId && repMap[entry.dstFileId]) {
      entry.dstFileId = repMap[entry.dstFileId];
      videoUpdated++;
    }
  }
  return { pdfUpdated, videoUpdated };
}

async function trashDriveFile(fileId) {
  if (!fileId) return false;
  await driveJson(
    `https://www.googleapis.com/drive/v3/files/${fileId}?supportsAllDrives=true`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trashed: true }),
    },
    true
  );
  return true;
}

function isPdfAlreadySynced(sourceFileId, relPathParts, rules = toolConfig.rules) {
  const { v2, v1 } = buildNormPaths(relPathParts);
  const byId = pdfSyncDb.syncedFileIds[sourceFileId];
  const byNorm = pdfSyncDb.syncedNormPaths[v2] || pdfSyncDb.syncedNormPaths[v1];

  if (byId || byNorm) {
    const alreadyUni = isEntryUniPdf(byId) || isEntryUniPdf(byNorm);
    if (!rules.replaceLegacyNonUniPdf || alreadyUni) {
      return { dup: true, reason: alreadyUni ? 'Đã có bản UNI trong _pdf_sync_db' : 'Trùng trong _pdf_sync_db' };
    }
    // Chế độ nâng cấp file cũ chưa có UNI sang bản UNI
    return {
      dup: false,
      isUpgradeFromLegacy: true,
      legacyDstFileId: byId?.dstFileId || null,
      normV2: v2,
      normV1: v1,
    };
  }

  if (schoolStats.pdfIds.has(sourceFileId) || schoolStats.webLessonDriveIds.has(sourceFileId)) {
    return { dup: true, reason: 'Đã tồn tại trong lessons.json của web' };
  }
  return { dup: false, normV2: v2, normV1: v1 };
}

function isVideoAlreadySynced(sourceFileId, relPathParts) {
  if (videoSyncDb.syncedFileIds[sourceFileId]) {
    return { dup: true, reason: 'Trùng sourceFileId trong _video_sync_db' };
  }
  const { v2, v1 } = buildNormPaths(relPathParts);
  if (videoSyncDb.syncedNormPaths[v2] || videoSyncDb.syncedNormPaths[v1]) {
    return { dup: true, reason: 'Trùng đường dẫn trong _video_sync_db' };
  }
  if (schoolStats.videoIds.has(sourceFileId) || schoolStats.webLessonDriveIds.has(sourceFileId)) {
    return { dup: true, reason: 'Đã có trong lessons.json' };
  }
  return { dup: false, normV2: v2, normV1: v1 };
}

// Cache danh sách file con của từng thư mục đích trên Drive SCHOOL để kiểm tra trùng trực tiếp
const dstFolderFilesCache = new Map();

async function getDstFolderExistingFiles(dstFolderId) {
  if (!dstFolderId) return [];
  if (dstFolderFilesCache.has(dstFolderId)) {
    return dstFolderFilesCache.get(dstFolderId);
  }
  const children = await listOwnDriveFoldersBatch([dstFolderId]);
  const files = children.filter((c) => c.mimeType !== 'application/vnd.google-apps.folder');
  dstFolderFilesCache.set(dstFolderId, files);
  return files;
}

async function prefetchDstFoldersFiles(dstFolderIds) {
  const uncached = [...new Set(dstFolderIds.filter((id) => id && !dstFolderFilesCache.has(id)))];
  if (!uncached.length) return;
  for (const id of uncached) {
    dstFolderFilesCache.set(id, []);
  }
  try {
    const children = await listOwnDriveFoldersBatch(uncached);
    for (const c of children) {
      if (c.mimeType === 'application/vnd.google-apps.folder') continue;
      const pId = c.parents && c.parents[0];
      if (pId && dstFolderFilesCache.has(pId)) {
        dstFolderFilesCache.get(pId).push(c);
      }
    }
  } catch {}
}

async function runSyncTargets(targets, options = {}) {
  const dryRun = options.mode === 'dry_run';
  const wantPdf = options.mode === 'dry_run' || options.mode === 'pdf_only' || options.mode === 'both';
  const wantVideo = options.mode === 'dry_run' || options.mode === 'video_only' || options.mode === 'both';
  const rules = { ...toolConfig.rules, ...(options.rules || {}) };

  syncJob.running = true;
  syncJob.stopRequested = false;
  syncJob.mode = options.mode || 'dry_run';
  syncJob.startedAt = new Date().toISOString();
  syncJob.finishedAt = null;
  syncJob.currentTeacher = '';
  syncJob.currentAction = 'Khởi tạo phiên quét...';
  syncJob.progress = {
    teachersDone: 0,
    teachersTotal: targets.length,
    scannedFolders: 0,
    scannedFiles: 0,
    skippedByRule: 0,
    duplicatePdf: 0,
    duplicateVideo: 0,
    newPdfFound: 0,
    newVideoFound: 0,
    upgradedLegacyPdf: 0,
    cleanedCoexistingLegacyPdf: 0,
    syncedPdf: 0,
    syncedVideo: 0,
    errors: 0,
  };
  syncJob.newItemsPreview = [];
  syncJob.logs = [];
  dstFolderFilesCache.clear();
  missingDstFoldersCache.clear();

  addJobLog(
    `Bắt đầu ${dryRun ? 'QUÉT KIỂM TRA BÀI MỚI & LỌC TRÙNG (Dry-Run)' : 'ĐỒNG BỘ & UPLOAD LÊN DRIVE'} cho ${targets.length} khóa/giáo viên...`
  );

  try {
    for (const target of targets) {
      if (syncJob.stopRequested) {
        addJobLog('Đã dừng theo yêu cầu người dùng.', 'warn');
        break;
      }

      const subject = cleanDisplayName(target.subject || 'TOÁN');
      const teacherFolder = cleanDisplayName(target.teacherFolder || target.rawTitle || 'KHÓA HỌC');
      const sourceRootId = target.sourceFolderId;
      syncJob.currentTeacher = `${subject} / ${teacherFolder}`;
      addJobLog(`▶ Đang quét: [${subject}] ${teacherFolder} (Folder nguồn: ${sourceRootId})`);

      // Quét BFS theo lô 25 thư mục/lần trên Drive nguồn
      let queue = [{ id: sourceRootId, relParts: [subject, teacherFolder] }];
      const pendingTasks = [];

      while (queue.length > 0 && !syncJob.stopRequested) {
        const batch = queue.splice(0, 25);
        syncJob.progress.scannedFolders += batch.length;
        syncJob.currentAction = `Đang quét cây thư mục (${syncJob.progress.scannedFolders} folders)...`;

        const parentMap = new Map(batch.map((b) => [b.id, b]));
        let children = [];
        try {
          children = await listFolderChildrenBatch(batch.map((b) => b.id));
        } catch (err) {
          syncJob.progress.errors++;
          addJobLog(`Lỗi quét nhánh thư mục của ${teacherFolder}: ${err.message}`, 'error');
          continue;
        }

        // Sắp xếp tự nhiên theo tên
        children.sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'vi', { numeric: true }));

        for (const item of children) {
          const pId = item.parents && item.parents[0];
          const pNode = parentMap.get(pId);
          if (!pNode) continue;

          if (item.mimeType === 'application/vnd.google-apps.folder') {
            const folderCheck = shouldSkipFolder(item.name, rules);
            if (folderCheck.skip) {
              syncJob.progress.skippedByRule++;
              addJobLog(`  ⏭ Bỏ qua thư mục [${cleanDisplayName(item.name)}] (${folderCheck.reason})`);
              continue;
            }
            queue.push({
              id: item.id,
              relParts: [...pNode.relParts, folderCheck.cleanName],
            });
            continue;
          }

          syncJob.progress.scannedFiles++;
          const cls = classifyDriveItem(item, pNode.relParts, rules);
          if (cls.kind === 'skip') {
            syncJob.progress.skippedByRule++;
            continue;
          }

          const fileRelParts = [...pNode.relParts, cls.cleanName];
          const relPathStr = fileRelParts.join('/');

          if (cls.kind === 'pdf') {
            if (!wantPdf) continue;
            const dupCheck = isPdfAlreadySynced(item.id, fileRelParts, rules);
            if (dupCheck.dup) {
              syncJob.progress.duplicatePdf++;
              continue;
            }
            pendingTasks.push({
              kind: 'pdf',
              sourceFileId: item.id,
              sourceName: cls.cleanName,
              size: Number(item.size || 0),
              md5: item.md5Checksum || '',
              folderRelParts: pNode.relParts,
              fileRelParts,
              relPath: relPathStr,
              normV2: dupCheck.normV2,
              normV1: dupCheck.normV1,
              isUpgradeFromLegacy: !!dupCheck.isUpgradeFromLegacy,
              legacyDstFileId: dupCheck.legacyDstFileId || null,
              legacyFilesToReplace: [],
            });
          } else if (cls.kind === 'video') {
            if (!wantVideo) continue;
            const dupCheck = isVideoAlreadySynced(item.id, fileRelParts);
            if (dupCheck.dup) {
              syncJob.progress.duplicateVideo++;
              continue;
            }
            pendingTasks.push({
              kind: 'video',
              sourceFileId: item.id,
              sourceName: cls.cleanName,
              size: Number(item.size || 0),
              md5: item.md5Checksum || '',
              folderRelParts: pNode.relParts,
              fileRelParts,
              relPath: relPathStr,
              normV2: dupCheck.normV2,
              normV1: dupCheck.normV1,
            });
          }
        }
      }

      // Kiểm tra tầng 2: đối chiếu với thư mục đích trên Drive SCHOOL (tự động tra cứu trên Drive kể cả khi chưa có trong cache)
      const verifiedNewTasks = [];
      const dstIdsToPrefetch = [];
      for (const task of pendingTasks) {
        const folderKeyV2 = task.folderRelParts.map((p) => normSegV2(p, false)).join('/');
        const folderKeyV1 = task.folderRelParts.map((p) => normSegV1(p, false)).join('/');
        const cid = pdfSyncDb.dstFolderCache[folderKeyV2] || pdfSyncDb.dstFolderCache[folderKeyV1] || null;
        if (cid) dstIdsToPrefetch.push(cid);
      }
      if (dstIdsToPrefetch.length > 0) {
        syncJob.currentAction = `Đang đối chiếu nhanh ${new Set(dstIdsToPrefetch).size} thư mục đích trên Drive SCHOOL...`;
        await prefetchDstFoldersFiles(dstIdsToPrefetch);
      }

      for (const task of pendingTasks) {
        if (syncJob.stopRequested) break;
        const folderKeyV2 = task.folderRelParts.map((p) => normSegV2(p, false)).join('/');
        const folderKeyV1 = task.folderRelParts.map((p) => normSegV1(p, false)).join('/');
        let cachedDstFolderId =
          pdfSyncDb.dstFolderCache[folderKeyV2] || pdfSyncDb.dstFolderCache[folderKeyV1] || null;
        if (!cachedDstFolderId) {
          try {
            cachedDstFolderId = await resolveExistingDestinationFolder(task.folderRelParts);
          } catch {}
        }

        if (cachedDstFolderId) {
          try {
            const existingFiles = await getDstFolderExistingFiles(cachedDstFolderId);
            const targetNorm = normSegV2(task.sourceName, true);
            const matchesOnDrive = existingFiles.filter((ef) => {
              const efNorm = normSegV2(ef.name, true);
              if (efNorm === targetNorm) return true;
              if (task.kind === 'video' && task.size > 0 && Number(ef.size || 0) === task.size && efNorm === targetNorm) {
                return true;
              }
              return false;
            });

            if (matchesOnDrive.length > 0) {
              if (task.kind === 'pdf') {
                const uniMatches = matchesOnDrive.filter((ef) => isUniFileName(ef.name));
                const legacyMatches = matchesOnDrive.filter((ef) => !isUniFileName(ef.name));

                if (uniMatches.length > 0) {
                  // Đã có bản UNI chuẩn trên Drive -> Lưu DB là bản UNI và không tải lại
                  const bestUni = uniMatches[0];
                  syncJob.progress.duplicatePdf++;
                  pdfSyncDb.syncedFileIds[task.sourceFileId] = {
                    relPath: task.relPath,
                    normRelPath: task.normV2,
                    title: bestUni.name,
                    size: Number(bestUni.size || task.size || 0),
                    dstFileId: bestUni.id,
                    isUni: true,
                    syncedAt: new Date().toISOString(),
                  };
                  pdfSyncDb.syncedNormPaths[task.normV2] = {
                    relPath: [...task.folderRelParts, bestUni.name].join('/'),
                    sourceFileId: task.sourceFileId,
                    dstFileId: bestUni.id,
                    size: Number(bestUni.size || task.size || 0),
                    isUni: true,
                    syncedAt: new Date().toISOString(),
                  };

                  // Nếu trong cùng thư mục vẫn còn bản cũ chưa xóa (tồn tại song song cả bản UNI và bản cũ)
                  if (legacyMatches.length > 0 && rules.cleanCoexistingLegacyPdf !== false) {
                    if (dryRun) {
                      addJobLog(
                        `  🧹 [Phát hiện bản cũ tồn tại song song] Đã có "${bestUni.name}", sẽ dọn ${legacyMatches.length} bản cũ (${legacyMatches.map((x) => x.name).join(', ')}) khi chạy đồng bộ.`,
                        'warn'
                      );
                    } else {
                      const repMap = {};
                      const keepMetaMap = { [bestUni.id]: { name: bestUni.name, isUni: true } };
                      for (const oldFile of legacyMatches) {
                        try {
                          repMap[oldFile.id] = bestUni.id;
                          await trashDriveFile(oldFile.id);
                          syncJob.progress.cleanedCoexistingLegacyPdf++;
                          addJobLog(
                            `  🧹 Đã xóa bản PDF cũ dư thừa "${oldFile.name}" (giữ lại "${bestUni.name}")`,
                            'success'
                          );
                        } catch (cleanErr) {
                          addJobLog(`  ⚠ Không xóa được bản cũ "${oldFile.name}": ${cleanErr.message}`, 'warn');
                        }
                      }
                      updateSyncDbsAfterFileReplacement(repMap, keepMetaMap);
                      replaceDriveIdsInSchoolLessons(repMap);
                    }
                  }
                  continue;
                }

                // Trường hợp chỉ có bản cũ chưa có chữ UNI trên Drive
                if (!rules.replaceLegacyNonUniPdf) {
                  const firstLegacy = legacyMatches[0];
                  syncJob.progress.duplicatePdf++;
                  pdfSyncDb.syncedFileIds[task.sourceFileId] = {
                    relPath: task.relPath,
                    normRelPath: task.normV2,
                    title: firstLegacy.name,
                    size: Number(firstLegacy.size || task.size || 0),
                    dstFileId: firstLegacy.id,
                    isUni: false,
                    syncedAt: new Date().toISOString(),
                  };
                  pdfSyncDb.syncedNormPaths[task.normV2] = {
                    relPath: [...task.folderRelParts, firstLegacy.name].join('/'),
                    sourceFileId: task.sourceFileId,
                    dstFileId: firstLegacy.id,
                    size: Number(firstLegacy.size || task.size || 0),
                    isUni: false,
                    syncedAt: new Date().toISOString(),
                  };
                  continue;
                } else {
                  // Bật chế độ Thay thế file PDF cũ chưa có UNI -> Đưa vào danh sách xử lý & ghi nhận các file cũ cần xóa sau khi up bản UNI
                  task.isUpgradeFromLegacy = true;
                  task.legacyFilesToReplace = legacyMatches;
                }
              } else {
                const foundOnDrive = matchesOnDrive[0];
                syncJob.progress.duplicateVideo++;
                videoSyncDb.syncedFileIds[task.sourceFileId] = {
                  relPath: task.relPath,
                  normRelPath: task.normV2,
                  title: foundOnDrive.name,
                  size: Number(foundOnDrive.size || task.size || 0),
                  dstFileId: foundOnDrive.id,
                  syncedAt: new Date().toISOString(),
                };
                videoSyncDb.syncedNormPaths[task.normV2] = {
                  relPath: task.relPath,
                  sourceFileId: task.sourceFileId,
                  dstFileId: foundOnDrive.id,
                  size: Number(foundOnDrive.size || task.size || 0),
                  syncedAt: new Date().toISOString(),
                };
                continue;
              }
            }
          } catch {}
        }

        verifiedNewTasks.push(task);
        if (task.kind === 'pdf') syncJob.progress.newPdfFound++;
        else syncJob.progress.newVideoFound++;

        if (syncJob.newItemsPreview.length < 500) {
          syncJob.newItemsPreview.push({
            kind: task.kind,
            sourceFileId: task.sourceFileId,
            name: task.isUpgradeFromLegacy ? `[Nâng cấp sang UNI] ${task.sourceName}` : task.sourceName,
            relPath: task.relPath,
            size: task.size,
          });
        }
      }

      addJobLog(
        `  ✔ Kết quả quét [${teacherFolder}]: Mới/Nâng cấp ${verifiedNewTasks.filter((x) => x.kind === 'pdf').length} PDF, ${verifiedNewTasks.filter((x) => x.kind === 'video').length} Video (Đã lọc trùng ${syncJob.progress.duplicatePdf} PDF, ${syncJob.progress.duplicateVideo} Video)`
      );

      // Nếu chế độ thật (không phải dryRun), tiến hành tải -> xử lý -> upload
      if (!dryRun && verifiedNewTasks.length > 0) {
        for (const task of verifiedNewTasks) {
          if (syncJob.stopRequested) break;
          try {
            const dstFolderId = await ensureDestinationFolder(task.folderRelParts);

            if (task.kind === 'pdf') {
              // Trước khi upload, kiểm tra lại thư mục đích xem có file cũ chưa có UNI không để xóa sau khi upload thành công
              let existingInDst = [];
              try {
                existingInDst = await getDstFolderExistingFiles(dstFolderId);
              } catch {}
              const targetNorm = normSegV2(task.sourceName, true);
              const sameLessonFiles = existingInDst.filter((ef) => normSegV2(ef.name, true) === targetNorm);
              const existingUni = sameLessonFiles.filter((ef) => isUniFileName(ef.name));
              const existingLegacy = sameLessonFiles.filter((ef) => !isUniFileName(ef.name));

              if (existingUni.length > 0) {
                // Nếu trong thư mục đích đã có sẵn bản UNI rồi thì không upload chồng thêm bản thứ 2, chỉ dọn bản cũ nếu có và cập nhật DB
                const bestUni = existingUni[0];
                pdfSyncDb.syncedFileIds[task.sourceFileId] = {
                  relPath: task.relPath,
                  normRelPath: task.normV2,
                  title: bestUni.name,
                  size: Number(bestUni.size || task.size || 0),
                  dstFileId: bestUni.id,
                  isUni: true,
                  syncedAt: new Date().toISOString(),
                };
                pdfSyncDb.syncedNormPaths[task.normV2] = {
                  relPath: [...task.folderRelParts, bestUni.name].join('/'),
                  sourceFileId: task.sourceFileId,
                  dstFileId: bestUni.id,
                  size: Number(bestUni.size || task.size || 0),
                  isUni: true,
                  syncedAt: new Date().toISOString(),
                };

                if (existingLegacy.length > 0 && rules.cleanCoexistingLegacyPdf !== false) {
                  const repMap = {};
                  const keepMetaMap = { [bestUni.id]: { name: bestUni.name, isUni: true } };
                  for (const oldF of existingLegacy) {
                    try {
                      repMap[oldF.id] = bestUni.id;
                      await trashDriveFile(oldF.id);
                      syncJob.progress.cleanedCoexistingLegacyPdf++;
                      addJobLog(`  🧹 Đã dọn bản PDF cũ "${oldF.name}" (giữ lại "${bestUni.name}")`, 'success');
                    } catch {}
                  }
                  updateSyncDbsAfterFileReplacement(repMap, keepMetaMap);
                  replaceDriveIdsInSchoolLessons(repMap);
                }
                savePdfSyncDb();
                continue;
              }

              const finalPdfName =
                rules.pdfAddUniPrefix && !isUniFileName(task.sourceName)
                  ? `UNI ${task.sourceName}`
                  : task.sourceName;

              syncJob.currentAction = `Đang tải & đóng dấu PDF: ${task.sourceName}`;
              const rawTmp = path.join(TMP_DIR, `raw_${task.sourceFileId}.pdf`);
              const outTmp = path.join(TMP_DIR, `uni_${task.sourceFileId}.pdf`);

              try {
                await downloadDriveFile(task.sourceFileId, rawTmp, 'pdf');
                const wmRes = await processPdfWithWatermark(rawTmp, outTmp, rules);
                syncJob.currentAction = `Đang upload PDF lên SCHOOL: ${finalPdfName}`;
                const uploaded = await uploadLocalFileToDrive(outTmp, finalPdfName, dstFolderId, 'application/pdf');

                // Xóa các bản PDF cũ chưa có chữ UNI của cùng bài học này trong thư mục đích (nếu có)
                const oldIdsToTrash = new Set();
                for (const lf of task.legacyFilesToReplace || []) {
                  if (lf && lf.id && lf.id !== uploaded.id) oldIdsToTrash.add(lf.id);
                }
                for (const lf of existingLegacy) {
                  if (lf && lf.id && lf.id !== uploaded.id) oldIdsToTrash.add(lf.id);
                }
                if (task.legacyDstFileId && task.legacyDstFileId !== uploaded.id) {
                  oldIdsToTrash.add(task.legacyDstFileId);
                }

                if (oldIdsToTrash.size > 0) {
                  const repMap = {};
                  const keepMetaMap = { [uploaded.id]: { name: finalPdfName, isUni: isUniFileName(finalPdfName) } };
                  for (const oldId of oldIdsToTrash) {
                    try {
                      repMap[oldId] = uploaded.id;
                      await trashDriveFile(oldId);
                      syncJob.progress.upgradedLegacyPdf++;
                    } catch (delErr) {
                      addJobLog(`  ⚠ Không xóa được bản PDF cũ (${oldId}): ${delErr.message}`, 'warn');
                    }
                  }
                  updateSyncDbsAfterFileReplacement(repMap, keepMetaMap);
                  replaceDriveIdsInSchoolLessons(repMap);
                }

                pdfSyncDb.syncedFileIds[task.sourceFileId] = {
                  relPath: task.relPath,
                  normRelPath: task.normV2,
                  title: finalPdfName,
                  size: Number(uploaded.size || wmRes.outputSize || 0),
                  dstFileId: uploaded.id,
                  isUni: isUniFileName(finalPdfName),
                  syncedAt: new Date().toISOString(),
                };
                pdfSyncDb.syncedNormPaths[task.normV2] = {
                  relPath: [...task.folderRelParts, finalPdfName].join('/'),
                  sourceFileId: task.sourceFileId,
                  dstFileId: uploaded.id,
                  size: Number(uploaded.size || wmRes.outputSize || 0),
                  isUni: isUniFileName(finalPdfName),
                  syncedAt: new Date().toISOString(),
                };
                savePdfSyncDb();
                syncJob.progress.syncedPdf++;
                addJobLog(
                  `  ✅ [PDF] Đã xử lý (${wmRes.pages} trang, xóa ${wmRes.removedStreams} WM cũ) & upload: ${finalPdfName} -> ${uploaded.id}${oldIdsToTrash.size > 0 ? ` (Đã thay thế & xóa ${oldIdsToTrash.size} bản cũ chưa có UNI)` : ''}`,
                  'success'
                );
              } finally {
                if (fs.existsSync(rawTmp)) fs.unlinkSync(rawTmp);
                if (fs.existsSync(outTmp)) fs.unlinkSync(outTmp);
              }
            } else if (task.kind === 'video') {
              const baseVideoName = task.sourceName.replace(/\.(ts|mkv|mov|avi|flv)$/i, '.mp4');
              const needRemux =
                rules.videoMode === 'remux_upload' ||
                /\.(ts|mkv|flv)$/i.test(task.sourceName);

              let uploaded = null;
              if (!needRemux && (rules.videoMode === 'server_copy' || rules.videoMode === 'remux_or_copy')) {
                try {
                  syncJob.currentAction = `Đang copy trực tiếp Video trên Drive: ${baseVideoName}`;
                  uploaded = await copyDriveFileServerSide(task.sourceFileId, baseVideoName, dstFolderId);
                } catch (copyErr) {
                  addJobLog(`  ⚠ Server-side copy không khả dụng cho ${baseVideoName}, chuyển sang tải & remux MP4...`, 'warn');
                }
              }

              if (!uploaded) {
                const rawVidTmp = path.join(TMP_DIR, `vid_in_${task.sourceFileId}${path.extname(task.sourceName) || '.mp4'}`);
                const outVidTmp = path.join(TMP_DIR, `vid_out_${task.sourceFileId}.mp4`);
                try {
                  syncJob.currentAction = `Đang tải Video (${(task.size / 1048576).toFixed(1)} MB): ${task.sourceName}`;
                  await downloadDriveFile(task.sourceFileId, rawVidTmp, 'video');
                  syncJob.currentAction = `Đang chuẩn hóa MP4 (+faststart): ${baseVideoName}`;
                  await remuxVideoFaststart(rawVidTmp, outVidTmp);
                  syncJob.currentAction = `Đang upload Video lên SCHOOL: ${baseVideoName}`;
                  uploaded = await uploadLocalFileToDrive(outVidTmp, baseVideoName, dstFolderId, 'video/mp4');
                } finally {
                  if (fs.existsSync(rawVidTmp)) fs.unlinkSync(rawVidTmp);
                  if (fs.existsSync(outVidTmp)) fs.unlinkSync(outVidTmp);
                }
              }

              videoSyncDb.syncedFileIds[task.sourceFileId] = {
                relPath: task.relPath,
                normRelPath: task.normV2,
                title: uploaded.name || baseVideoName,
                size: Number(uploaded.size || task.size || 0),
                dstFileId: uploaded.id,
                syncedAt: new Date().toISOString(),
              };
              videoSyncDb.syncedNormPaths[task.normV2] = {
                relPath: task.relPath,
                sourceFileId: task.sourceFileId,
                dstFileId: uploaded.id,
                size: Number(uploaded.size || task.size || 0),
                syncedAt: new Date().toISOString(),
              };
              saveVideoSyncDb();
              syncJob.progress.syncedVideo++;
              addJobLog(`  🎬 [VIDEO] Đã đồng bộ: ${baseVideoName} -> ${uploaded.id}`, 'success');
            }
          } catch (taskErr) {
            syncJob.progress.errors++;
            addJobLog(`  ❌ Lỗi xử lý [${task.sourceName}]: ${taskErr.message}`, 'error');
          }
        }
      }

      syncJob.progress.teachersDone++;
    }

    savePdfSyncDb();
    saveVideoSyncDb();

    if (!dryRun && (syncJob.progress.syncedPdf > 0 || syncJob.progress.syncedVideo > 0) && rules.autoTriggerSchoolSync) {
      addJobLog('Đang tự động chạy scripts/sync-drive.js để cập nhật dữ liệu cho web school.unizvn...');
      await triggerSchoolDriveSync();
    }

    addJobLog(
      `Hoàn tất phiên! Quét ${syncJob.progress.scannedFiles} files (${syncJob.progress.scannedFolders} folders) | Bài mới: ${syncJob.progress.newPdfFound} PDF, ${syncJob.progress.newVideoFound} Video | Đã upload: ${syncJob.progress.syncedPdf} PDF, ${syncJob.progress.syncedVideo} Video${syncJob.progress.upgradedLegacyPdf || syncJob.progress.cleanedCoexistingLegacyPdf ? ` | Đã dọn ${(syncJob.progress.upgradedLegacyPdf || 0) + (syncJob.progress.cleanedCoexistingLegacyPdf || 0)} bản PDF cũ` : ''}.`,
      'success'
    );
  } catch (err) {
    syncJob.progress.errors++;
    addJobLog(`Lỗi tiến trình: ${err.message}`, 'error');
  } finally {
    syncJob.running = false;
    syncJob.currentAction = 'Đã hoàn tất';
    syncJob.finishedAt = new Date().toISOString();
    loadSchoolWebData();
  }
}

// ---------------------------------------------------------------------------
// 8. Quét & Dọn File Trùng trực tiếp trên Drive SCHOOL (Ưu tiên giữ bản UNI & tự động cập nhật lessons.json)
// ---------------------------------------------------------------------------
let lastDedupScanResult = {
  scannedAt: null,
  folderId: '',
  folderLabel: '',
  scannedFolders: 0,
  totalFiles: 0,
  duplicateGroups: [],
  redundantFilesCount: 0,
  redundantBytes: 0,
};

async function scanDriveFolderForDuplicates(rootFolderId, folderLabel = 'SCHOOL') {
  loadSchoolWebData();
  let queue = [{ id: rootFolderId, pathStr: folderLabel }];
  let scannedFolders = 0;
  let totalFiles = 0;
  const duplicateGroups = [];
  let redundantFilesCount = 0;
  let redundantBytes = 0;

  while (queue.length > 0) {
    const batch = queue.splice(0, 25);
    scannedFolders += batch.length;
    const parentMap = new Map(batch.map((b) => [b.id, b]));
    const children = await listFolderChildrenBatch(batch.map((b) => b.id));

    const filesByParent = new Map();
    for (const item of children) {
      const pId = item.parents && item.parents[0];
      const pNode = parentMap.get(pId);
      if (!pNode) continue;

      if (item.mimeType === 'application/vnd.google-apps.folder') {
        queue.push({ id: item.id, pathStr: `${pNode.pathStr} / ${cleanDisplayName(item.name)}` });
      } else {
        totalFiles++;
        if (!filesByParent.has(pId)) filesByParent.set(pId, []);
        filesByParent.get(pId).push({ ...item, folderPath: pNode.pathStr });
      }
    }

    // Kiểm tra trùng trong phạm vi cùng 1 thư mục bài học
    for (const [pId, files] of filesByParent.entries()) {
      if (files.length < 2) continue;
      const groups = new Map();
      for (const f of files) {
        const isPdf = f.mimeType === 'application/pdf' || /\.pdf$/i.test(f.name);
        const normName = normSegV1(f.name, true);
        const key = isPdf ? `pdf::${normName}` : `vid::${normName}::${f.size || 0}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(f);
      }

      for (const [groupKey, list] of groups.entries()) {
        if (list.length < 2) continue;
        const isPdfGroup = groupKey.startsWith('pdf::');

        // Sắp xếp để chọn 1 bản GIỮ LẠI tốt nhất:
        // - Với PDF: Ưu tiên số 1 LUÔN LÀ bản có tiền tố "UNI " (đã xóa watermark cũ & đóng dấu school.unizvn.com),
        //   sau đó mới xét đến việc đang nằm trong lessons.json và thời gian mới nhất.
        // - Với Video: Ưu tiên số 1 là bản đang nằm trong lessons.json của web, sau đó là bản mới hơn.
        list.sort((a, b) => {
          const aUni = isUniFileName(a.name) ? 1 : 0;
          const bUni = isUniFileName(b.name) ? 1 : 0;
          const aCanonUni = /^UNI\s+(?!UNI(?:\s+|[-_.]+))/i.test(a.name) ? 1 : 0;
          const bCanonUni = /^UNI\s+(?!UNI(?:\s+|[-_.]+))/i.test(b.name) ? 1 : 0;
          const aWeb = schoolStats.webLessonDriveIds.has(a.id) ? 1 : 0;
          const bWeb = schoolStats.webLessonDriveIds.has(b.id) ? 1 : 0;

          if (isPdfGroup) {
            if (aUni !== bUni) return bUni - aUni;
            if (aCanonUni !== bCanonUni) return bCanonUni - aCanonUni;
            if (aWeb !== bWeb) return bWeb - aWeb;
          } else {
            if (aWeb !== bWeb) return bWeb - aWeb;
            if (aUni !== bUni) return bUni - aUni;
          }
          return String(b.modifiedTime || '').localeCompare(String(a.modifiedTime || ''));
        });

        const keep = list[0];
        const keepIsUni = isUniFileName(keep.name);
        // Nếu bản giữ lại là bản UNI, cho phép dọn tất cả các bản cũ trùng tên (kể cả nếu bản cũ từng lưu trong lessons.json, hệ thống sẽ tự trỏ lessons.json sang ID của bản UNI!)
        const redundant = list.slice(1).filter((r) => {
          if (isPdfGroup && keepIsUni) return true;
          return !schoolStats.webLessonDriveIds.has(r.id);
        });
        if (!redundant.length) continue;

        for (const r of redundant) {
          redundantFilesCount++;
          redundantBytes += Number(r.size || 0);
        }

        duplicateGroups.push({
          folderId: pId,
          folderPath: keep.folderPath,
          keep: {
            id: keep.id,
            name: keep.name,
            size: Number(keep.size || 0),
            isUni: keepIsUni,
            inWebLessons: schoolStats.webLessonDriveIds.has(keep.id),
          },
          redundant: redundant.map((r) => ({
            id: r.id,
            keepId: keep.id,
            name: r.name,
            size: Number(r.size || 0),
            inWebLessons: schoolStats.webLessonDriveIds.has(r.id),
          })),
        });
      }
    }
  }

  lastDedupScanResult = {
    scannedAt: new Date().toISOString(),
    folderId: rootFolderId,
    folderLabel,
    scannedFolders,
    totalFiles,
    duplicateGroups,
    redundantFilesCount,
    redundantBytes,
  };
  return lastDedupScanResult;
}

// ---------------------------------------------------------------------------
// 9. Đồng bộ ngược sang dự án web school.unizvn
// ---------------------------------------------------------------------------
function triggerSchoolDriveSync() {
  return new Promise((resolve) => {
    const syncScript = path.join(SCHOOL_PROJECT_DIR, 'scripts', 'sync-drive.js');
    if (!fs.existsSync(syncScript)) {
      return resolve({ ok: false, error: 'Không tìm thấy scripts/sync-drive.js' });
    }
    const child = spawn('node', [syncScript], { cwd: SCHOOL_PROJECT_DIR });
    let out = '';
    child.stdout.on('data', (d) => {
      out += d.toString();
    });
    child.stderr.on('data', (d) => {
      out += d.toString();
    });
    child.on('close', (code) => {
      loadSchoolWebData();
      resolve({ ok: code === 0, code, output: out.slice(-4000) });
    });
  });
}

// ---------------------------------------------------------------------------
// 10. Express API Server & Giao diện Web
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json({ limit: '25mb' }));
app.use(express.static(PUBLIC_DIR));

const upload = multer({ dest: TMP_DIR });

// API: Trạng thái tổng thể của Tool
app.get('/api/state', async (_req, res) => {
  try {
    const writeAccounts = tokenPool.filter((t) => t.canWrite);
    res.json({
      ok: true,
      config: toolConfig,
      accounts: tokenPool.map((t) => ({
        email: t.email,
        canWrite: t.canWrite,
        scopes: t.scopes,
      })),
      hasWriteAccess: writeAccounts.length > 0,
      dbStats: (() => {
        const normValues = Object.values(pdfSyncDb.syncedNormPaths || {});
        const uniPdfPathsCount = normValues.filter((x) => isEntryUniPdf(x)).length;
        const legacyPdfPathsCount = normValues.length - uniPdfPathsCount;
        return {
          pdfSyncedFileIds: Object.keys(pdfSyncDb.syncedFileIds || {}).length,
          pdfSyncedNormPaths: normValues.length,
          uniPdfPathsCount,
          legacyPdfPathsCount,
          dstFolderCacheCount: Object.keys(pdfSyncDb.dstFolderCache || {}).length,
          completedTeachersCount: Object.keys(pdfSyncDb.completedTeachers || {}).length,
          pdfDbUpdatedAt: pdfSyncDb.updatedAt,
          videoSyncedFileIds: Object.keys(videoSyncDb.syncedFileIds || {}).length,
        };
      })(),
      schoolWebStats: {
        lessonsCount: schoolStats.lessonsCount,
        uniqueVideos: schoolStats.videoIds.size,
        uniquePdfs: schoolStats.pdfIds.size,
      },
      masterSheet: masterSheetCache,
      subjectsRootMap: SUBJECT_ROOT_FOLDERS,
      syncJob: {
        running: syncJob.running,
        mode: syncJob.mode,
        startedAt: syncJob.startedAt,
        finishedAt: syncJob.finishedAt,
        currentTeacher: syncJob.currentTeacher,
        currentAction: syncJob.currentAction,
        progress: syncJob.progress,
      },
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// API: Trạng thái realtime của Sync Job
app.get('/api/sync/status', (_req, res) => {
  res.json({
    ok: true,
    ...syncJob,
  });
});

// API: Bắt đầu Quét / Đồng bộ
app.post('/api/sync/start', async (req, res) => {
  if (syncJob.running) {
    return res.status(409).json({ ok: false, error: 'Đang có một tiến trình đồng bộ đang chạy.' });
  }
  const { teacherFolderIds, customTargets, mode = 'dry_run', rules } = req.body || {};

  let targets = [];
  if (Array.isArray(customTargets) && customTargets.length > 0) {
    targets = customTargets;
  } else if (Array.isArray(teacherFolderIds) && teacherFolderIds.length > 0) {
    const idSet = new Set(teacherFolderIds);
    targets = (masterSheetCache.teachers || []).filter((t) => idSet.has(t.sourceFolderId));
  } else {
    targets = masterSheetCache.teachers || [];
  }

  if (!targets.length) {
    return res.status(400).json({ ok: false, error: 'Chưa chọn Giáo viên / Khóa học nào để quét.' });
  }

  if (mode !== 'dry_run') {
    const hasWrite = tokenPool.some((t) => t.canWrite);
    if (!hasWrite) {
      return res.status(403).json({
        ok: false,
        needWriteAuth: true,
        error:
          'Tài khoản Google Drive hiện tại mới chỉ có quyền ĐỌC (drive.readonly). Hãy bấm nút "Cấp quyền Ghi Google Drive (1-Click)" trước khi Upload.',
      });
    }
  }

  runSyncTargets(targets, { mode, rules });
  res.json({ ok: true, startedTargets: targets.length, mode });
});

// API: Dừng tiến trình đang chạy
app.post('/api/sync/stop', (_req, res) => {
  syncJob.stopRequested = true;
  res.json({ ok: true });
});

// API: Làm mới Master Sheet từ Google Drive
app.post('/api/sheet/refresh-master', async (req, res) => {
  try {
    const sheetId = req.body?.sheetId || toolConfig.masterSheetId || DEFAULT_MASTER_SHEET_ID;
    await exportGoogleSheetXlsx(sheetId, MASTER_SHEET_XLSX_PATH);
    const loaded = await loadMasterSheetFromDisk();
    res.json({ ok: true, masterSheet: loaded });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// API: Phân tích một link Google Sheet hoặc Google Drive Folder bất kỳ
app.post('/api/sheet/parse-url', async (req, res) => {
  try {
    const rawUrl = String(req.body?.url || '').trim();
    if (!rawUrl) return res.status(400).json({ ok: false, error: 'Vui lòng nhập link Google Sheet hoặc Google Drive Folder' });

    const mSheet = rawUrl.match(/spreadsheets\/d\/([A-Za-z0-9_-]{15,})/i);
    const mFolder = rawUrl.match(/(?:folders\/|id=)([A-Za-z0-9_-]{15,})/i);

    if (mSheet) {
      const sheetId = mSheet[1];
      const tmpXlsx = path.join(TMP_DIR, `sheet_${sheetId}.xlsx`);
      await exportGoogleSheetXlsx(sheetId, tmpXlsx);
      const parsed = await runPythonJson(SHEET_PARSER_PY, [tmpXlsx]);
      return res.json({
        ok: true,
        kind: 'sheet',
        sheetId,
        parsed,
      });
    }

    if (mFolder || /^[A-Za-z0-9_-]{20,}$/.test(rawUrl)) {
      const folderId = mFolder ? mFolder[1] : rawUrl;
      const meta = await driveJson(
        `https://www.googleapis.com/drive/v3/files/${folderId}?fields=id,name,mimeType&supportsAllDrives=true`,
        {},
        false
      );
      return res.json({
        ok: true,
        kind: 'folder',
        folder: {
          id: meta.id,
          name: cleanDisplayName(meta.name),
          rawName: meta.name,
        },
      });
    }

    res.status(400).json({ ok: false, error: 'Không nhận diện được ID Google Sheet hoặc Drive Folder từ đường dẫn.' });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// API: Lưu cấu hình luật lọc & hẹn giờ tự động
app.post('/api/settings/save', (req, res) => {
  try {
    const { rules, autoSync, schoolRootFolderId, masterSheetId } = req.body || {};
    if (rules) toolConfig.rules = { ...toolConfig.rules, ...rules };
    if (autoSync) toolConfig.autoSync = { ...toolConfig.autoSync, ...autoSync };
    if (schoolRootFolderId) toolConfig.schoolRootFolderId = String(schoolRootFolderId).trim();
    if (masterSheetId) toolConfig.masterSheetId = String(masterSheetId).trim();
    saveToolConfig(toolConfig);
    setupAutoSyncTimer();
    res.json({ ok: true, config: toolConfig });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// API: 1-Click OAuth2 Cấp quyền Ghi (Full Drive Scope) trên đúng cổng 53682 của dự án
let activeOAuthServer = null;

app.post('/api/oauth/start', async (_req, res) => {
  try {
    const { clientId, clientSecret } = getCredentials();
    if (!clientId || !clientSecret) {
      return res.status(400).json({ ok: false, error: 'Thiếu GDRIVE_CLIENT_ID hoặc GDRIVE_CLIENT_SECRET trong .env' });
    }

    if (activeOAuthServer) {
      try {
        activeOAuthServer.close();
      } catch {}
      activeOAuthServer = null;
    }

    const authUrl =
      `https://accounts.google.com/o/oauth2/v2/auth?` +
      new URLSearchParams({
        client_id: clientId,
        redirect_uri: OAUTH_REDIRECT_URI,
        response_type: 'code',
        scope: 'https://www.googleapis.com/auth/drive',
        access_type: 'offline',
        prompt: 'consent',
        login_hint: ALLOWED_GDRIVE_EMAIL,
      }).toString();

    activeOAuthServer = http.createServer(async (reqCb, resCb) => {
      try {
        const u = new URL(reqCb.url, `http://127.0.0.1:${OAUTH_CALLBACK_PORT}`);
        const code = u.searchParams.get('code');
        if (!code) {
          resCb.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          resCb.end('<h3>Không tìm thấy mã xác thực. Bạn có thể đóng tab này.</h3>');
          return;
        }

        const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            code,
            client_id: clientId,
            client_secret: clientSecret,
            redirect_uri: OAUTH_REDIRECT_URI,
            grant_type: 'authorization_code',
          }),
        });
        const tokenData = await tokenRes.json();
        if (!tokenData.refresh_token) {
          resCb.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          resCb.end(`<h3>Lỗi lấy refresh_token: ${tokenData.error_description || tokenData.error}</h3>`);
          return;
        }

        if (!toolConfig.writeRefreshTokens.includes(tokenData.refresh_token)) {
          toolConfig.writeRefreshTokens.unshift(tokenData.refresh_token);
          saveToolConfig(toolConfig);
        }
        await initTokenPool();

        resCb.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        resCb.end(`
          <!DOCTYPE html>
          <html><head><meta charset="utf-8"><title>Cấp quyền thành công</title></head>
          <body style="font-family: system-ui, sans-serif; background:#0f172a; color:#f8fafc; display:flex; align-items:center; justify-content:center; height:100vh; margin:0;">
            <div style="background:#1e293b; padding:32px; border-radius:16px; border:1px solid #334155; text-align:center; max-width:460px;">
              <h2 style="color:#4ade80; margin-top:0;">✅ Đã cấp quyền Ghi Google Drive thành công!</h2>
              <p>Tài khoản của bạn đã sẵn sàng tạo thư mục và upload PDF/Video lên thư mục <b>SCHOOL</b>.</p>
              <p style="color:#94a3b8; font-size:14px;">Bạn có thể đóng tab này và quay lại giao diện Tool.</p>
              <script>setTimeout(() => window.close(), 2500);</script>
            </div>
          </body></html>
        `);
      } catch (cbErr) {
        resCb.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        resCb.end('Lỗi xác thực: ' + cbErr.message);
      } finally {
        setTimeout(() => {
          if (activeOAuthServer) {
            try {
              activeOAuthServer.close();
            } catch {}
            activeOAuthServer = null;
          }
        }, 1000);
      }
    });

    activeOAuthServer.listen(OAUTH_CALLBACK_PORT, '127.0.0.1');

    // Tự động mở trình duyệt trên macOS
    spawn('open', [authUrl], { stdio: 'ignore', detached: true }).unref();

    res.json({ ok: true, authUrl });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// API: Quét & Dọn dẹp File Trùng trên Drive SCHOOL
app.post('/api/dedup/scan', async (req, res) => {
  try {
    const folderId = String(req.body?.folderId || toolConfig.schoolRootFolderId || DEFAULT_SCHOOL_ROOT_ID).trim();
    const label = String(req.body?.label || 'SCHOOL').trim();
    const result = await scanDriveFolderForDuplicates(folderId, label);
    res.json({ ok: true, result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/dedup/clean', async (req, res) => {
  try {
    const { fileIds, items } = req.body || {};
    const pairs = [];
    if (Array.isArray(items) && items.length > 0) {
      for (const it of items) {
        if (it && it.id) pairs.push({ id: String(it.id), keepId: it.keepId ? String(it.keepId) : '' });
      }
    } else if (Array.isArray(fileIds) && fileIds.length > 0) {
      for (const raw of fileIds) {
        const [id, keepId] = String(raw || '').split('|');
        if (id) pairs.push({ id, keepId: keepId || '' });
      }
    }

    if (!pairs.length) {
      return res.status(400).json({ ok: false, error: 'Không có file trùng nào được chọn để xóa.' });
    }
    loadSchoolWebData();
    let trashed = 0;
    let skippedProtected = 0;
    let updatedWebLinks = 0;
    const errors = [];
    const replacementsMap = {};
    const allReplacedMap = {};
    const trashedIdsSet = new Set();

    // Lấy thông tin keep từ lastDedupScanResult (nếu có) để cập nhật chính xác isUni/name trong DB
    const keepMetaMap = {};
    for (const grp of lastDedupScanResult?.duplicateGroups || []) {
      if (grp?.keep?.id) {
        keepMetaMap[grp.keep.id] = { name: grp.keep.name, isUni: grp.keep.isUni };
      }
    }

    for (const { id: fid, keepId } of pairs) {
      const inWeb = schoolStats.webLessonDriveIds.has(fid);
      if (inWeb && !keepId) {
        skippedProtected++;
        continue;
      }
      try {
        await trashDriveFile(fid);
        trashed++;
        trashedIdsSet.add(fid);
        if (keepId && keepId !== fid) {
          allReplacedMap[fid] = keepId;
          if (inWeb) {
            replacementsMap[fid] = keepId;
          }
        }
      } catch (e) {
        errors.push({ fileId: fid, error: e.message });
      }
    }

    dstFolderFilesCache.clear();

    if (Object.keys(allReplacedMap).length > 0) {
      const dbUpd = updateSyncDbsAfterFileReplacement(allReplacedMap, keepMetaMap);
      if (dbUpd.pdfUpdated > 0) savePdfSyncDb();
      if (dbUpd.videoUpdated > 0) saveVideoSyncDb();
    }

    if (Object.keys(replacementsMap).length > 0) {
      updatedWebLinks = replaceDriveIdsInSchoolLessons(replacementsMap);
    }

    if (trashedIdsSet.size > 0 && Array.isArray(lastDedupScanResult?.duplicateGroups)) {
      let remCount = 0;
      let remBytes = 0;
      const nextGroups = [];
      for (const grp of lastDedupScanResult.duplicateGroups) {
        const remRedundant = (grp.redundant || []).filter((r) => !trashedIdsSet.has(r.id));
        if (remRedundant.length > 0) {
          for (const r of remRedundant) {
            remCount++;
            remBytes += Number(r.size || 0);
          }
          nextGroups.push({
            ...grp,
            redundant: remRedundant,
          });
        }
      }
      lastDedupScanResult.duplicateGroups = nextGroups;
      lastDedupScanResult.redundantFilesCount = remCount;
      lastDedupScanResult.redundantBytes = remBytes;
    }

    res.json({ ok: true, trashed, skippedProtected, updatedWebLinks, errors, lastDedupScanResult });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// API: Test & Xem trước Xử lý Watermark PDF (Từ Drive ID/Link hoặc File Upload)
app.post('/api/pdf/test-drive', async (req, res) => {
  try {
    const raw = String(req.body?.fileIdOrUrl || '').trim();
    const m = raw.match(/(?:file\/d\/|id=)([A-Za-z0-9_-]{15,})/i);
    const fileId = m ? m[1] : raw;
    if (!fileId) return res.status(400).json({ ok: false, error: 'Vui lòng nhập ID hoặc Link file PDF trên Drive' });

    const meta = await driveJson(
      `https://www.googleapis.com/drive/v3/files/${fileId}?fields=id,name,size&supportsAllDrives=true`,
      {},
      false
    );
    const beforeName = `preview_before_${fileId}.pdf`;
    const afterName = `preview_after_${fileId}.pdf`;
    const beforePath = path.join(TMP_DIR, beforeName);
    const afterPath = path.join(TMP_DIR, afterName);

    await downloadDriveFile(fileId, beforePath);
    const report = await processPdfWithWatermark(beforePath, afterPath, toolConfig.rules);

    res.json({
      ok: true,
      fileName: meta.name,
      uniFileName: /^UNI\s+/i.test(meta.name) ? meta.name : `UNI ${cleanDisplayName(meta.name)}`,
      report,
      beforeUrl: `/api/pdf/preview/${encodeURIComponent(beforeName)}`,
      afterUrl: `/api/pdf/preview/${encodeURIComponent(afterName)}`,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/pdf/test-upload', upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: 'Chưa chọn file PDF' });
    const stamp = Date.now();
    const beforeName = `upload_before_${stamp}.pdf`;
    const afterName = `upload_after_${stamp}.pdf`;
    const beforePath = path.join(TMP_DIR, beforeName);
    const afterPath = path.join(TMP_DIR, afterName);

    fs.renameSync(req.file.path, beforePath);
    const report = await processPdfWithWatermark(beforePath, afterPath, toolConfig.rules);

    res.json({
      ok: true,
      fileName: req.file.originalname,
      uniFileName: `UNI ${cleanDisplayName(req.file.originalname)}`,
      report,
      beforeUrl: `/api/pdf/preview/${encodeURIComponent(beforeName)}`,
      afterUrl: `/api/pdf/preview/${encodeURIComponent(afterName)}`,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/pdf/preview/:fileName', (req, res) => {
  const safeName = path.basename(req.params.fileName);
  const fullPath = path.join(TMP_DIR, safeName);
  if (!fs.existsSync(fullPath)) {
    return res.status(404).send('Không tìm thấy file xem trước');
  }
  res.setHeader('Content-Type', 'application/pdf');
  res.sendFile(fullPath);
});

// API: Đồng bộ file _pdf_sync_db.json lên Drive & kéo về
app.post('/api/db/pull-from-drive', async (_req, res) => {
  try {
    await downloadDriveFile(toolConfig.remotePdfSyncDbFileId || REMOTE_PDF_SYNC_DB_ID, PDF_SYNC_DB_PATH);
    loadPdfSyncDb();
    await loadMasterSheetFromDisk();
    res.json({
      ok: true,
      syncedFileIds: Object.keys(pdfSyncDb.syncedFileIds).length,
      syncedNormPaths: Object.keys(pdfSyncDb.syncedNormPaths).length,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/db/push-to-drive', async (_req, res) => {
  try {
    savePdfSyncDb();
    const token = await getToken({ requireWrite: true });
    const fileId = toolConfig.remotePdfSyncDbFileId || REMOTE_PDF_SYNC_DB_ID;
    const bodyBuf = fs.readFileSync(PDF_SYNC_DB_PATH);
    const upRes = await fetch(
      `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media&supportsAllDrives=true`,
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Content-Length': String(bodyBuf.length),
        },
        body: bodyBuf,
      }
    );
    if (!upRes.ok) {
      const txt = await upRes.text().catch(() => '');
      throw new Error(`Upload _pdf_sync_db.json thất bại (${upRes.status}): ${txt.slice(0, 200)}`);
    }
    res.json({ ok: true, updatedAt: pdfSyncDb.updatedAt });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// API: Kích hoạt đồng bộ sang web school.unizvn
app.post('/api/school/sync', async (_req, res) => {
  try {
    const result = await triggerSchoolDriveSync();
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Hẹn giờ Auto-Sync định kỳ
let autoSyncTimer = null;
function setupAutoSyncTimer() {
  if (autoSyncTimer) {
    clearInterval(autoSyncTimer);
    autoSyncTimer = null;
  }
  if (toolConfig.autoSync?.enabled) {
    const mins = Math.max(15, Number(toolConfig.autoSync.intervalMinutes || 180));
    autoSyncTimer = setInterval(() => {
      if (!syncJob.running && masterSheetCache.teachers.length > 0) {
        const hasWrite = tokenPool.some((t) => t.canWrite);
        const mode = hasWrite ? 'both' : 'dry_run';
        toolConfig.autoSync.lastRunAt = new Date().toISOString();
        saveToolConfig(toolConfig);
        runSyncTargets(masterSheetCache.teachers, { mode, rules: toolConfig.rules });
      }
    }, mins * 60 * 1000);
  }
}

// Khởi động toàn bộ hệ thống
(async () => {
  loadPdfSyncDb();
  loadVideoSyncDb();
  loadSchoolWebData();
  await initTokenPool();
  await loadMasterSheetFromDisk();
  setupAutoSyncTimer();

  app.listen(PORT, '127.0.0.1', () => {
    console.log(`==================================================================`);
    console.log(`🚀 UNI Sheet -> Drive Sync Tool đang chạy tại: http://localhost:${PORT}`);
    console.log(`📚 Đã nạp DB lọc trùng: ${Object.keys(pdfSyncDb.syncedNormPaths).length} PDF paths, ${schoolStats.videoIds.size} Videos`);
    console.log(`👨‍🏫 Đã nạp Master Sheet: ${masterSheetCache.teachers.length} Giáo viên / Khóa học`);
    console.log(`==================================================================`);
  });
})();
