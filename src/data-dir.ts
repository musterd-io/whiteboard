/**
 * Where the whiteboard keeps its state: ~/.whiteboard by default, WHITEBOARD_DATA_DIR overrides —
 * deliberately NOT under ~/.musterd (ADR 330 decision 1). Squig boards and their sidecars live in
 * squig/ under it; the service token beside them.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

export function dataDir(): string {
  return process.env['WHITEBOARD_DATA_DIR'] ?? join(homedir(), '.whiteboard');
}
