import Dexie, { type Table } from 'dexie';
import type { Folder, Page, Setting } from '../types';

export class WorkspaceDB extends Dexie {
  pages!: Table<Page, string>;
  folders!: Table<Folder, string>;
  settings!: Table<Setting, string>;

  constructor() {
    super('personal-workspace-db');
    this.version(1).stores({
      pages: 'id, folderId, favorite, deleted, updatedAt, sortOrder',
      folders: 'id, parentId, deleted, sortOrder',
      settings: 'key',
    });
  }
}

export const db = new WorkspaceDB();

export async function hasExistingWorkspace(): Promise<boolean> {
  const pageCount = await db.pages.count();
  const folderCount = await db.folders.count();
  return pageCount > 0 || folderCount > 0;
}
