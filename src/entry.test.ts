import { execFile } from 'node:child_process';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const run = promisify(execFile);
const ENTRY = fileURLToPath(new URL('./entry.ts', import.meta.url));
let dir: string | undefined;

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

/** A script that prints whether isEntryPoint says it was run directly. */
async function probe(): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), 'wb-entry-'));
  const script = join(dir, 'main.ts');
  await writeFile(
    script,
    `import { isEntryPoint } from ${JSON.stringify(ENTRY)};\nconsole.log(isEntryPoint(import.meta.url));\n`,
  );
  return script;
}

async function runNode(path: string): Promise<string> {
  const { stdout } = await run(process.execPath, ['--experimental-strip-types', path]);
  return stdout.trim();
}

describe('isEntryPoint', () => {
  it('is true when run by its own path', async () => {
    expect(await runNode(await probe())).toBe('true');
  });

  // npm links a package's `bin` into node_modules/.bin as a symlink, so `npx` runs the script by a
  // path that is not its own. Comparing argv[1] to import.meta.url as strings said "not main", and
  // the MCP server exited silently without ever starting.
  it('is true when run through a symlink, as npm bin links run it', async () => {
    const script = await probe();
    const link = join(dir!, 'bin-link.ts');
    await symlink(script, link);
    expect(await runNode(link)).toBe('true');
  });

  it('is false when imported by another module', async () => {
    const script = await probe();
    const importer = join(dir!, 'importer.ts');
    await writeFile(importer, `import ${JSON.stringify(script)};\n`);
    expect(await runNode(importer)).toBe('false');
  });
});
