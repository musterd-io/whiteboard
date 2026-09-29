/**
 * Provider tests run against the REAL TldrawProvider over live TLSocketRooms — not a fake.
 * The producer and the renderer are exercised through the same seam the tools use, so a board
 * that writes what it cannot read back fails here (the two-naive-halves trap).
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { UnknownRecord } from '@tldraw/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RoomManager } from '../sync/roomManager.js';
import { TldrawProvider } from './provider.js';
import { buildNote } from './records.js';

let dir: string;
let rooms: RoomManager;
let provider: TldrawProvider;

/** Read one shape straight out of a live room — for asserting on tldraw-side props. */
function snapshotShape(
  room: Awaited<ReturnType<RoomManager['ensureRoom']>>['room'],
  id: string,
): { props: Record<string, unknown> } {
  const snap = room.getCurrentSnapshot() as unknown as {
    documents: Array<{ state: { id: string; props?: Record<string, unknown> } }>;
  };
  return snap.documents.find((d) => d.state.id === id)!.state as {
    props: Record<string, unknown>;
  };
}

/** The whole record, for tests that need to write it back. */
function snapshotShapeFull(
  room: Awaited<ReturnType<RoomManager['ensureRoom']>>['room'],
  id: string,
): { id: string; props: Record<string, unknown> } {
  const snap = room.getCurrentSnapshot() as unknown as {
    documents: Array<{ state: { id: string } }>;
  };
  return snap.documents.find((d) => d.state.id === id)!.state as {
    id: string;
    props: Record<string, unknown>;
  };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'whiteboard-test-'));
  process.env['WHITEBOARD_DATA_DIR'] = dir;
  rooms = new RoomManager({ idleTimeoutMs: 60_000, persistIntervalMs: 60_000 });
  provider = new TldrawProvider(rooms);
});

afterEach(async () => {
  await rooms.persistAllAndClose();
  delete process.env['WHITEBOARD_DATA_DIR'];
  await rm(dir, { recursive: true, force: true });
});

describe('TldrawProvider', () => {
  it('opens empty, batch-adds, reads back attributed items', async () => {
    const { outline: empty, created } = await provider.open('b1');
    expect(created).toBe(true);
    expect(empty.items).toHaveLength(0);

    const { ids } = await provider.add('b1', 'seat:izzo', [
      { kind: 'note', text: 'idea one' },
      { kind: 'note', text: 'idea two' },
      { kind: 'cluster', title: 'Theme' },
    ]);
    expect(ids).toHaveLength(3);

    const outline = await provider.read('b1');
    expect(outline.items).toHaveLength(3);
    for (const item of outline.items) expect(item.createdBy).toBe('seat:izzo');
    expect(
      outline.items
        .filter((i) => i.kind === 'note')
        .map((i) => i.text)
        .sort(),
    ).toEqual(['idea one', 'idea two']);
  });

  it('links resolve to outline ids in the read', async () => {
    const { ids } = await provider.add('b2', 'seat:izzo', [
      { kind: 'note', text: 'cause' },
      { kind: 'note', text: 'effect' },
    ]);
    await provider.add('b2', 'seat:izzo', [
      { kind: 'link', from: ids[0]!, to: ids[1]!, label: 'leads to' },
    ]);
    const outline = await provider.read('b2');
    const link = outline.items.find((i) => i.kind === 'link')!;
    expect(link.from).toBe(ids[0]);
    expect(link.to).toBe(ids[1]);
    expect(link.text).toBe('leads to');
  });

  it('since-diff sees exactly what changed after a version — including human shapes', async () => {
    await provider.add('b3', 'seat:izzo', [{ kind: 'note', text: 'before' }]);
    const v1 = (await provider.read('b3')).version;

    // A human drawing in the browser lands as an unstamped record through the sync room.
    const { room } = await rooms.ensureRoom('b3');
    const humanNote = buildNote({ x: 500, y: 500, index: 'a9', createdBy: '' });
    humanNote.meta = {};
    humanNote.props['richText'] = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'human idea' }] }],
    };
    await room.updateStore((store) => store.put(humanNote as unknown as UnknownRecord));

    const diff = await provider.read('b3', v1);
    expect(diff.items.map((i) => i.text)).toEqual(['human idea']);
    expect(diff.items[0]!.createdBy).toBe('human');
    expect(diff.version).toBeGreaterThan(v1);
  });

  it('move touches anyone; retitle/delete of the other party is refused with a reason', async () => {
    const { ids } = await provider.add('b4', 'seat:izzo', [
      { kind: 'note', text: 'agent note' },
      { kind: 'cluster', title: 'Theme' },
    ]);
    const [noteId, clusterId] = ids as [string, string];

    // A human note the agent may move but not reword or remove.
    const { room } = await rooms.ensureRoom('b4');
    const humanNote = buildNote({ x: 0, y: 0, index: 'a8', createdBy: '' });
    humanNote.meta = {};
    await room.updateStore((store) => store.put(humanNote as unknown as UnknownRecord));

    const moved = await provider.edit('b4', 'seat:izzo', [
      { op: 'move', id: humanNote.id, cluster: clusterId },
    ]);
    expect(moved.refused).toHaveLength(0);
    const afterMove = await provider.read('b4');
    expect(afterMove.items.find((i) => i.id === humanNote.id)!.cluster).toBe(clusterId);

    const refused = await provider.edit('b4', 'seat:izzo', [
      { op: 'retitle', id: humanNote.id, text: 'reworded' },
      { op: 'delete', id: humanNote.id },
      { op: 'retitle', id: noteId, text: 'my own, reworded' },
    ]);
    expect(refused.refused).toHaveLength(2);
    for (const r of refused.refused) expect(r.reason).toMatch(/not yours/);
    const after = await provider.read('b4');
    expect(after.items.find((i) => i.id === noteId)!.text).toBe('my own, reworded');
    expect(after.items.find((i) => i.id === humanNote.id)).toBeDefined();
  });

  it('grids cluster members and grows the frame to fit — never stacks them at one point', async () => {
    const { ids } = await provider.add('b8', 'seat:izzo', [{ kind: 'cluster', title: 'Big' }]);
    const clusterId = ids[0]!;
    await provider.add(
      'b8',
      'seat:izzo',
      Array.from({ length: 7 }, (_, i) => ({
        kind: 'note' as const,
        text: `idea ${i}`,
        cluster: clusterId,
      })),
    );

    const outline = await provider.read('b8');
    const members = outline.items.filter((i) => i.cluster === clusterId);
    expect(members).toHaveLength(7);
    // Every member sits at its own point — the stacking bug that made a real board unreadable.
    const points = new Set(members.map((m) => `${m.x},${m.y}`));
    expect(points.size).toBe(7);

    // And the frame grew to hold three rows rather than clipping them.
    const { room } = await rooms.ensureRoom('b8');
    const frame = snapshotShape(room, clusterId);
    expect(frame.props['h']).toBeGreaterThan(3 * 200);
    expect(frame.props['w']).toBeGreaterThan(3 * 200);
  });

  it('a tall note pushes the row below it instead of colliding with it', async () => {
    const { ids } = await provider.add('b10', 'seat:izzo', [{ kind: 'cluster', title: 'Mixed' }]);
    const clusterId = ids[0]!;
    const noteIds = (
      await provider.add(
        'b10',
        'seat:izzo',
        Array.from({ length: 4 }, (_, i) => ({
          kind: 'note' as const,
          text: `n${i}`,
          cluster: clusterId,
        })),
      )
    ).ids;

    // The browser writes growth back as props.growY when a note's text overflows; simulate a
    // long note in the first row, then force a relayout by adding a fifth member.
    const { room } = await rooms.ensureRoom('b10');
    const tall = snapshotShapeFull(room, noteIds[0]!);
    await room.updateStore((store) =>
      store.put({ ...tall, props: { ...tall.props, growY: 600 } } as never),
    );
    await provider.add('b10', 'seat:izzo', [
      { kind: 'note', text: 'forces relayout', cluster: clusterId },
    ]);

    const outline = await provider.read('b10');
    const byId = new Map(outline.items.map((i) => [i.id, i]));
    const firstRowTop = byId.get(noteIds[0]!)!.y;
    const secondRowTop = byId.get(noteIds[3]!)!.y;
    // Row 2 must start below the 800px-tall note in row 1, not at a fixed 240 offset.
    expect(secondRowTop).toBeGreaterThanOrEqual(firstRowTop + 800);

    const frame = snapshotShape(room, clusterId);
    expect(frame.props['h']).toBeGreaterThan(secondRowTop);
  });

  it('refuses a note aimed at a cluster that does not exist, rather than orphaning it', async () => {
    await expect(
      provider.add('b11', 'seat:izzo', [
        { kind: 'note', text: 'would vanish', cluster: 'shape:not-a-cluster' },
      ]),
    ).rejects.toThrow(/is not a cluster on this board/);
    expect((await provider.read('b11')).items).toHaveLength(0);
  });

  it('refuses a note aimed at a note as if it were a cluster', async () => {
    const { ids } = await provider.add('b12', 'seat:izzo', [{ kind: 'note', text: 'plain note' }]);
    await expect(
      provider.add('b12', 'seat:izzo', [{ kind: 'note', text: 'nested?', cluster: ids[0]! }]),
    ).rejects.toThrow(/is not a cluster on this board/);
  });

  it('caps the headline and keeps detail off the canvas but in the read', async () => {
    const long = 'x'.repeat(200);
    await expect(provider.add('b13', 'seat:izzo', [{ kind: 'note', text: long }])).rejects.toThrow(
      /headline is 200 characters.*a sticky is a headline, not a paragraph/s,
    );

    const { ids } = await provider.add('b13', 'seat:izzo', [
      { kind: 'note', text: 'door 3 makes it a team', detail: long },
    ]);
    const item = (await provider.read('b13')).items.find((i) => i.id === ids[0])!;
    expect(item.text).toBe('door 3 makes it a team');
    expect(item.detail).toBe(long);

    // Detail must not reach the canvas: it lives in meta, not in the drawn props.
    const { room } = await rooms.ensureRoom('b13');
    const shape = snapshotShape(room, ids[0]!);
    expect(JSON.stringify(shape.props)).not.toContain(long);
  });

  it('resize is refused on anything that is not a cluster', async () => {
    const { ids } = await provider.add('b9', 'seat:izzo', [{ kind: 'note', text: 'a note' }]);
    const { refused } = await provider.edit('b9', 'seat:izzo', [
      { op: 'resize', id: ids[0]!, w: 500, h: 500 },
    ]);
    expect(refused).toHaveLength(1);
    expect(refused[0]!.reason).toMatch(/only a cluster/);
  });

  it('refuses a link to a nonexistent item in port vocabulary, placing nothing', async () => {
    await provider.add('b7', 'seat:izzo', [{ kind: 'note', text: 'real' }]);
    await expect(
      provider.add('b7', 'seat:izzo', [
        { kind: 'note', text: 'casualty' },
        { kind: 'link', from: 'shape:nope', to: 'shape:alsono' },
      ]),
    ).rejects.toThrow(/not an item on this board.*whiteboard_read/);
    // Atomic: the valid note in the same batch did not land either.
    const outline = await provider.read('b7');
    expect(outline.items.map((i) => i.text)).toEqual(['real']);
  });

  it('deleting a link owner cleans bindings; deleting a cluster frees its members', async () => {
    const { ids } = await provider.add('b5', 'seat:izzo', [
      { kind: 'note', text: 'a' },
      { kind: 'note', text: 'b' },
      { kind: 'cluster', title: 'T' },
    ]);
    const [a, b, cluster] = ids as [string, string, string];
    const linkRes = await provider.add('b5', 'seat:izzo', [{ kind: 'link', from: a, to: b }]);
    await provider.edit('b5', 'seat:izzo', [{ op: 'move', id: a, cluster }]);

    await provider.edit('b5', 'seat:izzo', [
      { op: 'delete', id: linkRes.ids[0]! },
      { op: 'delete', id: cluster },
    ]);
    const outline = await provider.read('b5');
    expect(outline.items.find((i) => i.kind === 'link')).toBeUndefined();
    const noteA = outline.items.find((i) => i.id === a)!;
    expect(noteA.cluster).toBeUndefined(); // freed, not vanished
  });

  it('ops in ONE batch see each other: [delete, retitle] cannot resurrect the note', async () => {
    // #1084 review REQUIRED 1, the exact demonstrated falsifier: the retitle used to read the
    // pre-batch snapshot, re-put the deleted shape, and refuse nothing.
    const { ids } = await provider.add('b14', 'seat:izzo', [{ kind: 'note', text: 'doomed' }]);
    const id = ids[0]!;
    const { refused } = await provider.edit('b14', 'seat:izzo', [
      { op: 'delete', id },
      { op: 'retitle', id, text: 'back from the dead' },
    ]);
    expect(refused).toHaveLength(1);
    expect(refused[0]!.id).toBe(id);
    const outline = await provider.read('b14');
    expect(outline.items.find((i) => i.id === id)).toBeUndefined();
  });

  it('a batch that moves a note into a cluster and deletes the cluster frees the note', async () => {
    // The overlay must apply to membership too: the move happened in-batch, so the delete's
    // reparenting sweep has to see it.
    const { ids } = await provider.add('b15', 'seat:izzo', [
      { kind: 'note', text: 'survivor' },
      { kind: 'cluster', title: 'Doomed cluster' },
    ]);
    const [noteId, clusterId] = ids as [string, string];
    const { refused } = await provider.edit('b15', 'seat:izzo', [
      { op: 'move', id: noteId, cluster: clusterId },
      { op: 'delete', id: clusterId },
    ]);
    expect(refused).toHaveLength(0);
    const outline = await provider.read('b15');
    const note = outline.items.find((i) => i.id === noteId)!;
    expect(note).toBeDefined();
    expect(note.cluster).toBeUndefined();
  });

  it('auto-places a new cluster to the RIGHT of existing content, never on the count-grid', async () => {
    // The count-grid landed new clusters far off-viewport on a 100+ shape board — the human
    // could not find what the agent just placed.
    const { ids } = await provider.add('b20', 'seat:izzo', [
      { kind: 'cluster', title: 'First' },
      { kind: 'note', text: 'a', cluster: undefined },
    ]);
    const outline1 = await provider.read('b20');
    const maxX = Math.max(
      ...outline1.items.filter((i) => i.x !== undefined).map((i) => i.x! + 400),
    );

    await provider.add('b20', 'seat:izzo', [{ kind: 'cluster', title: 'Second' }]);
    const outline2 = await provider.read('b20');
    const second = outline2.items.find((i) => i.kind === 'cluster' && i.text === 'Second')!;
    expect(second.x).toBeGreaterThanOrEqual(maxX - 400);
    expect(ids).toHaveLength(2);
  });

  it('auto-places a loose note BELOW existing content', async () => {
    await provider.add('b21', 'seat:izzo', [
      { kind: 'cluster', title: 'Stuff' },
      { kind: 'note', text: 'in', cluster: undefined },
    ]);
    const before = await provider.read('b21');
    const maxY = Math.max(...before.items.filter((i) => i.y !== undefined).map((i) => i.y!));

    await provider.add('b21', 'seat:izzo', [{ kind: 'note', text: 'late loose idea' }]);
    const after = await provider.read('b21');
    const loose = after.items.find((i) => i.text === 'late loose idea')!;
    expect(loose.y).toBeGreaterThan(maxY);
  });

  it('grids a small cluster two columns wide — a 3-note cluster is not a long strip', async () => {
    const { ids } = await provider.add('b22', 'seat:izzo', [{ kind: 'cluster', title: 'Small' }]);
    const clusterId = ids[0]!;
    await provider.add('b22', 'seat:izzo', [
      { kind: 'note', text: 'one', cluster: clusterId },
      { kind: 'note', text: 'two', cluster: clusterId },
      { kind: 'note', text: 'three', cluster: clusterId },
    ]);
    const outline = await provider.read('b22');
    const xs = new Set(outline.items.filter((i) => i.cluster === clusterId).map((i) => i.x));
    expect(xs.size).toBe(2);
  });

  it('the add result says where auto-placed items landed', async () => {
    await provider.add('b23', 'seat:izzo', [{ kind: 'cluster', title: 'Origin' }]);
    const { hint } = await provider.add('b23', 'seat:izzo', [
      { kind: 'cluster', title: 'Next' },
      { kind: 'note', text: 'loose' },
    ]);
    expect(hint).toMatch(/right of existing content/);
    expect(hint).toMatch(/below existing content/);
  });

  it('concurrent add and close both settle fulfilled and the survivor clock is on disk', async () => {
    // #1084 review REQUIRED 2: the fixed temp path let two writers corrupt each other's
    // atomic rename — an ordinary add() failed with raw ENOENT.
    await provider.add('b16', 'seat:izzo', [{ kind: 'note', text: 'first' }]);
    const results = await Promise.allSettled([
      provider.add('b16', 'seat:izzo', [{ kind: 'note', text: 'second' }]),
      provider.close('b16'),
    ]);
    for (const r of results) expect(r.status).toBe('fulfilled');
    const { outline } = await provider.open('b16');
    expect(outline.version).toBeGreaterThan(0);
    expect(outline.items.length).toBeGreaterThanOrEqual(1);
  });

  it('accepts outline-form ids (shape: prefix stripped) everywhere ids are taken', async () => {
    // The tool results show ids WITHOUT the shape: prefix; everything a caller copies from
    // a read or an add result must round-trip into edit, link endpoints, and cluster refs.
    const { ids } = await provider.add('b16', 'seat:izzo', [
      { kind: 'note', text: 'a' },
      { kind: 'note', text: 'b' },
      { kind: 'cluster', title: 'Theme' },
    ]);
    const short = ids.map((id) => id.replace(/^shape:/, '')) as [string, string, string];
    const [noteA, noteB, cluster] = short;

    const { refused } = await provider.edit('b16', 'seat:izzo', [
      { op: 'move', id: noteA, cluster },
    ]);
    expect(refused).toHaveLength(0);

    await provider.add('b16', 'seat:izzo', [
      { kind: 'link', from: noteA, to: noteB },
      { kind: 'note', text: 'c', cluster },
    ]);

    const outline = await provider.read('b16');
    expect(outline.items.find((i) => i.id === ids[0])!.cluster).toBe(ids[2]);
    expect(outline.items.find((i) => i.text === 'c')!.cluster).toBe(ids[2]);
    const link = outline.items.find((i) => i.kind === 'link')!;
    expect(link.from).toBe(ids[0]);
    expect(link.to).toBe(ids[1]);
  });

  it('boards persist across close and reopen', async () => {
    await provider.add('b6', 'seat:izzo', [{ kind: 'note', text: 'survives' }]);
    const finalOutline = await provider.close('b6');
    expect(finalOutline.items.map((i) => i.text)).toEqual(['survives']);
    expect(rooms.activeRoomCount()).toBe(0);

    const { outline, created } = await provider.open('b6');
    expect(created).toBe(false);
    expect(outline.items.map((i) => i.text)).toEqual(['survives']);

    const boards = await provider.list();
    expect(boards.map((b) => b.name)).toContain('b6');
  });
});
