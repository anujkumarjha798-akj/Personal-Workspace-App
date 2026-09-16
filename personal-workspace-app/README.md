# Personal Workspace

**A local-first, dark-themed, developer-style documentation editor — no AI, no account, no cloud.**

Personal Workspace is a self-hosted note/documentation app inspired by the Eraser.io writing experience. It pairs a React + TypeScript + Tiptap (ProseMirror) rich-text editor with a small Node.js server that reads and writes a real folder on your own machine — so your notes live as a plain `workspace.json` file on disk, not in someone else's database.

---

## Highlights

- 🖊️ **Full-featured rich-text editor** — headings, text formatting, code blocks, tables, task lists, images, links, and more (powered by Tiptap/ProseMirror).
- 💾 **Local-first storage** — everything is saved to a workspace folder you pick on your own computer (`workspace.json` + `attachments/` + `backups/`). No account, no external database, no telemetry.
- 🌐 **LAN & optional global access** — open the same workspace from any device on your network, or, if you choose, expose it to the internet through a free Cloudflare Quick Tunnel with password protection.
- 🗂️ **Pages & folders** — create, rename, move, favorite, soft-delete/restore pages and folders, with drag-and-drop and right-click context menus.
- 🔍 **Search, Find & Replace** — sidebar search across titles/content, plus in-editor Ctrl+F / Ctrl+H with regex and whole-word options.
- 📦 **Import/export** — JSON and ZIP backups, including attachments.
- 🎨 **Dark theme by default** (JetBrains Mono), with a light theme option.
- 🔒 **Security-conscious server** — path-traversal protection, attachment sandboxing, upload limits, CSP, session cookies, and a strict host allowlist for tunnel access.

---

## Tech Stack

| Layer | Technology |
|---|---|
| UI | React 19 + TypeScript |
| Editor | Tiptap 3 / ProseMirror (tables, task lists, images, links, code blocks, text align, highlight, color…) |
| Build tool | Vite 8 |
| Local database (legacy/migration only) | Dexie (IndexedDB) |
| Backend | Plain Node.js `http` server (no framework) |
| Backups/exports | JSZip |
| Icons | lucide-react, simple-icons |
| Linting | oxlint |

No external UI framework, no state-management library, no AI integration — the project deliberately keeps its dependency footprint small.

---

## Getting Started

```bash
npm install
npm run dev
```

This starts two processes together:

1. **Workspace server** (`server/index.mjs`) — listens on `0.0.0.0:5173`, serves the app and all `/api/*` endpoints.
2. **Vite dev server** (internal only, `127.0.0.1:4173`) — the workspace server proxies to it for live-reloading during development.

Open the app:

- On this machine: `http://localhost:5173`
- From another device on the same LAN: `http://<server-ip>:5173` (the exact LAN URL is printed in the terminal on startup)

### Production build

```bash
npm run build
npm run preview
```

`preview` serves the built `dist/` output from the same `0.0.0.0:5173` server, with no Vite involved.

### All scripts

| Script | Purpose |
|---|---|
| `npm run dev` | Dev server (LAN only) |
| `npm run dev:global` | Dev server + internet access via Cloudflare tunnel |
| `npm run build` | Type-check and build for production |
| `npm run preview` | Serve the production build (LAN only) |
| `npm run preview:global` / `npm run start:global` | Serve the production build + internet access |
| `npm run lint` | Run oxlint |

---

## How Storage Works

The app is **not** tied to a browser or a browser database. On first launch you pick a workspace folder (via a native/in-app folder picker), and that folder becomes the single source of truth for every browser and device that connects to the server:

```
Selected Workspace Folder/
├── workspace.json      ← all pages, folders, content, settings, metadata, ordering
├── attachments/         ← images/files referenced from page content
└── backups/             ← workspace-backup-*.json (auto, rotated)
```

- Opening the app in different browsers or devices and selecting the **same folder** shows the **same data** — the server is the single storage authority.
- Saves are atomic: the server writes `workspace.tmp`, fsyncs it, then renames it over `workspace.json`; concurrent saves are serialized and revision-tracked.
- Timestamped backups are written to `backups/` on a throttled interval (default every 5 minutes, newest 12 kept).
- Images are uploaded to `attachments/` and referenced by filename, rather than being inlined as base64 in page content.
- Non-image files (documents, code, ZIP archives) can also be attached via the toolbar or drag-and-drop; ZIPs are validated (path traversal / entry-count checks) but never extracted server-side.
- A one-time **legacy import** path exists for anyone who used an earlier IndexedDB-only version of the app — `src/db/db.ts` reads that old browser data purely to migrate it into `workspace.json`.

---

## Networking & Remote Access

- The server always binds to `0.0.0.0`, not `localhost`, so it's reachable from other devices on the network by default.
- The frontend only ever calls **relative** API paths (`/api/...`) — there is no hard-coded host or IP anywhere in the client, so the identical build works over `localhost` or a LAN IP.
- The server prints every reachable URL (localhost + LAN IPs) at startup.
- Default port is `5173`; override with `PORT=xxxx npm run dev` if it's busy.

### Optional global (internet) access

The same running instance can optionally be reached from anywhere via a **Cloudflare Quick Tunnel** — free, no account required, automatic HTTPS:

```bash
npm run dev:global        # live-reload + internet access
npm run preview:global    # production build + internet access
```

(or set `GLOBAL_ACCESS=true` for either normal command). Regular `npm run dev` / `npm run preview` never open a tunnel.

At startup, all three access modes are printed:

```
This machine:    http://localhost:5173
Same LAN:        http://192.168.x.x:5173
Global access:   https://random-words-1234.trycloudflare.com
```

Remote visitors must enter the printed **Access ID** as a password (local/loopback users never need it). The tunnel URL is ephemeral — it changes on every restart and stops working the moment the app or host machine stops.

Security notes for global mode:

- All traffic is end-to-end HTTPS via Cloudflare's edge — no router port-forwarding needed.
- Every internet visitor is rate-limited individually and always required to enter the Access ID.
- The tunnel hostname is dynamically added to the server's Host allowlist; unknown hosts still get a 403.
- All other protections (path validation, attachment sandboxing, CSP, session cookies, upload limits) apply equally to remote visitors.

---

## Local-Only Features

Some capabilities only appear when the browser is talking to the server over `localhost` (loopback) rather than through the tunnel:

- **Open Folder…** — switch the active workspace to any folder on the host machine.
- **New Workspace…** — create a brand-new (empty) workspace folder.
- **Files…** — browse the current workspace's files, preview text files, and download any of them.

These controls are hidden entirely for LAN/tunnel visitors, and the corresponding `/api/local/*` endpoints reject any request that isn't genuinely local.

---

## Editor Features

- Headings H1–H6; bold, italic, underline, strikethrough, overline; inline code and code blocks; highlight; text color; font size; text alignment.
- Bullet, numbered, and task lists (with nesting); Tab / Shift+Tab indentation in both lists and paragraphs.
- Tables — insert/delete rows and columns, merge/split cells.
- Images (paste, drag-and-drop — stored in `attachments/`), links, horizontal dividers.
- Undo/redo and standard clipboard shortcuts.
- **Find** (Ctrl+F) and **Find & Replace** (Ctrl+H) with match count, next/previous navigation, match-case, whole-word, and regex options.
- **Autosave** with debounce and a Saving… / Saved ✓ / Save failed status indicator; Ctrl+S forces an immediate save.
- **Right panel**: live word/character count, created/modified timestamps, and a document outline auto-generated from headings (click to jump).

## Organization & Data Management

- Pages and folders: create, rename, duplicate, drag-and-drop or context-menu move, favorite, soft-delete to Trash, restore, and permanently delete.
- Sidebar **search** across page titles and body text.
- **Import/export**: JSON and ZIP backups (Settings → Export Backup, or Import via Ctrl+O). ZIP exports include attachments; JSON exports inline images as data URIs.

---

## Configuration

All limits are environment-configurable, with conservative defaults:

| Env var | Default | Meaning |
|---|---|---|
| `PORT` | `5173` | Server port |
| `PW_MAX_FILE_BYTES` | `10MB` | Max size for a single non-image attachment |
| `PW_MAX_ZIP_BYTES` | `25MB` | Max size for a single ZIP attachment |
| `PW_MAX_ATTACHMENTS_PER_REQUEST` | `5` | Max files per batch upload |
| `PW_MAX_TOTAL_BYTES_PER_REQUEST` | `30MB` | Max combined size of a batch upload |
| `PW_MAX_ZIP_ENTRIES` | `10000` | Max entries a ZIP may contain |
| `PW_TMP_MAX_AGE_MS` | `10 min` | Lifetime of temp attachment files before cleanup |
| `PW_BACKUP_INTERVAL_MS` | `5 min` | How often automatic backups are written |
| `PW_MAX_BACKUPS` | `12` | Number of rotated backups to keep |
| `PW_WORKSPACE_PATH` | — | Skip the folder picker and open this path directly (useful for headless/testing) |
| `GLOBAL_ACCESS` | `false` | Enable the Cloudflare tunnel without using the `:global` scripts |
| `CLOUDFLARED_BIN` | — | Use a specific local `cloudflared` binary |
| `PW_TUNNEL_AUTO_DOWNLOAD` | `1` | Set to `0` to disable auto-downloading `cloudflared` |

Current effective limits are also exposed to the client at `GET /api/workspace/limits`.

---

## Project Structure

```
server/          Node.js server: folder picker, static frontend, workspace.json I/O,
                 attachments, backups, Cloudflare tunnel integration
scripts/         dev/preview launchers (workspace server + internal Vite)
src/
  components/    Sidebar, RightPanel, Welcome, BackupDialog, Settings, ContextMenu,
                 ConfirmDialog, MigrationDialog, FolderPickerModal
  editor/        Tiptap wiring — Editor.tsx, Toolbar.tsx, FindBar.tsx, attachments,
                 paste sanitization
  store/         In-memory workspace store (pub/sub + debounced atomic saves)
  db/            Legacy IndexedDB schema + CRUD helpers (used only for one-time migration)
  services/      api.ts (server client), backup.ts (export/import), migrate.ts
  utils/         docText.ts (plain-text extraction for search)
  types.ts       Shared TypeScript types (Page, Folder, Setting, etc.)
public/          Static assets (favicon, icon sprite)
```

---

## Notes & Caveats

- Nothing is exposed to the internet unless you explicitly run one of the `:global` commands (or set `GLOBAL_ACCESS=true`) — normal `dev`/`preview` stay LAN-only.
- If the default port is busy, the server exits with a clear message; set `PORT=xxxx` to use another one.
- The native folder picker uses `zenity`/`kdialog` on Linux, `osascript` on macOS, and PowerShell on Windows.
- This is a personal/self-hosted tool, not a multi-tenant SaaS product — there's a single shared workspace per running server instance, protected by an Access ID only when global access is enabled.

---

## License

No license file is included in this project — add one (e.g. MIT) if you intend to share or open-source it.
