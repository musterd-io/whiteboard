/**
 * tldraw record knowledge, ported from the predecessor's canvas_ops.py (amprealize, tlschema
 * 4.5.9). This module and outline.ts are the ONLY code that knows what a tldraw record looks
 * like (ADR 330 decision 3). Everything is a pure function on plain records — no store, no
 * room, no IO — so the round-trip is testable without a canvas.
 */
import { randomBytes } from 'node:crypto';
import { getIndices } from '@tldraw/utils';

export interface TldrawRecord {
  id: string;
  typeName: string;
  [key: string]: unknown;
}

export interface ShapeRecord extends TldrawRecord {
  typeName: 'shape';
  type: string;
  x: number;
  y: number;
  rotation: number;
  isLocked: boolean;
  opacity: number;
  parentId: string;
  index: string;
  props: Record<string, unknown>;
  meta: Record<string, unknown>;
}

export interface BindingRecord extends TldrawRecord {
  typeName: 'binding';
  type: 'arrow';
  fromId: string;
  toId: string;
  props: Record<string, unknown>;
  meta: Record<string, unknown>;
}

export const PAGE_ID = 'page:page';

// Store snapshot schema — extracted from @tldraw/tlschema@4.5.9 (predecessor's constant).
// Seeded into new boards so an agent can place shapes before any browser client has joined.
export const TLDRAW_SCHEMA = {
  schemaVersion: 2,
  sequences: {
    'com.tldraw.store': 5,
    'com.tldraw.asset': 1,
    'com.tldraw.camera': 1,
    'com.tldraw.document': 2,
    'com.tldraw.instance': 26,
    'com.tldraw.instance_page_state': 5,
    'com.tldraw.page': 1,
    'com.tldraw.instance_presence': 6,
    'com.tldraw.pointer': 1,
    'com.tldraw.shape': 4,
    'com.tldraw.asset.bookmark': 2,
    'com.tldraw.asset.image': 6,
    'com.tldraw.asset.video': 5,
    'com.tldraw.shape.arrow': 8,
    'com.tldraw.shape.bookmark': 2,
    'com.tldraw.shape.draw': 4,
    'com.tldraw.shape.embed': 4,
    'com.tldraw.shape.frame': 1,
    'com.tldraw.shape.geo': 11,
    'com.tldraw.shape.group': 0,
    'com.tldraw.shape.highlight': 3,
    'com.tldraw.shape.image': 5,
    'com.tldraw.shape.line': 5,
    'com.tldraw.shape.note': 10,
    'com.tldraw.shape.text': 4,
    'com.tldraw.shape.video': 4,
    'com.tldraw.binding.arrow': 1,
  },
} as const;

/** Minimal records every board starts with, so parentId targets exist pre-client. */
export function baselineStore(): Record<string, TldrawRecord> {
  return {
    'document:document': {
      id: 'document:document',
      typeName: 'document',
      name: '',
      gridSize: 10,
      meta: {},
    },
    [PAGE_ID]: {
      id: PAGE_ID,
      typeName: 'page',
      name: 'Page 1',
      index: 'a1',
      meta: {},
    },
  };
}

export function newShapeId(): string {
  return `shape:${randomBytes(8).toString('hex')}`;
}

export function newBindingId(): string {
  return `binding:${randomBytes(8).toString('hex')}`;
}

// ---------------------------------------------------------------------------
// Rich text (tldraw 4.x stores note/text content as props.richText, a ProseMirror doc;
// the legacy props.text string fails validation)
// ---------------------------------------------------------------------------

interface RichTextNode {
  type: string;
  text?: string;
  content?: RichTextNode[];
}

export function toRichText(text: string): RichTextNode {
  const content: RichTextNode[] = (text || '')
    .split('\n')
    .map((line) =>
      line ? { type: 'paragraph', content: [{ type: 'text', text: line }] } : { type: 'paragraph' },
    );
  if (content.length === 0) content.push({ type: 'paragraph' });
  return { type: 'doc', content };
}

/**
 * Extract plain text from a richText doc. The predecessor never did this — notes it wrote via
 * richText read back EMPTY through its own summary path. The outline must not repeat that.
 */
export function richTextToPlain(rich: unknown): string {
  if (!rich || typeof rich !== 'object') return '';
  const node = rich as RichTextNode;
  if (node.type === 'text') return node.text ?? '';
  const parts = (node.content ?? []).map(richTextToPlain);
  if (node.type === 'doc') return parts.join('\n');
  return parts.join('');
}

// ---------------------------------------------------------------------------
// Shape builders. All stamp meta.createdBy — attribution is load-bearing (ADR 330 decision 5).
// ---------------------------------------------------------------------------

interface BuildBase {
  id?: string;
  x: number;
  y: number;
  parentId?: string;
  index: string;
  createdBy: string;
}

function baseShape(
  type: string,
  b: BuildBase & { detail?: string },
  props: Record<string, unknown>,
): ShapeRecord {
  return {
    id: b.id ?? newShapeId(),
    typeName: 'shape',
    type,
    x: b.x,
    y: b.y,
    rotation: 0,
    isLocked: false,
    opacity: 1,
    parentId: b.parentId ?? PAGE_ID,
    index: b.index,
    props,
    meta: {
      createdBy: b.createdBy,
      createdAt: new Date().toISOString(),
      // Detail lives in meta, never in props: tldraw draws props, so this stays off-canvas
      // while surviving persistence and coming back on every read.
      ...(b.detail ? { detail: b.detail } : {}),
    },
  };
}

export function buildNote(
  b: BuildBase & { text: string; color?: string; detail?: string },
): ShapeRecord {
  return baseShape('note', b, {
    color: b.color ?? 'yellow',
    labelColor: 'black',
    size: 'm',
    richText: toRichText(b.text),
    font: 'draw',
    align: 'middle',
    verticalAlign: 'middle',
    growY: 0,
    url: '',
    fontSizeAdjustment: 0,
    scale: 1,
  });
}

export function buildLabel(b: BuildBase & { text: string; color?: string }): ShapeRecord {
  return baseShape('text', b, {
    color: b.color ?? 'black',
    size: 'm',
    richText: toRichText(b.text),
    font: 'draw',
    textAlign: 'start',
    autoSize: true,
    w: 300,
    scale: 1,
  });
}

export function buildCluster(
  b: BuildBase & { title: string; w?: number; h?: number },
): ShapeRecord {
  return baseShape('frame', b, {
    name: b.title,
    w: b.w ?? 560,
    h: b.h ?? 400,
    color: 'black',
  });
}

/**
 * A link is an arrow shape PLUS two binding records — tldraw 4.x attaches arrows via
 * `binding:arrow` records, not the legacy props.start.boundShapeId the predecessor read
 * (which is why its connection reads went silently empty on 4.x boards).
 */
export function buildLink(
  b: BuildBase & { label?: string },
  fromShapeId: string,
  toShapeId: string,
): { arrow: ShapeRecord; bindings: [BindingRecord, BindingRecord] } {
  const arrow = baseShape('arrow', b, {
    dash: 'draw',
    size: 'm',
    fill: 'none',
    color: 'black',
    labelColor: 'black',
    bend: 0,
    start: { x: 0, y: 0 },
    end: { x: 2, y: 0 },
    arrowheadStart: 'none',
    arrowheadEnd: 'arrow',
    richText: toRichText(b.label ?? ''),
    labelPosition: 0.5,
    font: 'draw',
    scale: 1,
    kind: 'arc',
    elbowMidPoint: 0.5,
  });
  const mkBinding = (terminal: 'start' | 'end', toId: string): BindingRecord => ({
    id: newBindingId(),
    typeName: 'binding',
    type: 'arrow',
    fromId: arrow.id,
    toId,
    props: {
      terminal,
      isExact: false,
      isPrecise: false,
      normalizedAnchor: { x: 0.5, y: 0.5 },
      snap: 'none',
    },
    meta: {},
  });
  return { arrow, bindings: [mkBinding('start', fromShapeId), mkBinding('end', toShapeId)] };
}

// ---------------------------------------------------------------------------
// Auto-layout (ported grid): sequential placement when the caller gives no position.
// ---------------------------------------------------------------------------

const GRID_COLS = 4;
const GRID_GAP_X = 240;
const GRID_GAP_Y = 260;
const GRID_ORIGIN_X = 100;
const GRID_ORIGIN_Y = 100;

export function autoPosition(existingShapeCount: number): { x: number; y: number } {
  const col = existingShapeCount % GRID_COLS;
  const row = Math.floor(existingShapeCount / GRID_COLS);
  return { x: GRID_ORIGIN_X + col * GRID_GAP_X, y: GRID_ORIGIN_Y + row * GRID_GAP_Y };
}

/**
 * Nth valid fractional index key. NOT `a${n}` — tldraw's index keys are base-62, so the
 * successor of `a9` is `aA`, and `a10` fails validation. Found the hard way: a batch of ten
 * shapes was rejected mid-brainstorm at the tenth. Delegated to tldraw's own generator.
 */
export function nextIndex(existingShapeCount: number): string {
  return getIndices(existingShapeCount + 2)[existingShapeCount + 1]!;
}
