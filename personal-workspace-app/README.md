# Personal Workspace

A local-first, dark, developer-oriented documentation editor — inspired by the Eraser.io workflow, with no AI, no account, and no cloud. Built with React, TypeScript, Tiptap/ProseMirror, and a small local Node.js server that reads/writes the workspace folder on your machine.

## Run it

```bash
npm install
npm run dev
```

This starts two things:

1. A **workspace server** (`server/index.mjs`) that listens on `0.0.0.0:5173` and serves both the app and the `/api/*` endpoints
2. A **Vite dev server** (internal only, `127.0.0.1:4173`) that the workspace server proxies to for live development

Open the app from:

- this machine: `http://localhost:5173`
- another device on the same LAN: `http://<server-ip>:5173` (the server prints its LAN URLs on startup)

To build for production:

```bash
npm run build
npm run preview
```

`preview` serves the built app from `dist/` on the same `0.0.0.0:5173` server — no Vite involved.

## Networking

- The server always binds to `0.0.0.0` — never to `localhost` only — so it accepts connections through any of the machine's network interfaces.
- The frontend uses **relative API paths** (`/api/workspace`, `/api/workspace/save`, `/api/attachments/...`). No hard-coded host/IP exists anywhere in the client, so the same app works identically via `http://localhost:5173` and `http://192.168.x.x:5173`.
- The server prints every reachable URL (localhost + LAN IPs) at startup, so no IP has to be configured by hand.
- The server port defaults to `5173`; set `PORT=xxxx npm run dev` if that port is busy.

### Firewall / VM notes

- **Windows**: if other PCs can't reach `http://<server-ip>:5173`, allow port `5173` (TCP) through Windows Defender Firewall (or allow Node.js through it when prompted).
- **VM (VirtualBox/VMware/Hyper-V)**: use **Bridged** networking so the VM has its own LAN IP, or NAT with a port-forward for TCP `5173` → guest `5173`. The app itself does not care — it simply listens on `0.0.0.0:5173`.

## Global access (internet)

The same running instance can optionally be reached from anywhere in the world through a secure **Cloudflare Quick Tunnel** (`cloudflared`) — free, no account, automatic HTTPS. The tunnel forwards to the app's local server only; nothing else on the machine is exposed, and all data stays on the host PC.

Enable it:

```bash
npm run preview:global     # built app + global access (also: npm run start:global)
npm run dev:global         # live-reload dev mode + global access
```

or by setting `GLOBAL_ACCESS=true` in the environment for either normal command. Normal startup (`npm run dev`, `npm run preview`) is completely unchanged and never opens a tunnel.

At startup the server prints all three access modes:

```text
This machine:    http://localhost:5173
Same LAN:        http://192.168.x.x:5173
Global access:   https://random-words-1234.trycloudflare.com
```

Remote visitors open the global URL and enter the printed **Access ID** as the password (loopback/this-machine users never need it). The URL is ephemeral: it changes every time the server restarts, and access ends automatically when the app or the host PC stops.

How it works:

- On first use, the official `cloudflared` binary is downloaded automatically from Cloudflare's GitHub releases into `.cloudflared/` inside the project (gitignored). If `cloudflared` is already on your `PATH` it is used directly.
- Set `CLOUDFLARED_BIN=/path/to/cloudflared` to use a specific binary, or `PW_TUNNEL_AUTO_DOWNLOAD=0` to disable downloading entirely.

Security model when global access is on:

- Traffic is end-to-end HTTPS via Cloudflare's edge; no router port-forwarding required.
- Internet clients are authenticated per visitor: the server honors `CF-Connecting-IP`/`X-Forwarded-For` **only** from its own local tunnel process, so every internet visitor gets their own rate-limit bucket and always requires the Access ID (loopback trust cannot be reached through the tunnel).
- With global access enabled, a longer 12-character Access ID is generated on each start.
- The tunnel hostname is added to the server's Host allowlist at runtime; unknown hosts are still rejected with 403.
- All existing protections (path validation, attachment sandboxing, CSP, session cookies, upload limits) apply unchanged to remote visitors.

## How storage works

The app is **not** tied to a browser. On first launch, pick a workspace folder (a native folder dialog — no typing paths). That folder becomes the single source of truth for every browser and every device that can reach the server:

```
Selected Workspace Folder/
├── workspace.json      ← all pages, folders, content, settings, metadata, ordering
├── attachments/        ← images/files referenced from page content
└── backups/            ← workspace-backup-*.json (auto, rotated)
```

- Opening the app in Chrome, Edge, Firefox, etc. and choosing the **same folder** shows the **same data** — the server is the single storage authority; browsers never keep their own copy.
- `workspace.json` holds the full state (same structure the app previously kept in IndexedDB). Saves are atomic: the server writes `workspace.tmp`, fsyncs it, then renames it over `workspace.json`. Concurrent save requests are serialized server-side, and each save is revision-tracked.
- The server writes a timestamped `workspace-backup-*.json` into `backups/` on a throttled interval (default: every 5 minutes, keep the newest 12; tune with `PW_BACKUP_INTERVAL_MS` / `PW_MAX_BACKUPS`).
- Images added in the editor are uploaded to `attachments/` and referenced by file name; large base64 blobs no longer bloat page content.
- File attachments (documents, code, text, ZIP archives) are uploaded to `attachments/` via the **Attach file** toolbar button or by drag-and-drop (non-image files). They are stored as-is: ZIP archives are never extracted server-side, only validated (entry names are checked for path traversal, absolute paths and null bytes, and an entry-count cap is enforced).
- Local mode (browsing from the same machine) adds an **Open Folder / New Workspace / Files** browser: open any existing directory on the host as a workspace, or create a new one with a name prompt. The **Files…** dialog lets you browse the current workspace's folders, preview text files, and download any file (opened via the native host app).
- Existing data from the previous IndexedDB version is **not deleted**. If you open a new folder while old browser data exists, the app offers to import it into `workspace.json`; skipping leaves the browser data untouched.
- Legacy IndexedDB reads live in `src/db/db.ts` and are only used for that one-time import.
- The server only ever touches the currently selected workspace folder — there are no arbitrary read/write endpoints, and attachment names are strictly validated (no path traversal).

## What's implemented

- **Editor**: H1–H6, bold/italic/underline/strike/overline, inline code, code blocks, highlight, text color, font size, alignment, bullet/numbered/task lists (nested), Tab/Shift+Tab indent (works in lists and paragraphs), tables (insert/add/delete row & column/merge/split), images (paste, drag-drop, stored in the workspace `attachments/` folder), links, horizontal divider, undo/redo.
- **Find (Ctrl+F)** and **Find & Replace (Ctrl+H)** with match count, next/prev, match case, whole word, and regex options.
- **Autosave** to `workspace.json` with a debounce and a Saving…/Saved ✓/Save failed indicator. Ctrl+S forces an immediate save.
- **Pages & folders**: create, rename, duplicate, move (drag-and-drop or context menu), favorite, soft-delete to Trash, restore, permanently delete. Right-click context menus on pages and folders.
- **Search**: sidebar search matches page titles and body text; results open directly.
- **Import/export**: JSON and ZIP backups (Settings → Export Backup, or Import via Ctrl+O). ZIP exports include the `attachments/` files; JSON exports inline image references as data URIs. Imports restore into the current workspace.
- **Welcome screen** with workspace-folder picking, reopen-last-workspace, and one-time browser-data import.
- **Local mode** (loopback access only, i.e. `http://localhost:5173`): **Open Folder…** swaps the workspace to any directory picked via the native dialog, **New Workspace…** creates a new (empty) directory and opens it, and the **Files…** dialog browses the current workspace's files with text previews and downloads. These controls never appear for remote/tunnel visitors.
- **Keyboard shortcuts**: Ctrl+S, Ctrl+O, Ctrl+N, Ctrl+F, Ctrl+H, Ctrl+B/I/U, Tab/Shift+Tab, standard Ctrl+C/X/V/Z/Y (native).
- **Dark theme** (JetBrains Mono throughout) with a Light option in Settings.
- **Right panel**: word/character count, created/modified dates, document outline generated from headings.

## Local mode (Open/New/attach) & limits

**Local mode** means the browser is talking to the server over the loopback interface, not through the Cloudflare tunnel. Decisions:

- A request is local when its IP is a loopback address **and** it did not come via the tunnel. Local-only endpoints (`/api/local/*`) return `403 'Local mode only.'` to anything else.
- The frontend learns it is local from `GET /api/workspace/status` (`isLocal`) and only shows the Open Folder / New Workspace / Files controls in that case.

Attachment & local limits are configurable via env vars (all defaults safe, conservative):

| Env var | Default | Meaning |
| --- | --- | --- |
| `PW_MAX_FILE_BYTES` | `10MB` | Max size for a single non-image attachment file |
| `PW_MAX_ZIP_BYTES` | `25MB` | Max size for a single ZIP attachment |
| `PW_MAX_ATTACHMENTS_PER_REQUEST` | `5` | Max files in one batch upload |
| `PW_MAX_TOTAL_BYTES_PER_REQUEST` | `30MB` | Max combined size of a batch upload |
| `PW_MAX_ZIP_ENTRIES` | `10000` | Max entries a ZIP may contain (validated, never extracted) |
| `PW_TMP_MAX_AGE_MS` | `10 min` | How long attachment temp files may live before swept |
| `PW_WORKSPACE_PATH` | — | Set to a path to skip the native folder picker for local Open (useful in headless tests) |

The batch attachments endpoint is `POST /api/attachments/upload` (multipart field `files`). The older single `POST /api/attachments` is now image-only. Current limits are exposed to the client at `GET /api/workspace/limits`.

## Project structure

```
server/          local Node.js server: folder picker, static frontend, workspace.json I/O, attachments, backups
scripts/         dev/preview launchers (workspace server + internal Vite)
src/
  components/     Sidebar, RightPanel, Welcome, BackupDialog, Settings, ContextMenu, ConfirmDialog, MigrationDialog
  editor/         Tiptap wiring: Editor.tsx, Toolbar.tsx, FindBar.tsx, extensions/
  store/          in-memory workspace store (pub/sub + debounced atomic saves)
  db/             legacy IndexedDB schema + CRUD helpers (migration source only)
  services/       api.ts (server client), backup.ts (export/import), migrate.ts (browser-data import)
  utils/          docText.ts (plain-text extraction for search)
```

## Notes

- The workspace server listens on `0.0.0.0:5173`. Nothing is exposed to the internet unless your network/firewall is configured to do so.
- If the port is busy, the server exits with a message; set a different one with `PORT=xxxx npm run dev`.
- On Linux the folder picker uses `zenity` (GTK) or `kdialog` (KDE); macOS uses `osascript`; Windows uses PowerShell.