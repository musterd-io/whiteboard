/**
 * The package ships no tldraw (ADR 537): its npm publish must not redistribute tldraw's code,
 * so no tldraw package is declared and nothing tldraw lands in the packed tarball.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const pkgDir = fileURLToPath(new URL('..', import.meta.url));

describe('no tldraw ships (ADR 537)', () => {
  it('declares no tldraw package', () => {
    const pkg = JSON.parse(readFileSync(`${pkgDir}package.json`, 'utf8')) as Record<
      string,
      Record<string, string> | undefined
    >;
    const names = Object.keys({
      ...pkg['dependencies'],
      ...pkg['devDependencies'],
      ...pkg['optionalDependencies'],
      ...pkg['peerDependencies'],
    });
    expect(names.filter((n) => n.includes('tldraw'))).toEqual([]);
  });

  it('packs no tldraw path and no dist-web page', () => {
    const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
      cwd: pkgDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const [packed] = JSON.parse(out) as Array<{ files: Array<{ path: string }> }>;
    const files = packed!.files.map((f) => f.path);
    expect(files).toContain('vendor/squig/lib/agent/companion.mjs');
    expect(files.filter((f) => /tldraw|dist-web/.test(f))).toEqual([]);
  });
});
