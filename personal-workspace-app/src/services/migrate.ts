import { db as legacyDb } from '../db/db';
import { workspace } from '../store/workspace';
import type { Folder, Page, Setting } from '../types';

export interface LegacyCounts {
  pages: number;
  folders: number;
}

export async function hasLegacyData(): Promise<LegacyCounts> {
  try {
    const [pageCount, folderCount] = await Promise.all([
      legacyDb.pages.count(),
      legacyDb.folders.count(),
    ]);
    return { pages: pageCount, folders: folderCount };
  } catch {
    return { pages: 0, folders: 0 };
  }
}

export async function readLegacyData(): Promise<{ folders: Folder[]; pages: Page[]; settings: Setting[] }> {
  const [folders, pages, settings] = await Promise.all([
    legacyDb.folders.toArray(),
    legacyDb.pages.toArray(),
    legacyDb.settings.toArray(),
  ]);
  return { folders, pages, settings };
}

export async function importLegacyIntoWorkspace(): Promise<LegacyCounts> {
  const data = await readLegacyData();
  await workspace.mutate(() => {
    workspace.folders = data.folders.map((f) => ({ ...f }));
    workspace.pages = data.pages.map((p) => ({ ...p }));
    for (const setting of data.settings) {
      const existing = workspace.settings.find((s) => s.key === setting.key);
      if (existing) existing.value = setting.value;
      else workspace.settings.push({ key: setting.key, value: setting.value });
    }
  });
  return { pages: data.pages.length, folders: data.folders.length };
}