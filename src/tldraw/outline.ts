/**
 * Snapshot → Outline: the read half of the tldraw adapter. Pure functions; the input is the
 * room snapshot shape @tldraw/sync's TLSocketRoom.getCurrentSnapshot() returns
 * ({ clock, documents: [{ state, lastChangedClock }], tombstones }).
 */
import type { CreatedBy, Outline, OutlineItem } from '../port.js';
import {
  richTextToPlain,
  type BindingRecord,
  type ShapeRecord,
  type TldrawRecord,
} from './records.js';

export interface RoomSnapshotLike {
  documentClock: number;
  documents: Array<{ state: TldrawRecord; lastChangedClock: number }>;
  /** id → clock at which the record was deleted. */
  tombstones?: Record<string, number>;
}

function isShape(r: TldrawRecord): r is ShapeRecord {
  return r.typeName === 'shape';
}

function isArrowBinding(r: TldrawRecord): r is BindingRecord {
  return r.typeName === 'binding' && (r as BindingRecord).type === 'arrow';
}

function createdBy(shape: ShapeRecord): CreatedBy {
  const v = (shape.meta as Record<string, unknown>)['createdBy'];
  // Unstamped = drawn by a human hand in the browser (ADR 330 decision 5).
  return typeof v === 'string' && v.startsWith('seat:') ? (v as CreatedBy) : 'human';
}

function shapeText(shape: ShapeRecord): string {
  const props = shape.props;
  const rich = props['richText'];
  if (rich) {
    const t = richTextToPlain(rich);
    if (t) return t;
  }
  for (const key of ['text', 'name', 'label'] as const) {
    const v = props[key];
    if (typeof v === 'string' && v) return v;
  }
  return '';
}

const KIND_BY_TYPE: Record<string, OutlineItem['kind']> = {
  note: 'note',
  text: 'label',
  frame: 'cluster',
  arrow: 'link',
};

/**
 * Build the outline. With `since`, `items` holds only shapes whose lastChangedClock > since
 * and `removed` the tombstoned ids past it — but link endpoints and cluster membership are
 * always resolved against the FULL board, so a diff never dangles.
 */
export function outlineFromSnapshot(
  board: string,
  snap: RoomSnapshotLike,
  since?: number,
): Outline {
  const shapes = new Map<string, { shape: ShapeRecord; changed: number }>();
  const bindings: BindingRecord[] = [];
  let hasUnrepresentable = false;

  for (const doc of snap.documents) {
    const r = doc.state;
    if (isShape(r)) {
      shapes.set(r.id, { shape: r, changed: doc.lastChangedClock });
      if (!(r.type in KIND_BY_TYPE)) hasUnrepresentable = true;
    } else if (isArrowBinding(r)) {
      bindings.push(r);
    }
  }

  // Arrow endpoints come from binding records (tldraw 4.x), keyed by the arrow's shape id.
  const endpoints = new Map<string, { from?: string; to?: string }>();
  for (const b of bindings) {
    const e = endpoints.get(b.fromId) ?? {};
    const terminal = (b.props as Record<string, unknown>)['terminal'];
    if (terminal === 'start') e.from = b.toId;
    else if (terminal === 'end') e.to = b.toId;
    endpoints.set(b.fromId, e);
  }

  const clusterIds = new Set(
    [...shapes.values()].filter(({ shape }) => shape.type === 'frame').map(({ shape }) => shape.id),
  );

  const items: OutlineItem[] = [];
  for (const { shape, changed } of shapes.values()) {
    if (since !== undefined && changed <= since) continue;
    const kind = KIND_BY_TYPE[shape.type] ?? 'other';
    const detail = (shape.meta as Record<string, unknown>)['detail'];
    const item: OutlineItem = {
      id: shape.id,
      kind,
      text: shapeText(shape),
      createdBy: createdBy(shape),
      x: shape.x,
      y: shape.y,
      ...(typeof detail === 'string' && detail ? { detail } : {}),
    };
    if (clusterIds.has(shape.parentId)) item.cluster = shape.parentId;
    if (kind === 'link') {
      const e = endpoints.get(shape.id);
      if (e?.from) item.from = e.from;
      if (e?.to) item.to = e.to;
    }
    items.push(item);
  }

  const removed =
    since === undefined
      ? []
      : Object.entries(snap.tombstones ?? {})
          .filter(([id, clock]) => clock > since && id.startsWith('shape:'))
          .map(([id]) => id);

  return { board, version: snap.documentClock, items, removed, hasUnrepresentable };
}

/** Count shapes on the board — feeds the auto-layout grid. */
export function shapeCount(snap: RoomSnapshotLike): number {
  return snap.documents.filter((d) => isShape(d.state)).length;
}
