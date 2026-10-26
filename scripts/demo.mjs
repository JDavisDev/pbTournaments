// One command to try Courtside on this computer: installs the website's
// packages if they're missing, then starts it in local mode (its own
// database, practice tournaments, fast-forward, texts to the log). Nothing is
// charged or sent, and no Supabase account or keys are needed.
//
//   npm run demo      → http://localhost:3000
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const web = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');
// npm is npm.cmd on Windows, which Node only runs through a shell.
const shell = process.platform === 'win32';

if (!existsSync(path.join(web, 'node_modules'))) {
  console.log('Installing the website’s packages (first run only)…');
  const install = spawnSync('npm', ['install'], { cwd: web, stdio: 'inherit', shell });
  if (install.status !== 0) process.exit(install.status ?? 1);
}

// The environment wins over web/.env.local, so a Supabase setup there is left alone.
const dev = spawn('npm', ['run', 'dev'], {
  cwd: web,
  stdio: 'inherit',
  shell,
  env: { ...process.env, NEXT_PUBLIC_DATA_MODE: 'local' },
});
dev.on('exit', (code) => process.exit(code ?? 0));
