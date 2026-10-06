/**
 * Service tests: the real HTTP surface on an OS-assigned port — the transport the MCP client
 * uses — over an in-memory Squig, so they need no companion (ADR 537).
 */
import { statSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readServiceToken, serviceTokenPath } from './auth.js';
import type { Outline } from './port.js';
import { startService, type RunningService } from './service.js';
import type { SquigCheckout } from './squig/checkout.js';
import { FakeSquig } from './squig/fake.js';
import { SquigProvider } from './squig/provider.js';

const FAKE_CHECKOUT: SquigCheckout = {
  kind: 'vendored',
  root: '/v',
  entry: '/v/c.mjs',
  loader: null,
  node: process.execPath,
};
const fakeSquig = () => new SquigProvider(FAKE_CHECKOUT, async () => new FakeSquig());

let dir: string;
let service: RunningService;
let base: string;

/** fetch with the service's token, as the MCP client sends it (auth.ts). */
const authFetch = (url: string, init: RequestInit = {}): Promise<Response> =>
  fetch(url, {
    ...init,
    headers: {
      ...(init.headers as Record<string, string> | undefined),
      Authorization: `Bearer ${readServiceToken(service.port)}`,
    },
  });

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'whiteboard-service-test-'));
  process.env['WHITEBOARD_DATA_DIR'] = dir;
  service = await startService(0, { squig: fakeSquig() });
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
    const open = await authFetch(`${base}/api/boards/flow/open`, { method: 'POST' });
    const opened = (await open.json()) as { created: boolean; url: string };
    expect(opened.created).toBe(true);
    expect(opened.url).toBe(new FakeSquig().editorUrl);

    const add = await authFetch(`${base}/api/boards/flow/add`, {
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

    const read = await authFetch(`${base}/api/boards/flow/outline`);
    const outline = (await read.json()) as Outline;
    expect(outline.items.map((i) => i.text).sort()).toEqual(['one', 'two']);

    const diffRes = await authFetch(`${base}/api/boards/flow/outline?since=${outline.version}`);
    const diff = (await diffRes.json()) as Outline;
    expect(diff.items).toHaveLength(0);

    const edit = await authFetch(`${base}/api/boards/flow/edit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        actor: 'seat:izzo',
        ops: [{ op: 'retitle', id: added.ids[0], text: 'one, sharpened' }],
      }),
    });
    expect((await edit.json()) as { refused: unknown[] }).toMatchObject({ refused: [] });

    const closeRes = await authFetch(`${base}/api/boards/flow/close`, { method: 'POST' });
    const closed = (await closeRes.json()) as { outline: Outline };
    expect(closed.outline.items.map((i) => i.text).sort()).toEqual(['one, sharpened', 'two']);

    const list = await authFetch(`${base}/api/boards`);
    expect(
      ((await list.json()) as { boards: Array<{ name: string }> }).boards.map((b) => b.name),
    ).toContain('flow');
  });

  it('accepts a huddle layout — the shape `musterd huddle open` sends (ADR 378 §7)', async () => {
    // The CLI talks to this port over raw HTTP and imports nothing from here; this pins the
    // payload it sends so a port change on either side fails a test rather than a huddle.
    const board = 'huddle-01huddle0000000000000000aa';
    const open = await authFetch(`${base}/api/boards/${board}/open`, { method: 'POST' });
    expect(((await open.json()) as { created: boolean }).created).toBe(true);
    const add = await authFetch(`${base}/api/boards/${board}/add`, {
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
    const outline = (await (
      await authFetch(`${base}/api/boards/${board}/outline`)
    ).json()) as Outline;
    expect(
      outline.items
        .filter((i) => i.kind === 'cluster')
        .map((i) => i.text)
        .sort(),
    ).toEqual(['Anchor', 'Turns']);
  });

  it('rejects invalid board names', async () => {
    const res = await authFetch(`${base}/api/boards/..%2Fescape/open`, { method: 'POST' });
    expect(res.status).toBe(400);
  });
});

describe('no fallback (ADR 537)', () => {
  it('opening a board when Squig cannot start fails with the reason; listing still works', async () => {
    await service.close();
    service = await startService(0, {
      squig: new SquigProvider(FAKE_CHECKOUT, async () => {
        throw new Error('vendored Squig is missing at /v');
      }),
    });
    base = `http://127.0.0.1:${service.port}`;
    const open = await authFetch(`${base}/api/boards/x/open`, { method: 'POST' });
    expect(open.status).toBe(500);
    expect(await open.text()).toContain('vendored Squig is missing at /v');
    expect((await authFetch(`${base}/api/boards`)).status).toBe(200);
  });

  it('a board name with only an old tldraw file opens as a new Squig board and leaves the file alone', async () => {
    const legacy = join(dir, 'boards', 'legacy.json');
    await mkdir(join(dir, 'boards'), { recursive: true });
    await writeFile(legacy, '{"records":[]}');
    const open = await authFetch(`${base}/api/boards/legacy/open`, { method: 'POST' });
    expect(((await open.json()) as { created: boolean }).created).toBe(true);
    expect(await readFile(legacy, 'utf8')).toBe('{"records":[]}');
  });
});

describe('the board link /b/<name> (ADR 537)', () => {
  it('answers with a help page that opens nothing and carries no token', async () => {
    const res = await fetch(`${base}/b/huddle-01abc`, { redirect: 'manual' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/html/);
    const page = await res.text();
    expect(page).toContain('huddle-01abc');
    expect(page).toContain('musterd huddle room huddle-01abc');
    expect(page).not.toContain('token');
    const list = (await (await authFetch(`${base}/api/boards`)).json()) as {
      boards: Array<{ name: string }>;
    };
    expect(list.boards).toEqual([]);
  });

  it('names the musterd command only for a huddle board', async () => {
    const page = await (await fetch(`${base}/b/sketch`)).text();
    expect(page).toContain('whiteboard_open');
    expect(page).not.toContain('musterd');
  });

  it('refuses an invalid board name', async () => {
    expect((await fetch(`${base}/b/..%2Fescape`)).status).toBe(400);
  });
});

describe('the guard (lane 01M47FADGV)', () => {
  it('writes a 0600 token, refuses /api without it, and removes it on close', async () => {
    expect(statSync(serviceTokenPath(service.port)).mode & 0o777).toBe(0o600);
    const bare = await fetch(`${base}/api/boards`);
    expect(bare.status).toBe(401);
    const wrong = await fetch(`${base}/api/boards/x/link`, {
      method: 'POST',
      headers: { Authorization: 'Bearer nope', 'Content-Type': 'text/plain' },
      body: JSON.stringify({ file: '/tmp/evil.squig.json' }),
    });
    expect(wrong.status).toBe(401);
    expect((await authFetch(`${base}/api/boards`)).status).toBe(200);
  });

  it('refuses a request whose Host is not localhost — a DNS-rebound page', async () => {
    const res = await new Promise<number>((resolve) => {
      const req = request(
        {
          host: '127.0.0.1',
          port: service.port,
          path: '/healthz',
          headers: { Host: `evil.example:${service.port}` },
        },
        (r) => resolve(r.statusCode ?? 0),
      );
      req.end();
    });
    expect(res).toBe(403);
  });
});
