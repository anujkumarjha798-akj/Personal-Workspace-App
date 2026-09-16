import { spawn } from 'node:child_process';
import fs from 'node:fs';

if (!fs.existsSync('dist/index.html')) {
  console.error('[preview] dist/index.html not found. Run `npm run build` first.');
  process.exit(1);
}

const serverEnv = { ...process.env };
if (process.argv.includes('--global')) serverEnv.GLOBAL_ACCESS = 'true';

const server = spawn(process.execPath, ['server/index.mjs'], {
  env: serverEnv,
  stdio: 'inherit',
});

let shuttingDown = false;

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  server.kill();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
server.on('exit', shutdown);
