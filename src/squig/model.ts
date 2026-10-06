/**
 * The Squig document ↔ the port's vocabulary (ADR 524), as pure functions so they test without
 * a running Squig.
 *
 * Squig has a note (a boxed text node), a label (plain text) and an arrow bound to two node ids,
 * but no container and no label on an arrow. So a *cluster* is a dashed rect frame plus a title
 * text node, membership is geometric (a member's centre lies inside the frame — so a human
 * dragging a note out of a cluster takes it out, which is the dissent mechanic), and a *link
 * label* is a text node the sidecar ties to its arrow.
 *
 * What Squig cannot hold reliably goes in a sidecar (`<board>.meta.json`): who placed each item,
 * a note's off-canvas `detail`, which hidden nodes are cluster titles and link labels, and the
 * change ledger behind `version` / `since`. Squig's own revision is a content hash, not a
 * counter, and a human's browser edit announces itself to nobody — every sync diffs node
 * fingerprints against the ledger and bumps the version once per batch of changes. A node with
 * no sidecar entry came from a human hand.
 */
import type { CreatedBy, Outline, OutlineItem } from '../port.js';
import type { SquigDocument, SquigNode } from './session.js';

export type Role = 'note' | 'label' | 'link' | 'cluster' | 'cluster-title' | 'link-label';

export interface MetaEntry {
  role: Role;
  createdBy: CreatedBy;
  detail?: string;
  /** cluster → its title node; link → its label node. */
  part?: string;
  /** cluster-title / link-label → the item it belongs to. */
  owner?: string;
}

export interface BoardMeta {
  version: number;
  items: Record<string, MetaEntry>;
  /** Fingerprint of every node at the last sync. */
  seen: Record<string, string>;
  /** Version at which each visible item last changed. */
  changedAt: Record<string, number>;
  /** Version at which each removed item disappeared. */
  removed: Record<string, number>;
}

export function emptyMeta(): BoardMeta {
  return { version: 0, items: {}, seen: {}, changedAt: {}, removed: {} };
}

function fingerprint(n: SquigNode): string {
  return JSON.stringify([n.type, n.x, n.y, n.w, n.h, n.text ?? '', n.boxed ?? false, n.bind]);
}

/** The visible item a node is part of: a hidden title or label reports its owner. */
function itemIdOf(meta: BoardMeta, id: string): string {
  const entry = meta.items[id];
  return entry && (entry.role === 'cluster-title' || entry.role === 'link-label') && entry.owner
    ? entry.owner
    : id;
}

/**
 * Diff the document against the ledger and advance it. One version bump covers every change
 * found in this sync. Returns true when anything changed.
 */
export function syncMeta(meta: BoardMeta, doc: SquigDocument): boolean {
  const changedItems = new Set<string>();
  const removedNodes: string[] = [];
  for (const [id, node] of Object.entries(doc.nodes)) {
    const fp = fingerprint(node);
    if (meta.seen[id] !== fp) {
      meta.seen[id] = fp;
      changedItems.add(itemIdOf(meta, id));
    }
  }
  for (const id of Object.keys(meta.seen)) {
    if (!(id in doc.nodes)) removedNodes.push(id);
  }
  if (changedItems.size === 0 && removedNodes.length === 0) return false;
  meta.version += 1;
  for (const id of removedNodes) {
    const owner = itemIdOf(meta, id);
    delete meta.seen[id];
    if (owner !== id && owner in doc.nodes) {
      changedItems.add(owner); // a cluster lost its title, a link its label
    } else {
      meta.removed[id] = meta.version;
      delete meta.changedAt[id];
    }
    delete meta.items[id];
  }
  for (const id of changedItems) {
    if (id in doc.nodes) {
      meta.changedAt[id] = meta.version;
      delete meta.removed[id];
    }
  }
  return true;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function rectOf(n: SquigNode): Rect {
  return { x: n.x, y: n.y, w: n.w ?? 0, h: n.h ?? 0 };
}

/** The cluster frames on the board, by node id. */
export function clusterFrames(meta: BoardMeta, doc: SquigDocument): Map<string, SquigNode> {
  const frames = new Map<string, SquigNode>();
  for (const [id, entry] of Object.entries(meta.items)) {
    const node = doc.nodes[id];
    if (entry.role === 'cluster' && node) frames.set(id, node);
  }
  return frames;
}

/** The smallest cluster frame whose bounds hold this node's centre, if any. */
export function containingCluster(
  node: SquigNode,
  frames: Map<string, SquigNode>,
): string | undefined {
  const cx = node.x + (node.w ?? 0) / 2;
  const cy = node.y + (node.h ?? 0) / 2;
  let best: { id: string; area: number } | undefined;
  for (const [id, f] of frames) {
    if (id === node.id) continue;
    const r = rectOf(f);
    if (cx < r.x || cx > r.x + r.w || cy < r.y || cy > r.y + r.h) continue;
    const area = r.w * r.h;
    if (!best || area < best.area) best = { id, area };
  }
  return best?.id;
}

/** Kind of a node with no sidecar entry — drawn by a human in the editor. */
function humanKind(node: SquigNode): OutlineItem['kind'] {
  if (node.type === 'text') return node.boxed ? 'note' : 'label';
  if (node.type === 'arrow') return 'link';
  return 'other';
}

export function outlineOf(
  board: string,
  meta: BoardMeta,
  doc: SquigDocument,
  since?: number,
): Outline {
  const frames = clusterFrames(meta, doc);
  const items: OutlineItem[] = [];
  let hasUnrepresentable = false;
  for (const id of doc.order.filter((i) => i in doc.nodes)) {
    const node = doc.nodes[id]!;
    const entry = meta.items[id];
    if (entry && (entry.role === 'cluster-title' || entry.role === 'link-label')) continue;
    const kind: OutlineItem['kind'] = entry ? (entry.role as OutlineItem['kind']) : humanKind(node);
    if (kind === 'other') hasUnrepresentable = true;
    if (since !== undefined && (meta.changedAt[id] ?? 0) <= since) continue;
    const partText = entry?.part ? (doc.nodes[entry.part]?.text ?? '') : '';
    const item: OutlineItem = {
      id,
      kind,
      text: kind === 'cluster' || kind === 'link' ? partText : (node.text ?? ''),
      createdBy: entry?.createdBy ?? 'human',
      x: node.x,
      y: node.y,
    };
    if (entry?.detail) item.detail = entry.detail;
    if (kind === 'link') {
      const [from, to] = node.bind ?? [null, null];
      if (from) item.from = from;
      if (to) item.to = to;
    } else if (kind === 'note' || kind === 'label') {
      const cluster = containingCluster(node, frames);
      if (cluster) item.cluster = cluster;
    }
    items.push(item);
  }
  const removed =
    since === undefined
      ? []
      : Object.entries(meta.removed)
          .filter(([, v]) => v > since)
          .map(([id]) => id);
  return { board, version: meta.version, items, removed, hasUnrepresentable };
}

// Layout. A note is NOTE_W wide; its height grows with its text.
export const NOTE_W = 240;
const NOTE_CHARS_PER_LINE = 22;
const LINE_H = 28;
const NOTE_PAD = 32;
export const CLUSTER_PAD = 48;
export const CLUSTER_TITLE_H = 48;
const CLUSTER_GAP = 32;

export function noteHeight(text: string): number {
  const lines = text
    .split('\n')
    .reduce((n, line) => n + Math.max(1, Math.ceil(line.length / NOTE_CHARS_PER_LINE)), 0);
  return lines * LINE_H + NOTE_PAD;
}

/**
 * Grid a cluster's members inside its frame (2-wide when small, 3-wide past four) and grow the
 * frame to fit — a cluster is never smaller than what it holds. Returns the patches to apply.
 */
export function layoutCluster(
  frame: SquigNode,
  title: SquigNode | undefined,
  members: SquigNode[],
): Array<{ id: string; patch: Record<string, unknown> }> {
  const sorted = [...members].sort((a, b) => a.y - b.y || a.x - b.x);
  const cols = Math.max(1, Math.min(sorted.length, sorted.length <= 4 ? 2 : 3));
  const patches: Array<{ id: string; patch: Record<string, unknown> }> = [];
  let cursorY = frame.y + CLUSTER_TITLE_H + CLUSTER_PAD / 2;
  let widest = 0;
  for (let i = 0; i < sorted.length; i += cols) {
    const row = sorted.slice(i, i + cols);
    row.forEach((m, j) => {
      const w = m.w ?? NOTE_W;
      patches.push({
        id: m.id,
        patch: { x: frame.x + CLUSTER_PAD + j * (NOTE_W + CLUSTER_GAP), y: cursorY },
      });
      widest = Math.max(widest, CLUSTER_PAD * 2 + j * (NOTE_W + CLUSTER_GAP) + w);
    });
    cursorY += Math.max(...row.map((m) => m.h ?? noteHeight(m.text ?? ''))) + CLUSTER_GAP;
  }
  const w = Math.max(frame.w ?? 0, widest, CLUSTER_PAD * 2 + NOTE_W);
  const h = Math.max(frame.h ?? 0, cursorY - frame.y - CLUSTER_GAP + CLUSTER_PAD);
  patches.push({ id: frame.id, patch: { w, h } });
  if (title) patches.push({ id: title.id, patch: { x: frame.x + 16, y: frame.y + 12 } });
  return patches;
}

/** Bounding box of top-level content (arrows excluded — their box follows their endpoints). */
export function contentBounds(doc: SquigDocument): Rect | null {
  let out: { minX: number; minY: number; maxX: number; maxY: number } | null = null;
  for (const n of Object.values(doc.nodes)) {
    if (n.type === 'arrow') continue;
    const r = rectOf(n);
    if (!out) out = { minX: r.x, minY: r.y, maxX: r.x + r.w, maxY: r.y + r.h };
    else {
      out.minX = Math.min(out.minX, r.x);
      out.minY = Math.min(out.minY, r.y);
      out.maxX = Math.max(out.maxX, r.x + r.w);
      out.maxY = Math.max(out.maxY, r.y + r.h);
    }
  }
  return out && { x: out.minX, y: out.minY, w: out.maxX - out.minX, h: out.maxY - out.minY };
}
