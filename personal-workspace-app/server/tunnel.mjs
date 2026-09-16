// Global access support: manages a Cloudflare Quick Tunnel (cloudflared) that
// exposes ONLY this app's local server through an ephemeral HTTPS URL
// (https://<random>.trycloudflare.com). The tunnel runs as a child process on
// the host machine and forwards to http://127.0.0.1:<port> — nothing else on
// the computer is reachable through it. No account or configuration required.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN_DIR = path.join(PROJECT_ROOT, '.cloudflared');
const LATEST_BASE = 'https://github.com/cloudflare/cloudflared/releases/latest/download';
const CONNECT_TIMEOUT_MS = Number(process.env.PW_TUNNEL_TIMEOUT_MS) || 90 * 1000;
const AUTO_DOWNLOAD = !/^(0|false|off|no)$/i.test(String(process.env.PW_TUNNEL_AUTO_DOWNLOAD ?? '1'));

const QUICK_URL_RE = /https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com/i;

function releaseAsset() {
  switch (process.platform) {
    case 'linux':
      if (process.arch === 'x64') return { asset: 'cloudflared-linux-amd64', out: 'cloudflared', tar: false };
      if (process.arch === 'arm64') return { asset: 'cloudflared-linux-arm64', out: 'cloudflared', tar: false };
      if (process.arch === 'arm') return { asset: 'cloudflared-linux-arm', out: 'cloudflared', tar: false };
      break;
    case 'darwin':
      if (process.arch === 'x64') return { asset: 'cloudflared-darwin-amd64.tgz', out: 'cloudflared', tar: true };
      if (process.arch === 'arm64') return { asset: 'cloudflared-darwin-arm64.tgz', out: 'cloudflared', tar: true };
      break;
    case 'win32':
      if (process.arch === 'x64') return { asset: 'cloudflared-windows-amd64.exe', out: 'cloudflared.exe', tar: false };
      if (process.arch === 'arm64') return { asset: 'cloudflared-windows-arm64.exe', out: 'cloudflared.exe', tar: false };
      break;
  }
  return null;
}

async function findExistingBinary() {
  const custom = process.env.CLOUDFLARED_BIN;
  if (custom && custom.trim()) {
    const p = custom.trim();
    try {
      const st = await fsp.stat(p);
      if (st.isFile()) return p;
    } catch {}
    throw new Error(`CLOUDFLARED_BIN="${p}" does not exist.`);
  }
  const probe = spawnSync('cloudflared', ['--version'], { stdio: 'ignore' });
  if (!probe.error && probe.status === 0) return 'cloudflared';
  const spec = releaseAsset();
  if (spec) {
    const local = path.join(BIN_DIR, spec.out);
    try {
      await fsp.access(local, fs.constants.X_OK);
      return local;
    } catch {}
  }
  return null;
}

async function downloadCloudflared(log) {
  const spec = releaseAsset();
  if (!spec) {
    throw new Error(
      `No prebuilt cloudflared for ${process.platform}/${process.arch}. `
      + 'Install it manually and set CLOUDFLARED_BIN=/path/to/cloudflared.',
    );
  }
  const url = `${LATEST_BASE}/${spec.asset}`;
  log(`Downloading cloudflared (${process.platform}/${process.arch}) from ${url} …`);
  let res;
  try {
    res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(120 * 1000) });
  } catch (err) {
    throw new Error(`cloudflared download failed: ${err.message}`);
  }
  if (!res.ok) {
    throw new Error(`cloudflared download failed (HTTP ${res.status} from ${url}).`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  await fsp.mkdir(BIN_DIR, { recursive: true, mode: 0o700 });
  const tmpPath = path.join(BIN_DIR, `${spec.asset}.${process.pid}.tmp`);
  await fsp.writeFile(tmpPath, buf, { mode: 0o600 });
  const finalPath = path.join(BIN_DIR, spec.out);
  if (spec.tar) {
    const ex = spawnSync('tar', ['-xzf', tmpPath, '-C', BIN_DIR], { stdio: 'ignore' });
    await fsp.rm(tmpPath, { force: true });
    if (ex.error || ex.status !== 0) {
      throw new Error('Failed to extract cloudflared archive (is `tar` available?).');
    }
  } else {
    await fsp.rm(finalPath, { force: true });
    await fsp.rename(tmpPath, finalPath);
  }
  await fsp.chmod(finalPath, 0o755).catch(() => {});
  const check = spawnSync(finalPath, ['--version'], { stdio: 'ignore' });
  if (check.error || check.status !== 0) {
    throw new Error('Downloaded cloudflared binary did not run correctly.');
  }
  log('cloudflared is ready.');
  return finalPath;
}

export async function ensureCloudflared(log) {
  const found = await findExistingBinary();
  if (found) return found;
  if (!AUTO_DOWNLOAD) {
    throw new Error(
      'cloudflared was not found and auto-download is disabled '
      + '(PW_TUNNEL_AUTO_DOWNLOAD=0). Install cloudflared and put it on PATH, '
      + 'or point CLOUDFLARED_BIN at the binary.',
    );
  }
  return downloadCloudflared(log);
}

// Starts `cloudflared tunnel --url http://127.0.0.1:<port>` and resolves with
// { url, stop(), exited } once the public HTTPS URL is known.
export async function startQuickTunnel({ port, log }) {
  const bin = await ensureCloudflared(log);
  const child = spawn(
    bin,
    [
      'tunnel',
      '--no-autoupdate',
      '--protocol', 'http2',
      '--url', `http://127.0.0.1:${port}`,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );

  return new Promise((resolve, reject) => {
    let url = null;
    let settled = false;
    const tail = [];
    const timer = setTimeout(() => {
      finish(new Error(`tunnel did not produce a URL within ${Math.round(CONNECT_TIMEOUT_MS / 1000)}s.`));
    }, CONNECT_TIMEOUT_MS);

    function finish(err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) {
        try { child.kill(); } catch {}
        err.message += tail.length ? `\n  last output:\n    ${tail.slice(-5).join('\n    ')}` : '';
        reject(err);
        return;
      }
      resolve({
        url,
        stop() {
          try { child.kill(); } catch {}
        },
        exited: new Promise((res) => child.once('exit', (code) => res(code))),
      });
    }

    function scan(chunk) {
      for (const rawLine of chunk.toString('utf8').split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) continue;
        tail.push(line.length > 300 ? line.slice(0, 300) : line);
        if (tail.length > 40) tail.shift();
        if (!url) {
          const m = line.match(QUICK_URL_RE);
          if (m) {
            url = m[0];
            finish(null);
          }
        }
      }
    }

    child.stdout.on('data', scan);
    child.stderr.on('data', scan);
    child.on('error', (e) => finish(e instanceof Error ? e : new Error(String(e))));
    child.on('exit', (code) => finish(new Error(`cloudflared exited early (code ${code}).`)));
  });
}
