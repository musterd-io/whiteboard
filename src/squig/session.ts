/**
 * One live Squig companion per board (ADR 524): `squig.ts mcp <file>` owns the file (a sibling
 * `.lock`), serves the editor the human draws in, and answers its own tools over loopback HTTP
 * with the bearer token printed in the editor URL. The provider talks to it through
 * `POST /api/v1/tools/<name>` — plain fetch, no MCP client dependency.
 *
 * The token is the editor's only access control (loopback-only). It is held in memory and in
 * the URL handed to the human, never logged.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, unlinkSync } from 'node:fs';
import type { SquigCheckout } from './checkout.js';

export interface SquigNode {
  id: string;
  type: string;
  x: number;
  y: number;
  w?: number;
  h?: number;
  text?: string;
  boxed?: boolean;
  bind?: [string | null, string | null];
  [key: string]: unknown;
}

export interface SquigDocument {
  nodes: Record<string, SquigNode>;
  order: string[];
}

export type SquigOp =
  | { op: 'add'; nodes: Array<Partial<SquigNode> & { type: string }> }
  | { op: 'update'; patches: Array<{ id: string; patch: Record<string, unknown> }> }
  | { op: 'delete'; ids: string[] };

/** What the provider needs from a companion — an interface so tests can run without Squig. */
export interface SquigConnection {
  readonly editorUrl: string;
  read(): Promise<{ revision: number; document: SquigDocument }>;
  /** Apply ops against the latest revision, retrying once on a stale-revision 409. */
  edit(ops: SquigOp[]): Promise<void>;
  /** Any of Squig's own local tools, verbatim (ADR 527). The document id is filled in. */
  tool(name: SquigToolName, args: Record<string, unknown>): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

/**
 * Squig's local tools the whiteboard re-exposes (ADR 527), by Squig's own names. `documents`
 * is left out: a board IS one document, and whiteboard_list already lists boards.
 */
export const SQUIG_TOOLS = [
  'get_document',
  'edit_document',
  'replace_document',
  'render_document',
  'export_document',
  'measure_text',
  'catalog',
  'comment',
  'resolve_comment',
  'history',
  'restore',
] as const;
export type SquigToolName = (typeof SQUIG_TOOLS)[number];

const START_TIMEOUT_MS = 20_000;
const EDITOR_LINE = /Open canvas: (http:\/\/127\.0\.0\.1:\d+)\/\?local=1#token=(\S+)/;

/** Pull the origin and token out of the companion's stderr. */
export function parseEditorLine(text: string): { origin: string; token: string } | null {
  const m = text.match(EDITOR_LINE);
  return m ? { origin: m[1]!, token: m[2]! } : null;
}

/**
 * Squig refuses a file whose `.lock` names another session, even a dead one. Remove the lock
 * only when its pid is gone; a live owner keeps it, so Squig's own refusal still guards it.
 */
export function clearStaleLock(file: string): void {
  const lock = `${file}.lock`;
  let pid: unknown;
  try {
    pid = (JSON.parse(readFileSync(lock, 'utf8')) as { pid?: unknown }).pid;
  } catch {
    return;
  }
  if (typeof pid !== 'number' || pid <= 0) return;
  try {
    process.kill(pid, 0);
    return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ESRCH') return;
  }
  try {
    unlinkSync(lock);
  } catch {
    /* already gone */
  }
}

/**
 * How to start the companion on one file (ADR 537). The vendored companion is plain JavaScript;
 * a `SQUIG_CHECKOUT` clone runs Squig's TypeScript through strip-types and Squig's own loader.
 */
export function companionArgs(checkout: SquigCheckout, file: string): string[] {
  if (checkout.kind === 'vendored' || checkout.loader === null)
    return [checkout.entry, 'mcp', file];
  return [
    '--experimental-strip-types',
    '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON',
    '--import',
    checkout.loader,
    checkout.entry,
    'mcp',
    file,
  ];
}

export class SquigSession implements SquigConnection {
  private constructor(
    private child: ChildProcess,
    private origin: string,
    private token: string,
    private documentId: string,
  ) {}

  get editorUrl(): string {
    return `${this.origin}/?local=1#token=${this.token}`;
  }

  static async start(checkout: SquigCheckout, file: string): Promise<SquigSession> {
    clearStaleLock(file);
    const child = spawn(
      checkout.node,
      companionArgs(checkout, file),
      // stdin stays an open pipe: the companion exits when its stdio MCP input ends.
      { cwd: checkout.root, stdio: ['pipe', 'ignore', 'pipe'] },
    );
    const { origin, token } = await new Promise<{ origin: string; token: string }>(
      (resolve, reject) => {
        let stderr = '';
        const timer = setTimeout(() => {
          child.kill('SIGTERM');
          reject(new Error(`Squig did not open ${file} within ${START_TIMEOUT_MS}ms`));
        }, START_TIMEOUT_MS);
        child.stderr!.on('data', (chunk: Buffer) => {
          if (stderr.length < 65_536) stderr += chunk.toString('utf8');
          const parsed = parseEditorLine(stderr);
          if (parsed) {
            clearTimeout(timer);
            resolve(parsed);
          }
        });
        child.on('exit', (code) => {
          clearTimeout(timer);
          // The last stderr line names the cause (a live lock, a bad file); the token never
          // reaches stderr before the editor line, which resolved already if it printed.
          const last = stderr.trim().split('\n').pop() ?? '';
          reject(new Error(`Squig exited (${code}) before opening ${file}: ${last}`));
        });
      },
    );
    const res = await fetch(`${origin}/api/v1/documents`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = (await res.json()) as { documents?: Array<{ id: string }> };
    const documentId = body.documents?.[0]?.id;
    if (!documentId) {
      child.kill('SIGTERM');
      throw new Error(`Squig opened ${file} but listed no document`);
    }
    return new SquigSession(child, origin, token, documentId);
  }

  async tool(name: SquigToolName, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    // `catalog` is the one tool that names no document.
    return this.call(name, args, name !== 'catalog');
  }

  private async call<T>(
    name: string,
    body: Record<string, unknown>,
    withDocument = true,
  ): Promise<T> {
    const res = await fetch(`${this.origin}/api/v1/tools/${name}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(withDocument ? { ...body, documentId: this.documentId } : body),
    });
    const data = (await res.json()) as T & { error?: string };
    if (!res.ok) {
      const err = new Error(`Squig ${name}: ${data.error ?? `HTTP ${res.status}`}`);
      (err as Error & { status?: number }).status = res.status;
      throw err;
    }
    return data;
  }

  async read(): Promise<{ revision: number; document: SquigDocument }> {
    const got = await this.call<{ revision: number; document: SquigDocument }>('get_document', {});
    return { revision: got.revision, document: got.document };
  }

  async edit(ops: SquigOp[]): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      const { revision } = await this.read();
      try {
        await this.call('edit_document', { revision, operations: ops });
        return;
      } catch (err) {
        // The browser saved between our read and our edit; take its revision and go again.
        if ((err as { status?: number }).status === 409 && attempt === 0) continue;
        throw err;
      }
    }
  }

  async close(): Promise<void> {
    if (this.child.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      this.child.once('exit', () => resolve());
      this.child.stdin?.end();
      this.child.kill('SIGTERM');
    });
  }
}
