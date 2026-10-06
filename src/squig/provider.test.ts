/**
 * The Squig adapter's contract (ADR 524), against an in-memory Squig so it runs anywhere:
 * the write half is readable by the read half (links resolve endpoints, clusters carry members,
 * attribution and detail survive), `since` returns only what changed — the human's edits
 * included — and the edit policy refuses rather than skips. A real-Squig round trip lives in
 * squig.integration.test.ts and runs where a checkout exists.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HUMAN, seatActor } from '../port.js';
import { FakeSquig } from './fake.js';
import { SquigProvider } from './provider.js';
import { companionArgs } from './session.js';

const CHECKOUT = {
  kind: 'vendored' as const,
  root: '/x',
  entry: '/x/e',
  loader: null,
  node: '/x/node',
};
const ADA = seatActor('ada');

let dir: string;
let squig: FakeSquig;
let provider: SquigProvider;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wb-squig-'));
  process.env['WHITEBOARD_DATA_DIR'] = dir;
  squig = new FakeSquig();
  provider = new SquigProvider(CHECKOUT, async () => squig);
});

afterEach(() => {
  delete process.env['WHITEBOARD_DATA_DIR'];
  rmSync(dir, { recursive: true, force: true });
});

describe('SquigProvider', () => {
  it('round-trips notes, labels, clusters and links in the port vocabulary, attributed', async () => {
    const { created } = await provider.open('b');
    expect(created).toBe(true);
    const [cluster] = (await provider.add('b', ADA, [{ kind: 'cluster', title: 'Risks' }])).ids;
    const { ids } = await provider.add('b', ADA, [
      { kind: 'note', text: 'cold start', detail: 'the long why', cluster: cluster! },
      { kind: 'note', text: 'cost' },
      { kind: 'label', text: 'todo' },
    ]);
    const [inside, loose] = ids;
    await provider.add('b', ADA, [{ kind: 'link', from: inside!, to: loose!, label: 'drives' }]);

    const outline = await provider.read('b');
    const byText = (t: string) => outline.items.find((i) => i.text === t)!;
    expect(byText('Risks')).toMatchObject({ kind: 'cluster', createdBy: ADA });
    expect(byText('cold start')).toMatchObject({
      kind: 'note',
      detail: 'the long why',
      cluster,
      createdBy: ADA,
    });
    expect(byText('cost').cluster).toBeUndefined();
    expect(byText('todo').kind).toBe('label');
    expect(byText('drives')).toMatchObject({ kind: 'link', from: inside, to: loose });
    // Cluster titles and link labels are parts of their item, never items of their own.
    expect(outline.items).toHaveLength(5);
  });

  it('grows a cluster to hold its members and grids them inside the frame', async () => {
    await provider.open('b');
    const [c] = (await provider.add('b', ADA, [{ kind: 'cluster', title: 'C' }])).ids;
    await provider.add(
      'b',
      ADA,
      Array.from({ length: 6 }, (_, i) => ({ kind: 'note' as const, text: `n${i}`, cluster: c! })),
    );
    const outline = await provider.read('b');
    expect(outline.items.filter((i) => i.cluster === c)).toHaveLength(6);
  });

  it('`since` returns only what changed, including what a human drew in the editor', async () => {
    await provider.open('b');
    const { ids, version } = await provider.add('b', ADA, [
      { kind: 'note', text: 'a' },
      { kind: 'note', text: 'b' },
    ]);
    expect((await provider.read('b', version)).items).toEqual([]);

    // The human types a note of their own and moves one of ours.
    squig.doc.nodes['h1'] = {
      id: 'h1',
      type: 'text',
      x: 5,
      y: 5,
      w: 100,
      h: 40,
      text: 'mine',
      boxed: true,
    };
    squig.doc.order.push('h1');
    squig.doc.nodes[ids[0]!]!.x += 50;
    const diff = await provider.read('b', version);
    expect(diff.version).toBeGreaterThan(version);
    expect(diff.items.map((i) => [i.text, i.createdBy]).sort()).toEqual([
      ['a', ADA],
      ['mine', HUMAN],
    ]);

    // …then deletes one of ours.
    delete squig.doc.nodes[ids[1]!];
    squig.doc.order = squig.doc.order.filter((o) => o !== ids[1]);
    const after = await provider.read('b', diff.version);
    expect(after.removed).toEqual([ids[1]]);
  });

  it('refuses to reword or delete the other party’s item, and says so', async () => {
    await provider.open('b');
    squig.doc.nodes['h1'] = { id: 'h1', type: 'text', x: 0, y: 0, text: 'human idea', boxed: true };
    squig.doc.order.push('h1');
    const [mine] = (await provider.add('b', ADA, [{ kind: 'note', text: 'mine' }])).ids;
    const { refused } = await provider.edit('b', ADA, [
      { op: 'retitle', id: 'h1', text: 'reworded' },
      { op: 'delete', id: 'h1' },
      { op: 'retitle', id: mine!, text: 'mine, better' },
      { op: 'delete', id: 'nope' },
    ]);
    expect(refused.map((r) => r.id)).toEqual(['h1', 'h1', 'nope']);
    expect(refused[0]!.reason).toMatch(/not yours/);
    const texts = (await provider.read('b')).items.map((i) => i.text).sort();
    expect(texts).toEqual(['human idea', 'mine, better']);
  });

  it('moves anyone’s note into a cluster — converging is allowed — and out again', async () => {
    await provider.open('b');
    squig.doc.nodes['h1'] = {
      id: 'h1',
      type: 'text',
      x: 2000,
      y: 2000,
      w: 100,
      h: 40,
      text: 'h',
      boxed: true,
    };
    squig.doc.order.push('h1');
    const [c] = (await provider.add('b', ADA, [{ kind: 'cluster', title: 'C' }])).ids;
    expect(
      (await provider.edit('b', ADA, [{ op: 'move', id: 'h1', cluster: c! }])).refused,
    ).toEqual([]);
    expect((await provider.read('b')).items.find((i) => i.id === 'h1')!.cluster).toBe(c);
    await provider.edit('b', ADA, [{ op: 'move', id: 'h1', cluster: null, x: 3000, y: 3000 }]);
    expect((await provider.read('b')).items.find((i) => i.id === 'h1')!.cluster).toBeUndefined();
  });

  it('deleting an item takes its links with it; deleting a cluster leaves its members', async () => {
    await provider.open('b');
    const [c] = (await provider.add('b', ADA, [{ kind: 'cluster', title: 'C' }])).ids;
    const [a, b] = (
      await provider.add('b', ADA, [
        { kind: 'note', text: 'a', cluster: c! },
        { kind: 'note', text: 'b' },
      ])
    ).ids;
    await provider.add('b', ADA, [{ kind: 'link', from: a!, to: b!, label: 'x' }]);
    await provider.edit('b', ADA, [{ op: 'delete', id: b! }]);
    let items = (await provider.read('b')).items;
    expect(items.some((i) => i.kind === 'link')).toBe(false);
    expect(Object.values(squig.doc.nodes).some((n) => n.text === 'x')).toBe(false); // label gone too
    await provider.edit('b', ADA, [{ op: 'delete', id: c! }]);
    items = (await provider.read('b')).items;
    expect(items.map((i) => i.text)).toEqual(['a']);
  });

  it('refuses a bad link endpoint, a bad cluster and a paragraph headline — placing nothing', async () => {
    await provider.open('b');
    await expect(provider.add('b', ADA, [{ kind: 'link', from: 'x', to: 'y' }])).rejects.toThrow(
      /link endpoint/,
    );
    await expect(
      provider.add('b', ADA, [{ kind: 'note', text: 'n', cluster: 'zz' }]),
    ).rejects.toThrow(/not a cluster/);
    await expect(provider.add('b', ADA, [{ kind: 'note', text: 'x'.repeat(91) }])).rejects.toThrow(
      /headline/,
    );
    expect(Object.keys(squig.doc.nodes)).toEqual([]);
  });

  it('flags freehand and images as content the outline cannot carry', async () => {
    await provider.open('b');
    squig.doc.nodes['d1'] = { id: 'd1', type: 'draw', x: 0, y: 0 };
    squig.doc.order.push('d1');
    expect((await provider.read('b')).hasUnrepresentable).toBe(true);
  });

  it('keeps attribution across a service restart (the sidecar), and closes the companion', async () => {
    await provider.open('b');
    await provider.add('b', ADA, [{ kind: 'note', text: 'kept', detail: 'why' }]);
    await provider.close('b');
    expect(squig.closed).toBe(true);
    const again = new SquigProvider(CHECKOUT, async () => squig);
    const item = (await again.read('b')).items[0]!;
    expect(item).toMatchObject({ text: 'kept', detail: 'why', createdBy: ADA });
    expect((await again.list()).map((b) => b.name)).toEqual(['b']);
  });
});

describe("Squig's own tools through the provider (ADR 527)", () => {
  it('passes a tool through verbatim and attributes what an edit_document creates', async () => {
    await provider.open('b');
    const res = await provider.squigTool(
      'b',
      'edit_document',
      {
        revision: 1,
        operations: [
          {
            op: 'add',
            nodes: [
              { id: 'r1', type: 'text', text: 'raw note', boxed: true },
              { id: 'r2', type: 'shape', shape: 'rect' },
            ],
          },
        ],
      },
      ADA,
    );
    expect(res['createdIds']).toEqual(['r1', 'r2']);
    const items = (await provider.read('b')).items;
    expect(items.find((i) => i.id === 'r1')).toMatchObject({ kind: 'note', createdBy: ADA });
    // A plain shape is not a brainstorm item; it is honest about that rather than mislabelled.
    expect(items.find((i) => i.id === 'r2')).toMatchObject({ kind: 'other', createdBy: HUMAN });
    expect(await provider.squigTool('b', 'render_document', { format: 'png' })).toEqual({
      ok: true,
    });
    expect(squig.calls.at(-1)).toEqual(['render_document', { format: 'png' }]);
  });

  it('a linked board opens its own file, lists beside the rest, and refuses a relative path', async () => {
    const files: string[] = [];
    const p = new SquigProvider(CHECKOUT, async (file) => {
      files.push(file);
      return squig;
    });
    const team = join(dir, 'repo', 'docs', 'team.squig.json');
    p.link('team', team);
    // A linked board never creates folders (lane 01M47FADGV): the open fails until it exists.
    await expect(p.open('team')).rejects.toThrow();
    mkdirSync(join(dir, 'repo', 'docs'), { recursive: true });
    await p.open('team');
    expect(files).toEqual([team]);
    expect((await p.list()).map((b) => b.name)).toContain('team');
    expect(() => p.link('other', 'docs/x.squig.json')).toThrow(/absolute/);
    expect(() => p.link('team', join(dir, 'elsewhere.squig.json'))).toThrow(/close it/);
  });
});

describe('companionArgs (ADR 537)', () => {
  it('runs the vendored companion as plain JavaScript', () => {
    expect(
      companionArgs(
        {
          kind: 'vendored',
          root: '/v',
          entry: '/v/lib/agent/companion.mjs',
          loader: null,
          node: '/n',
        },
        '/b.squig.json',
      ),
    ).toEqual(['/v/lib/agent/companion.mjs', 'mcp', '/b.squig.json']);
  });
  it('runs a checkout through strip-types and its loader', () => {
    expect(
      companionArgs(
        {
          kind: 'checkout',
          root: '/c',
          entry: '/c/scripts/squig.ts',
          loader: '/c/scripts/register-loader.mjs',
          node: '/n',
        },
        '/b.squig.json',
      ),
    ).toEqual([
      '--experimental-strip-types',
      '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON',
      '--import',
      '/c/scripts/register-loader.mjs',
      '/c/scripts/squig.ts',
      'mcp',
      '/b.squig.json',
    ]);
  });
});
