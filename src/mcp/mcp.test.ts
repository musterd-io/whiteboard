/**
 * MCP registry + behavior tests. WHITEBOARD_TOOL_NAMES is pinned to the live registry (the
 * musterd toolNames pattern) so a rename cannot silently rot the SKILL.md prose that names
 * these tools. Tool handlers run against a REAL service on an OS-assigned port, over an
 * in-memory Squig (ADR 537).
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startService, type RunningService } from '../service.js';
import { FakeSquig } from '../squig/fake.js';
import { SquigProvider } from '../squig/provider.js';
import { WhiteboardServiceClient } from './client.js';
import { WHITEBOARD_TOOL_NAMES } from './toolNames.js';
import { buildWhiteboardMcpServer, parseLinkedBoards } from './index.js';

type Handler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

function handler(server: unknown, name: string): Handler {
  const tools = (server as { _registeredTools: Record<string, { handler: Handler }> })
    ._registeredTools;
  return tools[name]!.handler;
}

let dir: string;
let service: RunningService;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'whiteboard-mcp-test-'));
  process.env['WHITEBOARD_DATA_DIR'] = dir;
  service = await startService(0, {
    squig: new SquigProvider(
      { kind: 'vendored', root: '/v', entry: '/v/c.mjs', loader: null, node: process.execPath },
      async () => new FakeSquig(),
    ),
  });
});

afterEach(async () => {
  await service.close();
  delete process.env['WHITEBOARD_DATA_DIR'];
  await rm(dir, { recursive: true, force: true });
});

describe('whiteboard MCP server', () => {
  it('WHITEBOARD_TOOL_NAMES equals the live registry — SKILL.md names cannot rot silently', () => {
    const server = buildWhiteboardMcpServer(new WhiteboardServiceClient(service.port));
    const registered = Object.keys(
      (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools,
    ).sort();
    expect(registered).toEqual([...WHITEBOARD_TOOL_NAMES].sort());
  });

  it('add/edit before open teach the seat-attribution requirement instead of guessing', async () => {
    const server = buildWhiteboardMcpServer(new WhiteboardServiceClient(service.port));
    const res = await handler(
      server,
      'whiteboard_add',
    )({
      board: 'x',
      items: [{ kind: 'note', text: 'orphan' }],
    });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain('whiteboard_open first');
  });

  it('open → add → read → close, end to end through the tool handlers', async () => {
    const server = buildWhiteboardMcpServer(new WhiteboardServiceClient(service.port));

    const opened = await handler(server, 'whiteboard_open')({ board: 'session', seat: 'izzo' });
    expect(opened.isError).toBeUndefined();
    expect(opened.content[0]!.text).toContain(
      `(squig) — hand the human this URL to draw with you: ${new FakeSquig().editorUrl}`,
    );

    const added = await handler(
      server,
      'whiteboard_add',
    )({
      board: 'session',
      items: [
        { kind: 'note', text: 'first idea' },
        { kind: 'cluster', title: 'Theme A' },
      ],
    });
    expect(added.isError).toBeUndefined();
    expect(added.content[0]!.text).toContain('placed 2 item(s)');

    const read = await handler(server, 'whiteboard_read')({ board: 'session' });
    expect(read.content[0]!.text).toContain('(izzo) "first idea"');
    expect(read.content[0]!.text).toContain('cluster "Theme A"');

    const closed = await handler(server, 'whiteboard_close')({ board: 'session' });
    expect(closed.content[0]!.text).toContain('Author the summary yourself');

    const list = await handler(server, 'whiteboard_list')({});
    expect(list.content[0]!.text).toContain('- session');
  });

  it("Squig's mutating tools need a seat; its read-only tools do not (ADR 527)", async () => {
    const server = buildWhiteboardMcpServer(new WhiteboardServiceClient(service.port));
    const draw = await handler(server, 'whiteboard_draw')({ board: 'x', args: {} });
    expect(draw.isError).toBe(true);
    expect(draw.content[0]!.text).toContain('whiteboard_open first');
    const doc = await handler(server, 'whiteboard_document')({ board: 'x', args: {} });
    expect(doc.isError).toBeUndefined();
  });
});

describe('parseLinkedBoards (ADR 527)', () => {
  it('reads name=path pairs, resolving paths against the workspace', () => {
    expect([
      ...parseLinkedBoards('team=docs/wireframes/team.squig.json; x=/abs/x.squig.json;bad', '/w'),
    ]).toEqual([
      ['team', '/w/docs/wireframes/team.squig.json'],
      ['x', '/abs/x.squig.json'],
    ]);
    expect(parseLinkedBoards(undefined, '/w').size).toBe(0);
  });
});
