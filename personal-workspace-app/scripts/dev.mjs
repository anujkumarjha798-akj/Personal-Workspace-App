import { spawn } from 'node:child_process';
import os from 'node:os';

const port = process.env.PORT || '5173';
const vitePort = process.env.VITE_DEV_PORT || '4173';
const enableGlobal = process.argv.includes('--global');

const serverEnv = { ...process.env, PW_DEV: '1', PORT: port, VITE_DEV_PORT: vitePort };
if (enableGlobal) serverEnv.GLOBAL_ACCESS = 'true';

const server = spawn(process.execPath, ['server/index.mjs'], {
  env: serverEnv,
  stdio: 'inherit',
});

const vite = spawn('npx', ['vite'], {
  env: { ...process.env, PORT: port, VITE_DEV_PORT: vitePort },
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

let shuttingDown = false;

function printUrls() {
  console.log('\n[dev] App available at:');
  console.log(`[dev]   http://localhost:${port}`);
  for (const iface of Object.values(os.networkInterfaces())) {
    for (const entry of iface || []) {
      if (entry.family === 'IPv4' && !entry.internal) {
        console.log(`[dev]   http://${entry.address}:${port}`);
      }
    }
  }
  if (enableGlobal) {
    console.log('[dev]   Global access: starting secure tunnel (public URL appears once ready)');
  }
  console.log('');
}

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  server.kill();
  vite.kill();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
server.on('exit', shutdown);
vite.on('exit', shutdown);

setTimeout(() => {
  printUrls();
}, 800);
