import { useSyncExternalStore } from 'react';
import type { Folder, Page, Setting } from '../types';
import { api, type WorkspaceStateData } from '../services/api';

const SAVE_DEBOUNCE_MS = 250;

export interface WorkspaceOpenResult {
  cancelled?: boolean;
  path?: string;
  isNew?: boolean;
  state?: WorkspaceStateData;
}

class WorkspaceStore {
  folders: Folder[] = [];
  pages: Page[] = [];
  settings: Setting[] = [];
  path: string | null = null;
  saveError: string | null = null;
  lastSavedAt: number | null = null;

  private listeners = new Set<() => void>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;
  private flushChain: Promise<void> = Promise.resolve();

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify() {
    this.listeners.forEach((fn) => fn());
  }

  applyState(state: WorkspaceStateData, path: string) {
    this.folders = state.folders.map((f) => ({ ...f }));
    this.pages = state.pages.map((p) => ({ ...p }));
    this.settings = state.settings.map((s) => ({ ...s }));
    this.path = path;
    this.saveError = null;
    this.notify();
  }

  clearState() {
    this.folders = [];
    this.pages = [];
    this.settings = [];
    this.path = null;
    this.saveError = null;
    this.notify();
  }

  getSetting(key: string): string | null {
    return this.settings.find((s) => s.key === key)?.value ?? null;
  }

  putSetting(key: string, value: string): void {
    this.settings = this.settings.map((s) => ({ ...s }));
    const existing = this.settings.find((s) => s.key === key);
    if (existing) {
      existing.value = value;
    } else {
      this.settings.push({ key, value });
    }
    this.markDirty();
  }

  private markDirty() {
    this.dirty = true;
    this.notify();
    if (!this.saveTimer) {
      this.saveTimer = setTimeout(() => {
        this.saveTimer = null;
        this.flush().catch(() => {});
      }, SAVE_DEBOUNCE_MS);
    }
  }

  mutate(apply: () => void): Promise<void> {
    this.folders = this.folders.map((f) => ({ ...f }));
    this.pages = this.pages.map((p) => ({ ...p }));
    this.settings = this.settings.map((s) => ({ ...s }));
    apply();
    this.markDirty();
    return this.flush();
  }

  async openViaPicker(): Promise<WorkspaceOpenResult> {
    await this.flush().catch(() => {});
    const result = await api.openWorkspace();
    if (result.cancelled || !result.state) return result;
    this.applyState(result.state, result.path!);
    return result;
  }

  async reopenLast(): Promise<WorkspaceOpenResult> {
    await this.flush().catch(() => {});
    const result = await api.reopenWorkspace();
    if (result.cancelled || !result.state) return result;
    this.applyState(result.state, result.path!);
    return result;
  }

  flush(): Promise<void> {
    const run = this.flushChain.then(() => this.flushOnce());
    this.flushChain = run.catch(() => {});
    return run;
  }

  private async flushOnce(): Promise<void> {
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    while (this.dirty) {
      this.dirty = false;
      try {
        const { updatedAt } = await api.saveWorkspace(this.folders, this.pages, this.settings);
        this.lastSavedAt = updatedAt;
        this.saveError = null;
      } catch (err) {
        this.dirty = true;
        this.saveError = err instanceof Error ? err.message : 'Save failed.';
        this.notify();
        throw err;
      }
    }
  }

  clearSaveError() {
    if (!this.saveError) return;
    this.saveError = null;
    this.notify();
  }
}

export const workspace = new WorkspaceStore();

export function useWorkspace<T>(selector: (store: WorkspaceStore) => T): T {
  return useSyncExternalStore(
    (cb) => workspace.subscribe(cb),
    () => selector(workspace),
    () => selector(workspace),
  );
}

export function useWorkspacePages(): Page[] {
  return useWorkspace((s) => s.pages);
}

export function useWorkspaceFolders(): Folder[] {
  return useWorkspace((s) => s.folders);
}