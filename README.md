# pi-statusline

A status line for [pi](https://pi.dev) in [pi-deck](https://github.com/hisea/pi-deck)'s
visual language — that also renders the status entries other extensions publish.

```
  <dir> pi-statusline  <branch> main
  <model> claude-opus-5-5  <brain> ━━━───  <ctx> ━━━━──────·─ 36%·360k/1.0M
  5h ━━╾───── 34% <reset> 2h·19m  wk ━━━━━━╾─ 85% <reset> 3d  mo ━━━━╾─── 62% <reset> 12d
  ↑1.8M ↓416k R57M $0.687 36.0%/1.0M
```

Line 1 is where the session is happening — folder, git branch, worktree. Line 2
is what the turn is — model, thinking level, context. Line 3 is how much of each
quota is used, as chips that fill up like the context bar, followed by any other
extension statuses; it appears only when at least one extension has set a
status. Line 4 is what it has cost.

`<model>`, `<dir>`, `<branch>`, `<ctx>`, `<brain>` and `<reset>` are Nerd Font
glyphs. `<reset>` replaces the `↺` pi-quotas publishes, which JetBrains Mono
lacks.

## Why this exists

pi-deck replaces the built-in footer with its own two-line one. The built-in
footer is what draws the **extension status line** — the row that
`ctx.ui.setStatus()` writes to. So installing pi-deck silently hides every
status readout in the session: quota/usage windows, the context dumb-zone
indicator, and anything else an extension publishes.

This package keeps pi-deck's look and puts that row back, above the token line,
so the footer reads top to bottom as where the session is, what the turn is,
what is left, then what it has cost.

By default each status is rendered **verbatim**, including the colours the
owning extension applied. That matters: a dumb-zone readout is only useful
because it turns red as you approach the threshold, and a usage bar because it
turns amber. Wrapping the line in an outer `dim` (as the token-stats line does)
would be broken by each entry's trailing reset and would erase that signal.

Extensions that publish a **structured feed** on `pi.events` get their data
*drawn* instead — see [Structured feeds](#structured-feeds).

## Structured feeds

Two extensions publish their data on `pi.events` as well as a status string:

| Channel                  | Published by     | Drawn as                       |
| ------------------------ | ---------------- | ------------------------------ |
| `context-tokens:updated` | `pi-token-count` | the dumb-zone tick on the bar  |
| `quotas:usage:updated`   | `pi-quotas`      | quota chips on the status line |

Drawing beats parsing. The status string is already rendered, so reading a
number back out of it means guessing — and `pi-quotas` scores a window by
*pace* as well as level, where the same 85% is a warning early in a window and
fine late in one. That judgement cannot be recovered from the text, so the feed
carries it directly, and the colour comes from the owning extension rather than
from a threshold re-invented here.

Each feed names the status key it supersedes, so the raw string is dropped
rather than printed twice. Where a feed has not arrived — the extension is not
installed, or has not published yet — the status string renders verbatim as
before. The dumb-zone tick is drawn only when the feed describes the window
currently on screen, so a reading left over from a previous model cannot put
the tick in the wrong place; until then the raw readout stays visible.

Set `structuredFeeds` to `false` to turn all of it off and get the verbatim
footer back.

## Install

```bash
pi install git:github.com/sergio-agosti/pi-statusline
```

Or from a local checkout:

```bash
pi install /path/to/pi-statusline
```

This package ships **no themes** — pair it with
[`pi-kanso-themes`](https://github.com/sergio-agosti/pi-kanso-themes) if you
want the Kanso palette. It is also a drop-in replacement for pi-deck's footer,
so remove pi-deck when installing it:

```bash
pi remove npm:@haispeed/pi-deck
```

Running both is not useful: two extensions racing to call `setFooter` means
whichever loads last wins.

## Settings

Settings live under the `piStatusline` key in `~/.pi/agent/settings.json`
(global) or `.pi/settings.json` (project). Project values win. All are
optional.

```json
{
  "piStatusline": {
    "statusLine": true,
    "position": "top",
    "separator": "  ",
    "order": ["context-tokens", "pi-quotas-usage"],
    "hide": [],
    "structuredFeeds": true
  }
}
```

| Key               | Default    | Meaning                                                     |
| ----------------- | ---------- | ----------------------------------------------------------- |
| `statusLine`      | `true`     | Render the extension status line at all.                     |
| `position`        | `"top"`    | `"top"` above the token line, `"bottom"` below it.           |
| `separator`       | `"  "`     | Placed between status entries and quota chips.               |
| `order`           | `[]`       | Keys to place first, in this sequence. Others follow, A→Z.   |
| `hide`            | `[]`       | Keys to omit.                                                |
| `structuredFeeds` | `true`     | Draw the structured feeds instead of their status text.      |

The default ordering is alphabetical by key, matching the built-in footer.
Extensions can rely on that: `pi-token-count` deliberately picks the key
`context-tokens` so it sorts ahead of `pi-quotas-usage`.

Settings are read when the footer is installed. Run `/reload` (or start a new
session) after changing them. A malformed settings file falls back to defaults
rather than breaking the footer.

## What differs from pi-deck

The layout, icons, and colour roles are pi-deck's. The changes:

- **The extension status line is rendered.** The reason for this package.
- **The context bar carries the dumb-zone threshold.** pi-deck's bar was
  coloured by absolute fullness alone, which cannot say whether *this* model's
  dumb zone has been reached. The tick and the colour now come from
  `pi-token-count` when it is installed.
- **`git worktree list` is no longer spawned per frame.** pi-deck called
  `execSync` inside `render()`, and the footer renders on every TUI frame —
  including every frame of a streaming response. The lookup is now cached with
  a 5s TTL and invalidated on branch change.
- **Token totals include everything.** pi-deck summed assistant messages only.
  Standalone `usage` entries (cache warming) and tool results that report usage
  were silently dropped, undercounting tokens and cost. This matches the
  built-in footer's accounting.
- **The `max` thinking level is mapped.** pi-deck's table stopped at `xhigh`,
  so `max` fell back to `dim`. The level is also shown beside the model, as a
  brain glyph and a bar filled to the level in that level's colour, rather
  than as a word on the right. The context bar moved next to it, leaving the
  branch and folder on the right.
- **Icons are the same width.** Ghostty and the proportional Nerd Font variant
  draw icons at their natural width, so each spills over the space after it.
  pi-deck's set ranged from 1.25 to 1.9 cells, which made the gaps uneven; the
  icons here all draw about 1.5 cells wide and share one trailing space.
- **A stale context degrades instead of throwing.** The footer's context
  resolves lazily through getters that throw once the extension runner goes
  inactive (session switch, reload). A throw inside the TUI render loop is not
  survivable, so a bad frame renders `statusline unavailable` instead.
- **Current API.** Uses the `@earendil-works/*` scope and the documented
  `ctx.thinkingLevel` / `ctx.cwd` accessors. pi-deck imports the legacy
  `@mariozechner/*` scope and reads `ctx.sessionManager.buildSessionContext()`,
  which is not on the published `ReadonlySessionManager` type.

## Development

```bash
npm install          # --legacy-peer-deps if you delete package-lock.json
npm run typecheck
npm test
```

The lockfile is committed. On a fresh clone without one, `npm install` can fail
with an npm arborist error while resolving vitest's peers; use
`npm install --legacy-peer-deps`.

Tests cover the pure formatting logic, the settings reader, the git worktree
cache (against real temporary repositories), and the extension itself driven
through a fake pi API with assertions on the rendered lines.

## Credits and licence

The footer design and layout come from
[`@haispeed/pi-deck`](https://github.com/hisea/pi-deck) v0.1.5 (MIT,
Copyright © 2025 hai). This is a fork of that footer, not of the themes, which
live in [`pi-kanso-themes`](https://github.com/sergio-agosti/pi-kanso-themes).
See [NOTICE](NOTICE) for full attributions.

Released under the [MIT licence](LICENSE).
