# pi-statusline

A status line for [pi](https://pi.dev) in [pi-deck](https://github.com/hisea/pi-deck)'s
visual language — that also renders the status entries other extensions publish.

```
  claude-opus-5-5 |  pi-statusline |  main |  feat/status   [db] ━━━━━─── 42%  ◐ high
                                                              ↑12k ↓3.4k R56k $0.123 42.0%/200k
  160.0k ◆  5h: 85%/93% (2h) · wk: 12% (3d)
```

## Why this exists

pi-deck replaces the built-in footer with its own two-line one. The built-in
footer is what draws the **extension status line** — the row that
`ctx.ui.setStatus()` writes to. So installing pi-deck silently hides every
status readout in the session: quota/usage windows, the context dumb-zone
indicator, and anything else an extension publishes.

This package keeps pi-deck's two-line layout and puts that row back
underneath it. Line 3 appears only when at least one extension has set a
status, so a session with no such extensions still gets pi-deck's clean
two-line footer.

Each status is rendered **verbatim**, including the colours the owning
extension applied. That matters: a dumb-zone readout is only useful because it
turns red as you approach the threshold, and a usage bar because it turns
amber. Wrapping the line in an outer `dim` (as the token-stats line does) would
be broken by each entry's trailing reset and would erase that signal.

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
    "position": "bottom",
    "separator": "  ",
    "order": ["context-tokens", "pi-quotas-usage"],
    "hide": []
  }
}
```

| Key          | Default    | Meaning                                                        |
| ------------ | ---------- | -------------------------------------------------------------- |
| `statusLine` | `true`     | Render the extension status line at all.                        |
| `position`   | `"bottom"` | `"bottom"` below the token stats, or `"top"` above them.        |
| `separator`  | `"  "`     | Placed between status entries.                                  |
| `order`      | `[]`       | Keys to place first, in this sequence. Others follow, A→Z.      |
| `hide`       | `[]`       | Keys to omit.                                                   |

The default ordering is alphabetical by key, matching the built-in footer.
Extensions can rely on that: `pi-token-count` deliberately picks the key
`context-tokens` so it sorts ahead of `pi-quotas-usage`.

Settings are read when the footer is installed. Run `/reload` (or start a new
session) after changing them. A malformed settings file falls back to defaults
rather than breaking the footer.

## What differs from pi-deck

The layout, icons, and colour roles are pi-deck's. The changes:

- **The extension status line is rendered.** The reason for this package.
- **`git worktree list` is no longer spawned per frame.** pi-deck called
  `execSync` inside `render()`, and the footer renders on every TUI frame —
  including every frame of a streaming response. The lookup is now cached with
  a 5s TTL and invalidated on branch change.
- **Token totals include everything.** pi-deck summed assistant messages only.
  Standalone `usage` entries (cache warming) and tool results that report usage
  were silently dropped, undercounting tokens and cost. This matches the
  built-in footer's accounting.
- **The `max` thinking level is mapped.** pi-deck's table stopped at `xhigh`,
  so `max` fell back to `dim`.
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
