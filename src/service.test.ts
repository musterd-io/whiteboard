/**
 * Service tests: the real HTTP surface on an OS-assigned port, plus a raw ws upgrade smoke —
 * the same transports the MCP client and the browser page use.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type { Outline } from './port.js';
import { startService, type RunningService } from './service.js';

let dir: string;
let service: RunningService;
let base: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'whiteboard-service-test-'));
  process.env['WHITEBOARD_DATA_DIR'] = dir;
  service = await startService(0);
  base = `http://127.0.0.1:${service.port}`;
});

afterEach(async () => {
  await service.close();
  delete process.env['WHITEBOARD_DATA_DIR'];
  await rm(dir, { recursive: true, force: true });
});

describe('service', () => {
  it('healthz identifies itself — the spawn-on-demand probe depends on this', async () => {
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'ok', service: 'agent-whiteboard' });
  });

  it('drives the full board flow over HTTP', async () => {
    const open = await fetch(`${base}/api/boards/flow/open`, { method: 'POST' });
    const opened = (await open.json()) as { created: boolean; url: string };
    expect(opened.created).toBe(true);
    expect(opened.url).toContain(`/b/flow`);

    const add = await fetch(`${base}/api/boards/flow/add`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        actor: 'seat:izzo',
        items: [
          { kind: 'note', text: 'one' },
          { kind: 'note', text: 'two' },
        ],
      }),
    });
    const added = (await add.json()) as { ids: string[]; version: number };
    expect(added.ids).toHaveLength(2);

    const read = await fetch(`${base}/api/boards/flow/outline`);
    const outline = (await read.json()) as Outline;
    expect(outline.items.map((i) => i.text).sort()).toEqual(['one', 'two']);

    const diffRes = await fetch(`${base}/api/boards/flow/outline?since=${outline.version}`);
    const diff = (await diffRes.json()) as Outline;
    expect(diff.items).toHaveLength(0);

    const edit = await fetch(`${base}/api/boards/flow/edit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        actor: 'seat:izzo',
        ops: [{ op: 'retitle', id: added.ids[0], text: 'one, sharpened' }],
      }),
    });
    expect((await edit.json()) as { refused: unknown[] }).toMatchObject({ refused: [] });

    const closeRes = await fetch(`${base}/api/boards/flow/close`, { method: 'POST' });
    const closed = (await closeRes.json()) as { outline: Outline };
    expect(closed.outline.items.map((i) => i.text).sort()).toEqual(['one, sharpened', 'two']);

    const list = await fetch(`${base}/api/boards`);
    expect(
      ((await list.json()) as { boards: Array<{ name: string }> }).boards.map((b) => b.name),
    ).toContain('flow');
  });

  it('accepts a huddle layout — the shape `musterd huddle open` sends (ADR 378 §7)', async () => {
    // The CLI talks to this port over raw HTTP and imports nothing from here; this pins the
    // payload it sends so a port change on either side fails a test rather than a huddle.
    const board = 'huddle-01huddle0000000000000000aa';
    const open = await fetch(`${base}/api/boards/${board}/open`, { method: 'POST' });
    expect(((await open.json()) as { created: boolean }).created).toBe(true);
    const add = await fetch(`${base}/api/boards/${board}/add`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        actor: 'seat:izzo',
        items: [
          { kind: 'cluster', title: 'Anchor', x: 100, y: 100 },
          {
            kind: 'note',
            text: 'docs/design/thing.md',
            detail: 'anchor — docs/design/thing.md',
            x: 120,
            y: 160,
          },
          { kind: 'label', text: 'huddle · lane:01LANE', x: 100, y: 40 },
          { kind: 'cluster', title: 'Turns', x: 600, y: 100 },
          { kind: 'note', text: 'why we huddle', detail: 'why we huddle', x: 620, y: 160 },
        ],
      }),
    });
    expect(add.status).toBe(200);
    expect(((await add.json()) as { ids: string[] }).ids).toHaveLength(5);
    const outline = (await (await fetch(`${base}/api/boards/${board}/outline`)).json()) as Outline;
    expect(
      outline.items
        .filter((i) => i.kind === 'cluster')
        .map((i) => i.text)
        .sort(),
    ).toEqual(['Anchor', 'Turns']);
  });

  it('rejects invalid board names', async () => {
    const res = await fetch(`${base}/api/boards/..%2Fescape/open`, { method: 'POST' });
    expect(res.status).toBe(400);
  });

  it('completes the sync handshake over a real ws — a browser could join this room', async () => {
    await fetch(`${base}/api/boards/wsboard/open`, { method: 'POST' });
    const ws = new WebSocket(`ws://127.0.0.1:${service.port}/ws/wsboard`);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    // The sync protocol is client-initiated: send the connect request a tldraw client would.
    const { getTlsyncProtocolVersion } = await import('@tldraw/sync-core');
    const { TLDRAW_SCHEMA } = await import('./tldraw/records.js');
    ws.send(
      JSON.stringify({
        type: 'connect',
        connectRequestId: 'test',
        schema: TLDRAW_SCHEMA,
        protocolVersion: getTlsyncProtocolVersion(),
        lastServerClock: 0,
      }),
    );
    const reply = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no connect reply within 3s')), 3000);
      ws.once('message', (data) => {
        clearTimeout(timer);
        resolve(JSON.parse(String(data)) as Record<string, unknown>);
      });
      ws.once('error', reject);
    });
    expect(reply['type']).toBe('connect');
    expect(reply['connectRequestId']).toBe('test');
    ws.close();
  });

  it('refuses a ws upgrade for a bad board name', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${service.port}/ws/..%2Fnope`);
    const failed = await new Promise<boolean>((resolve) => {
      ws.once('error', () => resolve(true));
      ws.once('open', () => resolve(false));
    });
    expect(failed).toBe(true);
  });
});
