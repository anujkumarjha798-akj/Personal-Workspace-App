export interface Folder {
  id: string;
  name: string;
  parentId: string | null;
  sortOrder: number;
  createdAt: number;
  deleted: boolean;
}

export interface Page {
  id: string;
  title: string;
  content: string; // serialized Tiptap JSON
  folderId: string | null;
  createdAt: number;
  updatedAt: number;
  favorite: boolean;
  deleted: boolean;
  sortOrder: number;
}

export interface Setting {
  key: string;
  value: string;
}

export type SaveStatus = 'idle' | 'editing' | 'saving' | 'saved' | 'error';

// A single heading in the document outline. `pos` is the absolute
// ProseMirror document position of the heading node itself, which gives a
// stable, unambiguous reference to that exact heading (even when several
// headings share identical text) so outline clicks can navigate precisely.
export interface OutlineHeading {
  level: number;
  text: string;
  pos: number;
}

export type ThemeMode = 'dark' | 'light' | 'system';
