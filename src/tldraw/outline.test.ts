import { describe, expect, it } from 'vitest';
import { outlineFromSnapshot, type RoomSnapshotLike } from './outline.js';
import {
  buildCluster,
  buildLink,
  buildNote,
  type ShapeRecord,
  type TldrawRecord,
} from './records.js';

function snapshotOf(
  records: TldrawRecord[],
  clocks?: number[],
  tombstones?: Record<string, number>,
): RoomSnapshotLike {
  const snap: RoomSnapshotLike = {
    documentClock: Math.max(0, ...(clocks ?? records.map((_, i) => i + 1))),
    documents: records.map((state, i) => ({ state, lastChangedClock: clocks?.[i] ?? i + 1 })),
  };
  if (tombstones) snap.tombstones = tombstones;
  return snap;
}

const base = { x: 0, y: 0, index: 'a1', createdBy: 'seat:izzo' };

describe('outlineFromSnapshot', () => {
  it('round-trips notes, clusters, and links built by the adapter — the write half is readable by the read half', () => {
    const cluster = buildCluster({ ...base, title: 'Theme A' });
    const note = buildNote({ ...base, text: 'auth is the bottleneck' });
    note.parentId = cluster.id;
    const loose = buildNote({ ...base, text: 'ship it weekly' });
    const { arrow, bindings } = buildLink({ ...base, label: 'causes' }, note.id, loose.id);

    const outline = outlineFromSnapshot(
      't',
      snapshotOf([cluster, note, loose, arrow, ...bindings]),
    );

    const byId = new Map(outline.items.map((i) => [i.id, i]));
    expect(byId.get(cluster.id)).toMatchObject({ kind: 'cluster', text: 'Theme A' });
    expect(byId.get(note.id)).toMatchObject({
      kind: 'note',
      text: 'auth is the bottleneck',
      cluster: cluster.id,
    });
    expect(byId.get(loose.id)!.cluster).toBeUndefined();
    expect(byId.get(arrow.id)).toMatchObject({
      kind: 'link',
      text: 'causes',
      from: note.id,
      to: loose.id,
    });
    // Bindings are plumbing, not items.
    expect(outline.items).toHaveLength(4);
    expect(outline.hasUnrepresentable).toBe(false);
  });

  it('attributes unstamped shapes to the human hand', () => {
    const agentNote = buildNote({ ...base, text: 'mine' });
    const humanNote = buildNote({ ...base, text: 'yours' });
    humanNote.meta = {}; // drawn in the browser: no createdBy stamp
    const outline = outlineFromSnapshot('t', snapshotOf([agentNote, humanNote]));
    const byText = new Map(outline.items.map((i) => [i.text, i]));
    expect(byText.get('mine')!.createdBy).toBe('seat:izzo');
    expect(byText.get('yours')!.createdBy).toBe('human');
  });

  it('since returns only later changes plus tombstoned removals', () => {
    const a = buildNote({ ...base, text: 'old' });
    const b = buildNote({ ...base, text: 'new' });
    const outline = outlineFromSnapshot(
      't',
      snapshotOf([a, b], [3, 7], { 'shape:gone': 6, 'shape:ancient': 2 }),
      5,
    );
    expect(outline.items.map((i) => i.text)).toEqual(['new']);
    expect(outline.removed).toEqual(['shape:gone']);
    expect(outline.version).toBe(7);
  });

  it('flags freehand content the outline cannot carry', () => {
    const draw: ShapeRecord = {
      ...buildNote({ ...base, text: '' }),
      type: 'draw',
      props: {},
    };
    const outline = outlineFromSnapshot('t', snapshotOf([draw]));
    expect(outline.hasUnrepresentable).toBe(true);
    expect(outline.items[0]!.kind).toBe('other');
  });
});
