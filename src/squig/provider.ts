/**
 * The Squig provider — implements the port over one live Squig companion per board (ADR 524).
 * Boards live under the whiteboard's own data dir (`~/.whiteboard/squig/<board>.squig.json`,
 * ADR 330 decision 1), never in a repository (decision 6). The companion stays up from open to
 * close so the human's editor tab keeps working; every port call re-reads the document, so what
 * the human drew since is always in the next answer.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { dataDir } from '../data-dir.js';
import type {
  CreatedBy,
  EditOp,
  EditRefusal,
  ItemInput,
  Outline,
  WhiteboardProvider,
} from '../port.js';
import { assertBoardName, NOTE_TEXT_MAX } from '../port.js';
import type { SquigCheckout } from './checkout.js';
import {
  CLUSTER_PAD,
  clusterFrames,
  containingCluster,
  contentBounds,
  emptyMeta,
  layoutCluster,
  NOTE_W,
  noteHeight,
  outlineOf,
  syncMeta,
  type BoardMeta,
  type MetaEntry,
} from './model.js';
import {
  SquigSession,
  type SquigConnection,
  type SquigDocument,
  type SquigOp,
  type SquigToolName,
} from './session.js';

export function squigDir(): string {
  return join(dataDir(), 'squig');
}

function boardFile(board: string): string {
  assertBoardName(board);
  return join(squigDir(), `${board}.squig.json`);
}

function metaFile(board: string): string {
  return join(squigDir(), `${board}.meta.json`);
}

/** An empty Squig file, the shape `squig new` writes. */
function emptyDocument(board: string): unknown {
  return {
    app: 'squig',
    version: 1,
    fileName: board,
    look: { theme: 'internet-blue', paper: 'subtle', font: 'hand', grid: true },
    nodes: {},
    order: [],
    variations: [],
    comments: [],
  };
}

function newId(): string {
  return `wb_${randomBytes(6).toString('hex')}`;
}

function ownedBy(meta: BoardMeta, id: string, actor: CreatedBy): boolean {
  return (meta.items[id]?.createdBy ?? 'human') === actor;
}

const CLUSTER_W = 600;
const CLUSTER_H = 360;
const PLACE_MARGIN = 120;
const LOOSE_STEP_X = NOTE_W + 40;
const LOOSE_STEP_Y = 180;
const LOOSE_COLS = 4;
const CLUSTER_STEP_Y = CLUSTER_H + 80;

export type Connect = (file: string) => Promise<SquigConnection>;

interface Board {
  conn: SquigConnection;
  meta: BoardMeta;
}

export class SquigProvider implements WhiteboardProvider {
  private boards = new Map<string, Promise<Board>>();
  private queues = new Map<string, Promise<unknown>>();
  private connect: Connect;
  /** Linked boards (ADR 527): a board name bound to a file the workspace chose, e.g. a repo. */
  private links = new Map<string, string>();

  constructor(checkout: SquigCheckout, connect?: Connect) {
    this.connect = connect ?? ((file) => SquigSession.start(checkout, file));
  }

  /** The editor URL for an open board — handed to the human (it carries the access token). */
  async editorUrl(board: string): Promise<string> {
    return (await this.board(board)).conn.editorUrl;
  }

  /**
   * Bind a board name to an existing `.squig.json` outside the data dir (ADR 527) — the team
   * canvas in the repo, say. Opt-in by the workspace that names it; re-linking to the same file
   * is a no-op, and a board cannot be re-pointed while it is open.
   */
  link(board: string, file: string): void {
    assertBoardName(board);
    if (!isAbsolute(file) || !file.endsWith('.squig.json'))
      throw new Error(
        `a linked board needs an absolute path to a .squig.json file, got ${JSON.stringify(file)}`,
      );
    const current = this.links.get(board);
    if (current === file) return;
    if (current !== undefined && this.boards.has(board))
      throw new Error(
        `board "${board}" is open on ${current} — close it before linking it elsewhere`,
      );
    this.links.set(board, file);
  }

  private fileFor(board: string): string {
    return this.links.get(board) ?? boardFile(board);
  }

  /**
   * One of Squig's own tools on a board (ADR 527), verbatim, so nothing Squig can do is lost by
   * going through the whiteboard. Shapes an attributed caller creates with `edit_document` are
   * stamped in the sidecar like any `whiteboard_add`; a ledger sync follows every call so the
   * next `since` read sees the change.
   */
  async squigTool(
    board: string,
    name: SquigToolName,
    args: Record<string, unknown>,
    actor?: CreatedBy,
  ): Promise<Record<string, unknown>> {
    return this.serial(board, async () => {
      const b = await this.board(board);
      await this.sync(board, b);
      const result = await b.conn.tool(name, args);
      if (name === 'edit_document' && actor && Array.isArray(result['createdIds'])) {
        const { document } = await b.conn.read();
        for (const id of result['createdIds'] as string[]) {
          const node = document.nodes[id];
          if (!node || b.meta.items[id]) continue;
          const role =
            node.type === 'arrow'
              ? 'link'
              : node.type === 'text'
                ? node.boxed
                  ? 'note'
                  : 'label'
                : null;
          if (role) b.meta.items[id] = { role, createdBy: actor };
        }
      }
      await this.sync(board, b);
      await saveMeta(board, b.meta);
      return result;
    });
  }

  /** One call at a time per board: every call is read-diff-write against the live file. */
  private serial<T>(board: string, work: () => Promise<T>): Promise<T> {
    const next = (this.queues.get(board) ?? Promise.resolve()).catch(() => {}).then(work);
    this.queues.set(
      board,
      next.catch(() => {}),
    );
    return next;
  }

  private board(board: string): Promise<Board> {
    let pending = this.boards.get(board);
    if (!pending) {
      pending = (async () => {
        const file = this.fileFor(board);
        await mkdir(squigDir(), { recursive: true });
        // A linked board writes only where its folder already exists — the link route never
        // creates directories (lane 01M47FADGV).
        if (!this.links.has(board)) await mkdir(dirname(file), { recursive: true });
        try {
          await stat(file);
        } catch {
          await writeFile(file, JSON.stringify(emptyDocument(board), null, 2), 'utf8');
        }
        const meta = await loadMeta(board);
        return { conn: await this.connect(file), meta };
      })();
      // A failed start must not wedge the board: the next call tries again.
      pending.catch(() => this.boards.delete(board));
      this.boards.set(board, pending);
    }
    return pending;
  }

  /** Read the live document and fold any change (the human's included) into the ledger. */
  private async sync(board: string, b: Board): Promise<SquigDocument> {
    const { document } = await b.conn.read();
    if (syncMeta(b.meta, document)) await saveMeta(board, b.meta);
    return document;
  }

  async open(board: string): Promise<{ outline: Outline; created: boolean }> {
    assertBoardName(board);
    let created = false;
    try {
      await stat(this.fileFor(board));
    } catch {
      created = true;
    }
    return this.serial(board, async () => {
      const b = await this.board(board);
      return { outline: outlineOf(board, b.meta, await this.sync(board, b)), created };
    });
  }

  async read(board: string, since?: number): Promise<Outline> {
    return this.serial(board, async () => {
      const b = await this.board(board);
      return outlineOf(board, b.meta, await this.sync(board, b), since);
    });
  }

  async add(
    board: string,
    actor: CreatedBy,
    items: ItemInput[],
  ): Promise<{ ids: string[]; version: number; hint?: string }> {
    return this.serial(board, async () => {
      const b = await this.board(board);
      const doc = await this.sync(board, b);
      const frames = clusterFrames(b.meta, doc);
      for (const item of items) {
        if (item.kind === 'link') {
          for (const end of [item.from, item.to]) {
            if (!(end in doc.nodes)) {
              throw new Error(
                `link endpoint ${JSON.stringify(end)} is not an item on this board — use ids from the outline (whiteboard_read); nothing was placed`,
              );
            }
          }
        }
        if (item.kind === 'note' && item.cluster !== undefined && !frames.has(item.cluster)) {
          throw new Error(
            `cluster ${JSON.stringify(item.cluster)} is not a cluster on this board — create it first, or use an id from whiteboard_read; nothing was placed`,
          );
        }
        if (item.kind === 'note' && item.text.length > NOTE_TEXT_MAX) {
          throw new Error(
            `note headline is ${item.text.length} characters, over the ${NOTE_TEXT_MAX} limit — ` +
              `a sticky is a headline, not a paragraph. Shorten \`text\` and move the rest to ` +
              `\`detail\`, which stays off the canvas and comes back on every read. Nothing was placed.`,
          );
        }
      }

      const bounds = contentBounds(doc);
      const clusterX = bounds ? bounds.x + bounds.w + PLACE_MARGIN : 100;
      let clusterY = bounds ? bounds.y : 100;
      const looseX = bounds ? bounds.x : 100;
      const looseY = bounds ? bounds.y + bounds.h + PLACE_MARGIN : 100 + CLUSTER_STEP_Y;
      let looseN = 0;
      let clustersPlaced = 0;
      let loosePlaced = 0;
      const place = (item: ItemInput): { x: number; y: number } => {
        if ('x' in item && item.x !== undefined && item.y !== undefined)
          return { x: item.x, y: item.y };
        if (item.kind === 'cluster') {
          const pos = { x: clusterX, y: clusterY };
          clusterY += CLUSTER_STEP_Y;
          clustersPlaced++;
          return pos;
        }
        const pos = {
          x: looseX + (looseN % LOOSE_COLS) * LOOSE_STEP_X,
          y: looseY + Math.floor(looseN / LOOSE_COLS) * LOOSE_STEP_Y,
        };
        if (!(item.kind === 'note' && item.cluster)) {
          looseN++;
          loosePlaced++;
        }
        return pos;
      };

      const nodes: Array<Record<string, unknown> & { type: string }> = [];
      const entries: Record<string, MetaEntry> = {};
      const ids: string[] = [];
      const touched = new Map<string, string[]>(); // cluster → new member ids
      for (const item of items) {
        const id = newId();
        ids.push(id);
        switch (item.kind) {
          case 'note': {
            const pos = place(item);
            nodes.push({
              id,
              type: 'text',
              ...pos,
              w: NOTE_W,
              h: noteHeight(item.text),
              text: item.text,
              boxed: true,
              boxFill: 'light',
            });
            entries[id] = {
              role: 'note',
              createdBy: actor,
              ...(item.detail ? { detail: item.detail } : {}),
            };
            if (item.cluster) touched.set(item.cluster, [...(touched.get(item.cluster) ?? []), id]);
            break;
          }
          case 'label': {
            nodes.push({ id, type: 'text', ...place(item), text: item.text });
            entries[id] = { role: 'label', createdBy: actor };
            break;
          }
          case 'cluster': {
            const pos = place(item);
            const title = newId();
            nodes.push({
              id,
              type: 'shape',
              shape: 'rect',
              dashed: true,
              ...pos,
              w: CLUSTER_W,
              h: CLUSTER_H,
            });
            nodes.push({
              id: title,
              type: 'text',
              x: pos.x + 16,
              y: pos.y + 12,
              text: item.title,
              fontSize: 22,
            });
            entries[id] = { role: 'cluster', createdBy: actor, part: title };
            entries[title] = { role: 'cluster-title', createdBy: actor, owner: id };
            break;
          }
          case 'link': {
            nodes.push({
              id,
              type: 'arrow',
              x: 0,
              y: 0,
              points: [
                [0, 0],
                [1, 1],
              ],
              bind: [item.from, item.to],
            });
            entries[id] = { role: 'link', createdBy: actor };
            if (item.label) {
              const label = newId();
              const a = doc.nodes[item.from]!;
              const z = doc.nodes[item.to]!;
              nodes.push({
                id: label,
                type: 'text',
                x: (a.x + z.x) / 2,
                y: (a.y + z.y) / 2,
                text: item.label,
                fontSize: 16,
              });
              entries[id] = { ...entries[id]!, part: label };
              entries[label] = { role: 'link-label', createdBy: actor, owner: id };
            }
            break;
          }
        }
      }
      Object.assign(b.meta.items, entries);
      try {
        await b.conn.edit([{ op: 'add', nodes }]);
      } catch (err) {
        for (const id of Object.keys(entries)) delete b.meta.items[id];
        throw err;
      }
      if (touched.size > 0) await this.relayout(b, [...touched.keys()], touched);
      await this.sync(board, b);

      const hints: string[] = [];
      if (bounds && clustersPlaced > 0)
        hints.push(
          `${clustersPlaced} cluster(s) placed right of existing content — zoom out to see them`,
        );
      if (bounds && loosePlaced > 0)
        hints.push(`${loosePlaced} loose item(s) placed below existing content`);
      return { ids, version: b.meta.version, ...(hints.length ? { hint: hints.join('; ') } : {}) };
    });
  }

  /**
   * Re-grid each cluster's members inside its frame. `joining` names members that are not
   * inside the frame yet (just placed, or moved in) — membership is otherwise geometric.
   */
  private async relayout(
    b: Board,
    clusters: string[],
    joining: Map<string, string[]> = new Map(),
    leaving: Set<string> = new Set(),
  ): Promise<void> {
    const { document: doc } = await b.conn.read();
    const frames = clusterFrames(b.meta, doc);
    const patches: Array<{ id: string; patch: Record<string, unknown> }> = [];
    for (const clusterId of clusters) {
      const frame = frames.get(clusterId);
      if (!frame) continue;
      const join = new Set(joining.get(clusterId) ?? []);
      const members = Object.values(doc.nodes).filter((n) => {
        if (leaving.has(n.id)) return false;
        if (join.has(n.id)) return true;
        const role = b.meta.items[n.id]?.role;
        const memberish = role ? role === 'note' || role === 'label' : n.type === 'text';
        return memberish && containingCluster(n, frames) === clusterId;
      });
      const titleId = b.meta.items[clusterId]?.part;
      patches.push(...layoutCluster(frame, titleId ? doc.nodes[titleId] : undefined, members));
    }
    if (patches.length > 0) await b.conn.edit([{ op: 'update', patches }]);
  }

  async edit(
    board: string,
    actor: CreatedBy,
    ops: EditOp[],
  ): Promise<{ version: number; refused: EditRefusal[] }> {
    return this.serial(board, async () => {
      const b = await this.board(board);
      const doc = await this.sync(board, b);
      const frames = clusterFrames(b.meta, doc);
      const refused: EditRefusal[] = [];
      const patches: Array<{ id: string; patch: Record<string, unknown> }> = [];
      const adds: Array<Record<string, unknown> & { type: string }> = [];
      const deletes = new Set<string>();
      const relayout = new Set<string>();
      const joining = new Map<string, string[]>();
      const leaving = new Set<string>();
      const roleOf = (id: string): string => {
        const r = b.meta.items[id]?.role;
        if (r) return r;
        const n = doc.nodes[id]!;
        return n.type === 'text'
          ? n.boxed
            ? 'note'
            : 'label'
          : n.type === 'arrow'
            ? 'link'
            : 'other';
      };

      for (const op of ops) {
        const node = doc.nodes[op.id];
        if (!node || deletes.has(op.id) || b.meta.items[op.id]?.owner) {
          refused.push({
            id: op.id,
            reason: 'no such item on this board — read the outline again',
          });
          continue;
        }
        const role = roleOf(op.id);
        switch (op.op) {
          case 'move': {
            const from = containingCluster(node, frames);
            if (op.cluster !== null && !frames.has(op.cluster)) {
              refused.push({
                id: op.id,
                reason: `${JSON.stringify(op.cluster)} is not a cluster on this board`,
              });
              continue;
            }
            if (op.cluster) {
              joining.set(op.cluster, [...(joining.get(op.cluster) ?? []), op.id]);
              relayout.add(op.cluster);
            } else {
              leaving.add(op.id);
              const bounds = contentBounds(doc);
              const x = op.x ?? (bounds ? bounds.x : 100);
              const y = op.y ?? (bounds ? bounds.y + bounds.h + CLUSTER_PAD : 100);
              patches.push({ id: op.id, patch: { x, y } });
            }
            if (op.cluster && op.x !== undefined && op.y !== undefined)
              patches.push({ id: op.id, patch: { x: op.x, y: op.y } });
            if (from && from !== op.cluster) {
              leaving.add(op.id);
              relayout.add(from);
            }
            break;
          }
          case 'resize': {
            if (role !== 'cluster') {
              refused.push({
                id: op.id,
                reason: 'only a cluster can be resized — notes and labels size themselves',
              });
              continue;
            }
            patches.push({ id: op.id, patch: { w: op.w, h: op.h } });
            break;
          }
          case 'retitle': {
            if (!ownedBy(b.meta, op.id, actor)) {
              refused.push({
                id: op.id,
                reason: `rewording the other party's item is not yours to do — add your own note beside it, or ask them`,
              });
              continue;
            }
            const part = b.meta.items[op.id]?.part;
            if (role === 'cluster' || role === 'link') {
              if (part && doc.nodes[part]) patches.push({ id: part, patch: { text: op.text } });
              else if (role === 'link') {
                const label = newId();
                adds.push({
                  id: label,
                  type: 'text',
                  x: node.x,
                  y: node.y,
                  text: op.text,
                  fontSize: 16,
                });
                b.meta.items[op.id] = { ...b.meta.items[op.id]!, part: label };
                b.meta.items[label] = { role: 'link-label', createdBy: actor, owner: op.id };
              }
            } else {
              patches.push({
                id: op.id,
                patch:
                  role === 'note' ? { text: op.text, h: noteHeight(op.text) } : { text: op.text },
              });
            }
            break;
          }
          case 'delete': {
            if (!ownedBy(b.meta, op.id, actor)) {
              refused.push({
                id: op.id,
                reason: `deleting the other party's item is not yours to do — say why it should go, on the board or in chat`,
              });
              continue;
            }
            deletes.add(op.id);
            const part = b.meta.items[op.id]?.part;
            if (part) deletes.add(part);
            // A deleted item takes the links bound to it (and their labels) with it; a deleted
            // cluster's members stay on the board where they are.
            for (const n of Object.values(doc.nodes)) {
              if (n.type !== 'arrow' || !n.bind || !n.bind.includes(op.id)) continue;
              deletes.add(n.id);
              const lp = b.meta.items[n.id]?.part;
              if (lp) deletes.add(lp);
            }
            const from = containingCluster(node, frames);
            if (from && role !== 'cluster') {
              leaving.add(op.id);
              relayout.add(from);
            }
            break;
          }
        }
      }

      const batch: SquigOp[] = [];
      if (adds.length) batch.push({ op: 'add', nodes: adds });
      const livePatches = patches.filter((p) => !deletes.has(p.id));
      if (livePatches.length) batch.push({ op: 'update', patches: livePatches });
      if (deletes.size) batch.push({ op: 'delete', ids: [...deletes] });
      if (batch.length) await b.conn.edit(batch);
      for (const id of deletes) relayout.delete(id);
      if (relayout.size) await this.relayout(b, [...relayout], joining, leaving);
      await this.sync(board, b);
      return { version: b.meta.version, refused };
    });
  }

  async list(): Promise<Array<{ name: string; updatedAt: number }>> {
    let entries: string[];
    try {
      entries = await readdir(squigDir());
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const boards: Array<{ name: string; updatedAt: number }> = [];
    for (const entry of entries) {
      if (!entry.endsWith('.squig.json')) continue;
      const s = await stat(join(squigDir(), entry));
      boards.push({ name: entry.slice(0, -'.squig.json'.length), updatedAt: s.mtimeMs });
    }
    for (const [name, file] of this.links) {
      if (boards.some((b) => b.name === name)) continue;
      try {
        boards.push({ name, updatedAt: (await stat(file)).mtimeMs });
      } catch {
        /* linked but not created yet */
      }
    }
    return boards.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async close(board: string): Promise<Outline> {
    return this.serial(board, async () => {
      const b = await this.board(board);
      const outline = outlineOf(board, b.meta, await this.sync(board, b));
      this.boards.delete(board);
      await b.conn.close();
      return outline;
    });
  }

  /** Stop every companion — the service is shutting down. */
  async closeAll(): Promise<void> {
    const open = [...this.boards.values()];
    this.boards.clear();
    await Promise.all(
      open.map(async (p) => {
        try {
          await (await p).conn.close();
        } catch {
          /* a companion that never started has nothing to stop */
        }
      }),
    );
  }
}

async function loadMeta(board: string): Promise<BoardMeta> {
  try {
    return {
      ...emptyMeta(),
      ...(JSON.parse(await readFile(metaFile(board), 'utf8')) as BoardMeta),
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return emptyMeta();
    throw err;
  }
}

async function saveMeta(board: string, meta: BoardMeta): Promise<void> {
  const path = metaFile(board);
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(tmp, JSON.stringify(meta), 'utf8');
  await rename(tmp, path);
}
