/**
 * The extraction guarantee (ADR 330 decision 1), enforced: this package can be lifted into its own
 * repository as-is. Three ways it could quietly stop being true, each a test:
 *   1. a source file imports from @musterd/*, or package.json depends on it;
 *   2. a config file reaches outside the package (`../../tsconfig.base.json`, a shared vitest file);
 *   3. a bare import resolves only because the monorepo hoisted it — nothing in package.json names it.
 * If one fails, the standalone claim has become false while every other test stays green.
 */
import { readdir, readFile } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PKG_ROOT = fileURLToPath(new URL('..', import.meta.url));
/** Each config file with how deep its paths resolve from: vite.config.ts sets `root: 'web'`, so its
 *  `../dist-web` is still inside the package. */
const CONFIG_DEPTH: Record<string, number> = {
  'tsconfig.json': 0,
  'web/tsconfig.json': 1,
  'vite.config.ts': 1,
  'vitest.config.ts': 0,
};
const CONFIG_FILES = Object.keys(CONFIG_DEPTH);

async function sourceFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await sourceFiles(full)));
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

async function allCode(): Promise<string[]> {
  return [
    ...(await sourceFiles(join(PKG_ROOT, 'src'))),
    ...(await sourceFiles(join(PKG_ROOT, 'web', 'src'))),
    ...CONFIG_FILES.filter((f) => f.endsWith('.ts')).map((f) => join(PKG_ROOT, f)),
  ];
}

async function manifest(): Promise<Record<string, Record<string, string>>> {
  return JSON.parse(await readFile(join(PKG_ROOT, 'package.json'), 'utf8')) as Record<
    string,
    Record<string, string>
  >;
}

/** `@scope/name/sub` → `@scope/name`; `name/sub` → `name`. */
function packageOf(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!;
}

describe('extraction guarantee', () => {
  it('no source file imports from @musterd/*', async () => {
    const files = await allCode();
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const content = await readFile(file, 'utf8');
      expect(content, `${file} imports @musterd/*`).not.toMatch(/from ['"]@musterd\//);
    }
  });

  it('package.json declares no @musterd/* dependency', async () => {
    const pkg = await manifest();
    for (const section of ['dependencies', 'devDependencies', 'peerDependencies']) {
      for (const dep of Object.keys(pkg[section] ?? {})) {
        expect(dep, `${section} contains ${dep}`).not.toMatch(/^@musterd\//);
      }
    }
  });

  it('no config file reaches outside the package', async () => {
    for (const rel of CONFIG_FILES) {
      const content = await readFile(join(PKG_ROOT, rel), 'utf8');
      const depth = CONFIG_DEPTH[rel]!;
      const escape = new RegExp(`['"](\\.\\./){${depth + 1},}`);
      expect(content, `${rel} reaches outside the package`).not.toMatch(escape);
    }
  });

  it('every bare import is declared in package.json', async () => {
    const pkg = await manifest();
    const declared = new Set([
      ...Object.keys(pkg['dependencies'] ?? {}),
      ...Object.keys(pkg['devDependencies'] ?? {}),
    ]);
    const builtins = new Set(builtinModules);
    const importRe = /(?:from\s+|import\s*\(\s*)['"]([^'"]+)['"]/g;
    for (const file of await allCode()) {
      const content = await readFile(file, 'utf8');
      for (const [, spec] of content.matchAll(importRe)) {
        if (spec!.startsWith('.') || spec!.startsWith('node:')) continue;
        const name = packageOf(spec!);
        if (builtins.has(name)) continue;
        expect(declared.has(name), `${file} imports undeclared ${name}`).toBe(true);
      }
    }
  });
});
