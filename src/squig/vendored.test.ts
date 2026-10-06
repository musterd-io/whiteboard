/**
 * The vendored Squig is exactly what scripts/vendor-squig.mjs wrote (ADR 537): the package
 * declares the bundle's externals at the versions it was built against, ships the vendor
 * directory, and nobody has edited the output by hand.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { VENDORED_ROOT } from './checkout.js';

const vendored = JSON.parse(readFileSync(join(VENDORED_ROOT, 'VENDORED.json'), 'utf8')) as {
  commit: string;
  externals: Record<string, string>;
  files: Record<string, string>;
};
const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
  dependencies: Record<string, string>;
  files: string[];
};

describe('the vendored Squig (ADR 537)', () => {
  it("declares exactly the bundle's externals, at the vendored version or a later patch", () => {
    expect(Object.keys(vendored.externals).sort()).toEqual(['@resvg/resvg-js', 'sharp']);
    // A patch bump (a security fix, say) keeps the API Squig was built against; a minor bump of a
    // 0.x package does not, so it needs a re-vendor.
    for (const [name, built] of Object.entries(vendored.externals)) {
      const declared = pkg.dependencies[name] ?? '';
      const [bMaj, bMin, bPatch] = built.split('.').map(Number);
      const [dMaj, dMin, dPatch] = declared.split('.').map(Number);
      expect([dMaj, dMin], `${name} ${declared} vs built ${built}`).toEqual([bMaj, bMin]);
      expect(dPatch!, `${name} ${declared} vs built ${built}`).toBeGreaterThanOrEqual(bPatch!);
    }
  });

  it('ships the vendor directory, with the companion, editor build and license in it', () => {
    expect(pkg.files).toContain('vendor');
    expect(Object.keys(vendored.files)).toEqual(
      expect.arrayContaining([
        'LICENSE',
        'lib/agent/companion.mjs',
        'out/.squig-local-editor.json',
        'out/index.html',
      ]),
    );
  });

  it('matches its manifest — the vendored output was not edited by hand', () => {
    const drifted = Object.entries(vendored.files).filter(
      ([rel, sha]) =>
        createHash('sha256')
          .update(readFileSync(join(VENDORED_ROOT, rel)))
          .digest('hex') !== sha,
    );
    expect(drifted.map(([rel]) => rel)).toEqual([]);
  });
});
