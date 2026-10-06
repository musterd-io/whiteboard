#!/usr/bin/env node
/**
 * The whiteboard MCP server (stdio). Six brainstorm tools over the provider port, plus Squig's
 * own tools on any board (ADR 527), all via the HTTP client.
 * Session state is one field: which actor (seat) opened the board — set by whiteboard_open,
 * required by add/edit so every shape lands attributed (ADR 330 decision 5).
 */
import { resolve } from 'node:path';
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import { isEntryPoint } from '../entry.js';
import { NOTE_TEXT_MAX, seatActor, type CreatedBy, type EditOp, type ItemInput } from '../port.js';
import { WhiteboardServiceClient } from './client.js';
import { formatOutline } from './format.js';

const NO_ACTOR_MSG =
  'no seat has opened a board in this session — call whiteboard_open first (its `seat` parameter is what attributes your shapes)';

function textResult(text: string): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text }] };
}

function errorResult(err: unknown): {
  content: Array<{ type: 'text'; text: string }>;
  isError: true;
} {
  return {
    content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
    isError: true,
  };
}

const itemSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('note'),
    text: z
      .string()
      .min(1)
      .max(
        NOTE_TEXT_MAX,
        `a sticky is a headline, not a paragraph — keep it under ${NOTE_TEXT_MAX} characters and put the thinking in \`detail\``,
      )
      .describe(`the headline, max ${NOTE_TEXT_MAX} chars — a phrase someone can read at zoom`),
    detail: z
      .string()
      .optional()
      .describe('the full thought. Stays OFF the canvas; returned on every read'),
    color: z.string().optional().describe('color name, default yellow'),
    cluster: z.string().optional().describe('cluster id to place the note inside'),
    x: z.number().optional(),
    y: z.number().optional(),
  }),
  z.object({
    kind: z.literal('label'),
    text: z.string().min(1),
    x: z.number().optional(),
    y: z.number().optional(),
  }),
  z.object({
    kind: z.literal('link'),
    from: z.string().describe('outline id of the source item'),
    to: z.string().describe('outline id of the target item'),
    label: z.string().optional(),
  }),
  z.object({
    kind: z.literal('cluster'),
    title: z.string().min(1),
    x: z.number().optional(),
    y: z.number().optional(),
  }),
]);

const editOpSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('move'),
    id: z.string(),
    cluster: z
      .union([z.string(), z.null()])
      .describe('target cluster id, or null for the open board'),
    x: z.number().optional(),
    y: z.number().optional(),
  }),
  z.object({ op: z.literal('retitle'), id: z.string(), text: z.string().min(1) }),
  z.object({ op: z.literal('delete'), id: z.string() }),
  z.object({
    op: z.literal('resize'),
    id: z.string().describe('a cluster id — notes and labels size themselves'),
    w: z.number(),
    h: z.number(),
  }),
]);

/**
 * Linked boards (ADR 527): `WHITEBOARD_LINKED_BOARDS="team=docs/wireframes/team.squig.json"`,
 * `;`-separated, paths resolved against this server's working directory (the workspace that
 * registered it). The team canvas is a board like any other, but its file is the repo's.
 */
export function parseLinkedBoards(raw: string | undefined, cwd: string): Map<string, string> {
  const links = new Map<string, string>();
  for (const pair of (raw ?? '').split(';')) {
    const at = pair.indexOf('=');
    if (at <= 0) continue;
    links.set(pair.slice(0, at).trim(), resolve(cwd, pair.slice(at + 1).trim()));
  }
  return links;
}

/** A Squig tool result as MCP content: a PNG render becomes an image, everything else JSON. */
function squigResult(result: Record<string, unknown>): {
  content: Array<
    { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
  >;
} {
  if (result['mimeType'] === 'image/png' && typeof result['base64'] === 'string') {
    const { base64, ...rest } = result;
    return {
      content: [
        { type: 'image', data: base64, mimeType: 'image/png' },
        { type: 'text', text: JSON.stringify(rest) },
      ],
    };
  }
  return { content: [{ type: 'text', text: JSON.stringify(result) }] };
}

/**
 * Squig's own tools, re-exposed under the whiteboard's name (ADR 527) so one server covers both
 * the brainstorm and the wireframe. Arguments pass through to Squig verbatim — its schemas are
 * at https://squig.sh/llms-full.txt — with the board in place of Squig's document id.
 * `mutates` tools need a seat (whiteboard_open) so what they create is attributed.
 */
const SQUIG_PASSTHROUGH: Array<{
  name: string;
  squig: string;
  mutates: boolean;
  description: string;
}> = [
  {
    name: 'whiteboard_document',
    squig: 'get_document',
    mutates: false,
    description:
      "The board's full Squig document: nodes, order, variations, comments and the `revision` token every raw edit must pass back. Args: none.",
  },
  {
    name: 'whiteboard_draw',
    squig: 'edit_document',
    mutates: true,
    description:
      'Draw with Squig directly — components, shapes, text, arrows, groups, variations. Args: `revision` (from whiteboard_document) and `operations`: add{nodes}, update{patches:[{id,patch}]}, delete{ids}, duplicate, group, ungroup, align, distribute, tidy, reorder, rename, look, variation, note{text,x,y}. A stale revision is a 409: re-read and reconcile, never overwrite the human. What you create is attributed to your seat.',
  },
  {
    name: 'whiteboard_replace',
    squig: 'replace_document',
    mutates: true,
    description:
      'Replace the editable canvas fields wholesale at an expected revision (comments and surviving variations kept). Args: `revision`, `document: {fileName, nodes, order, look?}`. Prefer whiteboard_draw.',
  },
  {
    name: 'whiteboard_render',
    squig: 'render_document',
    mutates: false,
    description:
      'Render the board to see it. Args: `format` ("png" | "svg"), optional `variationId`. PNG comes back as an image.',
  },
  {
    name: 'whiteboard_export',
    squig: 'export_document',
    mutates: false,
    description:
      'Export the portable .squig.json plus the implementation handoff (variations, comments). Nothing is uploaded. Args: none.',
  },
  {
    name: 'whiteboard_measure_text',
    squig: 'measure_text',
    mutates: false,
    description: 'Measure rendered text for clipping before handing off. Args: optional `nodeIds`.',
  },
  {
    name: 'whiteboard_catalog',
    squig: 'catalog',
    mutates: false,
    description:
      "Search Squig's component library before inventing a component. Args: `query` and/or `kind`. The board is ignored.",
  },
  {
    name: 'whiteboard_comment',
    squig: 'comment',
    mutates: true,
    description:
      'Leave a review comment, optionally on a node or variation. Args: `text`, optional `nodeId`, `variationId`. The editor does not show comments yet — put anything the human must see on the canvas with whiteboard_draw.',
  },
  {
    name: 'whiteboard_resolve_comment',
    squig: 'resolve_comment',
    mutates: true,
    description: 'Resolve or reopen a review comment. Args: `commentId`, `resolved` (boolean).',
  },
  {
    name: 'whiteboard_history',
    squig: 'history',
    mutates: false,
    description: 'List up to 50 saved states of the board. Args: none.',
  },
  {
    name: 'whiteboard_restore',
    squig: 'restore',
    mutates: true,
    description:
      'Restore the board to a saved state from whiteboard_history. Args: `revision` (current) and `targetRevision` (the state to restore).',
  },
];

export function buildWhiteboardMcpServer(
  client: WhiteboardServiceClient,
  links: Map<string, string> = new Map(),
): McpServer {
  const server = new McpServer({ name: 'agent-whiteboard', version: '0.1.0' });
  let actor: CreatedBy | null = null;
  const linked = new Set<string>();
  // A linked board is bound on first use in this session; the service keeps the binding.
  const prep = async (board: string): Promise<void> => {
    const file = links.get(board);
    if (!file || linked.has(board)) return;
    await client.link(board, file);
    linked.add(board);
  };

  server.registerTool(
    'whiteboard_open',
    {
      description:
        'Open (or reopen) a named shared whiteboard and start the service if it is not running. ' +
        'Returns the URL for the human to draw at, plus the current outline and version. ' +
        'Call this first: `seat` is what attributes every shape you place.',
      inputSchema: {
        board: z.string().describe('board name, e.g. "team-memory-brainstorm"'),
        seat: z.string().describe('your seat name — stamps your shapes'),
      },
    },
    async ({ board, seat }) => {
      try {
        actor = seatActor(seat);
        await prep(board);
        const { outline, created, url, provider } = await client.open(board);
        const head = created ? `created board "${board}"` : `reopened board "${board}"`;
        const canvas = provider ? ` (${provider})` : '';
        return textResult(
          `${head}${canvas} — hand the human this URL to draw with you: ${url}\n\n${formatOutline(outline, { url })}`,
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'whiteboard_add',
    {
      description:
        'Place notes, labels, links (A → B), and clusters on the board — batched: one call per ' +
        'burst of ideas, not one per idea. A note is a HEADLINE (short, scannable at zoom); put ' +
        'the reasoning in `detail`, which stays off the canvas and comes back on every read. ' +
        'Layout is automatic — clusters grid their members and grow to fit.',
      inputSchema: {
        board: z.string(),
        items: z.array(itemSchema).min(1),
      },
    },
    async ({ board, items }) => {
      try {
        if (!actor) return errorResult(new Error(NO_ACTOR_MSG));
        await prep(board);
        const { ids, version, hint } = await client.add(board, actor, items as ItemInput[]);
        return textResult(
          `placed ${ids.length} item(s), board now v${version}: ${ids.map((id) => id.replace(/^shape:/, '')).join(', ')}` +
            (hint ? `\n${hint}` : ''),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'whiteboard_read',
    {
      description:
        'Read the board as a structured outline (notes, labels, links as A → B, clusters with ' +
        'their members, each attributed to who drew it). Pass `since` (a version from an earlier ' +
        'read) to get only what changed — the cheap way to see what the human just drew.',
      inputSchema: {
        board: z.string(),
        since: z
          .number()
          .optional()
          .describe('version from a previous read; returns only changes after it'),
      },
    },
    async ({ board, since }) => {
      try {
        await prep(board);
        const outline = await client.read(board, since);
        return textResult(formatOutline(outline, { diff: since !== undefined }));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'whiteboard_edit',
    {
      description:
        'Converge: move items into or out of clusters (anyone’s — proposing a grouping is the ' +
        'point), retitle or delete your OWN items. Rewording or deleting the human’s items is ' +
        'refused with the reason. The human dissents by dragging things back out — read the ' +
        'board again to see it.',
      inputSchema: {
        board: z.string(),
        ops: z.array(editOpSchema).min(1),
      },
    },
    async ({ board, ops }) => {
      try {
        if (!actor) return errorResult(new Error(NO_ACTOR_MSG));
        await prep(board);
        const { version, refused } = await client.edit(board, actor, ops as EditOp[]);
        const lines = [`board now v${version}`];
        for (const r of refused)
          lines.push(`refused [${r.id.replace(/^shape:/, '')}]: ${r.reason}`);
        return textResult(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'whiteboard_close',
    {
      description:
        'End the session: persists and unloads the board, returning the final outline. The board ' +
        'itself survives on disk (reopen it any day); the outline is YOURS to turn into a durable ' +
        'artifact — the service never writes into a repository.',
      inputSchema: { board: z.string() },
    },
    async ({ board }) => {
      try {
        await prep(board);
        const { outline } = await client.close(board);
        return textResult(
          `closed "${board}" — final outline below. Author the summary yourself (a design ` +
            `exploration doc), under your own identity:\n\n${formatOutline(outline)}`,
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'whiteboard_list',
    {
      description: 'List the boards on disk, most recently touched first.',
      inputSchema: {},
    },
    async () => {
      try {
        const { boards } = await client.list();
        if (boards.length === 0) return textResult('no boards yet — whiteboard_open creates one');
        return textResult(
          boards
            .map((b) => `- ${b.name}  (touched ${new Date(b.updatedAt).toISOString()})`)
            .join('\n'),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  for (const tool of SQUIG_PASSTHROUGH) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: {
          board: z.string().describe('board name — a brainstorm board or a linked one like "team"'),
          args: z
            .record(z.string(), z.unknown())
            .optional()
            .describe("Squig's own arguments for this tool, passed through verbatim"),
        },
      },
      async ({ board, args }) => {
        try {
          if (tool.mutates && !actor) return errorResult(new Error(NO_ACTOR_MSG));
          await prep(board);
          return squigResult(
            await client.squig(board, tool.squig, args ?? {}, tool.mutates ? actor! : undefined),
          );
        } catch (err) {
          return errorResult(err);
        }
      },
    );
  }

  return server;
}

// stdio entry point (the .mcp.json target).
if (isEntryPoint(import.meta.url)) {
  const port = parseInt(process.env['WHITEBOARD_PORT'] ?? '4851', 10);
  const server = buildWhiteboardMcpServer(
    new WhiteboardServiceClient(port),
    parseLinkedBoards(process.env['WHITEBOARD_LINKED_BOARDS'], process.cwd()),
  );
  await server.connect(new StdioServerTransport());
}
