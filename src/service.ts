/**
 * The whiteboard service: one process serving three surfaces on one localhost port —
 *   GET  /healthz                       liveness (also answers "is it already running")
 *   /api/boards...                      the provider port over HTTP (the MCP server's transport)
 *   GET  /b/:name (+ static assets)     the browser page a human draws on
 *   WS   /ws/:name                      tldraw sync for that page
 *
 * Binds 127.0.0.1 only: this is a local pairing surface, not a network service. The service
 * holds no repo-writing authority of any kind (ADR 330 decision 6).
 */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { isEntryPoint } from './entry.js';
import type { CreatedBy, EditOp, ItemInput } from './port.js';
import { BOARD_NAME_RE } from './port.js';
import { RoomManager } from './sync/roomManager.js';
import { TldrawProvider } from './tldraw/provider.js';

export const DEFAULT_PORT = 4851;

export function servicePort(): number {
  return parseInt(process.env['WHITEBOARD_PORT'] ?? String(DEFAULT_PORT), 10);
}

export function boardUrl(name: string, port = servicePort()): string {
  return `http://localhost:${port}/b/${name}`;
}

const IDLE_TIMEOUT_MS = 5 * 60_000;
const PERSIST_INTERVAL_MS = 30_000;
const MAX_BODY_BYTES = 1_048_576;

const WEB_DIST = fileURLToPath(new URL('../dist-web', import.meta.url));

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
};

export interface RunningService {
  port: number;
  close(): Promise<void>;
}

export async function startService(port = servicePort()): Promise<RunningService> {
  const rooms = new RoomManager({
    idleTimeoutMs: IDLE_TIMEOUT_MS,
    persistIntervalMs: PERSIST_INTERVAL_MS,
  });
  const provider = new TldrawProvider(rooms);
  // Rewritten after listen() when the OS picks the port (port 0, tests).
  let boundPort = port;

  const server = createServer((req, res) => {
    void route(req, res).catch((err) => {
      log('error', `unhandled route error for ${req.method} ${req.url}`, err);
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'internal error' }));
    });
  });

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://localhost:${port}`);
    const path = url.pathname;

    if (req.method === 'GET' && path === '/healthz') {
      return json(res, 200, {
        status: 'ok',
        service: 'agent-whiteboard',
        rooms: rooms.activeRoomCount(),
        uptime: process.uptime(),
      });
    }

    if (req.method === 'GET' && path === '/api/boards') {
      return json(res, 200, { boards: await provider.list() });
    }

    const api = path.match(/^\/api\/boards\/([^/]+)\/(open|add|outline|edit|close)$/);
    if (api) {
      const [, name, action] = api as unknown as [string, string, string];
      if (!BOARD_NAME_RE.test(name))
        return json(res, 400, { error: `invalid board name ${JSON.stringify(name)}` });

      if (action === 'outline' && req.method === 'GET') {
        const sinceRaw = url.searchParams.get('since');
        const since = sinceRaw === null ? undefined : Number(sinceRaw);
        return json(res, 200, await provider.read(name, since));
      }
      if (req.method !== 'POST') return json(res, 405, { error: 'POST required' });
      const body = (await readBody(req)) as {
        actor?: CreatedBy;
        items?: ItemInput[];
        ops?: EditOp[];
      };

      switch (action) {
        case 'open': {
          const { outline, created } = await provider.open(name);
          return json(res, 200, { outline, created, url: boardUrl(name, boundPort) });
        }
        case 'add': {
          if (!body.actor || !Array.isArray(body.items))
            return json(res, 400, { error: 'actor and items[] required' });
          return json(res, 200, await provider.add(name, body.actor, body.items));
        }
        case 'edit': {
          if (!body.actor || !Array.isArray(body.ops))
            return json(res, 400, { error: 'actor and ops[] required' });
          return json(res, 200, await provider.edit(name, body.actor, body.ops));
        }
        case 'close': {
          return json(res, 200, { outline: await provider.close(name) });
        }
      }
    }

    // Browser page: /b/<name> serves the SPA shell; anything else under / is a static asset.
    if (req.method === 'GET') {
      const isBoardPage = /^\/b\/[^/]+$/.test(path) || path === '/';
      const assetPath = isBoardPage ? '/index.html' : path;
      const file = normalize(join(WEB_DIST, assetPath));
      // Trailing separator so a sibling like `dist-web-other` can never pass the prefix
      // check (#1084 review, non-blocking b) — unreachable today, real tomorrow.
      if (!file.startsWith(WEB_DIST + sep)) return json(res, 404, { error: 'not found' });
      try {
        const content = await readFile(file);
        res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
        res.end(content);
        return;
      } catch {
        return json(res, 404, { error: 'not found' });
      }
    }

    return json(res, 404, { error: 'not found' });
  }

  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const match = req.url?.match(/^\/ws\/([^/?]+)/);
    const name = match?.[1];
    if (!name || !BOARD_NAME_RE.test(name)) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      // Per-connection session id: two tabs are two sessions, never a collision.
      void rooms.handleConnection(name, randomUUID(), ws).catch((err) => {
        log('error', `ws connection failed for board=${name}`, err);
        ws.close(4002, 'Board initialization failed');
      });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
  // port 0 asks the OS for a free one (tests) — report the port actually bound.
  const address = server.address();
  boundPort = typeof address === 'object' && address ? address.port : port;
  log('info', `agent-whiteboard service listening on 127.0.0.1:${boundPort}`);

  return {
    port: boundPort,
    close: async () => {
      await rooms.persistAllAndClose();
      wss.close();
      // server.close() alone waits for open connections — a browser ws or a pooled
      // keep-alive fetch keeps the process alive AFTER it stops listening, leaving a
      // half-dead server still answering old connections while a new process owns the
      // port. That split brain ate real board work; sever everything.
      for (const client of wss.clients) client.terminate();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function log(level: 'info' | 'warn' | 'error', message: string, error?: unknown): void {
  const entry = {
    ts: new Date().toISOString(),
    level,
    service: 'agent-whiteboard',
    message,
    ...(error instanceof Error ? { error: error.message, stack: error.stack } : {}),
  };
  if (level === 'error') console.error(JSON.stringify(entry));
  else console.log(JSON.stringify(entry));
}

// Entry point when spawned directly (the MCP server's spawn-on-demand path, ADR 330 decision 8).
if (isEntryPoint(import.meta.url)) {
  const running = await startService();
  const shutdown = async () => {
    log('info', 'shutting down — persisting open boards');
    // Belt on the graceful path: if anything above stalls, die anyway. A signaled service
    // that lingers becomes the split-brain server the close() comment describes.
    setTimeout(() => process.exit(1), 10_000).unref();
    await running.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}
