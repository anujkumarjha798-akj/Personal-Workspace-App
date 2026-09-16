import type { Editor } from '@tiptap/react';
import { api, type UploadedFile, type WorkspaceLimits } from '../services/api';

export function extensionOf(fileName: string): string {
  const m = /\.([a-zA-Z0-9]+)$/.exec(fileName);
  return m ? m[1].toLowerCase() : '';
}

export function maxBytesForFile(fileName: string, limits: WorkspaceLimits): number {
  return extensionOf(fileName) === 'zip' ? limits.maxZipBytes : limits.maxFileBytes;
}

function capLabel(limit: number): string {
  if (limit % (1024 * 1024) === 0) return `${limit / (1024 * 1024)} MB`;
  if (limit % 1024 === 0) return `${limit / 1024} KB`;
  return `${limit} bytes`;
}

// Client-side pre-validation mirrors the server limits (fetched once), so
// obvious mistakes are refused before anything is uploaded.
export function validateAttachmentFiles(files: File[], limits: WorkspaceLimits): { accepted: File[]; errors: string[] } {
  const accepted: File[] = [];
  const errors: string[] = [];

  if (files.length > limits.maxAttachmentsPerRequest) {
    errors.push(`You can attach at most ${limits.maxAttachmentsPerRequest} files per request.`);
  }

  const checked = files.slice(0, limits.maxAttachmentsPerRequest);
  let total = 0;
  for (const file of checked) {
    const ext = extensionOf(file.name);
    if (!limits.allowedExtensions.includes(ext)) {
      errors.push(`"${file.name}" — ${ext ? `.${ext}` : 'this'} file type is not supported.`);
      continue;
    }
    const max = maxBytesForFile(file.name, limits);
    if (file.size > max) {
      errors.push(`"${file.name}" exceeds the ${capLabel(max)} per-file limit.`);
      continue;
    }
    total += file.size;
    accepted.push(file);
  }

  if (accepted.length && total > limits.maxTotalBytesPerRequest) {
    errors.push(`Combined size exceeds the ${capLabel(limits.maxTotalBytesPerRequest)} per-request limit.`);
    while (accepted.length && accepted.reduce((s, f) => s + f.size, 0) > limits.maxTotalBytesPerRequest) {
      accepted.pop();
    }
  }

  return { accepted, errors };
}

// Validates a set of files against the server-published limits and uploads the
// accepted subset. Returns the uploaded records, or null when nothing was
// uploaded (the user is shown which files were rejected / why).
export async function uploadAttachmentFiles(files: File[]): Promise<UploadedFile[] | null> {
  if (!files || !files.length) return null;

  let limits: WorkspaceLimits;
  try {
    limits = await api.getLimits();
  } catch {
    window.alert('Could not load upload limits — the attachment could not be checked.');
    return null;
  }

  const { accepted, errors } = validateAttachmentFiles(files, limits);
  if (errors.length) window.alert(errors.join('\n'));
  if (!accepted.length) return null;

  try {
    const { files: uploaded } = await api.uploadAttachments(accepted);
    return uploaded;
  } catch (err) {
    window.alert(err instanceof Error ? err.message : 'Upload failed.');
    return null;
  }
}

// Upload the given files and insert a fileAttachment block for each one.
// `pos` (a resolved drop position) inserts at that exact spot; otherwise the
// files are inserted at the current selection.
export async function insertAttachments(editor: Editor, files: File[], pos?: number): Promise<{ inserted: number }> {
  if (!editor || !files || !files.length) return { inserted: 0 };
  const uploaded = await uploadAttachmentFiles(files);
  if (!uploaded || !uploaded.length) return { inserted: 0 };

  if (pos === undefined) {
    const chain = editor.chain().focus();
    for (const file of uploaded) {
      chain.insertContent({
        type: 'fileAttachment',
        attrs: { name: file.name, title: file.title || file.name },
      });
    }
    chain.run();
  } else {
    const { schema } = editor.view.state;
    const tr = editor.view.state.tr;
    let insertPos = pos;
    for (const file of uploaded) {
      const node = schema.nodes.fileAttachment.create({ name: file.name, title: file.title || file.name });
      tr.insert(insertPos, node);
      insertPos += 1;
    }
    editor.view.dispatch(tr);
    editor.commands.focus();
  }
  return { inserted: uploaded.length };
}