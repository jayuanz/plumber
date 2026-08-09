import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import * as esbuild from 'esbuild';
import JavaScriptObfuscator from 'javascript-obfuscator';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const buildDir = path.join(root, '.release-build');
const releaseRoot = path.join(root, 'release');
const platformName = process.platform === 'darwin' ? 'macos' : process.platform;
const releaseDir = path.join(releaseRoot, `plumber-${platformName}-${process.arch}`);
const appDir = path.join(releaseDir, 'app');
const webDistDir = path.join(releaseDir, 'web', 'dist');
const nodeModulesDir = path.join(appDir, 'node_modules');

const obfuscatorBaseOptions = {
  compact: true,
  controlFlowFlattening: false,
  deadCodeInjection: false,
  debugProtection: false,
  disableConsoleOutput: false,
  identifierNamesGenerator: 'hexadecimal',
  renameGlobals: false,
  selfDefending: false,
  simplify: true,
  sourceMap: false,
  splitStrings: true,
  stringArray: true,
  stringArrayEncoding: ['base64'],
  stringArrayThreshold: 0.72,
};

await fs.rm(buildDir, { recursive: true, force: true });
await fs.rm(releaseDir, { recursive: true, force: true });
await fs.mkdir(buildDir, { recursive: true });
await fs.mkdir(appDir, { recursive: true });

run('npm', ['run', 'build']);

await fs.cp(path.join(root, 'web', 'dist'), webDistDir, { recursive: true });
await obfuscateJavaScriptFiles(path.join(webDistDir, 'assets'), 'browser');

const serverBundle = path.join(buildDir, 'server.bundle.mjs');
await esbuild.build({
  absWorkingDir: root,
  banner: {
    js: 'import { createRequire as __plumberCreateRequire } from "node:module"; const require = __plumberCreateRequire(import.meta.url);',
  },
  bundle: true,
  entryPoints: ['server/index.js'],
  external: ['node-pty'],
  format: 'esm',
  legalComments: 'none',
  minify: true,
  outfile: serverBundle,
  platform: 'node',
  sourcemap: false,
  target: ['node20'],
});

const serverCode = await fs.readFile(serverBundle, 'utf8');
const obfuscatedServer = JavaScriptObfuscator.obfuscate(serverCode, {
  ...obfuscatorBaseOptions,
  target: 'node',
}).getObfuscatedCode();
await fs.writeFile(path.join(appDir, 'server.mjs'), obfuscatedServer);

await copyRuntimeNativeModule('node-pty');
await copyRuntimeNativeModule('node-addon-api');
await assertNodePtyNativeBinary(path.join(nodeModulesDir, 'node-pty'));
await fixNodePtyHelperMode(path.join(nodeModulesDir, 'node-pty'));

await writeReleaseReadme();
await writeSeaLauncher();
await buildSeaExecutable();
const tarball = await createTarball();

console.log('');
console.log(`Obfuscated executable release created: ${path.relative(root, releaseDir)}`);
console.log(`Run it with: ${path.relative(root, path.join(releaseDir, 'plumber'))}`);
console.log(`Tarball: ${path.relative(root, tarball)}`);

async function obfuscateJavaScriptFiles(directory, target) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await obfuscateJavaScriptFiles(fullPath, target);
      continue;
    }

    if (!entry.name.endsWith('.js')) {
      continue;
    }

    const code = await fs.readFile(fullPath, 'utf8');
    const obfuscated = JavaScriptObfuscator.obfuscate(code, {
      ...obfuscatorBaseOptions,
      target,
    }).getObfuscatedCode();
    await fs.writeFile(fullPath, obfuscated);
  }
}

async function copyRuntimeNativeModule(packageName) {
  const source = path.join(root, 'node_modules', packageName);
  const destination = path.join(nodeModulesDir, packageName);
  if (!fsSync.existsSync(source)) {
    return;
  }

  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.cp(source, destination, { recursive: true, verbatimSymlinks: true });
}

async function assertNodePtyNativeBinary(nodePtyRoot) {
  const binaryCandidates = [
    path.join(nodePtyRoot, 'build', 'Release', 'pty.node'),
    path.join(nodePtyRoot, 'prebuilds', `${platformName === 'macos' ? 'darwin' : process.platform}-${process.arch}`, 'pty.node'),
    path.join(nodePtyRoot, 'prebuilds', `linux-${process.arch}`, 'pty.node'),
    path.join(nodePtyRoot, 'prebuilds', `darwin-${process.arch}`, 'pty.node'),
  ];

  if (binaryCandidates.some((candidate) => fsSync.existsSync(candidate))) {
    return;
  }

  throw new Error(
    `node-pty native binary (pty.node) not found under ${path.relative(root, nodePtyRoot)}. ` +
      'node-pty failed to compile during npm install. On Linux, install build tooling ' +
      '(python3, make, g++) and reinstall: `apt-get install -y python3 build-essential && npm ci`.',
  );
}

async function fixNodePtyHelperMode(nodePtyRoot) {
  const helperCandidates = [
    path.join(nodePtyRoot, 'build', 'Release', 'spawn-helper'),
    path.join(nodePtyRoot, 'prebuilds', 'darwin-arm64', 'spawn-helper'),
    path.join(nodePtyRoot, 'prebuilds', 'darwin-x64', 'spawn-helper'),
    path.join(nodePtyRoot, 'prebuilds', 'linux-x64', 'spawn-helper'),
    path.join(nodePtyRoot, 'prebuilds', 'linux-arm64', 'spawn-helper'),
  ];

  for (const helper of helperCandidates) {
    if (!fsSync.existsSync(helper)) {
      continue;
    }

    const stat = await fs.stat(helper);
    await fs.chmod(helper, stat.mode | 0o755);
  }
}

async function writeReleaseReadme() {
  const text = `# Plumber Obfuscated Release

This directory contains an obfuscated Plumber release for ${platformName}/${process.arch}.

Run:

\`\`\`bash
./plumber
\`\`\`

The executable expects the sidecar \`app/\` and \`web/\` directories to stay next to it. This is required because Plumber uses the native \`node-pty\` addon.

Set production configuration through environment variables or a local \`.env\` file in this directory, for example:

\`\`\`bash
WEBTERM_USERNAME=admin
WEBTERM_PASSWORD=change-this-long-random-password
SESSION_SECRET=${crypto.randomBytes(32).toString('base64url')}
HOST=127.0.0.1
PORT=3000
\`\`\`
`;

  await fs.writeFile(path.join(releaseDir, 'README.md'), text);
}

async function writeSeaLauncher() {
  const launcher = `const path = require('node:path');
const { pathToFileURL } = require('node:url');

const releaseRoot = path.dirname(process.execPath);
process.chdir(releaseRoot);
process.env.NODE_ENV = process.env.NODE_ENV || 'production';
process.env.PLUMBER_RELEASE_ROOT = releaseRoot;

const serverPath = path.join(releaseRoot, 'app', 'server.mjs');
import(pathToFileURL(serverPath).href).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
`;

  await fs.writeFile(path.join(buildDir, 'sea-launcher.cjs'), launcher);
}

async function buildSeaExecutable() {
  const blobPath = path.join(buildDir, 'plumber-sea.blob');
  const seaConfigPath = path.join(buildDir, 'sea-config.json');
  const executablePath = path.join(releaseDir, 'plumber');
  const postjectPath = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'postject.cmd' : 'postject');

  await fs.writeFile(
    seaConfigPath,
    JSON.stringify(
      {
        main: path.join(buildDir, 'sea-launcher.cjs'),
        output: blobPath,
        disableExperimentalSEAWarning: true,
      },
      null,
      2,
    ),
  );

  run(process.execPath, ['--experimental-sea-config', seaConfigPath]);
  await fs.copyFile(process.execPath, executablePath);
  await fs.chmod(executablePath, 0o755);

  if (process.platform === 'darwin') {
    runOptional('codesign', ['--remove-signature', executablePath]);
  }

  const postjectArgs = [
    executablePath,
    'NODE_SEA_BLOB',
    blobPath,
    '--sentinel-fuse',
    'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  ];

  if (process.platform === 'darwin') {
    postjectArgs.push('--macho-segment-name', 'NODE_SEA');
  }

  run(postjectPath, postjectArgs);

  if (process.platform === 'darwin') {
    runOptional('codesign', ['--sign', '-', executablePath]);
  }
}

async function createTarball() {
  // Reuse the release dir name so the tarball always matches the build target,
  // e.g. release/plumber-linux-x64.tar.gz or release/plumber-macos-arm64.tar.gz.
  const dirName = path.basename(releaseDir);
  const tarball = path.join(releaseRoot, `${dirName}.tar.gz`);
  run('tar', ['-czf', tarball, '-C', releaseRoot, dirName]);
  return tarball;
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: process.env,
    stdio: 'inherit',
  });

  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}`);
  }
}

function runOptional(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: process.env,
    stdio: 'inherit',
  });

  if (result.status !== 0) {
    console.warn(`[release] optional command failed: ${command} ${args.join(' ')}`);
  }
}
