import { nanoid } from 'nanoid';
import { workspace } from '../store/workspace';
import type { Page } from '../types';

const EMPTY_DOC = JSON.stringify({ type: 'doc', content: [{ type: 'paragraph' }] });

export async function createPage(folderId: string | null, title = 'Untitled'): Promise<Page> {
  const now = Date.now();
  const count = workspace.pages.filter((p) => p.folderId === folderId).length;
  const page: Page = {
    id: nanoid(),
    title,
    content: EMPTY_DOC,
    folderId,
    createdAt: now,
    updatedAt: now,
    favorite: false,
    deleted: false,
    sortOrder: count,
  };
  await workspace.mutate(() => {
    workspace.pages.push(page);
  });
  return page;
}

export function updatePage(id: string, changes: Partial<Page>): Promise<void> {
  return workspace.mutate(() => {
    const page = workspace.pages.find((p) => p.id === id);
    if (page) Object.assign(page, changes, { updatedAt: Date.now() });
  });
}

export function softDeletePage(id: string): Promise<void> {
  return updatePage(id, { deleted: true });
}

export function restorePage(id: string): Promise<void> {
  return updatePage(id, { deleted: false });
}

export function permanentlyDeletePage(id: string): Promise<void> {
  return workspace.mutate(() => {
    workspace.pages = workspace.pages.filter((p) => p.id !== id);
  });
}

export async function duplicatePage(id: string): Promise<Page | undefined> {
  const original = workspace.pages.find((p) => p.id === id);
  if (!original) return undefined;
  const now = Date.now();
  const copy: Page = {
    ...original,
    id: nanoid(),
    title: `${original.title} (copy)`,
    createdAt: now,
    updatedAt: now,
  };
  await workspace.mutate(() => {
    workspace.pages.push(copy);
  });
  return copy;
}

export function toggleFavorite(id: string): Promise<void> {
  const page = workspace.pages.find((p) => p.id === id);
  if (!page) return Promise.resolve();
  return updatePage(id, { favorite: !page.favorite });
}

export function movePage(id: string, folderId: string | null): Promise<void> {
  return updatePage(id, { folderId });
}