/**
 * The tldraw provider — implements the port over a RoomManager of live TLSocketRooms.
 * Agent mutations go through room.updateStore, so a connected browser sees them the moment
 * they land; every mutation persists write-through (boards are small).
 */
import type { UnknownRecord } from '@tldraw/store';
import type { TLSocketRoom } from '@tldraw/sync-core';
import type {
  CreatedBy,
  EditOp,
  EditRefusal,
  ItemInput,
  Outline,
  WhiteboardProvider,
} from '../port.js';
import { assertBoardName, NOTE_TEXT_MAX } from '../port.js';
import { listBoards } from '../sync/persistence.js';
import type { RoomManager } from '../sync/roomManager.js';
import { outlineFromSnapshot, shapeCount, type RoomSnapshotLike } from './outline.js';
import {
  buildCluster,
  buildLabel,
  buildLink,
  buildNote,
  nextIndex,
  PAGE_ID,
  richTextToPlain,
  toRichText,
  type BindingRecord,
  type ShapeRecord,
} from './records.js';

type Room = TLSocketRoom<UnknownRecord, void>;

// Cluster layout. A tldraw note is 200x200; these are the gaps and padding around them.
const CLUSTER_COLS = 3;
const CLUSTER_GAP = 40;
const CLUSTER_PAD = 60;
const MEMBER_W = 200;
const MEMBER_H = 200;

function snap(room: Room): RoomSnapshotLike {
  return room.getCurrentSnapshot() as unknown as RoomSnapshotLike;
}

/**
 * Ids in tool results are shown WITHOUT the `shape:` prefix (mcp/format.ts strips it), so
 * every id a caller hands back is accepted in either form. Store records always carry the
 * full form.
 */
function fullId(id: string): string {
  return id.startsWith('shape:') ? id : `shape:${id}`;
}

/**
 * Bounding box of the board's top-level content (page children; arrows excluded — their x/y
 * are anchors, not extents). Drives placement of new items NEXT TO what exists: the old
 * count-grid landed additions far off-viewport on a mature board, where the human at the
 * browser could not find what the agent had just placed.
 */
function contentBounds(
  s: RoomSnapshotLike,
): { minX: number; minY: number; maxX: number; maxY: number } | null {
  let out: { minX: number; minY: number; maxX: number; maxY: number } | null = null;
  for (const d of s.documents) {
    if (d.state.typeName !== 'shape') continue;
    const sh = d.state as ShapeRecord;
    if (sh.type === 'arrow' || sh.parentId !== PAGE_ID) continue;
    const w =
      sh.type === 'frame' && typeof sh.props['w'] === 'number' ? (sh.props['w'] as number) : 200;
    const h =
      sh.type === 'frame' && typeof sh.props['h'] === 'number'
        ? (sh.props['h'] as number)
        : memberHeight(sh);
    if (!out) out = { minX: sh.x, minY: sh.y, maxX: sh.x + w, maxY: sh.y + h };
    else {
      out.minX = Math.min(out.minX, sh.x);
      out.minY = Math.min(out.minY, sh.y);
      out.maxX = Math.max(out.maxX, sh.x + w);
      out.maxY = Math.max(out.maxY, sh.y + h);
    }
  }
  return out;
}

const PLACE_MARGIN = 120;
const LOOSE_STEP_X = 240;
const LOOSE_STEP_Y = 260;
const LOOSE_COLS = 4;
const CLUSTER_STEP_Y = 420;

function getShape(room: Room, id: string): ShapeRecord | undefined {
  const doc = snap(room).documents.find((d) => d.state.id === fullId(id));
  return doc && doc.state.typeName === 'shape' ? (doc.state as ShapeRecord) : undefined;
}

/**
 * A member's rendered height. A tldraw note is 200 wide but grows DOWN to fit its text, and
 * the browser writes that growth back as props.growY — so a long note is 700+ tall and a
 * fixed-size layout puts the next row straight through it.
 */
function memberHeight(shape: ShapeRecord): number {
  const props = shape.props;
  if (shape.type === 'note') {
    // Two sources, take the larger. props.growY is authoritative but only exists AFTER a
    // browser has rendered and measured the note — laying out from it alone means the first
    // pass under-sizes every fresh note and the row below lands on top of it. The estimate
    // is independent of any client, so the layout is stable before anyone has looked.
    const growY = props['growY'];
    const measured = MEMBER_H + (typeof growY === 'number' ? growY : 0);
    return Math.max(measured, estimatedNoteHeight(richTextToPlain(props['richText'])));
  }
  const h = props['h'];
  return typeof h === 'number' ? h : MEMBER_H;
}

/** A note is 200 wide and wraps at roughly this many characters at the default text size. */
const NOTE_CHARS_PER_LINE = 22;
const NOTE_LINE_HEIGHT = 28;
const NOTE_TEXT_PAD = 48;

function estimatedNoteHeight(text: string): number {
  const lines = text
    .split('\n')
    .reduce((n, line) => n + Math.max(1, Math.ceil(line.length / NOTE_CHARS_PER_LINE)), 0);
  return Math.max(MEMBER_H, lines * NOTE_LINE_HEIGHT + NOTE_TEXT_PAD);
}

function ownedBy(shape: ShapeRecord, actor: CreatedBy): boolean {
  const v = (shape.meta as Record<string, unknown>)['createdBy'];
  const creator = typeof v === 'string' && v.startsWith('seat:') ? v : 'human';
  return creator === actor;
}

export class TldrawProvider implements WhiteboardProvider {
  constructor(private rooms: RoomManager) {}

  async open(board: string): Promise<{ outline: Outline; created: boolean }> {
    assertBoardName(board);
    const { room, created } = await this.rooms.ensureRoom(board);
    return { outline: outlineFromSnapshot(board, snap(room)), created };
  }

  async add(
    board: string,
    actor: CreatedBy,
    rawItems: ItemInput[],
  ): Promise<{ ids: string[]; version: number; hint?: string }> {
    // Accept outline-form ids (prefix stripped) wherever an item references another.
    const items = rawItems.map((item): ItemInput => {
      if (item.kind === 'link') return { ...item, from: fullId(item.from), to: fullId(item.to) };
      if (item.kind === 'note' && item.cluster !== undefined)
        return { ...item, cluster: fullId(item.cluster) };
      return item;
    });
    const { room } = await this.rooms.ensureRoom(board);
    const ids: string[] = [];
    const touchedClusters = new Set<string>();
    let count = shapeCount(snap(room));

    // Pre-validate link endpoints in OUR vocabulary before touching the store — the whole
    // batch is atomic, and a canvas-level validation error would teach the wrong terms.
    const known = new Set(
      snap(room)
        .documents.filter((d) => d.state.typeName === 'shape')
        .map((d) => d.state.id),
    );
    const clusters = new Set(
      snap(room)
        .documents.filter(
          (d) => d.state.typeName === 'shape' && (d.state as ShapeRecord).type === 'frame',
        )
        .map((d) => d.state.id),
    );
    for (const item of items) {
      if (item.kind === 'link') {
        for (const end of [item.from, item.to]) {
          if (!known.has(end)) {
            throw new Error(
              `link endpoint ${JSON.stringify(end)} is not an item on this board — use ids from the outline (whiteboard_read); nothing was placed`,
            );
          }
        }
      }
      // A bad cluster id used to be accepted silently, orphaning the note where nobody could
      // see it — including the board's own author, mid-session.
      if (item.kind === 'note' && item.cluster !== undefined && !clusters.has(item.cluster)) {
        throw new Error(
          `cluster ${JSON.stringify(item.cluster)} is not a cluster on this board — create it first, or use an id from whiteboard_read; nothing was placed`,
        );
      }
      // A whiteboard is scanned, not read. Paragraph-length stickies are unreadable at the
      // zoom anyone actually views the board at, so the headline is capped and the thinking
      // goes to `detail` (off-canvas, returned on every read).
      if (item.kind === 'note' && item.text.length > NOTE_TEXT_MAX) {
        throw new Error(
          `note headline is ${item.text.length} characters, over the ${NOTE_TEXT_MAX} limit — ` +
            `a sticky is a headline, not a paragraph. Shorten \`text\` and move the rest to ` +
            `\`detail\`, which stays off the canvas and comes back on every read. Nothing was placed.`,
        );
      }
    }

    // Content-aware placement cursors: new clusters flow DOWN a column to the RIGHT of the
    // existing content; loose notes/labels flow in rows BELOW it. Explicit x/y always wins,
    // and members of a cluster are gridded by relayoutCluster regardless.
    const bounds = contentBounds(snap(room));
    const clusterX = bounds ? bounds.maxX + PLACE_MARGIN : 100;
    let clusterY = bounds ? bounds.minY : 100;
    const looseOriginX = bounds ? bounds.minX : 100;
    let looseY = bounds ? bounds.maxY + PLACE_MARGIN : 100;
    let looseN = 0;
    let clustersPlaced = 0;
    let loosePlaced = 0;
    // An empty board and a populated one need different cursors for clusters vs loose items;
    // on an empty board give loose items their own row below where a first cluster would go.
    if (!bounds) looseY = 600;

    const nextAutoPos = (item: ItemInput): { x: number; y: number } => {
      if (item.kind === 'cluster') {
        const pos = { x: clusterX, y: clusterY };
        clusterY += CLUSTER_STEP_Y;
        clustersPlaced++;
        return pos;
      }
      const pos = {
        x: looseOriginX + (looseN % LOOSE_COLS) * LOOSE_STEP_X,
        y: looseY + Math.floor(looseN / LOOSE_COLS) * LOOSE_STEP_Y,
      };
      // A note headed into a cluster is re-gridded by relayoutCluster; don't burn a slot.
      if (!(item.kind === 'note' && item.cluster)) {
        looseN++;
        if (item.kind !== 'link') loosePlaced++;
      }
      return pos;
    };

    await room.updateStore((store) => {
      for (const item of items) {
        const pos =
          'x' in item && item.x !== undefined && item.y !== undefined
            ? { x: item.x, y: item.y }
            : nextAutoPos(item);
        const base = { ...pos, index: nextIndex(count), createdBy: actor };
        count++;

        switch (item.kind) {
          case 'note': {
            const note = buildNote({
              ...base,
              text: item.text,
              ...(item.color ? { color: item.color } : {}),
              ...(item.detail ? { detail: item.detail } : {}),
            });
            // Position inside a cluster is not the caller's business — relayoutCluster()
            // below grids every member and grows the frame to fit.
            if (item.cluster) {
              note.parentId = item.cluster;
              touchedClusters.add(item.cluster);
            }
            store.put(note as unknown as UnknownRecord);
            ids.push(note.id);
            break;
          }
          case 'label': {
            const label = buildLabel({ ...base, text: item.text });
            store.put(label as unknown as UnknownRecord);
            ids.push(label.id);
            break;
          }
          case 'cluster': {
            const cluster = buildCluster({ ...base, title: item.title });
            store.put(cluster as unknown as UnknownRecord);
            ids.push(cluster.id);
            break;
          }
          case 'link': {
            const { arrow, bindings } = buildLink(
              { ...base, ...(item.label !== undefined ? { label: item.label } : {}) },
              item.from,
              item.to,
            );
            store.put(arrow as unknown as UnknownRecord);
            for (const b of bindings) store.put(b as unknown as UnknownRecord);
            ids.push(arrow.id);
            break;
          }
        }
      }
    });

    for (const clusterId of touchedClusters) await this.relayoutCluster(room, clusterId);
    await this.rooms.persist(board);

    const hints: string[] = [];
    if (bounds && clustersPlaced > 0)
      hints.push(
        `${clustersPlaced} cluster(s) placed right of existing content — zoom out to see them`,
      );
    if (bounds && loosePlaced > 0)
      hints.push(`${loosePlaced} loose item(s) placed below existing content`);
    return {
      ids,
      version: snap(room).documentClock,
      ...(hints.length ? { hint: hints.join('; ') } : {}),
    };
  }

  /**
   * Grid a cluster's members and grow the frame to fit them. Called after any change to
   * membership, so a cluster is never smaller than what it holds — the failure mode that
   * made a real board unreadable (notes stacked at one point, inside a frame too small to
   * show them). Members keep their relative order; positions are the layout's business,
   * not the caller's.
   */
  private async relayoutCluster(room: Room, clusterId: string): Promise<void> {
    const s = snap(room);
    const frame = s.documents.find((d) => d.state.id === clusterId)?.state as
      | ShapeRecord
      | undefined;
    if (!frame || frame.type !== 'frame') return;

    const members = s.documents
      .map((d) => d.state)
      .filter((r): r is ShapeRecord => r.typeName === 'shape' && r.parentId === clusterId)
      .sort((a, b) => (a.index < b.index ? -1 : a.index > b.index ? 1 : 0));

    // Small clusters grid 2-wide so they read as a block, not a strip; bigger ones fill out.
    const maxCols = members.length <= 4 ? 2 : CLUSTER_COLS;
    const cols = Math.max(1, Math.min(members.length, maxCols));
    let cursorY = CLUSTER_PAD;
    const placed: Array<{ member: ShapeRecord; x: number; y: number }> = [];

    // Row by row, each row as tall as its tallest member. Order-preserving, and it accounts
    // for the fact that a note GROWS with its text — long content makes a 700px-tall sticky,
    // which is what overflowed the frame and collided with the row below.
    for (let i = 0; i < members.length; i += cols) {
      const row = members.slice(i, i + cols);
      row.forEach((member, j) => {
        placed.push({
          member,
          x: CLUSTER_PAD + j * (MEMBER_W + CLUSTER_GAP),
          y: cursorY,
        });
      });
      cursorY += Math.max(...row.map(memberHeight)) + CLUSTER_GAP;
    }

    await room.updateStore((store) => {
      for (const { member, x, y } of placed) {
        store.put({ ...member, x, y } as unknown as UnknownRecord);
      }
      store.put({
        ...frame,
        props: {
          ...frame.props,
          w: CLUSTER_PAD * 2 + cols * MEMBER_W + (cols - 1) * CLUSTER_GAP,
          h: Math.max(CLUSTER_PAD * 2 + MEMBER_H, cursorY - CLUSTER_GAP + CLUSTER_PAD),
        },
      } as unknown as UnknownRecord);
    });
  }

  async read(board: string, since?: number): Promise<Outline> {
    const { room } = await this.rooms.ensureRoom(board);
    return outlineFromSnapshot(board, snap(room), since);
  }

  async edit(
    board: string,
    actor: CreatedBy,
    rawOps: EditOp[],
  ): Promise<{ version: number; refused: EditRefusal[] }> {
    // Accept outline-form ids (prefix stripped) on every op.
    const ops = rawOps.map((op): EditOp => {
      const normalized = { ...op, id: fullId(op.id) };
      if (normalized.op === 'move' && normalized.cluster != null)
        normalized.cluster = fullId(normalized.cluster);
      return normalized;
    });
    const { room } = await this.rooms.ensureRoom(board);
    const refused: EditRefusal[] = [];
    const touchedClusters = new Set<string>();

    await room.updateStore((store) => {
      // In-batch overlay (#1084 review, REQUIRED 1): updateStore's snapshot is the COMMITTED
      // store — the callback's own puts/deletes are not in it, so a second op on the same id
      // used to read pre-batch state, and a [delete, retitle] batch resurrected the note it
      // had just deleted, refusing nothing. Every read and write in this callback goes
      // through the overlay so ops see each other. null = deleted this batch.
      const overlay = new Map<string, ShapeRecord | null>();
      const resolveShape = (id: string): ShapeRecord | undefined =>
        overlay.has(id) ? (overlay.get(id) ?? undefined) : getShape(room, id);
      const putShape = (s: ShapeRecord): void => {
        store.put(s as unknown as UnknownRecord);
        overlay.set(s.id, s);
      };
      const deleteShape = (id: string): void => {
        store.delete(id);
        overlay.set(id, null);
      };
      const deletedBindings = new Set<string>();

      for (const op of ops) {
        const shape = resolveShape(op.id);
        if (!shape) {
          refused.push({
            id: op.id,
            reason: 'no such item on this board — read the outline again',
          });
          continue;
        }

        switch (op.op) {
          case 'move': {
            // Moving anyone's item is allowed: proposing a grouping IS the converge mechanic.
            const updated: ShapeRecord = { ...shape, parentId: op.cluster ?? PAGE_ID };
            if (op.x !== undefined) updated.x = op.x;
            if (op.y !== undefined) updated.y = op.y;
            putShape(updated);
            // Both the old and new cluster re-fit: one loses a member, one gains.
            if (op.cluster) touchedClusters.add(op.cluster);
            if (shape.parentId !== PAGE_ID) touchedClusters.add(shape.parentId);
            break;
          }
          case 'resize': {
            if (shape.type !== 'frame') {
              refused.push({
                id: op.id,
                reason: 'only a cluster can be resized — notes and labels size themselves',
              });
              continue;
            }
            putShape({
              ...shape,
              props: { ...shape.props, w: op.w, h: op.h },
            });
            break;
          }
          case 'retitle': {
            if (!ownedBy(shape, actor)) {
              refused.push({
                id: op.id,
                reason: `rewording the other party's item is not yours to do — add your own note beside it, or ask them`,
              });
              continue;
            }
            const props = { ...shape.props };
            if (shape.type === 'frame') props['name'] = op.text;
            else props['richText'] = toRichText(op.text);
            putShape({ ...shape, props });
            break;
          }
          case 'delete': {
            if (!ownedBy(shape, actor)) {
              refused.push({
                id: op.id,
                reason: `deleting the other party's item is not yours to do — say why it should go, on the board or in chat`,
              });
              continue;
            }
            // Bindings referencing a deleted shape must go with it; a deleted cluster's
            // children return to the open board rather than vanishing. Membership resolves
            // through the overlay so an in-batch move into (or out of) this cluster counts.
            const s = snap(room);
            for (const doc of s.documents) {
              const r = doc.state;
              if (r.typeName === 'binding') {
                const b = r as BindingRecord;
                if ((b.fromId === op.id || b.toId === op.id) && !deletedBindings.has(b.id)) {
                  store.delete(b.id);
                  deletedBindings.add(b.id);
                }
              } else if (r.typeName === 'shape') {
                const current = resolveShape(r.id);
                if (current && current.parentId === op.id) {
                  putShape({ ...current, parentId: PAGE_ID });
                }
              }
            }
            deleteShape(op.id);
            if (shape.parentId !== PAGE_ID) touchedClusters.add(shape.parentId);
            break;
          }
        }
      }
    });

    for (const clusterId of touchedClusters) await this.relayoutCluster(room, clusterId);
    await this.rooms.persist(board);
    return { version: snap(room).documentClock, refused };
  }

  async list(): Promise<Array<{ name: string; updatedAt: number }>> {
    return listBoards();
  }

  async close(board: string): Promise<Outline> {
    const { room } = await this.rooms.ensureRoom(board);
    const outline = outlineFromSnapshot(board, snap(room));
    await this.rooms.closeRoom(board);
    return outline;
  }
}
