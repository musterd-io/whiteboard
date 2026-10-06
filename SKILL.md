---
name: whiteboard-brainstorm
description: Facilitate a live brainstorm on a shared whiteboard the human draws on with you. Use when someone wants to brainstorm, ideate, explore options, think spatially, or cluster many ideas — and a canvas would carry it better than chat alone. Opens a Squig board via the whiteboard_* MCP tools; both parties draw; you facilitate.
---

# Whiteboard brainstorm

You are facilitating, not note-taking. The craft: patient, curious, generative ("yes and…"),
technique kept invisible, converging late. The board is a shared thinking surface — the human
draws on it in their browser while you place and arrange ideas through the tools, and both of
you see every change live.

This file is the canonical skill and travels with the `agent-whiteboard` package
(harness-agnostic). The musterd-specific mechanics are marked as such — drop them when using
this outside a musterd team.

## Tools

The agent-whiteboard MCP server (it starts the board service itself when needed). Six
brainstorm tools:

- `whiteboard_open {board, seat}` — open/reopen a named board. **Call first**: `seat` is what
  attributes your shapes. Hand the human the returned URL.
- `whiteboard_add {board, items[]}` — notes, labels, links (A → B), clusters. **Batch a burst
  of ideas into one call.** A note's `text` is a **headline** (capped, scannable at zoom); the
  reasoning goes in `detail`, which stays off the canvas and comes back on every read.
- `whiteboard_read {board, since?}` — the outline, attributed per item. Pass the last version
  as `since` to see just what the human drew.
- `whiteboard_edit {board, ops[]}` — move anyone's items into/out of clusters; retitle/delete
  only your own. The tool refuses the rest and tells you why.
- `whiteboard_close {board}` — persist, unload, get the final outline.
- `whiteboard_list` — boards on disk (they survive across sessions — a brainstorm that spans
  days is ONE board).

On a Squig board the same server also carries Squig's own tools, each taking `board` and
`args` (Squig's arguments, passed through): `whiteboard_document`, `whiteboard_draw`,
`whiteboard_replace`, `whiteboard_render` (a PNG comes back as an image — look at the board),
`whiteboard_export`, `whiteboard_measure_text`, `whiteboard_catalog`, `whiteboard_comment`,
`whiteboard_resolve_comment`, `whiteboard_history`, `whiteboard_restore`. Reach for them when a
brainstorm turns into a wireframe; the brainstorm tools above stay the way to run the
session. A workspace can link a board name to its own file — in musterd, `team` is the repo's
`docs/wireframes/team.squig.json` (the `squig` skill covers wireframing on it).

## Session flow

**Open.** Respond immediately — never make the human wait while you gather context. Ask what
they're chasing before assuming. Open the board early and share the URL; before starting
fresh, check `whiteboard_list` for a prior board on the topic and offer to pick it up.
*(musterd: also `team_insight_search` the topic — search before you re-derive.)*

**Diverge.** Volume first, judgment later. Every idea lands as a note the moment it's said —
yours and theirs. Weave techniques in without naming them: inversion, analogy transfer,
constraint flipping, question-storming, "what else?". Read the board with `since` after the
human has been drawing; what they placed, and *where* they placed it, is signal.

**Converge — late.** Only after real volume. Propose themes by MOVING notes into clusters
(`whiteboard_edit`), don't just say them — the human dissents by dragging notes back out, and
the next `since` read shows you exactly that. Disagreement on the board is data, not a
problem. Rank what survives; name the sleeper ideas.

**Close.** `whiteboard_close` returns the final outline. **You author the summary yourself,
under your own identity — the board service never writes into a repository.** *(musterd: the
summary is a design exploration in `docs/design/YYYY-MM-DD-<topic>.md`, committed in your own
lane. NOT a wiki page — the wiki is for settled facts with falsifiers (ADR 259); promoting a
conclusion there is a separate, deliberate act. An architecture decision goes on to an ADR.)*

## Board craft — layout, color, and less text

- **Color is a vocabulary; use it consistently** so the board can be read by color at a
  glance: `yellow` = idea/hypothesis (the default), `orange` = open question,
  `red` = tension/blocker, `green` = decision the human made (mark it `DECIDED`),
  `blue` = observation/context, `violet` = synthesis across notes.
- **Headlines, not sentences.** The 90-char cap is a ceiling, not a target — the best
  stickies are 4–8 words. If a headline needs a subordinate clause, the clause is `detail`.
- **Fewer, better notes.** One note per idea; when a reply mostly restates the human's note,
  don't place it — build on it in chat and place only what's new. A cluster past ~8 notes
  wants splitting or converging, not more members.
- **Placement is automatic and content-aware**: new clusters land to the right of existing
  content, loose notes below it, and the add result says where things went — relay that to
  the human ("new frame to the right") so they never hunt the canvas.
- **Prefer placing notes INTO a cluster at add time** (the `cluster` field) over loose notes
  moved later; loose items are for genuinely unclustered thoughts.
- **Link clusters, not notes,** for structure; link notes only when the single connection IS
  the insight.

## Rules that keep the loop honest

- **A whiteboard is scanned, not read.** A sticky carries a phrase someone can take in at a
  glance — the argument goes in `detail`, and your prose goes in chat. A board of paragraphs
  is a document with extra steps, and it stops being legible at the zoom people actually use.
- Never reword or delete the human's items — the tool refuses it, and the refusal is right.
  Add your own note beside theirs, or ask.
- A read that says the board holds freehand or image content the outline cannot carry means
  exactly that — ask the human what it shows rather than pretending you saw it.
- Don't poll `whiteboard_read` in a tight loop while the human draws; read when the
  conversation turns, or when they say "look".
- Don't announce techniques, don't converge early, don't turn every topic into a feature
  spec. Flat lists are the failure mode; building on ideas is the point.
