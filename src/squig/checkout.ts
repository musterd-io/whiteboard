/**
 * Where Squig comes from (ADR 537). The package carries a vendored companion — Squig built at a
 * pinned commit and bundled by `scripts/vendor-squig.mjs` into `vendor/squig/` — so a machine
 * needs no Squig clone. `SQUIG_CHECKOUT` points at a local clone instead, for trying a newer
 * upstream; a clone runs Squig's TypeScript under `--experimental-strip-types` with its own
 * loader, which needs Node 22.6 or newer. A wrong override fails and names the path: it never
 * falls back to the vendored copy.
 */
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface SquigCheckout {
  kind: 'vendored' | 'checkout';
  root: string;
  entry: string;
  /** The ESM loader a clone needs; the vendored companion is plain JavaScript and has none. */
  loader: string | null;
  node: string;
}

export type CheckoutProbe = { ok: true; checkout: SquigCheckout } | { ok: false; reason: string };

/** This package's vendored Squig, resolved from this module, so any install location works. */
export const VENDORED_ROOT = fileURLToPath(new URL('../../vendor/squig', import.meta.url));

/** Squig's scripts run under `--experimental-strip-types`, which needs Node 22.6 or newer. */
export function nodeSupportsSquig(version: string): boolean {
  const [major = 0, minor = 0] = version.split('.').map((n) => parseInt(n, 10));
  return major > 22 || (major === 22 && minor >= 6);
}

export function probeSquigCheckout(
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync,
  node: { execPath: string; version: string } = {
    execPath: process.execPath,
    version: process.versions.node,
  },
  vendoredRoot: string = VENDORED_ROOT,
): CheckoutProbe {
  const override = env['SQUIG_CHECKOUT'];
  if (override) {
    const root = resolve(override);
    const entry = join(root, 'scripts', 'squig.ts');
    const loader = join(root, 'scripts', 'register-loader.mjs');
    if (!exists(entry) || !exists(loader)) {
      return { ok: false, reason: `SQUIG_CHECKOUT=${root} is not a Squig checkout` };
    }
    if (!exists(join(root, 'out', '.squig-local-editor.json'))) {
      return {
        ok: false,
        reason: `Squig checkout at ${root} has no local editor build — run \`pnpm build:local\` there`,
      };
    }
    if (!nodeSupportsSquig(node.version)) {
      return {
        ok: false,
        reason: `a Squig checkout needs Node 22.6 or newer; the whiteboard service runs Node ${node.version}`,
      };
    }
    return { ok: true, checkout: { kind: 'checkout', root, entry, loader, node: node.execPath } };
  }
  const entry = join(vendoredRoot, 'lib', 'agent', 'companion.mjs');
  if (!exists(entry) || !exists(join(vendoredRoot, 'out', '.squig-local-editor.json'))) {
    return {
      ok: false,
      reason: `this package's vendored Squig is missing at ${vendoredRoot} — reinstall @musterd/whiteboard`,
    };
  }
  return {
    ok: true,
    checkout: { kind: 'vendored', root: vendoredRoot, entry, loader: null, node: node.execPath },
  };
}
