# musterd-whiteboard

A shared whiteboard for a person and an agent to brainstorm on. You draw in the
browser. The agent draws and reads through MCP tools. You both see every change
live, and every shape is labelled with who put it there.

```sh
npx @musterd/whiteboard
```

That starts the MCP server. Your agent calls `whiteboard_open`, which starts the
board service when it isn't running and hands you a URL. Open it and draw.

## Add it to your harness

Any harness that speaks MCP over stdio can run it. The shapes below are the usual
ones. Check your harness's docs if it keeps its MCP config somewhere else.

**Claude Code** (`.mcp.json` in your project), **Cursor** (`.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "whiteboard": { "command": "npx", "args": ["-y", "@musterd/whiteboard"] }
  }
}
```

**Codex** (`~/.codex/config.toml`):

```toml
[mcp_servers.whiteboard]
command = "npx"
args = ["-y", "@musterd/whiteboard"]
```

Then give your agent [`SKILL.md`](SKILL.md). It holds the facilitation craft
(open early, batch ideas, cluster late, let the person steer), not just the tool
list. Copy it to wherever your harness reads skills.

## The tools

| Tool | Does |
| --- | --- |
| `whiteboard_open {board, seat}` | open or create a named board; returns the URL for the person |
| `whiteboard_add {board, items[]}` | notes, labels, links (A → B) and clusters, batched; layout is automatic |
| `whiteboard_read {board, since?}` | the board as an outline, attributed per item; `since` returns only what changed |
| `whiteboard_edit {board, ops[]}` | move anyone's items between clusters; retitle or delete only your own |
| `whiteboard_close {board}` | save, unload, return the final outline |
| `whiteboard_list` | boards on disk, most recent first |

A note's text is a **headline**, kept short so it reads when zoomed out. The
reasoning goes in `detail`, which stays off the canvas and comes back on every
read.

## Where things live

- **Boards** are JSON files in `~/.whiteboard/boards/`, and they survive restarts.
  A brainstorm that spans days is one board. Set `WHITEBOARD_DATA_DIR` to move the
  whole directory (boards go in its `boards/`).
- **The service** listens on `localhost:4851`. Set `WHITEBOARD_PORT` to change it.
  It runs detached after the first `whiteboard_open` and holds no authority beyond
  the boards.
- **Node 22 or newer.**

## Develop

```sh
npm ci          # use the lockfile: a bare `npm install` without it trips an npm 10.9 peer-resolver bug
npm run build   # tsc + the browser page (vite)
npm test        # includes extraction.test.ts: nothing here may depend on the monorepo it came from
```

The canvas is [tldraw](https://tldraw.dev), used under its license. Check the
tldraw license terms before you put it in a hosted product.

---

*From the musterd team — the coordination layer where agents and humans are
peers. This tool is deliberately standalone; musterd is where a brainstorm's
output lands as work someone owns, on a team with a roster and a record.
[musterd.io](https://musterd.io)*
