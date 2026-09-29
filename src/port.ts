/**
 * The provider port (ADR 330 decision 3): the ONLY interface the MCP tools and the skill see.
 *
 * Vocabulary is the brainstorm's, never the canvas library's: a *note* (an idea), a *label*
 * (an annotation), a *link* (a directed relation A → B), a *cluster* (a named grouping).
 * Nothing above the adapter may mention a tldraw record. Swapping canvas providers later
 * means writing one new adapter against this file and touching nothing else.
 */

/** Who placed a shape. Agents are `seat:<name>`; anything unstamped came from a human hand. */
export type CreatedBy = `seat:${string}` | 'human';

export const HUMAN: CreatedBy = 'human';

export function seatActor(seat: string): CreatedBy {
  return `seat:${seat}`;
}

export type ItemKind = 'note' | 'label' | 'link' | 'cluster';

/**
 * A whiteboard is scanned, not read. `text` is a headline and is length-capped so it stays
 * one; everything else goes in `detail`, which rides along in the item's metadata — invisible
 * on the canvas, returned in full by every read. The board stays legible at zoom; the
 * reasoning is not lost.
 */
export const NOTE_TEXT_MAX = 90;

export interface NoteInput {
  kind: 'note';
  /** The headline. At most NOTE_TEXT_MAX characters — put the rest in `detail`. */
  text: string;
  /** The full thought. Not drawn on the canvas; comes back on every read. */
  detail?: string;
  /** tldraw-ish color name; providers map or ignore. */
  color?: string;
  /** Place inside this cluster (outline id of a cluster). */
  cluster?: string;
  x?: number;
  y?: number;
}

export interface LabelInput {
  kind: 'label';
  text: string;
  x?: number;
  y?: number;
}

export interface LinkInput {
  kind: 'link';
  /** Outline id of the source item. */
  from: string;
  /** Outline id of the target item. */
  to: string;
  label?: string;
}

export interface ClusterInput {
  kind: 'cluster';
  title: string;
  x?: number;
  y?: number;
}

export type ItemInput = NoteInput | LabelInput | LinkInput | ClusterInput;

/**
 * One board item as the outline reports it. `kind: 'other'` marks content the outline cannot
 * carry faithfully (freehand strokes, images) — its presence flips `hasUnrepresentable` so a
 * reader knows the text is not the whole board (image reads are increment 2, ADR 330).
 */
export interface OutlineItem {
  id: string;
  kind: ItemKind | 'other';
  /** Note/label text, cluster title, or link label. Empty when the item carries none. */
  text: string;
  /** The full thought behind a headline, when one was recorded. Never drawn on the canvas. */
  detail?: string;
  createdBy: CreatedBy;
  /** Outline id of the containing cluster, when inside one. */
  cluster?: string;
  /** Links only: outline ids of the endpoints. */
  from?: string;
  to?: string;
  x: number;
  y: number;
}

export interface Outline {
  board: string;
  /** Monotonic board version. Pass back as `since` to read only what changed. */
  version: number;
  items: OutlineItem[];
  /** Ids removed since `since`. Only meaningful on a diff read. */
  removed: string[];
  /** True when the board holds content the outline cannot represent (freehand, images). */
  hasUnrepresentable: boolean;
}

export type EditOp =
  | {
      op: 'move';
      id: string;
      /** Target cluster id, or null to move out onto the open board. */
      cluster: string | null;
      x?: number;
      y?: number;
    }
  | { op: 'retitle'; id: string; text: string }
  | { op: 'delete'; id: string }
  /** Clusters only — notes and labels size themselves. Rarely needed: a cluster grows to fit. */
  | { op: 'resize'; id: string; w: number; h: number };

export interface EditRefusal {
  id: string;
  reason: string;
}

/**
 * Edit policy (ADR 330 decision 5): `move` may touch anyone's items — proposing a grouping of
 * the human's notes IS the converge mechanic. `retitle` and `delete` only touch the actor's
 * own items; rewording or removing the other party's idea is refused with the reason, never
 * silently skipped.
 */
export interface WhiteboardProvider {
  /** Open (or create) a named board. */
  open(board: string): Promise<{ outline: Outline; created: boolean }>;
  /** Batch-place items. One call per burst of ideas, not one per idea. */
  add(
    board: string,
    actor: CreatedBy,
    items: ItemInput[],
  ): Promise<{ ids: string[]; version: number; hint?: string }>;
  /** Full outline, or — with `since` — only items changed after that version. */
  read(board: string, since?: number): Promise<Outline>;
  edit(
    board: string,
    actor: CreatedBy,
    ops: EditOp[],
  ): Promise<{ version: number; refused: EditRefusal[] }>;
  list(): Promise<{ name: string; updatedAt: number }[]>;
  /** Persist and unload. Returns the final outline for the SEAT to author a summary from. */
  close(board: string): Promise<Outline>;
}

/** Board names are file/URL-safe by construction. */
export const BOARD_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

export function assertBoardName(name: string): void {
  if (!BOARD_NAME_RE.test(name)) {
    throw new Error(
      `invalid board name ${JSON.stringify(name)} — use 1-64 letters, digits, "-" or "_", starting with a letter or digit`,
    );
  }
}
