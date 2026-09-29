/**
 * Regression tests for the ghost-room clobber: two callers racing ensureRoom used to build
 * two TLSocketRooms for one board, and the loser's persist timer overwrote newer work.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadSnapshot, saveSnapshot } from './persistence.js';
import { RoomManager } from './roomManager.js';

let dir: string;
let rooms: RoomManager;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'whiteboard-rooms-test-'));
  process.env['WHITEBOARD_DATA_DIR'] = dir;
  rooms = new RoomManager({ idleTimeoutMs: 60_000, persistIntervalMs: 60_000 });
});

afterEach(async () => {
  await rooms.persistAllAndClose();
  delete process.env['WHITEBOARD_DATA_DIR'];
  await rm(dir, { recursive: true, force: true });
});

describe('ensureRoom', () => {
  it('concurrent callers get the SAME room — no ghost with a live persist timer', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => rooms.ensureRoom('raced')));
    const first = results[0]!.room;
    // Every racer shares the one load — same room object, one entry in the map. (They also
    // share its `created` flag; only a later, separate call reports created:false.)
    for (const r of results) expect(r.room).toBe(first);
    expect(rooms.activeRoomCount()).toBe(1);
    const later = await rooms.ensureRoom('raced');
    expect(later.room).toBe(first);
    expect(later.created).toBe(false);
  });
});

describe('saveSnapshot regression guard', () => {
  it('refuses to move a board file backwards', async () => {
    await saveSnapshot('b', { documentClock: 10, documents: [] });
    await expect(saveSnapshot('b', { documentClock: 7, documents: [] })).rejects.toThrow(
      /stale room is trying to overwrite newer work/,
    );
    expect(((await loadSnapshot('b')) as { documentClock: number }).documentClock).toBe(10);
    // Equal or newer clocks still write.
    await saveSnapshot('b', { documentClock: 11, documents: [] });
    expect(((await loadSnapshot('b')) as { documentClock: number }).documentClock).toBe(11);
  });
});
