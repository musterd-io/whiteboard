#!/usr/bin/env node
/**
 * Vendors Squig (MIT, Pablo Stanley) into this package (ADR 537).
 *
 * Builds Squig at a pinned upstream commit, bundles its local companion into one ESM file, and
 * writes the result to vendor/squig/ — the companion, its fonts, the local editor build, Squig's
 * LICENSE, and VENDORED.json (commit, externals, file checksums). The output is committed; CI
 * never builds Squig. A Squig upgrade is a PR that runs this again with a new commit.
 *
 *   pnpm --filter @musterd/whiteboard vendor:squig [<commit>]
 *
 * The entry is scripts/agent/local.ts, not scripts/squig.ts: local.ts runs itself when argv[1]
 * is its own module URL, which in a one-file bundle is true for every module — so bundling
 * squig.ts would start local.ts a second time. The layout keeps Squig's own path lookups
 * working without patching it: local-server.ts finds out/ at <module dir>/../.., and the text
 * metrics find fonts/ beside the module.
 */
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const UPSTREAM = 'https://github.com/pablostanley/squig.git';
const COMMIT = process.argv[2] ?? '85f92ab132f5e621754b19de24ff95e67e474602';
/** Per-platform native binaries: declared as package dependencies, never bundled. */
const EXTERNALS = ['@resvg/resvg-js', 'sharp'];

const pkgRoot = fileURLToPath(new URL('..', import.meta.url));
const dest = join(pkgRoot, 'vendor', 'squig');

const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: 'inherit' });

const work = mkdtempSync(join(tmpdir(), 'vendor-squig-'));
try {
  const src = join(work, 'squig');
  run('git', ['init', '-q', src]);
  run('git', ['remote', 'add', 'origin', UPSTREAM], src);
  run('git', ['fetch', '-q', '--depth', '1', 'origin', COMMIT], src);
  run('git', ['checkout', '-q', 'FETCH_HEAD'], src);
  run('pnpm', ['install', '--frozen-lockfile'], src);
  run('pnpm', ['build:local'], src);

  const out = join(work, 'bundle');
  await build({
    configFile: false,
    logLevel: 'warn',
    root: src,
    publicDir: false,
    resolve: { alias: [{ find: /^@\//, replacement: `${src}/` }] },
    ssr: { noExternal: true, external: EXTERNALS },
    build: {
      ssr: join(src, 'scripts', 'agent', 'local.ts'),
      outDir: out,
      emptyOutDir: true,
      target: 'node22',
      minify: false,
      rolldownOptions: {
        external: (id) => EXTERNALS.some((e) => id === e || id.startsWith(`${e}/`)),
        output: { format: 'es', entryFileNames: 'companion.mjs', codeSplitting: false },
      },
    },
  });

  rmSync(dest, { recursive: true, force: true });
  mkdirSync(join(dest, 'lib', 'agent'), { recursive: true });
  cpSync(join(out, 'companion.mjs'), join(dest, 'lib', 'agent', 'companion.mjs'));
  cpSync(join(src, 'lib', 'agent', 'fonts'), join(dest, 'lib', 'agent', 'fonts'), {
    recursive: true,
  });
  cpSync(join(src, 'out'), join(dest, 'out'), { recursive: true });
  cpSync(join(src, 'LICENSE'), join(dest, 'LICENSE'));

  const externals = Object.fromEntries(
    EXTERNALS.map((e) => [
      e,
      JSON.parse(readFileSync(join(src, 'node_modules', e, 'package.json'), 'utf8')).version,
    ]),
  );
  /** @type {Record<string, string>} */
  const files = {};
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else files[relative(dest, p)] = createHash('sha256').update(readFileSync(p)).digest('hex');
    }
  };
  walk(dest);
  const manifest = {
    upstream: UPSTREAM,
    commit: COMMIT,
    vendoredAt: new Date().toISOString().slice(0, 10),
    externals,
    files,
  };
  writeFileSync(join(dest, 'VENDORED.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  await smoke(join(dest, 'lib', 'agent', 'companion.mjs'), work);
  console.log(`vendored Squig ${COMMIT.slice(0, 7)} → ${relative(process.cwd(), dest)}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}

/** Start the vendored companion on a scratch board, from a foreign cwd, and fetch its editor. */
async function smoke(companion, cwd) {
  const file = join(cwd, 'smoke.squig.json');
  // stdin stays an open pipe: the companion exits when its stdio MCP input ends.
  const child = spawn(process.execPath, [companion, 'mcp', file], {
    cwd,
    stdio: ['pipe', 'ignore', 'pipe'],
  });
  try {
    const editor = await new Promise((resolve, reject) => {
      let err = '';
      const timer = setTimeout(() => reject(new Error(`smoke: no editor line\n${err}`)), 30_000);
      child.stderr.on('data', (chunk) => {
        err += chunk;
        const m = err.match(/Open canvas: (\S+)/);
        if (m) {
          clearTimeout(timer);
          resolve(m[1]);
        }
      });
      child.on('exit', (code) => reject(new Error(`smoke: companion exited ${code}\n${err}`)));
    });
    const res = await fetch(editor.split('#')[0]);
    const body = await res.text();
    if (!res.ok || !body.includes('<html')) {
      throw new Error(`smoke: the editor did not serve HTML (${res.status})`);
    }
  } finally {
    child.kill('SIGTERM');
  }
}
