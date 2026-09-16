import type { Folder, Page, Setting } from '../types';

// Relative API paths on purpose: the app is served from the same origin as the
// workspace server, so it works identically via http://localhost:5173 and
// http://<machine-ip>:5173 with no hard-coded host.
export const API_BASE = '';

const TOKEN_KEY = 'pw-server-token';

export function getServerToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setServerToken(token: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, token.trim());
  } catch {
    // localStorage unavailable — token will be re-requested on next boot.
  }
}

export function clearServerToken(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    // ignore
  }
}

// If the page was opened with ?token=... in the URL (the URLs the server prints
// at startup), adopt that token and strip it from the address bar so it is not
// left in browser history. Must run before the first API call.
export function applyTokenFromUrl(): void {
  if (typeof window === 'undefined') return;
  try {
    const params = new URLSearchParams(window.location.search);
    const token = params.get('token');
    if (!token) return;
    setServerToken(token);
    params.delete('token');
    const next = params.toString();
    const url = `${window.location.pathname}${next ? `?${next}` : ''}${window.location.hash}`;
    window.history.replaceState(null, '', url);
  } catch {
    // ignore
  }
}

export interface WorkspaceStateData {
  format: string;
  version: number;
  revision: number;
  updatedAt: number;
  folders: Folder[];
  pages: Page[];
  settings: Setting[];
}

export interface OpenWorkspaceResult {
  cancelled?: boolean;
  path?: string;
  isNew?: boolean;
  state?: WorkspaceStateData;
}

export interface SaveResult {
  revision: number;
  updatedAt: number;
}

export interface WorkspaceLimits {
  maxFileBytes: number;
  maxZipBytes: number;
  maxAttachmentsPerRequest: number;
  maxTotalBytesPerRequest: number;
  maxZipEntries: number;
  allowedExtensions: string[];
}

export interface WorkspaceStatus {
  lastPath: string | null;
  openPath: string | null;
  viaTunnel: boolean;
  isLocal: boolean;
}

export interface UploadedFile {
  name: string;
  title: string;
  ext: string;
  size: number;
}

export interface LocalFileEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  mtime: number;
}

export interface LocalListResult {
  path: string;
  root: string;
  up: string | null;
  entries: LocalFileEntry[];
}

export interface LocalDirEntry {
  name: string;
  path: string;
}

export interface LocalBrowseResult {
  path: string;
  up: string | null;
  drives: string[] | null;
  home: string;
  entries: LocalDirEntry[];
}

export interface LocalReadResult {
  name: string;
  size: number;
  binary: boolean;
  tooLarge?: boolean;
  mime?: string;
  content?: string;
}

let limitsCache: WorkspaceLimits | null = null;

export function resetLimitsCache(): void {
  limitsCache = null;
}

export class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export class TokenRequiredError extends ApiError {
  constructor() {
    super('Server token required.', 401);
    this.name = 'TokenRequiredError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  const token = getServerToken();
  if (token) headers.set('X-Server-Token', token);
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, { ...init, headers });
  } catch {
    throw new ApiError('Local workspace server is not reachable.', 0);
  }
  const data = await res.json().catch(() => null);
  if (data && data.tokenRequired === true) {
    throw new TokenRequiredError();
  }
  if (!res.ok || !data || data.ok === false) {
    throw new ApiError(data?.error || `Request failed (${res.status}).`, res.status);
  }
  return data as T;
}

export const api = {
  async health(): Promise<void> {
    await request('/api/health');
  },

  async workspaceStatus(): Promise<WorkspaceStatus> {
    return request('/api/workspace/status');
  },

  async fetchLimits(force = false): Promise<WorkspaceLimits> {
    if (limitsCache && !force) return limitsCache;
    const limits = await request<WorkspaceLimits>('/api/workspace/limits');
    limitsCache = limits;
    return limits;
  },

  getLimits(): Promise<WorkspaceLimits> {
    return this.fetchLimits();
  },

  async uploadAttachments(files: File[]): Promise<{ files: UploadedFile[] }> {
    const form = new FormData();
    for (const file of files) form.append('files', file, file.name);
    return request('/api/attachments/upload', { method: 'POST', body: form });
  },

  async localOpen(path: string): Promise<OpenWorkspaceResult> {
    return request('/api/local/open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    });
  },

  async localBrowse(dir?: string): Promise<LocalBrowseResult> {
    const q = dir ? `?dir=${encodeURIComponent(dir)}` : '';
    return request(`/api/local/browse${q}`);
  },

  async localCreate(parentPath: string, name: string): Promise<OpenWorkspaceResult> {
    return request('/api/local/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parentPath, name }),
    });
  },

  async localList(dir?: string): Promise<LocalListResult> {
    const q = dir ? `?dir=${encodeURIComponent(dir)}` : '';
    return request(`/api/local/list${q}`);
  },

  async localRead(filePath: string): Promise<LocalReadResult> {
    return request(`/api/local/read?path=${encodeURIComponent(filePath)}`);
  },

  localFileUrl(filePath: string): string {
    const token = getServerToken();
    const query = token ? `?token=${encodeURIComponent(token)}` : '';
    return `/api/local/file?path=${encodeURIComponent(filePath)}${query}`;
  },

  async openWorkspace(): Promise<OpenWorkspaceResult> {
    return request('/api/workspace/open', { method: 'POST' });
  },

  async reopenWorkspace(): Promise<OpenWorkspaceResult> {
    return request('/api/workspace/reopen', { method: 'POST' });
  },

  async closeWorkspace(): Promise<void> {
    await request('/api/workspace/close', { method: 'POST' });
  },

  async getWorkspaceState(): Promise<{ path: string; state: WorkspaceStateData }> {
    return request('/api/workspace/state');
  },

  async saveWorkspace(folders: Folder[], pages: Page[], settings: Setting[]): Promise<SaveResult> {
    return request('/api/workspace/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folders, pages, settings }),
    });
  },

  async uploadAttachment(blob: Blob, ext: string): Promise<{ name: string }> {
    return request(`/api/attachments?ext=${encodeURIComponent(ext)}`, {
      method: 'POST',
      body: blob,
    });
  },

  async restoreAttachment(name: string, blob: Blob): Promise<{ name: string }> {
    return request(`/api/attachments/${encodeURIComponent(name)}`, {
      method: 'PUT',
      body: blob,
    });
  },

  async listAttachments(): Promise<{ names: string[] }> {
    return request('/api/attachments/list');
  },

  async attachmentDataUrl(name: string): Promise<{ dataUrl: string }> {
    return request(`/api/attachments/data?name=${encodeURIComponent(name)}`);
  },

  attachmentUrl(name: string): string {
    const token = getServerToken();
    const query = token ? `?token=${encodeURIComponent(token)}` : '';
    return `/api/attachments/${encodeURIComponent(name)}${query}`;
  },
};

const OLD_API_PREFIX = /^(?:https?:\/\/[^/]+)?\/api\/attachments\/(.+)$/;

export function isAttachmentRef(src: string): boolean {
  return typeof src === 'string' && src.startsWith('attachments/');
}

export function toImageUrl(src: string): string {
  if (!src) return src;
  if (isAttachmentRef(src)) return `/api/attachments/${encodeURIComponent(src.slice('attachments/'.length))}`;
  return src;
}

export function canonicalizeImageSrc(src: string): string {
  if (!src) return src;
  if (isAttachmentRef(src)) return src;
  const m = src.match(OLD_API_PREFIX);
  if (m) return `attachments/${m[1]}`;
  return src;
}

export function attachmentExtFromMime(mime: string): string {
  const map: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/svg+xml': 'svg',
    'image/avif': 'avif',
    'image/bmp': 'bmp',
    'image/x-icon': 'ico',
    'application/pdf': 'pdf',
    'text/plain': 'txt',
    'text/markdown': 'md',
  };
  return map[mime] || 'bin';
}