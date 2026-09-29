/**
 * The canonical list of MCP tools this server registers. Kept as a tiny dependency-free
 * module so the registry test can pin it against the built server (the same pattern musterd's
 * own registry uses) — a rename breaks the build here instead of rotting the skill prose.
 * The `whiteboard_` prefix is deliberately an external namespace: NOT part of musterd's
 * two-namespace tool registry (ADR 330 decision 2).
 */
export const WHITEBOARD_TOOL_NAMES = [
  'whiteboard_open',
  'whiteboard_add',
  'whiteboard_read',
  'whiteboard_edit',
  'whiteboard_close',
  'whiteboard_list',
] as const;

export type WhiteboardToolName = (typeof WHITEBOARD_TOOL_NAMES)[number];
