/**
 * Render an Outline as compact text for tool results: enums/ids/short lines, grouped so a
 * reader can scan clusters first, then loose items, then links.
 */
import type { Outline, OutlineItem } from '../port.js';

function shortId(id: string): string {
  return id.replace(/^shape:/, '');
}

function who(item: OutlineItem): string {
  return item.createdBy === 'human' ? 'human' : item.createdBy.slice('seat:'.length);
}

function line(item: OutlineItem, byId: Map<string, OutlineItem>): string {
  const id = shortId(item.id);
  const detail = item.detail ? `\n    ↳ ${item.detail.replace(/\n/g, '\n      ')}` : '';
  switch (item.kind) {
    case 'note':
      return `- [${id}] (${who(item)}) "${item.text}"${detail}`;
    case 'label':
      return `- [${id}] (${who(item)}) label "${item.text}"`;
    case 'link': {
      const from = item.from ? shortId(item.from) : '?';
      const to = item.to ? shortId(item.to) : '?';
      const fromText = item.from ? byId.get(item.from)?.text : undefined;
      const toText = item.to ? byId.get(item.to)?.text : undefined;
      const label = item.text ? ` "${item.text}"` : '';
      const gloss = fromText || toText ? `  (${fromText ?? '?'} → ${toText ?? '?'})` : '';
      return `- [${id}] (${who(item)}) ${from} → ${to}${label}${gloss}`;
    }
    case 'cluster':
      return `- [${id}] (${who(item)}) cluster "${item.text}"`;
    case 'other':
      return `- [${id}] (${who(item)}) [drawn content the outline cannot carry]`;
  }
}

export function formatOutline(outline: Outline, opts?: { url?: string; diff?: boolean }): string {
  const out: string[] = [];
  const head = opts?.diff
    ? `board "${outline.board}" v${outline.version} — changes only`
    : `board "${outline.board}" v${outline.version}`;
  out.push(opts?.url ? `${head} · ${opts.url}` : head);

  if (outline.items.length === 0 && outline.removed.length === 0) {
    out.push(opts?.diff ? 'nothing changed' : 'empty board');
  }

  const byId = new Map(outline.items.map((i) => [i.id, i]));
  const clusters = outline.items.filter((i) => i.kind === 'cluster');
  const links = outline.items.filter((i) => i.kind === 'link');
  const loose = outline.items.filter(
    (i) => i.kind !== 'cluster' && i.kind !== 'link' && !i.cluster,
  );

  for (const cluster of clusters) {
    out.push(line(cluster, byId));
    for (const item of outline.items) {
      if (item.cluster === cluster.id && item.kind !== 'link') out.push(`  ${line(item, byId)}`);
    }
  }
  // A diff can contain items whose cluster did not itself change — show them under its id.
  const shownClusterIds = new Set(clusters.map((c) => c.id));
  const orphanedClustered = outline.items.filter(
    (i) => i.cluster && !shownClusterIds.has(i.cluster) && i.kind !== 'link',
  );
  for (const item of orphanedClustered) {
    out.push(`${line(item, byId)}  @cluster:${shortId(item.cluster!)}`);
  }
  for (const item of loose) out.push(line(item, byId));
  for (const link of links) out.push(line(link, byId));

  for (const id of outline.removed) out.push(`- removed [${shortId(id)}]`);

  if (outline.hasUnrepresentable) {
    out.push(
      'note: this board holds freehand or image content the text outline cannot carry — ' +
        'ask the human what it shows, or wait for image reads (increment 2).',
    );
  }
  return out.join('\n');
}
