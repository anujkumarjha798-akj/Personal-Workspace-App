import { nanoid } from 'nanoid';
import { workspace } from '../store/workspace';
import type { Folder } from '../types';

export async function createFolder(parentId: string | null, name = 'New Folder'): Promise<Folder> {
  const count = workspace.folders.filter((f) => f.parentId === parentId).length;
  const folder: Folder = {
    id: nanoid(),
    name,
    parentId,
    sortOrder: count,
    createdAt: Date.now(),
    deleted: false,
  };
  await workspace.mutate(() => {
    workspace.folders.push(folder);
  });
  return folder;
}

export function renameFolder(id: string, name: string): Promise<void> {
  return workspace.mutate(() => {
    const folder = workspace.folders.find((f) => f.id === id);
    if (folder) folder.name = name;
  });
}

export function deleteFolder(id: string): Promise<void> {
  return workspace.mutate(() => {
    const folder = workspace.folders.find((f) => f.id === id);
    if (!folder) return;
    workspace.pages = workspace.pages.map((p) => (
      p.folderId === id ? { ...p, deleted: true, updatedAt: Date.now() } : p
    ));
    workspace.folders = workspace.folders.map((f) => (
      f.parentId === id ? { ...f, parentId: folder.parentId } : f
    ));
    workspace.folders = workspace.folders.filter((f) => f.id !== id);
  });
}

export function moveFolder(id: string, parentId: string | null): Promise<void> {
  return workspace.mutate(() => {
    const folder = workspace.folders.find((f) => f.id === id);
    if (folder) folder.parentId = parentId;
  });
}