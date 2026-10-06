import { describe, expect, it } from 'vitest';
import { probeSquigCheckout } from './checkout.js';

const NODE = { execPath: '/bin/node', version: '22.12.0' };
const VENDOR = '/pkg/vendor/squig';
const vendoredFiles = new Set([
  `${VENDOR}/lib/agent/companion.mjs`,
  `${VENDOR}/out/.squig-local-editor.json`,
]);
const has = (files: Set<string>) => (f: string) => files.has(f);

describe('probeSquigCheckout (ADR 537)', () => {
  it('uses the vendored companion when nothing overrides it, with no loader', () => {
    expect(probeSquigCheckout({}, has(vendoredFiles), NODE, VENDOR)).toEqual({
      ok: true,
      checkout: {
        kind: 'vendored',
        root: VENDOR,
        entry: `${VENDOR}/lib/agent/companion.mjs`,
        loader: null,
        node: '/bin/node',
      },
    });
  });

  it('never looks at ~/.squig/src', () => {
    const seen: string[] = [];
    const exists = (f: string) => {
      seen.push(f);
      return vendoredFiles.has(f);
    };
    probeSquigCheckout({}, exists, NODE, VENDOR);
    expect(seen.filter((f) => f.includes('.squig/src'))).toEqual([]);
    expect(seen.every((f) => f.startsWith(VENDOR))).toBe(true);
  });

  it('SQUIG_CHECKOUT wins over the vendored copy and runs through the loader', () => {
    const files = new Set([
      ...vendoredFiles,
      '/c/scripts/squig.ts',
      '/c/scripts/register-loader.mjs',
      '/c/out/.squig-local-editor.json',
    ]);
    expect(probeSquigCheckout({ SQUIG_CHECKOUT: '/c' }, has(files), NODE, VENDOR)).toEqual({
      ok: true,
      checkout: {
        kind: 'checkout',
        root: '/c',
        entry: '/c/scripts/squig.ts',
        loader: '/c/scripts/register-loader.mjs',
        node: '/bin/node',
      },
    });
  });

  it('a SQUIG_CHECKOUT that is not a checkout fails and names it — no silent vendored fallback', () => {
    const p = probeSquigCheckout({ SQUIG_CHECKOUT: '/missing' }, has(vendoredFiles), NODE, VENDOR);
    expect(p).toEqual({ ok: false, reason: expect.stringContaining('/missing') });
  });

  it('a SQUIG_CHECKOUT still needs Node 22.6 for strip-types', () => {
    const files = new Set([
      '/c/scripts/squig.ts',
      '/c/scripts/register-loader.mjs',
      '/c/out/.squig-local-editor.json',
    ]);
    const old = { execPath: '/bin/node', version: '22.3.0' };
    const p = probeSquigCheckout({ SQUIG_CHECKOUT: '/c' }, has(files), old, VENDOR);
    expect(p).toEqual({ ok: false, reason: expect.stringContaining('22.6') });
  });

  it('a package without its vendored copy says so', () => {
    const p = probeSquigCheckout({}, () => false, NODE, VENDOR);
    expect(p).toEqual({ ok: false, reason: expect.stringContaining(VENDOR) });
  });
});
