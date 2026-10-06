#!/usr/bin/env node
/**
 * The whiteboard service: one process serving three surfaces on one localhost port —
 *   GET  /healthz                       liveness (also answers "is it already running")
 *   /api/boards...                      the provider port over HTTP (the MCP server's transport)
 *   GET  /b/:name                       a board link's help page — opens nothing, no token
 * The human draws in Squig's own editor, served by the companion each open board runs; the open
 * result carries its URL (ADR 524, ADR 537).
 *
 * Binds 127.0.0.1 only: this is a local pairing surface, not a network service. The service
 * holds no repo-writing authority of any kind (ADR 330 decision 6).
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import {
  bearerMatches,
  loopbackHost,
  publishServiceToken,
  removeServiceToken,
  serviceTokenPath,
} from './auth.js';
import { isEntryPoint } from './entry.js';
import type { CreatedBy, EditOp, ItemInput } from './port.js';
import { BOARD_NAME_RE } from './port.js';
import { probeSquigCheckout, type SquigCheckout } from './squig/checkout.js';
import { SquigProvider } from './squig/provider.js';
import { SQUIG_TOOLS, type SquigToolName } from './squig/session.js';

/** Stands in when Squig cannot start: every board open fails with the probe's reason. */
const UNAVAILABLE: SquigCheckout = {
  kind: 'vendored',
  root: '',
  entry: '',
  loader: null,
  node: process.execPath,
};

/**
 * The service's one canvas (ADR 537): Squig, from this package's vendored copy or a
 * SQUIG_CHECKOUT clone. There is no fallback — when Squig cannot start, opening a board fails
 * with the reason, and the service stays up so `whiteboard_list` still answers.
 */
export function squigProvider(): { squig: SquigProvider; source: SquigCheckout['kind'] | null } {
  const probe = probeSquigCheckout();
  if (probe.ok) return { squig: new SquigProvider(probe.checkout), source: probe.checkout.kind };
  log('warn', probe.reason);
  return {
    squig: new SquigProvider(UNAVAILABLE, async () => {
      throw new Error(probe.reason);
    }),
    source: null,
  };
}

export const DEFAULT_PORT = 4851;

export function servicePort(): number {
  return parseInt(process.env['WHITEBOARD_PORT'] ?? String(DEFAULT_PORT), 10);
}

const MAX_BODY_BYTES = 1_048_576;

export interface RunningService {
  port: number;
  close(): Promise<void>;
}

export async function startService(
  port = servicePort(),
  deps: { squig?: SquigProvider } = {},
): Promise<RunningService> {
  const { squig, source } = deps.squig ? { squig: deps.squig, source: null } : squigProvider();
  // Rewritten after listen() when the OS picks the port (port 0, tests).
  let boundPort = port;
  // Minted after listen(), once the port is known; no request is routed before then.
  let token = '';

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

    // The guard (auth.ts): a rebound or cross-site request never reaches a route.
    if (!loopbackHost(req.headers.host, boundPort))
      return json(res, 403, { error: 'the whiteboard service answers only localhost' });
    if (path.startsWith('/api/') && !bearerMatches(req.headers.authorization, token))
      return json(res, 401, {
        error: `missing or wrong service token — the MCP client reads it from ${serviceTokenPath(boundPort)}`,
      });

    if (req.method === 'GET' && path === '/healthz') {
      return json(res, 200, {
        status: 'ok',
        service: 'agent-whiteboard',
        provider: 'squig',
        // Where Squig runs from (ADR 537): the package's vendored copy, or a SQUIG_CHECKOUT clone.
        squig: source,
        uptime: process.uptime(),
      });
    }

    if (req.method === 'GET' && path === '/api/boards') {
      return json(res, 200, { boards: await squig.list() });
    }

    // Squig's own tools on a board, and binding a board to a workspace file (ADR 527).
    const sq = path.match(/^\/api\/boards\/([^/]+)\/(squig\/([a-z_]+)|link)$/);
    if (sq && req.method === 'POST') {
      const [, name, , tool] = sq as unknown as [string, string, string, string | undefined];
      if (!BOARD_NAME_RE.test(name))
        return json(res, 400, { error: `invalid board name ${JSON.stringify(name)}` });
      const body = (await readBody(req)) as {
        file?: string;
        actor?: CreatedBy;
        args?: Record<string, unknown>;
      };
      if (tool === undefined) {
        if (typeof body.file !== 'string') return json(res, 400, { error: 'file required' });
        squig.link(name, body.file);
        return json(res, 200, { linked: name, file: body.file });
      }
      if (!(SQUIG_TOOLS as readonly string[]).includes(tool))
        return json(res, 404, { error: `unknown Squig tool ${JSON.stringify(tool)}` });
      return json(
        res,
        200,
        await squig.squigTool(name, tool as SquigToolName, body.args ?? {}, body.actor),
      );
    }

    const api = path.match(/^\/api\/boards\/([^/]+)\/(open|add|outline|edit|close)$/);
    if (api) {
      const [, name, action] = api as unknown as [string, string, string];
      if (!BOARD_NAME_RE.test(name))
        return json(res, 400, { error: `invalid board name ${JSON.stringify(name)}` });

      if (action === 'outline' && req.method === 'GET') {
        const sinceRaw = url.searchParams.get('since');
        const since = sinceRaw === null ? undefined : Number(sinceRaw);
        return json(res, 200, await squig.read(name, since));
      }
      if (req.method !== 'POST') return json(res, 405, { error: 'POST required' });
      const body = (await readBody(req)) as {
        actor?: CreatedBy;
        items?: ItemInput[];
        ops?: EditOp[];
      };

      switch (action) {
        case 'open': {
          const { outline, created } = await squig.open(name);
          return json(res, 200, {
            outline,
            created,
            url: await squig.editorUrl(name),
            provider: 'squig',
          });
        }
        case 'add': {
          if (!body.actor || !Array.isArray(body.items))
            return json(res, 400, { error: 'actor and items[] required' });
          return json(res, 200, await squig.add(name, body.actor, body.items));
        }
        case 'edit': {
          if (!body.actor || !Array.isArray(body.ops))
            return json(res, 400, { error: 'actor and ops[] required' });
          return json(res, 200, await squig.edit(name, body.actor, body.ops));
        }
        case 'close': {
          return json(res, 200, { outline: await squig.close(name) });
        }
      }
    }

    // The board link (ADR 537): huddles post `<service>/b/<board>` to the team (ADR 378 §7). It is
    // a help page only — it opens nothing and carries no token. Squig's editor URL holds the
    // companion's token, so it is handed out only to a caller holding the service token (the
    // MCP client, or `musterd huddle room`), never to an unauthenticated GET.
    const link = path.match(/^\/b\/([^/]+)$/);
    if (link && req.method === 'GET') {
      const [, name] = link as unknown as [string, string];
      if (!BOARD_NAME_RE.test(name))
        return json(res, 400, { error: `invalid board name ${JSON.stringify(name)}` });
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(boardLinkPage(name));
      return;
    }

    return json(res, 404, { error: 'not found' });
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
  // port 0 asks the OS for a free one (tests) — report the port actually bound.
  const address = server.address();
  boundPort = typeof address === 'object' && address ? address.port : port;
  token = publishServiceToken(boundPort);
  log('info', `agent-whiteboard service listening on 127.0.0.1:${boundPort}`);

  return {
    port: boundPort,
    close: async () => {
      await squig.closeAll();
      removeServiceToken(boundPort);
      // server.close() alone waits for open connections — a pooled keep-alive fetch keeps the
      // process alive AFTER it stops listening, leaving a half-dead server still answering old
      // connections while a new process owns the port. That split brain ate real board work;
      // sever everything.
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** The help page behind a board link. `name` has passed BOARD_NAME_RE, so it needs no escaping. */
function boardLinkPage(name: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Board ${name}</title>
<meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="font: 16px/1.5 system-ui, sans-serif; max-width: 36rem; margin: 3rem auto; padding: 0 1rem">
<h1 style="font-size: 1.25rem">Board <code>${name}</code></h1>
<p>This board is drawn in Squig. Its editor link is private to this machine, so this page cannot open it for you.</p>
${
  name.startsWith('huddle-')
    ? `<p>It is a musterd huddle's room. To open it, run this in a terminal on this machine:</p>
<pre><code>musterd huddle room ${name}</code></pre>
<p>Or ask`
    : '<p>To open it, ask'
} your agent to call <code>whiteboard_open</code> with the board <code>${name}</code>.</p>
</body></html>
`;
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
