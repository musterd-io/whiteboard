/**
 * The whiteboard service's guard (lane 01M47FADGV). Binding to 127.0.0.1 keeps other machines
 * out, but not a web page in the user's own browser: a cross-site `text/plain` POST or a
 * DNS-rebound one reaches loopback. Three checks close that:
 *
 * - **Host** must be `localhost` or `127.0.0.1` at the service's own port, on every request. A
 *   rebound request carries the attacker's hostname.
 * - **The API needs a token.** At start the service writes a random token to
 *   `<data dir>/service-<port>.token` (mode 0600). Every `/api` call must present it as a Bearer
 *   token. The MCP client reads it from disk; a browser page cannot.
 * - **A websocket from a foreign Origin is refused.** The board page the service serves is
 *   same-origin; any other page is not.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from './data-dir.js';

export function serviceTokenPath(port: number): string {
  return join(dataDir(), `service-${port}.token`);
}

/** Mint and publish a fresh token for this service instance. Returns it. */
export function publishServiceToken(port: number): string {
  const token = randomBytes(32).toString('base64url');
  mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
  const path = serviceTokenPath(port);
  writeFileSync(path, token, { mode: 0o600 });
  chmodSync(path, 0o600);
  return token;
}

export function removeServiceToken(port: number): void {
  rmSync(serviceTokenPath(port), { force: true });
}

/** The running service's token, as the client reads it. Null when the service never wrote one. */
export function readServiceToken(port: number): string | null {
  try {
    return readFileSync(serviceTokenPath(port), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

export function loopbackHost(host: string | undefined, port: number): boolean {
  return host === `localhost:${port}` || host === `127.0.0.1:${port}`;
}

export function bearerMatches(header: string | undefined, token: string): boolean {
  const given = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}
