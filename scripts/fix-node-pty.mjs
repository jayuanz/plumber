import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const nodePtyRoot = path.join(root, 'node_modules', 'node-pty');

if (!fs.existsSync(nodePtyRoot)) {
  process.exit(0);
}

const candidates = [
  path.join(nodePtyRoot, 'build', 'Release', 'spawn-helper'),
  path.join(nodePtyRoot, 'prebuilds', 'darwin-arm64', 'spawn-helper'),
  path.join(nodePtyRoot, 'prebuilds', 'darwin-x64', 'spawn-helper'),
];

let fixed = 0;
for (const file of candidates) {
  if (!fs.existsSync(file)) {
    continue;
  }

  const mode = fs.statSync(file).mode;
  if ((mode & 0o111) === 0o111) {
    continue;
  }

  fs.chmodSync(file, mode | 0o755);
  fixed += 1;
}

if (fixed > 0) {
  console.log(`[plumber] fixed executable bit on ${fixed} node-pty helper file(s)`);
}
