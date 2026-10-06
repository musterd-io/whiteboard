/**
 * The adapter against a real Squig companion: the one vendored into this package (ADR 537).
 * It runs everywhere, CI included, with HOME pointed at an empty directory and the working
 * directory somewhere foreign — so it proves a machine needs no ~/.squig/src clone, and that the
 * companion finds its editor build and fonts from its own location, the way an npx install
 * starts it. The in-memory suite in provider.test.ts covers the op shapes in depth.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seatActor } from '../port.js';
import { probeSquigCheckout } from './checkout.js';
import { SquigProvider } from './provider.js';

const ADA = seatActor('ada');

describe('SquigProvider on the vendored companion', () => {
  let dir: string;
  let provider: SquigProvider;
  const realHome = process.env['HOME'];
  const realCwd = process.cwd();
  const realOverride = process.env['SQUIG_CHECKOUT'];

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'wb-squig-live-'));
    process.env['WHITEBOARD_DATA_DIR'] = dir;
    process.env['HOME'] = mkdtempSync(join(tmpdir(), 'wb-empty-home-'));
    delete process.env['SQUIG_CHECKOUT'];
    process.chdir(mkdtempSync(join(tmpdir(), 'wb-foreign-cwd-')));
    const probe = probeSquigCheckout();
    if (!probe.ok || probe.checkout.kind !== 'vendored') {
      throw new Error(`expected the vendored companion, got ${JSON.stringify(probe)}`);
    }
    provider = new SquigProvider(probe.checkout);
  });

  afterAll(async () => {
    await provider?.closeAll();
    process.chdir(realCwd);
    process.env['HOME'] = realHome;
    if (realOverride !== undefined) process.env['SQUIG_CHECKOUT'] = realOverride;
    delete process.env['WHITEBOARD_DATA_DIR'];
    rmSync(dir, { recursive: true, force: true });
  });

  it('serves the editor page from the vendored build', async () => {
    await provider.open('page');
    const res = await fetch((await provider.editorUrl('page')).split('#')[0]!);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<html');
    await provider.close('page');
  });

  it('opens, places, reads back, edits and closes through the live companion', async () => {
    const { created } = await provider.open('live');
    expect(created).toBe(true);
    expect(await provider.editorUrl('live')).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/\?local=1#token=/,
    );

    const [c] = (await provider.add('live', ADA, [{ kind: 'cluster', title: 'Risks' }])).ids;
    const { ids, version } = await provider.add('live', ADA, [
      { kind: 'note', text: 'cold start', detail: 'why', cluster: c! },
      { kind: 'note', text: 'cost' },
    ]);
    await provider.add('live', ADA, [
      { kind: 'link', from: ids[0]!, to: ids[1]!, label: 'drives' },
    ]);

    const outline = await provider.read('live');
    expect(outline.items.map((i) => [i.kind, i.text]).sort()).toEqual([
      ['cluster', 'Risks'],
      ['link', 'drives'],
      ['note', 'cold start'],
      ['note', 'cost'],
    ]);
    expect(outline.items.find((i) => i.text === 'cold start')).toMatchObject({
      cluster: c,
      detail: 'why',
    });
    expect((await provider.read('live', outline.version)).items).toEqual([]);

    const { refused } = await provider.edit('live', ADA, [
      { op: 'retitle', id: ids[1]!, text: 'cost, monthly' },
      { op: 'delete', id: ids[0]! },
    ]);
    expect(refused).toEqual([]);
    const diff = await provider.read('live', version);
    expect(diff.removed).toContain(ids[0]);
    expect(diff.items.some((i) => i.text === 'cost, monthly')).toBe(true);
    expect(diff.items.some((i) => i.kind === 'link')).toBe(false);

    const final = await provider.close('live');
    expect(final.items.map((i) => i.text).sort()).toEqual(['Risks', 'cost, monthly']);
  });

  it("runs Squig's own tools on a linked board: draw attributed, render a PNG, read history (ADR 527)", async () => {
    const file = join(dir, 'repo', 'team.squig.json');
    mkdirSync(join(dir, 'repo'), { recursive: true });
    provider.link('team', file);
    await provider.open('team');
    const doc = await provider.squigTool('team', 'get_document', {});
    const drawn = await provider.squigTool(
      'team',
      'edit_document',
      {
        revision: doc['revision'],
        operations: [{ op: 'note', text: 'a raw sticky', x: 0, y: 0 }],
      },
      ADA,
    );
    const [id] = drawn['createdIds'] as string[];
    expect((await provider.read('team')).items.find((i) => i.id === id)).toMatchObject({
      text: 'a raw sticky',
      createdBy: ADA,
    });
    const png = await provider.squigTool('team', 'render_document', { format: 'png' });
    expect(png['mimeType']).toBe('image/png');
    expect(String(png['base64']).length).toBeGreaterThan(100);
    expect(
      ((await provider.squigTool('team', 'history', {}))['revisions'] as unknown[]).length,
    ).toBeGreaterThan(0);
    expect(existsSync(file)).toBe(true);
    await provider.close('team');
  });
});
