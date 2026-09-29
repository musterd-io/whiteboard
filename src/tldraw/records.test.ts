import { describe, expect, it } from 'vitest';
import {
  buildCluster,
  buildLabel,
  buildLink,
  buildNote,
  nextIndex,
  richTextToPlain,
  toRichText,
} from './records.js';

describe('rich text', () => {
  it('round-trips plain text through the richText doc', () => {
    for (const text of ['one idea', 'two\nlines', '', 'a\n\nb']) {
      expect(richTextToPlain(toRichText(text))).toBe(text);
    }
  });

  it('returns empty for junk', () => {
    expect(richTextToPlain(null)).toBe('');
    expect(richTextToPlain(42)).toBe('');
    expect(richTextToPlain({})).toBe('');
  });
});

describe('nextIndex', () => {
  it('stays a valid tldraw index key past the ninth shape — a10 is not one', () => {
    const keys = Array.from({ length: 70 }, (_, i) => nextIndex(i));
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) expect(key).toMatch(/^[a-zA-Z0-9]+$/);
    // The base-62 boundary that broke a real ten-item batch.
    expect(keys).not.toContain('a10');
    // Index keys must sort in placement order, which is what tldraw uses them for.
    expect([...keys].sort()).toEqual(keys);
  });
});

describe('shape builders', () => {
  const base = { x: 10, y: 20, index: 'a1', createdBy: 'seat:izzo' };

  it('stamps createdBy on every shape — attribution is load-bearing (ADR 330 decision 5)', () => {
    const note = buildNote({ ...base, text: 'idea' });
    const label = buildLabel({ ...base, text: 'theme' });
    const cluster = buildCluster({ ...base, title: 'Theme A' });
    const { arrow } = buildLink(base, note.id, label.id);
    for (const shape of [note, label, cluster, arrow]) {
      expect(shape.meta['createdBy']).toBe('seat:izzo');
    }
  });

  it('builds notes with richText, never the legacy text prop', () => {
    const note = buildNote({ ...base, text: 'hello' });
    expect(note.props['richText']).toBeDefined();
    expect(note.props['text']).toBeUndefined();
    expect(richTextToPlain(note.props['richText'])).toBe('hello');
  });

  it('links carry endpoints as binding records, not legacy props', () => {
    const { arrow, bindings } = buildLink(base, 'shape:aaa', 'shape:bbb');
    expect(bindings).toHaveLength(2);
    const byTerminal = Object.fromEntries(bindings.map((b) => [b.props['terminal'], b]));
    expect(byTerminal['start']!.toId).toBe('shape:aaa');
    expect(byTerminal['end']!.toId).toBe('shape:bbb');
    for (const b of bindings) expect(b.fromId).toBe(arrow.id);
  });
});
