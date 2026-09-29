/**
 * Thin HTTP client to the whiteboard service, with spawn-on-demand (ADR 330 decision 8):
 * the first open that finds the port dead spawns the service detached and waits for health.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { EditOp, EditRefusal, ItemInput, Outline } from '../port.js';

const SERVICE_ENTRY = fileURLToPath(new URL('../service.js', import.meta.url));
const HEALTH_TIMEOUT_MS = 500;
const SPAWN_WAIT_MS = 5_000;

export class WhiteboardServiceClient {
  constructor(private port: number) {}

  private base(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async isUp(): Promise<boolean> {
    try {
      const res = await fetch(`${this.base()}/healthz`, {
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      });
      if (!res.ok) return false;
      const body = (await res.json()) as { service?: string };
      // A different process squatting the port is a hard error, not a service to talk to.
      if (body.service !== 'agent-whiteboard') {
        throw new Error(
          `port ${this.port} is serving something that is not the whiteboard service — set WHITEBOARD_PORT to a free port`,
        );
      }
      return true;
    } catch (err) {
      if (err instanceof Error && err.message.includes('not the whiteboard service')) throw err;
      return false;
    }
  }

  /** Ensure the service is running, spawning it detached when it is not. */
  async ensureService(): Promise<void> {
    if (await this.isUp()) return;
    const child = spawn(process.execPath, [SERVICE_ENTRY], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, WHITEBOARD_PORT: String(this.port) },
    });
    child.unref();

    const deadline = Date.now() + SPAWN_WAIT_MS;
    while (Date.now() < deadline) {
      if (await this.isUp()) return;
      await new Promise((r) => setTimeout(r, 150));
    }
    throw new Error(
      `whiteboard service did not answer on port ${this.port} within ${SPAWN_WAIT_MS}ms of spawning — ` +
        `run it by hand to see why: node ${SERVICE_ENTRY}`,
    );
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.base()}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = (await res.json()) as T & { error?: string };
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status} from ${path}`);
    return data;
  }

  async open(board: string): Promise<{ outline: Outline; created: boolean; url: string }> {
    await this.ensureService();
    return this.post(`/api/boards/${board}/open`, {});
  }

  async add(
    board: string,
    actor: string,
    items: ItemInput[],
  ): Promise<{ ids: string[]; version: number; hint?: string }> {
    return this.post(`/api/boards/${board}/add`, { actor, items });
  }

  async read(board: string, since?: number): Promise<Outline> {
    const query = since === undefined ? '' : `?since=${since}`;
    const res = await fetch(`${this.base()}/api/boards/${board}/outline${query}`);
    const data = (await res.json()) as Outline & { error?: string };
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    return data;
  }

  async edit(
    board: string,
    actor: string,
    ops: EditOp[],
  ): Promise<{ version: number; refused: EditRefusal[] }> {
    return this.post(`/api/boards/${board}/edit`, { actor, ops });
  }

  async close(board: string): Promise<{ outline: Outline }> {
    return this.post(`/api/boards/${board}/close`, {});
  }

  async list(): Promise<{ boards: Array<{ name: string; updatedAt: number }> }> {
    await this.ensureService();
    const res = await fetch(`${this.base()}/api/boards`);
    return (await res.json()) as { boards: Array<{ name: string; updatedAt: number }> };
  }
}
