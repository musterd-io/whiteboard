import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * Whether the module at `moduleUrl` is the script node was asked to run. Resolves argv[1] through
 * symlinks first: npm links each `bin` into node_modules/.bin, so `npx` runs a script by a path that
 * is not its own, and a plain string compare would say "imported" and skip startup.
 */
export function isEntryPoint(moduleUrl: string): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return pathToFileURL(realpathSync(argv1)).href === moduleUrl;
  } catch {
    return false;
  }
}
