/**
 * Bundle the express/Typst server for the Electron shell.
 *
 * The Electron main process forks the resulting CommonJS bundle with
 * `ELECTRON_RUN_AS_NODE=1`, so the bundle must run on Electron's embedded Node
 * (20.x), not on bun.
 *
 * The Typst compiler is a *native* N-API addon (`@myriaddreamin/*`): it is kept
 * external on purpose. Inlining it would break the addon's own
 * `createRequire(__filename)` lookup for the platform binary, and the packaged
 * app ships production `node_modules` (see `build.asarUnpack` in package.json)
 * so the require resolves at runtime from `.../Resources/app.asar.unpacked`.
 *
 * Usage: bun scripts/build-server.mjs
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = path.join(repoRoot, 'server', 'index.ts');
const outfile = path.join(repoRoot, 'dist-server', 'index.cjs');

/** Native N-API package: never inline. */
const EXTERNALS = [
  '@myriaddreamin/typst-ts-node-compiler',
  '@myriaddreamin/typst-ts-node-compiler-darwin-arm64',
  '@myriaddreamin/typst-ts-node-compiler-darwin-x64',
  '@myriaddreamin/*',
];

function fail(message) {
  console.error(`[build-server] ${message}`);
  process.exit(1);
}

if (!fs.existsSync(entry)) fail(`missing entry point: ${entry}`);

fs.mkdirSync(path.dirname(outfile), { recursive: true });

/** Arguments for `bun build`; `process.execPath` is the bun binary running us. */
const args = [
  'build',
  entry,
  '--target=node',
  '--format=cjs',
  `--outfile=${outfile}`,
  ...EXTERNALS.flatMap((name) => ['--external', name]),
];

console.log(`[build-server] bun ${args.join(' ')}`);
const build = spawnSync(process.execPath, args, {
  cwd: repoRoot,
  stdio: 'inherit',
  env: { ...process.env, NODE_ENV: 'production' },
});
if (build.error) fail(`failed to spawn bun: ${build.error.message}`);
if (build.status !== 0) fail(`bun build exited with status ${build.status}`);

if (!fs.existsSync(outfile)) fail(`bun build produced no output: ${outfile}`);

const source = fs.readFileSync(outfile, 'utf8');
const size = (fs.statSync(outfile).size / 1024).toFixed(0);

// Guard rails: the native addon must stay a runtime require, and no .node
// binary may have been inlined into the bundle.
const problems = [];
if (!source.includes('@myriaddreamin/typst-ts-node-compiler')) {
  problems.push('typst compiler is not referenced in the bundle');
}
if (source.includes('typst-ts-node-compiler.darwin-arm64.node')) {
  problems.push('a native .node path was inlined (expected the addon to stay external)');
}
if (source.length > 12 * 1024 * 1024) {
  problems.push(`bundle is unexpectedly large (${size} KB)`);
}
if (problems.length > 0) fail(problems.join('; '));

console.log(`[build-server] ✔ ${path.relative(repoRoot, outfile)} (${size} KB)`);
