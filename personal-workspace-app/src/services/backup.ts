import JSZip from 'jszip';
import { workspace } from '../store/workspace';
import { api, isAttachmentRef } from './api';
import type { Folder, Page } from '../types';

export interface WorkspaceExport {
  manifest: {
    exportedAt: number;
    pageCount: number;
    folderCount: number;
    version: 1;
  };
  folders: Folder[];
  pages: Page[];
}

export interface ParsedBackup {
  folders: Folder[];
  pages: Page[];
  attachments: { name: string; blob: Blob }[];
  pageCount: number;
  folderCount: number;
}

async function buildExport(): Promise<WorkspaceExport> {
  return {
    manifest: {
      exportedAt: Date.now(),
      pageCount: workspace.pages.length,
      folderCount: workspace.folders.length,
      version: 1,
    },
    folders: workspace.folders.map((f) => ({ ...f })),
    pages: workspace.pages.map((p) => ({ ...p })),
  };
}

async function inlineAttachmentRefs(pages: Page[]): Promise<Page[]> {
  const resolved = new Map<string, string>();
  const result: Page[] = [];
  for (const page of pages) {
    if (!page.content.includes('attachments/')) {
      result.push(page);
      continue;
    }
    let json: any;
    try {
      json = JSON.parse(page.content);
    } catch {
      result.push(page);
      continue;
    }
    let changed = false;
    const walk = (node: any) => {
      if (!node) return;
      if (node.type === 'image' && typeof node.attrs?.src === 'string' && isAttachmentRef(node.attrs.src)) {
        changed = true;
      }
      // Diagram blocks carry attachment refs inside their serialized objects.
      if (node.type === 'diagram' && typeof node.attrs?.diagram === 'string' && node.attrs.diagram.includes('attachments/')) {
        changed = true;
      }
      (node.content || []).forEach(walk);
    };
    walk(json);
    if (!changed) {
      result.push(page);
      continue;
    }
    const walkResolve = async (node: any) => {
      if (!node) return;
      if (node.type === 'image' && typeof node.attrs?.src === 'string' && isAttachmentRef(node.attrs.src)) {
        const name = node.attrs.src.slice('attachments/'.length);
        if (!resolved.has(name)) {
          try {
            const { dataUrl } = await api.attachmentDataUrl(name);
            resolved.set(name, dataUrl);
          } catch {
            resolved.set(name, node.attrs.src);
          }
        }
        node.attrs.src = resolved.get(name) || node.attrs.src;
      }
      if (node.type === 'diagram' && typeof node.attrs?.diagram === 'string' && node.attrs.diagram.includes('attachments/')) {
        try {
          const d = JSON.parse(node.attrs.diagram);
          for (const obj of d.objects || []) {
            if (obj && typeof obj.src === 'string' && isAttachmentRef(obj.src)) {
              const name = obj.src.slice('attachments/'.length);
              if (!resolved.has(name)) {
                try {
                  const { dataUrl } = await api.attachmentDataUrl(name);
                  resolved.set(name, dataUrl);
                } catch {
                  resolved.set(name, obj.src);
                }
              }
              obj.src = resolved.get(name) || obj.src;
            }
          }
          node.attrs.diagram = JSON.stringify(d);
        } catch {
          // Leave the diagram untouched if it cannot be parsed.
        }
      }
      for (const child of node.content || []) {
        await walkResolve(child);
      }
    };
    await walkResolve(json);
    result.push({ ...page, content: JSON.stringify(json) });
  }
  return result;
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export async function exportAsJSON(): Promise<void> {
  const data = await buildExport();
  const pages = await inlineAttachmentRefs(data.pages);
  const blob = new Blob([JSON.stringify({ ...data, pages }, null, 2)], { type: 'application/json' });
  downloadBlob(blob, `personal-workspace-${Date.now()}.json`);
}

export async function exportAsZip(): Promise<void> {
  const data = await buildExport();
  const zip = new JSZip();
  zip.file('manifest.json', JSON.stringify(data.manifest, null, 2));
  const pagesFolder = zip.folder('pages');
  data.pages.forEach((p) => pagesFolder?.file(`${p.id}.json`, JSON.stringify(p, null, 2)));
  const foldersFolder = zip.folder('folders');
  data.folders.forEach((f) => foldersFolder?.file(`${f.id}.json`, JSON.stringify(f, null, 2)));
  try {
    const { names } = await api.listAttachments();
    const attachmentsFolder = zip.folder('attachments');
    for (const name of names) {
      const res = await fetch(api.attachmentUrl(name));
      if (res.ok) {
        const blob = await res.blob();
        attachmentsFolder?.file(name, blob);
      }
    }
  } catch {
    // Attachments unavailable — export pages/folders only.
  }
  const blob = await zip.generateAsync({ type: 'blob' });
  downloadBlob(blob, `personal-workspace-${Date.now()}.zip`);
}

export async function parseBackupFile(file: File): Promise<ParsedBackup> {
  if (file.name.endsWith('.zip')) {
    const zip = await JSZip.loadAsync(file);
    const entries = Object.values(zip.files);
    if (entries.length > 5000) throw new Error('Invalid backup file.');
    const pages: Page[] = [];
    const folders: Folder[] = [];
    const attachments: { name: string; blob: Blob }[] = [];
    const pageFiles = entries.filter((f) => f.name.startsWith('pages/') && f.name.endsWith('.json'));
    const folderFiles = entries.filter((f) => f.name.startsWith('folders/') && f.name.endsWith('.json'));
    const attachmentFiles = entries.filter((f) => f.name.startsWith('attachments/') && !f.dir);
    let totalBytes = 0;
    for (const f of pageFiles) {
      const text = await f.async('text');
      if (text.length > 10 * 1024 * 1024) throw new Error('Invalid backup file.');
      pages.push(JSON.parse(text));
    }
    for (const f of folderFiles) {
      const text = await f.async('text');
      if (text.length > 10 * 1024 * 1024) throw new Error('Invalid backup file.');
      folders.push(JSON.parse(text));
    }
    for (const f of attachmentFiles) {
      const blob = await f.async('blob');
      totalBytes += blob.size;
      if (totalBytes > 256 * 1024 * 1024) throw new Error('Invalid backup file.');
      attachments.push({ name: f.name.slice('attachments/'.length), blob });
    }
    if (!pages.length && !folders.length) throw new Error('Invalid backup file.');
    return { folders, pages, attachments, pageCount: pages.length, folderCount: folders.length };
  }
  if (file.name.endsWith('.json')) {
    const text = await file.text();
    if (text.length > 64 * 1024 * 1024) throw new Error('Invalid backup file.');
    const data = JSON.parse(text) as WorkspaceExport;
    if (!data.pages || !data.folders) throw new Error('Invalid backup file.');
    if (data.pages.length > 100000 || data.folders.length > 100000) throw new Error('Invalid backup file.');
    return {
      folders: data.folders,
      pages: data.pages,
      attachments: [],
      pageCount: data.pages.length,
      folderCount: data.folders.length,
    };
  }
  throw new Error('Invalid backup file.');
}

async function restoreAttachments(attachments: { name: string; blob: Blob }[]): Promise<void> {
  for (const attachment of attachments) {
    try {
      await api.restoreAttachment(attachment.name, attachment.blob);
    } catch {
      // Skip attachments that cannot be restored; page content still loads the rest.
    }
  }
}

export async function replaceWorkspace(backup: ParsedBackup): Promise<void> {
  await restoreAttachments(backup.attachments);
  await workspace.mutate(() => {
    workspace.folders = backup.folders.map((f) => ({ ...f }));
    workspace.pages = backup.pages.map((p) => ({ ...p }));
  });
}

export async function mergeWorkspace(backup: ParsedBackup): Promise<void> {
  await restoreAttachments(backup.attachments);
  await workspace.mutate(() => {
    const folderIds = new Set(workspace.folders.map((f) => f.id));
    for (const folder of backup.folders) {
      if (!folderIds.has(folder.id)) {
        workspace.folders.push({ ...folder });
        folderIds.add(folder.id);
      }
    }
    const pageIds = new Set(workspace.pages.map((p) => p.id));
    for (const page of backup.pages) {
      if (!pageIds.has(page.id)) {
        workspace.pages.push({ ...page });
        pageIds.add(page.id);
      }
    }
  });
}