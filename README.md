# @musterd/whiteboard

A shared whiteboard for a person and an agent to brainstorm on. You draw in the
browser, in [Squig](https://github.com/pablostanley/squig)'s editor. The agent
draws and reads through MCP tools. You both see every change, and every item is
labelled with who put it there.

Squig is bundled in the package, so there is nothing else to install or build.

```sh
npx @musterd/whiteboard
```

That starts the MCP server. Your agent calls `whiteboard_open`, which starts the
board service when it isn't running and hands you a URL. Open it and draw. The URL
holds a private token for that board, so keep it on your machine.

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

Squig's own tools work on any board too. Each takes `{board, args}` and passes
`args` through to Squig: `whiteboard_document`, `whiteboard_draw`,
`whiteboard_replace`, `whiteboard_render` (SVG, or a PNG the agent can look at),
`whiteboard_export`, `whiteboard_measure_text`, `whiteboard_catalog`,
`whiteboard_comment`, `whiteboard_resolve_comment`, `whiteboard_history` and
`whiteboard_restore`. The ones that change the board need `whiteboard_open` first,
so what the agent draws is attributed to it.

A note's text is a **headline**, kept short so it reads when zoomed out. The
reasoning goes in `detail`, which stays off the canvas and comes back on every
read.

## Where things live

- **Boards** are Squig files in `~/.whiteboard/squig/<board>.squig.json`, with a
  `<board>.meta.json` beside each that records who placed what. They survive
  restarts, so a brainstorm that spans days is one board. Set `WHITEBOARD_DATA_DIR`
  to move the whole directory.
- **A board can live in your project** instead: set
  `WHITEBOARD_LINKED_BOARDS=team=docs/team.squig.json` in the MCP server's
  environment, and the board `team` reads and writes that file.
- **The service** listens on `localhost:4851`. Set `WHITEBOARD_PORT` to change it.
  It runs detached after the first `whiteboard_open`, answers only localhost, and
  requires a token on its API that it writes to a file only you can read. It holds
  no authority beyond the boards.
- **Node 22 or newer.**

## Develop

```sh
npm ci          # use the lockfile: a bare `npm install` without it trips an npm 10.9 peer-resolver bug
npm run build   # tsc
npm test        # includes the live Squig test and extraction.test.ts
```

`vendor/squig/` is Squig, built at a pinned commit and bundled by
`scripts/vendor-squig.mjs` (it needs git and pnpm). Never edit it by hand: run
`npm run vendor:squig -- <commit>` to move to a newer Squig, and review the diff of
`vendor/squig/VENDORED.json`.

## Credits and licenses

- This package is MIT licensed ([LICENSE](LICENSE)).
- **Squig** is by [Pablo Stanley](https://github.com/pablostanley/squig), MIT
  licensed. Its notice ships in `vendor/squig/LICENSE`.
- Squig's fonts (Geist, Patrick Hand, Source Serif 4) are under the SIL Open Font
  License; their license files ship beside them in `vendor/squig/lib/agent/fonts/`.
- Rendering uses [`sharp`](https://sharp.pixelplumbing.com) (Apache-2.0) and
  [`@resvg/resvg-js`](https://github.com/yisibl/resvg-js) (MPL-2.0), installed from
  npm as dependencies.

---

*From the musterd team — the coordination layer where agents and humans are
peers. This tool is deliberately standalone; musterd is where a brainstorm's
output lands as work someone owns, on a team with a roster and a record.
[musterd.io](https://musterd.io)*
