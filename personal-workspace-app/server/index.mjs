import http from 'node:http';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import readline from 'node:readline';
import JSZip from 'jszip';
import { startQuickTunnel } from './tunnel.mjs';

const PORT = Number(process.env.PORT) || 5173;
const HOST = '0.0.0.0';
const DEV_MODE = process.env.PW_DEV === '1';
// Global (internet) access via a secure Cloudflare Quick Tunnel. Off by
// default — local and LAN behavior are completely unchanged when off.
const GLOBAL_ACCESS = /^(1|true|yes|on)$/i.test(String(process.env.GLOBAL_ACCESS || ''));
const VITE_HOST = '127.0.0.1';
const VITE_PORT = Number(process.env.VITE_DEV_PORT) || 4173;
const DIST_DIR = path.resolve(process.cwd(), 'dist');
const FORMAT = 'personal-workspace';
const FORMAT_VERSION = 1;
const STATE_FILE = 'workspace.json';
const TMP_SUFFIX = '.tmp';
const DIRS = ['attachments', 'backups'];
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_STATE_BYTES = 64 * 1024 * 1024;
const BACKUP_INTERVAL_MS = Number(process.env.PW_BACKUP_INTERVAL_MS) || 5 * 60 * 1000;
const MAX_BACKUPS = Number(process.env.PW_MAX_BACKUPS) || 12;

// ---- attachment & upload limits ---------------------------------------------
// Conservative defaults for a machine with limited disk space. Every value is
// configurable through the environment and exposed to the client in a single
// place (GET /api/workspace/limits) so the UI and the server never disagree.
const MB = 1024 * 1024;
const MAX_FILE_BYTES = Number(process.env.PW_MAX_FILE_BYTES) || 10 * MB;            // non-archive document/code file
const MAX_ZIP_BYTES = Number(process.env.PW_MAX_ZIP_BYTES) || 25 * MB;              // ZIP archive
const MAX_ATTACHMENTS_PER_REQUEST = Number(process.env.PW_MAX_ATTACHMENTS_PER_REQUEST) || 5;
const MAX_TOTAL_BYTES_PER_REQUEST = Number(process.env.PW_MAX_TOTAL_BYTES_PER_REQUEST) || 30 * MB;
const MAX_ZIP_ENTRIES = Number(process.env.PW_MAX_ZIP_ENTRIES) || 10000;
const TMP_MAX_AGE_MS = Number(process.env.PW_TMP_MAX_AGE_MS) || 10 * 60 * 1000;

// Allowlist of file types users may attach. Everything else (executables,
// scripts that auto-run, installer payloads, etc.) is rejected with 415.
const ATTACH_ALLOWED_EXTENSIONS = new Set([
  // documents
  'pdf', 'doc', 'docx', 'odt', 'rtf',
  // text / markdown / data
  'txt', 'md', 'markdown', 'csv', 'json', 'xml', 'yaml', 'yml', 'log',
  // archives (stored as archives — never extracted)
  'zip',
  // common source-code files
  'js', 'mjs', 'cjs', 'ts', 'mts', 'cts', 'tsx', 'jsx', 'py', 'rb', 'go', 'rs',
  'java', 'c', 'cc', 'cpp', 'cxx', 'h', 'hh', 'hpp', 'hxx', 'cs', 'php', 'swift',
  'kt', 'kts', 'scala', 'lua', 'pl', 'r', 'dart', 'groovy', 'sh', 'bash', 'zsh',
  'fish', 'css', 'scss', 'less', 'sass', 'sql', 'toml', 'ini', 'cfg', 'conf',
  'properties',
]);

// Image extensions are accepted by the existing single-image upload path and by
// backup restore. They are separate from ATTACH_ALLOWED_EXTENSIONS purely so
// the two existing flows keep behaving exactly as before.
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'bmp', 'ico']);

const attachLimits = {
  maxFileBytes: MAX_FILE_BYTES,
  maxZipBytes: MAX_ZIP_BYTES,
  maxAttachmentsPerRequest: MAX_ATTACHMENTS_PER_REQUEST,
  maxTotalBytesPerRequest: MAX_TOTAL_BYTES_PER_REQUEST,
  maxZipEntries: MAX_ZIP_ENTRIES,
  allowedExtensions: [...ATTACH_ALLOWED_EXTENSIONS],
};

const SESSION_COOKIE = 'pw_sid';
const SESSION_MAX_AGE = 60 * 60 * 24 * 365;
const MAX_REQUESTS_PER_MIN = 600;
const MAX_UPLOAD_BYTES_PER_MIN = 100 * 1024 * 1024;
const MAX_CONCURRENT_UPLOADS = 4;

const configDir = path.join(os.homedir(), '.config', 'personal-workspace-app');
const configFile = path.join(configDir, 'config.json');

let openPath = null;
let stateRevision = 0;
let lastBackupAt = 0;
let writeChain = Promise.resolve();
let serverToken = null;
let activeUploads = 0;
let tunnel = null;
// Hostname of the active global-access tunnel (e.g. xxx.trycloudflare.com).
let tunnelHost = null;

// ---- local (self-hosted) mode ------------------------------------------------
// "Local mode" means the browser is running on the very machine that runs this
// server (loopback) and is not reaching it through the global-access tunnel. In
// local mode the user can pick ANY directory as the workspace, create new
// workspaces, and browse/read files inside the currently open workspace. Those
// extra endpoints are gated on isLocalClient(req) below, so a server or tunnel
// deployment never exposes the server's filesystem.

const sessions = new Set();
const rateBuckets = new Map();

const MIME_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.zip': 'application/zip',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.odt': 'application/vnd.oasis.opendocument.text',
  '.rtf': 'application/rtf',
  '.csv': 'text/csv',
  '.xml': 'application/xml',
  '.yaml': 'text/yaml',
  '.yml': 'text/yaml',
  '.log': 'text/plain',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.cjs': 'text/javascript',
  '.ts': 'text/typescript',
  '.tsx': 'text/typescript',
  '.jsx': 'text/javascript',
  '.py': 'text/x-python',
  '.rb': 'text/x-ruby',
  '.go': 'text/x-go',
  '.rs': 'text/x-rust',
  '.java': 'text/x-java-source',
  '.c': 'text/x-c',
  '.h': 'text/x-c',
  '.cpp': 'text/x-c++',
  '.cc': 'text/x-c++',
  '.hpp': 'text/x-c++',
  '.cs': 'text/x-csharp',
  '.php': 'text/x-php',
  '.swift': 'text/x-swift',
  '.kt': 'text/x-kotlin',
  '.sh': 'text/x-shellscript',
  '.bash': 'text/x-shellscript',
  '.css': 'text/css',
  '.scss': 'text/x-scss',
  '.sql': 'text/x-sql',
  '.toml': 'application/toml',
  '.ini': 'text/plain',
  '.cfg': 'text/plain',
  '.conf': 'text/plain',
};

const STATIC_MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

const APP_CSP = DEV_MODE
  ? "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob: https:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
  : "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob: https:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

// Uploaded content is served inline (needed for <img> in the editor), so it is
// sandboxed: scripts are disabled even when the file is opened top-level.
const ATTACHMENT_CSP = "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; media-src data:; frame-ancestors 'none'";

const allowedHosts = new Set(['localhost', '127.0.0.1', '[::1]', '::1', os.hostname().toLowerCase()]);
for (const iface of Object.values(os.networkInterfaces())) {
  for (const entry of iface || []) {
    if (!entry.internal) {
      allowedHosts.add(entry.address.toLowerCase());
      allowedHosts.add(entry.address.toLowerCase().split('%')[0]);
    }
  }
}
if (process.env.PW_ALLOWED_HOST) {
  for (const h of process.env.PW_ALLOWED_HOST.split(',')) {
    const t = h.trim().toLowerCase();
    if (t) allowedHosts.add(t);
  }
}

function log(...args) {
  console.log('[workspace-server]', ...args);
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function applyBaseHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
}

function json(res, status, data) {
  if (res.destroyed || res.headersSent) return;
  const body = JSON.stringify(data);
  applyBaseHeaders(res);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function ok(res, data) {
  json(res, 200, { ok: true, ...data });
}

function fail(res, status, error, extra = {}) {
  json(res, status, { ok: false, error, ...extra });
}

function hostAllowed(req) {
  const raw = (req.headers.host || '').toLowerCase();
  if (!raw) return false;
  let hostPart;
  if (raw.startsWith('[')) {
    const end = raw.indexOf(']');
    hostPart = end === -1 ? raw : raw.slice(0, end + 1);
  } else {
    hostPart = raw.split(':')[0];
  }
  return allowedHosts.has(hostPart);
}

function isLoopback(addr) {
  return addr === '127.0.0.1'
    || addr === '::1'
    || addr === '::ffff:127.0.0.1'
    || addr.startsWith('::ffff:127.');
}

// True when THIS request arrived through the global-access tunnel — the Host
// header then matches the cloudflare quick-tunnel hostname.
function viaTunnel(req) {
  if (!tunnelHost) return false;
  const raw = (req.headers.host || '').toLowerCase();
  return raw.split(':')[0] === tunnelHost;
}

// When global access is on, requests arrive through the local cloudflared
// process, i.e. over a loopback socket carrying the visitor's real address in
// CF-Connecting-IP / X-Forwarded-For. Only forwarding headers from loopback
// sockets are honored, and Cloudflare overwrites inbound CF-* headers at the
// edge, so direct LAN clients cannot spoof them. With global access off this
// always returns null and clientIp behaves exactly as before.
function forwardedClientIp(req) {
  if (!GLOBAL_ACCESS) return null;
  if (!isLoopback(req.socket.remoteAddress)) return null;
  const cf = req.headers['cf-connecting-ip'];
  if (typeof cf === 'string' && cf.trim()) return cf.trim();
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim()) {
    const first = xff.split(',')[0].trim();
    if (first) return first;
  }
  return null;
}

function clientIp(req) {
  return forwardedClientIp(req) || req.socket.remoteAddress || 'unknown';
}

function validServerTokenValue(value) {
  if (!serverToken) return true;
  if (typeof value !== 'string' || !value) return false;
  const a = Buffer.from(value);
  const b = Buffer.from(serverToken);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// The token can be sent as an X-Server-Token header or (for <img> and other
// no-header requests) as a ?token= query parameter.
function getTokenFromRequest(req, url) {
  const header = req.headers['x-server-token'];
  if (typeof header === 'string' && header) return header;
  try {
    const q = url && url.searchParams.get('token');
    return typeof q === 'string' && q ? q : null;
  } catch {
    return null;
  }
}

function sessionValid(req) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === SESSION_COOKIE) {
      return sessions.has(part.slice(eq + 1).trim());
    }
  }
  return false;
}

function issueSession(res) {
  if (sessions.size > 2048) sessions.clear();
  const token = crypto.randomBytes(32).toString('hex');
  sessions.add(token);
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_MAX_AGE}`);
  return token;
}

function rateLimit(ip, key, limit, windowMs, amount = 1) {
  const now = Date.now();
  const id = `${ip}:${key}`;
  let bucket = rateBuckets.get(id);
  if (!bucket || now - bucket.start >= windowMs) {
    bucket = { start: now, count: 0 };
    rateBuckets.set(id, bucket);
  }
  bucket.count += amount;
  if (bucket.count > limit) return false;
  if (rateBuckets.size > 5000) rateBuckets.clear();
  return true;
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function isInside(rootReal, targetReal) {
  return targetReal === rootReal || targetReal.startsWith(rootReal + path.sep);
}

// True when the browser is on the machine running this server and the request
// did not arrive through the global-access tunnel. Local-mode-only endpoints
// (pick any directory, create workspaces, browse files) require this.
function isLocalClient(req) {
  return isLoopback(clientIp(req)) && !viaTunnel(req);
}

function requireLocal(req, res) {
  if (!isLocalClient(req)) {
    fail(res, 403, 'Local mode only.');
    return false;
  }
  return true;
}

async function resolveInsideWorkspace(relOrAbs) {
  if (!openPath) throw httpError(400, 'No workspace is open.');
  const rootReal = await fsp.realpath(openPath);
  let targetReal;
  try {
    targetReal = await fsp.realpath(relOrAbs);
  } catch {
    throw httpError(404, 'Not found.');
  }
  if (!isInside(rootReal, targetReal)) throw httpError(403, 'Outside the workspace.');
  return targetReal;
}

function formatBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// Minimal multipart/form-data parser. Bodies are bounded by the caller
// (MAX_TOTAL_BYTES_PER_REQUEST), and each parsed part's buffer is a subarray of
// that already-bounded buffer, so memory use is capped.
function parseMultipart(buffer, boundary) {
  const marker = Buffer.from(`--${boundary}`);
  const parts = [];
  let index = buffer.indexOf(marker);
  if (index === -1) return parts;
  while (index !== -1) {
    let start = index + marker.length;
    // Skip the CRLF that follows the boundary marker.
    if (buffer[start] === 0x0d && buffer[start + 1] === 0x0a) start += 2;
    else if (buffer[start] === 0x0a) start += 1;
    const next = buffer.indexOf(marker, start);
    if (next === -1) break;
    // The two bytes right before the next "--boundary" are its leading CRLF.
    let end = next;
    if (buffer[end - 2] === 0x0d && buffer[end - 1] === 0x0a) end -= 2;
    const part = buffer.subarray(start, end);
    const headerEnd = part.indexOf(Buffer.from('\r\n\r\n'));
    if (headerEnd === -1) {
      index = next;
      continue;
    }
    const headers = part.subarray(0, headerEnd).toString('utf8');
    const data = Buffer.from(part.subarray(headerEnd + 4));
    const nameMatch = /name="([^"]*)"/.exec(headers);
    const filenameMatch = /filename="([^"]*)"/.exec(headers);
    const contentTypeMatch = /content-type:\s*([^\r\n]+)/i.exec(headers);
    parts.push({
      name: nameMatch ? nameMatch[1] : undefined,
      filename: filenameMatch ? filenameMatch[1] : undefined,
      contentType: contentTypeMatch ? contentTypeMatch[1].trim() : undefined,
      data,
    });
    index = next;
  }
  return parts;
}

function safeUploadTitle(filename) {
  const base = path.basename(String(filename || '')).replace(/[^\x20-\x7E]/g, '').trim();
  return (base || 'file').slice(0, 180);
}

function extOf(filename) {
  const m = /\.([a-zA-Z0-9]+)$/.exec(String(filename || ''));
  return m ? m[1].toLowerCase() : '';
}

// ZIP archives are stored as archives and never extracted. Validation only
// parses entry names (JSZip reads the central directory without unpacking file
// data) to reject traversal, absolute paths, null bytes, and archive bombs.
// Reads the raw entry names straight from the ZIP central directory. JSZip
// normalizes/sanitizes names while loading (it silently drops "../", absolute
// paths, etc.), so validation must look at the undecoded names a normal unzip
// tool would actually use. Returns null for archives we can't scan (then JSZip
// structural validation below is the only bound, which is fine since we never
// extract).
function scanZipEntryNames(buf) {
  if (buf.length < 22) return null;
  const start = Math.max(0, buf.length - 65557);
  let eocd = -1;
  for (let i = buf.length - 22; i >= start; i--) {
    if (
      buf[i] === 0x50 &&
      buf.readUInt32LE(i) === 0x06054b50
    ) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const names = [];
  for (let n = 0; n < count; n++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) break;
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    names.push(buf.toString('latin1', off + 46, off + 46 + nameLen));
    off += 46 + nameLen + extraLen + commentLen;
  }
  return names.length ? names : null;
}

async function validateZipBuffer(buf) {
  let zip;
  try {
    zip = await JSZip.loadAsync(buf, { checkCRC32: false });
  } catch {
    throw httpError(400, 'Invalid ZIP archive.');
  }
  const names = Object.keys(zip.files);
  if (names.length > MAX_ZIP_ENTRIES) {
    throw httpError(413, 'ZIP contains too many entries.');
  }
  const rawNames = scanZipEntryNames(buf);
  if (rawNames) {
    for (const raw of rawNames) {
      if (raw.includes('\0')) throw httpError(400, 'Invalid ZIP entry name.');
      const norm = raw.replace(/\\/g, '/');
      const segments = norm.split('/');
      if (segments.includes('..')) throw httpError(400, 'ZIP contains path traversal.');
      if (norm.startsWith('/') || /^[a-zA-Z]:/.test(norm)) throw httpError(400, 'ZIP contains absolute paths.');
    }
  }
}

// Writes an already-buffered upload into the current workspace's attachments
// folder as a fresh random name (writes tmp, then renames — same atomic pattern
// the workspace state file uses).
async function saveAttachmentBuffer(name, data) {
  const safe = safeAttachmentName(name);
  if (!openPath) throw httpError(400, 'No workspace is open.');
  const dir = path.join(openPath, 'attachments');
  const [rootReal, dirReal] = await Promise.all([
    fsp.realpath(openPath),
    fsp.realpath(dir),
  ]);
  if (!isInside(rootReal, dirReal)) {
    throw httpError(403, 'Forbidden.');
  }
  const filePath = path.join(dirReal, safe);
  try {
    const st = await fsp.lstat(filePath);
    if (st.isSymbolicLink()) throw httpError(403, 'Forbidden.');
  } catch (err) {
    if (err.status) throw err;
    if (err.code !== 'ENOENT') throw err;
  }
  const tmpFile = filePath + TMP_SUFFIX;
  await fsp.unlink(tmpFile).catch(() => {});
  await fsp.writeFile(tmpFile, data, { mode: 0o600, flag: 'wx' });
  await fsp.rename(tmpFile, filePath);
}

async function cleanupTmpFiles(root) {
  const dirCandidates = [
    root,
    path.join(root, 'attachments'),
    path.join(root, 'backups'),
  ];
  for (const dir of dirCandidates) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(TMP_SUFFIX)) continue;
      const full = path.join(dir, entry.name);
      try {
        const st = await fsp.stat(full);
        if (Date.now() - st.mtimeMs > TMP_MAX_AGE_MS) {
          await fsp.unlink(full).catch(() => {});
        }
      } catch {
        // ignore unreadable/invalid entries
      }
    }
  }
}

async function readJson(file, fallback) {
  try {
    const raw = await fsp.readFile(file, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

async function readConfig() {
  try {
    return await readJson(configFile, {});
  } catch {
    return {};
  }
}

async function writeConfig(config) {
  await fsp.mkdir(configDir, { recursive: true, mode: 0o700 });
  await fsp.writeFile(configFile, JSON.stringify(config, null, 2), 'utf8');
  await fsp.chmod(configFile, 0o600).catch(() => {});
  await fsp.chmod(configDir, 0o700).catch(() => {});
}

// Short, easy-to-type token: 8 chars from an unambiguous charset (no 0/O/1/I/l).
// 32^8 = 1.1e12 combinations, and brute force is throttled by the per-IP rate
// limit, which is ample for a trusted-LAN threat model. With global access
// enabled the ID is 12 chars (32^12 ≈ 1.2e18) for an internet-facing surface.
const TOKEN_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789';

function generateToken() {
  const length = GLOBAL_ACCESS ? 12 : 8;
  const bytes = crypto.randomBytes(length);
  let token = '';
  for (let i = 0; i < length; i++) token += TOKEN_CHARS[bytes[i] % TOKEN_CHARS.length];
  return token;
}

async function initServerToken() {
  if (process.env.PW_SERVER_TOKEN) {
    serverToken = process.env.PW_SERVER_TOKEN;
    return;
  }
  // A fresh Access ID on every start: a stale token from a previous session is
  // useless, and LAN devices just re-enter the one printed in the console.
  serverToken = generateToken();
  const config = await readConfig();
  if (typeof config.authToken === 'string') {
    delete config.authToken;
    await writeConfig(config);
  }
}

async function ensureWorkspaceStructure(dir) {
  await fsp.mkdir(dir, { recursive: true });
  for (const sub of DIRS) {
    await fsp.mkdir(path.join(dir, sub), { recursive: true });
  }
  const rootReal = await fsp.realpath(dir);
  for (const sub of DIRS) {
    const subReal = await fsp.realpath(path.join(dir, sub));
    if (!isInside(rootReal, subReal)) {
      throw httpError(403, 'Workspace contains external links.');
    }
  }
  const stateFile = path.join(dir, STATE_FILE);
  try {
    await fsp.access(stateFile);
    return false;
  } catch {
    return true;
  }
}

function emptyState() {
  return {
    format: FORMAT,
    version: FORMAT_VERSION,
    revision: 0,
    updatedAt: 0,
    folders: [],
    pages: [],
    settings: [],
  };
}

async function loadStateFile(dir) {
  const stateFile = path.join(dir, STATE_FILE);
  const [rootReal, fileReal] = await Promise.all([
    fsp.realpath(dir),
    fsp.realpath(stateFile),
  ]);
  if (!isInside(rootReal, fileReal)) {
    throw httpError(403, 'Forbidden.');
  }
  const raw = await fsp.readFile(fileReal, 'utf8');
  const state = JSON.parse(raw);
  if (!state || state.format !== FORMAT) {
    throw new Error(`"${STATE_FILE}" is not a Personal Workspace file.`);
  }
  if (!Array.isArray(state.folders)) state.folders = [];
  if (!Array.isArray(state.pages)) state.pages = [];
  if (!Array.isArray(state.settings)) state.settings = [];
  stateRevision = typeof state.revision === 'number' ? state.revision : 0;
  return state;
}

async function writeStateFile(dir, state) {
  const stateFile = path.join(dir, STATE_FILE);
  const tmpFile = stateFile + TMP_SUFFIX;
  const rootReal = await fsp.realpath(dir);
  const dirReal = await fsp.realpath(path.dirname(stateFile));
  if (!isInside(rootReal, dirReal)) {
    throw httpError(403, 'Forbidden.');
  }
  await fsp.unlink(tmpFile).catch(() => {});
  const data = JSON.stringify(state, null, 2);
  const handle = await fsp.open(tmpFile, 'wx', 0o600);
  try {
    await handle.writeFile(data, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsp.rename(tmpFile, stateFile);
}

function enqueueWrite(task) {
  const run = writeChain.then(task, task);
  writeChain = run.catch(() => {});
  return run;
}

function serializeState(dir, folders, pages, settings) {
  const revision = stateRevision + 1;
  stateRevision = revision;
  return {
    format: FORMAT,
    version: FORMAT_VERSION,
    revision,
    updatedAt: Date.now(),
    folders,
    pages,
    settings,
  };
}

async function createBackup(dir, state) {
  const backupsDir = path.join(dir, 'backups');
  const rootReal = await fsp.realpath(dir);
  const backupsReal = await fsp.realpath(backupsDir);
  if (!isInside(rootReal, backupsReal)) {
    throw httpError(403, 'Forbidden.');
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const name = `workspace-backup-${stamp}.json`;
  const file = path.join(backupsDir, name);
  const tmpFile = file + TMP_SUFFIX;
  await fsp.unlink(tmpFile).catch(() => {});
  await fsp.writeFile(tmpFile, JSON.stringify(state, null, 2), { mode: 0o600, flag: 'wx' });
  await fsp.rename(tmpFile, file);
  let entries;
  try {
    entries = await fsp.readdir(backupsDir);
  } catch {
    entries = [];
  }
  const backups = entries
    .filter((n) => n.startsWith('workspace-backup-') && n.endsWith('.json'))
    .sort();
  const extra = backups.length - MAX_BACKUPS;
  for (let i = 0; i < extra; i++) {
    await fsp.rm(path.join(backupsDir, backups[i]), { force: true });
  }
  return name;
}

async function saveWorkspace(folders, pages, settings) {
  if (!openPath) throw new Error('No workspace is open.');
  const dir = openPath;
  const state = serializeState(dir, folders, pages, settings);
  await enqueueWrite(async () => {
    await writeStateFile(dir, state);
    const now = Date.now();
    if (now - lastBackupAt >= BACKUP_INTERVAL_MS) {
      lastBackupAt = now;
      const name = await createBackup(dir, state);
      log('Created backup:', name);
    }
  });
  return state;
}

function safeAttachmentName(name) {
  const base = path.basename(String(name || ''));
  if (!base || base !== name || base.startsWith('.') || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(base)) {
    throw httpError(404, 'Not found.');
  }
  return base;
}

async function resolveWorkspaceAttachment(name) {
  const safe = safeAttachmentName(name);
  if (!openPath) throw httpError(400, 'No workspace is open.');
  const dir = path.join(openPath, 'attachments');
  const filePath = path.join(dir, safe);
  const [rootReal, dirReal, fileReal] = await Promise.all([
    fsp.realpath(openPath),
    fsp.realpath(dir),
    fsp.realpath(filePath),
  ]);
  if (!isInside(rootReal, dirReal) || !isInside(rootReal, fileReal)) {
    throw httpError(403, 'Forbidden.');
  }
  return fileReal;
}

function pickDirectory(title = 'Select Workspace Folder') {
  return new Promise((resolve) => {
    if (process.platform === 'linux') {
      const zenity = spawnSync('zenity', ['--version'], { stdio: 'ignore' });
      const kdialog = spawnSync('kdialog', ['--version'], { stdio: 'ignore' });
      const tool = zenity.status === 0
        ? { cmd: 'zenity', args: ['--file-selection', '--directory', '--title', title] }
        : kdialog.status === 0
          ? { cmd: 'kdialog', args: ['--getexistingdirectory', '--title', title] }
          : null;
      if (!tool) {
        resolve(promptFallback(title));
        return;
      }
      const child = spawn(tool.cmd, tool.args, { stdio: ['ignore', 'pipe', 'inherit'] });
      let out = '';
      child.stdout.on('data', (d) => { out += d; });
      child.on('error', () => resolve(promptFallback(title)));
      child.on('close', (code) => {
        const value = out.trim();
        resolve(code === 0 && value ? value : null);
      });
    } else if (process.platform === 'darwin') {
      const script = `POSIX path of (choose folder with prompt "${title}")`;
      const child = spawn('osascript', ['-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
      let out = '';
      child.stdout.on('data', (d) => { out += d; });
      child.on('error', () => resolve(promptFallback(title)));
      child.on('close', (code) => resolve(code === 0 && out.trim() ? out.trim() : null));
    } else {
      // Windows: three bugs stacked here.
      // (1) Focus-stealing: Windows blocks background processes from
      //     forcing themselves to the foreground.
      // (2) Positioning: an off-screen owner made the dialog get clamped to
      //     a random corner of the desktop, disconnected from the browser.
      //     (Fixed previously by sizing the invisible owner to the active
      //     window's rectangle.)
      // (3) THE REMAINING BUG: forcing the *owner* window to the foreground
      //     is not the same as forcing the actual "Browse For Folder"
      //     dialog itself. The owner is invisible (Opacity 0) — only the
      //     dialog window is real GUI. Bringing the owner forward doesn't
      //     reliably drag the separate dialog window's z-order above the
      //     browser, which is exactly the screenshot: the dialog sits
      //     *behind* the browser, with only the sliver outside the browser's
      //     bounds visible. Fix: find the actual dialog window (it's the
      //     only visible top-level window owned by our owner handle) and
      //     force *that* window itself to the very top, retried for a
      //     couple of seconds since the dialog takes a moment to appear
      //     after ShowDialog() is called.
      const safeTitle = String(title).replace(/[`"$]/g, '');
      const ps = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
public class ForegroundHelper {
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hWnd, uint uCmd);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    const uint GW_OWNER = 4;
    static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
    const uint SWP_NOMOVE = 0x0002, SWP_NOSIZE = 0x0001, SWP_SHOWWINDOW = 0x0040;
    public static RECT GetActiveWindowRect() {
        RECT r;
        GetWindowRect(GetForegroundWindow(), out r);
        return r;
    }
    // The real "Browse For Folder" dialog is the only visible top-level
    // window owned by our invisible owner form.
    public static IntPtr FindDialogWindow(IntPtr owner) {
        IntPtr found = IntPtr.Zero;
        EnumWindows(delegate(IntPtr hWnd, IntPtr lParam) {
            if (GetWindow(hWnd, GW_OWNER) == owner && IsWindowVisible(hWnd)) {
                found = hWnd;
                return false;
            }
            return true;
        }, IntPtr.Zero);
        return found;
    }
    public static void Force(IntPtr hwnd) {
        if (hwnd == IntPtr.Zero) return;
        IntPtr fg = GetForegroundWindow();
        uint fgThread;
        GetWindowThreadProcessId(fg, out fgThread);
        uint curThread = GetCurrentThreadId();
        AttachThreadInput(curThread, fgThread, true);
        ShowWindow(hwnd, 9);
        SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
        BringWindowToTop(hwnd);
        SetForegroundWindow(hwnd);
        AttachThreadInput(curThread, fgThread, false);
    }
}
"@

# Capture where the user is actually working (the browser window) BEFORE
# creating our own window, since showing our window changes the foreground.
$fgRect = [ForegroundHelper]::GetActiveWindowRect()
$ax = $fgRect.Left
$ay = $fgRect.Top
$aw = $fgRect.Right - $fgRect.Left
$ah = $fgRect.Bottom - $fgRect.Top
if ($aw -lt 200 -or $ah -lt 200) {
    # Something went wrong reading the active window - fall back to the
    # primary screen bounds so the dialog still centers on-screen.
    $screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $ax = $screen.X
    $ay = $screen.Y
    $aw = $screen.Width
    $ah = $screen.Height
}

$owner = New-Object System.Windows.Forms.Form
$owner.FormBorderStyle = 'None'
$owner.StartPosition = 'Manual'
$owner.Location = New-Object System.Drawing.Point($ax, $ay)
$owner.Size = New-Object System.Drawing.Size($aw, $ah)
$owner.Opacity = 0
$owner.ShowInTaskbar = $false
$owner.TopMost = $true
$owner.Show()
[ForegroundHelper]::Force($owner.Handle)
$owner.Activate()

$f = New-Object System.Windows.Forms.FolderBrowserDialog
$f.Description = "${safeTitle}"
$f.ShowNewFolderButton = $true

# Repeatedly find the real dialog window (once Windows has created it) and
# force *it* — not just the invisible owner — to the very top. Keep retrying
# for a few seconds in case it takes a moment to appear, and stop once the
# dialog closes.
$script:dlgFound = $false
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 120
$script:attempts = 0
$timer.add_Tick({
    $script:attempts++
    $dlgHwnd = [ForegroundHelper]::FindDialogWindow($owner.Handle)
    if ($dlgHwnd -ne [IntPtr]::Zero) {
        [ForegroundHelper]::Force($dlgHwnd)
        $script:dlgFound = $true
    } elseif (-not $script:dlgFound) {
        [ForegroundHelper]::Force($owner.Handle)
    }
    if ($script:attempts -gt 25) { $timer.Stop() }
})
$timer.Start()

$result = $f.ShowDialog($owner)
$timer.Stop()
$owner.Close()
if ($result -eq [System.Windows.Forms.DialogResult]::OK) { $f.SelectedPath }
`;
      const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], {
        stdio: ['ignore', 'pipe', 'inherit'],
      });
      let out = '';
      child.stdout.on('data', (d) => { out += d; });
      child.on('error', () => resolve(promptFallback(title)));
      child.on('close', (code) => {
        const value = out.trim();
        resolve(code === 0 && value ? value : null);
      });
    }
  });
}

function promptFallback(title) {
  log(`No native folder dialog is available on this system (install zenity or kdialog for a GUI picker).`);
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`[${title}] Enter an absolute folder path (or press Enter to cancel): `, (answer) => {
      rl.close();
      resolve(answer.trim() || null);
    });
  });
}

// Folder choosers are serialized: if two people ask at once, the owner sees
// ONE clearly-labelled dialog at a time, in request order.
let pickQueue = Promise.resolve(null);

function queuedPickDirectory(title) {
  const run = pickQueue.then(() => pickDirectory(title), () => pickDirectory(title));
  pickQueue = run.then(
    () => null,
    () => null,
  );
  return run;
}

async function openWorkspace(folderPath, { setLast = true } = {}) {
  const isNew = await ensureWorkspaceStructure(folderPath);
  // loadStateFile() resets the module-level `stateRevision` counter from the
  // file it reads. For a brand-new workspace there is no file to read it
  // from, so it must be reset explicitly here — otherwise a fresh workspace's
  // first save would inherit whatever revision number the previously open
  // workspace had reached, instead of starting at 1.
  const state = isNew ? emptyState() : await loadStateFile(folderPath);
  if (isNew) {
    stateRevision = 0;
    await enqueueWrite(() => writeStateFile(folderPath, state));
  }
  openPath = folderPath;
  // Sweep stale *.tmp files (interrupted state/attachment writes) whenever a
  // workspace changes, so temporary uploads never accumulate on a small disk.
  cleanupTmpFiles(folderPath).catch(() => {});
  if (setLast) {
    const config = await readConfig();
    await writeConfig({ ...config, lastFolderPath: folderPath });
  }
  return { path: folderPath, isNew, state };
}

function bodyToFile(req, dest, maxBytes, ip) {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      ws.destroy();
      fs.unlink(dest, () => {});
      reject(err);
    };
    const ws = fs.createWriteStream(dest, { flags: 'wx', mode: 0o600 });
    ws.on('error', fail);
    req.on('error', fail);
    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        fail(httpError(413, 'File too large.'));
        req.destroy();
        return;
      }
      if (!rateLimit(ip, 'upbytes', MAX_UPLOAD_BYTES_PER_MIN, 60 * 1000, chunk.length)) {
        fail(httpError(429, 'Too many requests.'));
        req.destroy();
        return;
      }
      ws.write(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      ws.end(() => resolve(bytes));
    });
  });
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        reject(httpError(413, 'Request too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function attachmentMime(name) {
  return MIME_TYPES[path.extname(name).toLowerCase()] || 'application/octet-stream';
}

async function saveAttachment(name, req, ip) {
  const safe = safeAttachmentName(name);
  if (!openPath) throw httpError(400, 'No workspace is open.');
  const dir = path.join(openPath, 'attachments');
  const filePath = path.join(dir, safe);
  const tmpFile = filePath + TMP_SUFFIX;
  const [rootReal, dirReal] = await Promise.all([
    fsp.realpath(openPath),
    fsp.realpath(dir),
  ]);
  if (!isInside(rootReal, dirReal)) {
    throw httpError(403, 'Forbidden.');
  }
  try {
    const st = await fsp.lstat(filePath);
    if (st.isSymbolicLink()) throw httpError(403, 'Forbidden.');
  } catch (err) {
    if (err.status) throw err;
    if (err.code !== 'ENOENT') throw err;
  }
  await fsp.unlink(tmpFile).catch(() => {});
  const bytes = await bodyToFile(req, tmpFile, MAX_ATTACHMENT_BYTES, ip);
  await fsp.rename(tmpFile, filePath);
  return bytes;
}

// Types the browser may safely render inline (images first, plus plain text and
// data documents). Everything else is forced to download as an attachment so no
// uploaded file is ever interpreted/executed by the browser.
const INLINE_ATTACHMENT_TYPES = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml',
  'image/avif', 'image/bmp', 'image/x-icon',
  'application/pdf', 'text/plain', 'text/markdown', 'text/csv',
  'application/json', 'application/xml', 'text/yaml', 'text/x-sql',
]);

async function streamAttachment(res, name, mime) {
  const real = await resolveWorkspaceAttachment(name);
  const stat = await fsp.stat(real);
  const headers = {
    'Content-Type': mime,
    'Content-Length': stat.size,
    'Cache-Control': 'private, max-age=31536000, immutable',
    'Content-Security-Policy': ATTACHMENT_CSP,
  };
  if (!INLINE_ATTACHMENT_TYPES.has(mime)) {
    headers['Content-Disposition'] = `attachment; filename="${name.replace(/["\r\n]/g, '')}"`;
  }
  res.writeHead(200, headers);
  const rs = fs.createReadStream(real);
  rs.on('error', () => res.destroy());
  rs.pipe(res);
}

function serveStatic(res, url, isHead) {
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    fail(res, 400, 'Bad path.');
    return;
  }
  if (pathname === '/') pathname = '/index.html';
  if (pathname.includes('..')) {
    fail(res, 403, 'Forbidden.');
    return;
  }
  const filePath = path.join(DIST_DIR, pathname);
  if (filePath !== DIST_DIR && !filePath.startsWith(DIST_DIR + path.sep)) {
    fail(res, 403, 'Forbidden.');
    return;
  }
  fs.stat(filePath, (err, stat) => {
    if (!err && stat.isFile()) {
      const mime = STATIC_MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
      const cache = pathname.startsWith('/assets/')
        ? 'public, max-age=31536000, immutable'
        : 'no-cache';
      res.writeHead(200, {
        'Content-Type': mime,
        'Content-Length': stat.size,
        'Cache-Control': cache,
        'Content-Security-Policy': APP_CSP,
      });
      if (isHead) {
        res.end();
        return;
      }
      fs.createReadStream(filePath).pipe(res);
      return;
    }
    if (!err) {
      fail(res, 404, 'Not found.');
      return;
    }
    if (pathname.startsWith('/assets/')) {
      fail(res, 404, 'Not found.');
      return;
    }
    const indexFile = path.join(DIST_DIR, 'index.html');
    fs.stat(indexFile, (idxErr, idxStat) => {
      if (idxErr) {
        fail(res, 404, 'Not found. Run `npm run build` first.');
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': idxStat.size,
        'Cache-Control': 'no-cache',
        'Content-Security-Policy': APP_CSP,
      });
      if (isHead) {
        res.end();
        return;
      }
      fs.createReadStream(indexFile).pipe(res);
    });
  });
}

function proxyToVite(req, res) {
  let url;
  try {
    url = new URL(req.url, `http://${HOST}:${PORT}`);
  } catch {
    fail(res, 400, 'Bad request.');
    return;
  }
  const headers = { ...req.headers, host: `${VITE_HOST}:${VITE_PORT}` };
  const proxyReq = http.request(
    {
      host: VITE_HOST,
      port: VITE_PORT,
      path: url.pathname + url.search,
      method: req.method,
      headers,
    },
    (proxyRes) => {
      proxyRes.headers['content-security-policy'] = APP_CSP;
      res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
      proxyRes.pipe(res);
    },
  );
  proxyReq.on('error', () => {
    fail(res, 502, 'Vite dev server is not reachable. Run `npm run dev`.');
  });
  req.pipe(proxyReq);
}

async function handleRequest(req, res) {
  applyBaseHeaders(res);
  if (!hostAllowed(req)) {
    fail(res, 403, 'Forbidden.');
    return;
  }
  let url;
  try {
    url = new URL(req.url, `http://${HOST}:${PORT}`);
  } catch {
    fail(res, 400, 'Bad request.');
    return;
  }
  const { pathname } = url;
  const method = (req.method || 'GET').toUpperCase();

  if (method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const isApi = pathname === '/api' || pathname.startsWith('/api/');
  if (isApi) {
    const ip = clientIp(req);
    if (!rateLimit(ip, 'req', MAX_REQUESTS_PER_MIN, 60 * 1000)) {
      fail(res, 429, 'Too many requests.');
      return;
    }
    const hasSession = sessionValid(req);
    const tokenOk = isLoopback(ip) || validServerTokenValue(getTokenFromRequest(req, url));
    if (pathname === '/api/health') {
      if (!hasSession) issueSession(res);
      if (!tokenOk) {
        fail(res, 401, 'Server token required.', { tokenRequired: true });
        return;
      }
    } else {
      if (!hasSession) {
        fail(res, 401, 'Unauthorized.');
        return;
      }
      if (!tokenOk) {
        fail(res, 401, 'Server token required.', { tokenRequired: true });
        return;
      }
    }
  }

  try {
    if (method === 'GET' && pathname === '/api/health') {
      ok(res, { version: 1, port: PORT, mode: DEV_MODE ? 'dev' : 'prod' });
      return;
    }

    if (method === 'GET' && pathname === '/api/workspace/status') {
      const config = await readConfig();
      ok(res, {
        lastPath: config.lastFolderPath ?? null,
        openPath,
        viaTunnel: viaTunnel(req),
        isLocal: isLocalClient(req),
      });
      return;
    }

    if (method === 'GET' && pathname === '/api/workspace/limits') {
      ok(res, attachLimits);
      return;
    }

    if (method === 'POST' && pathname === '/api/workspace/open') {
      const picked = process.env.PW_WORKSPACE_PATH || await queuedPickDirectory('Select Workspace Folder');
      if (!picked) {
        ok(res, { cancelled: true });
        return;
      }
      const result = await openWorkspace(picked);
      log('Opened workspace:', result.path, result.isNew ? '(new)' : '(existing)');
      ok(res, result);
      return;
    }

    if (method === 'POST' && pathname === '/api/workspace/reopen') {
      // Global visitors never get silent access to the last folder — the
      // owner must explicitly pick it (the chooser pops up on their PC).
      // Enforced here, not just in the UI.
      if (viaTunnel(req)) {
        fail(res, 403, 'Reopening the last workspace is disabled over global access. Ask the owner to choose a folder.');
        return;
      }
      const config = await readConfig();
      if (!config.lastFolderPath) {
        fail(res, 400, 'No previously used workspace folder.');
        return;
      }
      const result = await openWorkspace(config.lastFolderPath, { setLast: false });
      log('Reopened workspace:', result.path);
      ok(res, result);
      return;
    }

    // ---- local-mode only: browse the filesystem / open or create workspaces ----
    // The picker itself now lives IN the app (see /api/local/browse below) —
    // the browser and this server are the same machine for every caller that
    // reaches this endpoint (requireLocal), so the picker can be a normal
    // in-page modal instead of a server-spawned OS dialog. That sidesteps the
    // whole class of z-order/focus bugs a spawned dialog has, since nothing
    // outside the browser window is ever created.
    if (method === 'POST' && pathname === '/api/local/open') {
      if (!requireLocal(req, res)) return;
      let bodyPath = null;
      try {
        const raw = await readBody(req, 8 * 1024);
        if (raw.length) {
          const payload = JSON.parse(raw.toString('utf8'));
          if (payload && typeof payload.path === 'string' && payload.path.trim()) bodyPath = payload.path.trim();
        }
      } catch {
        fail(res, 400, 'Invalid request.');
        return;
      }
      let picked = process.env.PW_WORKSPACE_PATH || bodyPath;
      if (picked) {
        let st;
        try {
          st = await fsp.stat(picked);
        } catch {
          fail(res, 400, 'That folder is not accessible.');
          return;
        }
        if (!st.isDirectory()) {
          fail(res, 400, 'That path is not a folder.');
          return;
        }
      } else {
        // No path supplied (older client, or the in-page picker was skipped)
        // — fall back to the legacy native dialog rather than failing.
        picked = await queuedPickDirectory('Select Folder to Open as Workspace');
      }
      if (!picked) {
        ok(res, { cancelled: true });
        return;
      }
      const result = await openWorkspace(picked);
      log('Local open:', result.path, result.isNew ? '(new)' : '(existing)');
      ok(res, result);
      return;
    }

    // In-page folder browser used by the "Open Folder…" / "New Workspace…"
    // picker modal. Lists real subfolders of `dir` (default: the user's home
    // folder), plus drive roots on Windows so the whole filesystem is
    // reachable. Local-only, same as the other /api/local/* endpoints —
    // never exposed over the tunnel.
    if (method === 'GET' && pathname === '/api/local/browse') {
      if (!requireLocal(req, res)) return;
      const rawDir = url.searchParams.get('dir') || '';
      let dir = rawDir ? safeDecode(rawDir) : os.homedir();
      if (dir === null) {
        fail(res, 400, 'Bad path.');
        return;
      }
      let dirReal;
      try {
        dirReal = await fsp.realpath(dir);
      } catch {
        fail(res, 404, 'Folder not found.');
        return;
      }
      let st;
      try {
        st = await fsp.stat(dirReal);
      } catch {
        fail(res, 404, 'Folder not found.');
        return;
      }
      if (!st.isDirectory()) {
        fail(res, 400, 'Not a folder.');
        return;
      }
      let dirents;
      try {
        dirents = await fsp.readdir(dirReal, { withFileTypes: true });
      } catch {
        fail(res, 403, 'Folder could not be read.');
        return;
      }
      const entries = [];
      for (const d of dirents) {
        if (!d.isDirectory() && !d.isSymbolicLink()) continue;
        if (d.name.startsWith('.')) continue;
        const full = path.join(dirReal, d.name);
        if (d.isSymbolicLink()) {
          try {
            const target = await fsp.stat(full);
            if (!target.isDirectory()) continue;
          } catch {
            continue;
          }
        }
        entries.push({ name: d.name, path: full });
        if (entries.length >= 5000) break;
      }
      entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
      const parent = path.dirname(dirReal);
      const up = parent !== dirReal ? parent : null;
      let drives = null;
      if (process.platform === 'win32') {
        const letters = 'CDEFGHIJKLMNOPQRSTUVWXYZAB'.split('');
        const checks = await Promise.all(letters.map(async (letter) => {
          const root = `${letter}:\\`;
          try {
            await fsp.access(root);
            return root;
          } catch {
            return null;
          }
        }));
        drives = checks.filter(Boolean);
      }
      ok(res, { path: dirReal, up, drives, home: os.homedir(), entries });
      return;
    }

    if (method === 'POST' && pathname === '/api/local/create') {
      if (!requireLocal(req, res)) return;
      const raw = await readBody(req, 64 * 1024);
      let payload;
      try {
        payload = JSON.parse(raw.toString('utf8'));
      } catch {
        fail(res, 400, 'Invalid request.');
        return;
      }
      const parentPath = payload && typeof payload.parentPath === 'string' ? payload.parentPath : '';
      const name = payload && typeof payload.name === 'string' ? payload.name.trim() : '';
      if (
        !name.length || name.length > 120 || name === '.' || name === '..'
        || name.startsWith('.') || /[/\\\0]/.test(name)
      ) {
        fail(res, 400, 'Invalid workspace name.');
        return;
      }
      let st;
      try {
        st = await fsp.stat(parentPath);
      } catch {
        fail(res, 400, 'Parent folder is not accessible.');
        return;
      }
      if (!st.isDirectory()) {
        fail(res, 400, 'Parent path is not a folder.');
        return;
      }
      const dir = path.join(parentPath, name);
      try {
        await fsp.access(dir);
        fail(res, 409, 'That folder already exists.');
        return;
      } catch {}
      const result = await openWorkspace(dir);
      log('Local new workspace:', dir);
      ok(res, result);
      return;
    }

    if (method === 'GET' && pathname === '/api/local/list') {
      if (!requireLocal(req, res)) return;
      if (!openPath) {
        fail(res, 400, 'No workspace is open.');
        return;
      }
      const rawDir = url.searchParams.get('dir') || '';
      let dir;
      if (!rawDir) {
        dir = openPath;
      } else {
        const decoded = safeDecode(rawDir);
        if (decoded === null) {
          fail(res, 400, 'Bad path.');
          return;
        }
        dir = decoded;
      }
      const rootReal = await fsp.realpath(openPath);
      let dirReal;
      try {
        dirReal = await fsp.realpath(dir);
      } catch {
        fail(res, 404, 'Folder not found.');
        return;
      }
      if (!isInside(rootReal, dirReal)) {
        fail(res, 403, 'Outside the workspace.');
        return;
      }
      const st = await fsp.stat(dirReal);
      if (!st.isDirectory()) {
        fail(res, 400, 'Not a folder.');
        return;
      }
      let dirents;
      try {
        dirents = await fsp.readdir(dirReal, { withFileTypes: true });
      } catch {
        fail(res, 403, 'Folder could not be read.');
        return;
      }
      const entries = [];
      for (const d of dirents) {
        if (d.isSymbolicLink()) continue;
        if (d.name.startsWith('.')) continue;
        const full = path.join(dirReal, d.name);
        if (d.isDirectory()) {
          entries.push({ name: d.name, path: full, isDir: true, size: 0, mtime: 0 });
        } else if (d.isFile()) {
          try {
            const fs = await fsp.stat(full);
            entries.push({ name: d.name, path: full, isDir: false, size: fs.size, mtime: fs.mtimeMs });
          } catch {
            // skip entries that cannot be inspected
          }
        }
        if (entries.length >= 5000) break;
      }
      entries.sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
      });
      const up = path.dirname(dirReal);
      const upValid = isInside(rootReal, path.resolve(up))
        ? up
        : null;
      ok(res, { path: dirReal, root: openPath, up: dirReal === rootReal ? null : upValid, entries });
      return;
    }

    if (method === 'GET' && pathname === '/api/local/read') {
      if (!requireLocal(req, res)) return;
      if (!openPath) {
        fail(res, 400, 'No workspace is open.');
        return;
      }
      const rawPath = url.searchParams.get('path') || '';
      const decoded = safeDecode(rawPath);
      if (decoded === null) {
        fail(res, 400, 'Bad path.');
        return;
      }
      const real = await resolveInsideWorkspace(decoded);
      const st = await fsp.stat(real);
      if (!st.isFile()) {
        fail(res, 400, 'Not a file.');
        return;
      }
      const base = path.basename(real);
      if (st.size > MAX_FILE_BYTES) {
        ok(res, { name: base, size: st.size, binary: true, tooLarge: true });
        return;
      }
      const buf = await fsp.readFile(real);
      if (buf.includes(0)) {
        ok(res, { name: base, size: buf.length, binary: true });
        return;
      }
      ok(res, {
        name: base,
        size: buf.length,
        binary: false,
        mime: attachmentMime(base),
        content: buf.toString('utf8'),
      });
      return;
    }

    if (method === 'GET' && pathname === '/api/local/file') {
      if (!requireLocal(req, res)) return;
      if (!openPath) {
        fail(res, 400, 'No workspace is open.');
        return;
      }
      const rawPath = url.searchParams.get('path') || '';
      const decoded = safeDecode(rawPath);
      if (decoded === null) {
        fail(res, 400, 'Bad path.');
        return;
      }
      const real = await resolveInsideWorkspace(decoded);
      const st = await fsp.stat(real);
      if (!st.isFile()) {
        fail(res, 400, 'Not a file.');
        return;
      }
      const base = path.basename(real);
      const mime = attachmentMime(base);
      res.writeHead(200, {
        'Content-Type': mime,
        'Content-Length': st.size,
        'Content-Disposition': `attachment; filename="${base.replace(/["\r\n]/g, '')}"`,
        'Content-Security-Policy': ATTACHMENT_CSP,
      });
      const rs = fs.createReadStream(real);
      rs.on('error', () => res.destroy());
      rs.pipe(res);
      return;
    }

    if (method === 'POST' && pathname === '/api/workspace/close') {
      if (!isLoopback(clientIp(req))) {
        fail(res, 403, 'Only the owner can close the workspace.');
        return;
      }
      openPath = null;
      ok(res, {});
      return;
    }

    if (method === 'GET' && pathname === '/api/workspace/state') {
      if (!openPath) {
        fail(res, 400, 'No workspace is open.');
        return;
      }
      const state = await loadStateFile(openPath);
      ok(res, { path: openPath, state });
      return;
    }

    if (method === 'POST' && pathname === '/api/workspace/save') {
      const raw = await readBody(req, MAX_STATE_BYTES);
      let payload;
      try {
        payload = JSON.parse(raw.toString('utf8'));
      } catch {
        fail(res, 400, 'Invalid workspace data.');
        return;
      }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        fail(res, 400, 'Invalid workspace data.');
        return;
      }
      const { folders, pages, settings } = payload;
      if (
        !Array.isArray(folders) || !Array.isArray(pages) || !Array.isArray(settings)
        || folders.length > 100000 || pages.length > 100000 || settings.length > 10000
      ) {
        fail(res, 400, 'Invalid workspace data.');
        return;
      }
      const state = await saveWorkspace(folders, pages, settings);
      ok(res, { revision: state.revision, updatedAt: state.updatedAt });
      return;
    }

    if (method === 'POST' && pathname === '/api/attachments') {
      if (activeUploads >= MAX_CONCURRENT_UPLOADS) {
        fail(res, 429, 'Too many concurrent uploads.');
        return;
      }
      activeUploads++;
      try {
        const ext = (url.searchParams.get('ext') || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '');
        // This endpoint keeps its existing single-image role; binary documents
        // and archives go through the batch endpoint below.
        if (!IMAGE_EXTENSIONS.has(ext || 'bin')) {
          fail(res, 415, 'Unsupported file type.');
          return;
        }
        const name = `${crypto.randomBytes(10).toString('hex')}.${ext || 'bin'}`;
        const bytes = await saveAttachment(name, req, clientIp(req));
        log('Stored attachment:', name, bytes, 'bytes');
        ok(res, { name });
      } finally {
        activeUploads--;
      }
      return;
    }

    if (method === 'POST' && pathname === '/api/attachments/upload') {
      if (activeUploads >= MAX_CONCURRENT_UPLOADS) {
        fail(res, 429, 'Too many concurrent uploads.');
        return;
      }
      activeUploads++;
      try {
        const contentType = req.headers['content-type'] || '';
        const boundaryMatch = /boundary\s*=\s*(?:"([^"]+)"|([^;]+))/i.exec(contentType);
        if (!boundaryMatch) {
          fail(res, 400, 'Invalid upload.');
          return;
        }
        const boundary = boundaryMatch[1] || boundaryMatch[2];
        const raw = await readBody(req, MAX_TOTAL_BYTES_PER_REQUEST + 2 * 1024 * 1024);
        if (!rateLimit(clientIp(req), 'upbytes', MAX_UPLOAD_BYTES_PER_MIN, 60 * 1000, raw.length)) {
          fail(res, 429, 'Too many requests.');
          return;
        }
        const parts = parseMultipart(raw, boundary);
        const files = parts.filter((p) => p.filename && p.name === 'files');
        if (!files.length) {
          fail(res, 400, 'No files were sent.');
          return;
        }
        if (files.length > MAX_ATTACHMENTS_PER_REQUEST) {
          fail(res, 413, `Too many files (max ${MAX_ATTACHMENTS_PER_REQUEST} per request).`);
          return;
        }
        const totalBytes = files.reduce((sum, p) => sum + p.data.length, 0);
        if (totalBytes > MAX_TOTAL_BYTES_PER_REQUEST) {
          fail(res, 413, 'Combined size exceeds the per-request limit.');
          return;
        }
        const saved = [];
        for (const part of files) {
          const ext = extOf(part.filename);
          if (!ATTACH_ALLOWED_EXTENSIONS.has(ext)) {
            fail(res, 415, `Unsupported file type (${ext ? `.${ext}` : 'file'}).`);
            return;
          }
          const perFileCap = ext === 'zip' ? MAX_ZIP_BYTES : MAX_FILE_BYTES;
          if (part.data.length > perFileCap) {
            fail(res, 413, `File too large (max for ${ext ? `.${ext}` : 'files'} is ${formatBytes(perFileCap)}).`);
            return;
          }
          if (ext === 'zip') await validateZipBuffer(part.data);
          const name = `${crypto.randomBytes(10).toString('hex')}.${ext}`;
          await saveAttachmentBuffer(name, part.data);
          saved.push({ name, title: safeUploadTitle(part.filename), ext, size: part.data.length });
        }
        ok(res, { files: saved });
      } finally {
        activeUploads--;
      }
      return;
    }

    if (method === 'PUT' && pathname.startsWith('/api/attachments/')) {
      const name = safeDecode(pathname.slice('/api/attachments/'.length));
      if (name === null) {
        fail(res, 400, 'Bad path.');
        return;
      }
      const ext = extOf(name);
      if (!IMAGE_EXTENSIONS.has(ext) && !ATTACH_ALLOWED_EXTENSIONS.has(ext)) {
        fail(res, 415, 'Unsupported file type.');
        return;
      }
      if (activeUploads >= MAX_CONCURRENT_UPLOADS) {
        fail(res, 429, 'Too many concurrent uploads.');
        return;
      }
      activeUploads++;
      try {
        const bytes = await saveAttachment(name, req, clientIp(req));
        log('Restored attachment:', name, bytes, 'bytes');
        ok(res, { name });
      } finally {
        activeUploads--;
      }
      return;
    }

    if (method === 'GET' && pathname === '/api/attachments/list') {
      if (!openPath) {
        fail(res, 400, 'No workspace is open.');
        return;
      }
      const dir = path.join(openPath, 'attachments');
      const [rootReal, dirReal] = await Promise.all([
        fsp.realpath(openPath),
        fsp.realpath(dir),
      ]);
      if (!isInside(rootReal, dirReal)) {
        fail(res, 403, 'Forbidden.');
        return;
      }
      const names = await fsp.readdir(dirReal);
      ok(res, { names });
      return;
    }

    if (method === 'GET' && pathname === '/api/attachments/data') {
      const rawName = url.searchParams.get('name') || '';
      const name = safeDecode(rawName);
      if (name === null) {
        fail(res, 400, 'Bad path.');
        return;
      }
      const safe = safeAttachmentName(name);
      const real = await resolveWorkspaceAttachment(safe);
      const stat = await fsp.stat(real);
      if (stat.size > MAX_ATTACHMENT_BYTES) {
        fail(res, 413, 'File too large.');
        return;
      }
      const mime = attachmentMime(safe);
      const buf = await fsp.readFile(real);
      ok(res, { dataUrl: `data:${mime};base64,${buf.toString('base64')}`, name: safe });
      return;
    }

    if (method === 'GET' && pathname.startsWith('/api/attachments/')) {
      const name = safeDecode(pathname.slice('/api/attachments/'.length));
      if (name === null) {
        fail(res, 400, 'Bad path.');
        return;
      }
      const safe = safeAttachmentName(name);
      const mime = attachmentMime(safe);
      await streamAttachment(res, safe, mime);
      return;
    }

    if (isApi) {
      fail(res, 404, 'Not found.');
      return;
    }

    if (DEV_MODE) {
      proxyToVite(req, res);
      return;
    }

    if (method !== 'GET' && method !== 'HEAD') {
      fail(res, 405, 'Method not allowed.');
      return;
    }
    serveStatic(res, url, method === 'HEAD');
  } catch (err) {
    log('Error:', err.message);
    if (err.status) {
      fail(res, err.status, err.message);
      return;
    }
    if (err.code === 'ENOENT' || err.code === 'EACCES') {
      fail(res, 404, 'Not found.');
      return;
    }
    fail(res, 500, 'Server error.');
  }
}

const server = http.createServer(handleRequest);

server.on('upgrade', (req, socket, head) => {
  if (!DEV_MODE || !hostAllowed(req)) {
    socket.destroy();
    return;
  }
  const upstream = net.connect(VITE_PORT, VITE_HOST, () => {
    // Rewrite Host to the internal Vite address — same treatment the HTTP
    // proxy applies — so HMR also works through global-access tunnel hosts.
    const headers = { ...req.headers, host: `${VITE_HOST}:${VITE_PORT}` };
    const lines = [
      `${req.method} ${req.url} HTTP/${req.httpVersion}`,
      ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
      '',
      '',
    ];
    upstream.write(lines.join('\r\n'));
    if (head && head.length) upstream.write(head);
  });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
  upstream.pipe(socket);
  socket.pipe(upstream);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[workspace-server] Port ${PORT} is already in use. Close the other instance or set PORT.`);
    process.exit(1);
  }
  console.error('[workspace-server] Failed to start:', err.message);
  process.exit(1);
});

function stopTunnel() {
  if (tunnel) {
    try { tunnel.stop(); } catch {}
    tunnel = null;
  }
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    stopTunnel();
    process.exit(0);
  });
}
process.on('exit', stopTunnel);

// Periodic sweep of stale temporary files while a workspace is open.
const TMP_SWEEP_INTERVAL_MS = Math.max(60 * 1000, TMP_MAX_AGE_MS / 2);
setInterval(() => {
  if (openPath) cleanupTmpFiles(openPath).catch(() => {});
}, TMP_SWEEP_INTERVAL_MS).unref();

initServerToken().then(() => {
  server.listen(PORT, HOST, () => {
    log(`Listening on http://${HOST}:${PORT}`);
    log(`This machine:   http://localhost:${PORT}`);
    for (const iface of Object.values(os.networkInterfaces())) {
      for (const entry of iface || []) {
        if (entry.family === 'IPv4' && !entry.internal) {
          log(`Same LAN:       http://${entry.address}:${PORT}`);
        }
      }
    }
    log('Access ID for other devices (enter it as the password in the app):');
    log(serverToken);
    log('A new Access ID is generated on every server start. Loopback (this machine) access does not need it.');
    if (GLOBAL_ACCESS) {
      log('Global access: starting secure tunnel …');
      startQuickTunnel({ port: PORT, log }).then((handle) => {
        tunnel = handle;
        const host = new URL(handle.url).hostname.toLowerCase();
        allowedHosts.add(host);
        tunnelHost = host;
        handle.exited.then((code) => {
          log(`Global access tunnel stopped (code ${code ?? 'signal'}). Restart the server for a fresh URL.`);
          if (tunnel === handle) { tunnel = null; tunnelHost = null; }
        });
        log('');
        log(`Global access:  ${handle.url}`);
        log('Remote visitors need BOTH this URL and the Access ID printed above.');
      }).catch((err) => {
        log(`Global access could not be started: ${err.message}`);
        log('Local and LAN access continue to work normally.');
      });
    }
    if (DEV_MODE) {
      log(`Proxying frontend to Vite dev server at http://${VITE_HOST}:${VITE_PORT}`);
    } else {
      log(`Serving built frontend from ${DIST_DIR}`);
    }
    console.log('WORKSPACE-SERVER-READY');
  });
}).catch((err) => {
  console.error('[workspace-server] Failed to initialize:', err.message);
  process.exit(1);
});