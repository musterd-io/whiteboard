/**
 * Disk persistence. The predecessor persisted through a Python REST backend; standalone means
 * boards are plain JSON snapshots under the data dir (default ~/.whiteboard/boards/,
 * WHITEBOARD_DATA_DIR overrides — deliberately NOT under ~/.musterd, ADR 330 decision 1).
 * Boards stay out of git: mutable working state, not a reviewed artifact.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { assertBoardName } from '../port.js';

export function dataDir(): string {
  return process.env['WHITEBOARD_DATA_DIR'] ?? join(homedir(), '.whiteboard');
}

function boardsDir(): string {
  return join(dataDir(), 'boards');
}

function boardPath(name: string): string {
  assertBoardName(name);
  return join(boardsDir(), `${name}.json`);
}

export async function loadSnapshot(name: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(boardPath(name), 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

// One write at a time per board (#1084 review, REQUIRED 2): write-through persists, the 30s
// periodic timer, and closeRoom all call saveSnapshot with nothing serializing them, and a
// FIXED temp path meant two in-flight writers corrupted each other's atomic rename — loudly
// (rename ENOENT out of an ordinary add) or quietly (one writer's bytes renamed into place
// under the other's clock, invisible to the on-disk clock guard). The chain serializes
// writers per board; the per-write temp name is the belt under it.
const writeChains = new Map<string, Promise<void>>();

export async function saveSnapshot(name: string, snapshot: unknown): Promise<void> {
  const chained = (writeChains.get(name) ?? Promise.resolve())
    // A failed predecessor must not poison the chain — each writer gets its own verdict.
    .catch(() => {})
    .then(() => saveSnapshotNow(name, snapshot));
  writeChains.set(
    name,
    chained.catch(() => {}),
  );
  return chained;
}

async function saveSnapshotNow(name: string, snapshot: unknown): Promise<void> {
  await mkdir(boardsDir(), { recursive: true });
  // A snapshot must never move the file backwards. The room manager's single-flight load is
  // the real fix for the ghost-room clobber; this is the belt that makes any future stale
  // writer lose harmlessly instead of eating newer work.
  const clock = (snapshot as { documentClock?: number })?.documentClock;
  if (typeof clock === 'number') {
    const onDisk = (await loadSnapshot(name)) as { documentClock?: number } | null;
    if (onDisk && typeof onDisk.documentClock === 'number' && onDisk.documentClock > clock) {
      throw new Error(
        `refusing to persist board ${JSON.stringify(name)} at clock ${clock}: the file is already at ${onDisk.documentClock} — a stale room is trying to overwrite newer work`,
      );
    }
  }
  // Write-then-rename so a crash mid-write can't leave a truncated board; the temp name is
  // unique per write so a concurrent writer can never overwrite or steal it.
  const path = boardPath(name);
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(tmp, JSON.stringify(snapshot), 'utf8');
  await rename(tmp, path);
}

export async function listBoards(): Promise<Array<{ name: string; updatedAt: number }>> {
  let entries: string[];
  try {
    entries = await readdir(boardsDir());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const boards: Array<{ name: string; updatedAt: number }> = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const name = entry.slice(0, -'.json'.length);
    const s = await stat(join(boardsDir(), entry));
    boards.push({ name, updatedAt: s.mtimeMs });
  }
  return boards.sort((a, b) => b.updatedAt - a.updatedAt);
}
