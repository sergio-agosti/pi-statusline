/**
 * pi-statusline — a status line in pi-deck's visual language that also renders
 * the entries other extensions publish with `ctx.ui.setStatus()`.
 *
 * pi-deck replaces the built-in footer outright. The built-in footer is what
 * draws the extension status line, so installing pi-deck silently hides every
 * `setStatus` readout in the session — usage quotas, the context dumb-zone
 * indicator, and anything else an extension publishes. This extension keeps
 * pi-deck's two-line layout and adds the status line back underneath it.
 *
 *   line 1   model + thinking | context             git | folder
 *   line 2   5h ━━╾───── 34% ↺ 2h·19m  wk ━━━━━━╾─ 85% ↺ 3d
 *   line 3                              ↑in ↓out Rcache Wcache $cost 45%/200k
 *
 * Line 2 appears only when at least one extension has set a status.
 *
 * Extensions that publish a structured feed on `pi.events` — pi-token-count and
 * pi-quotas — get their data drawn rather than printed: the dumb-zone threshold
 * becomes a tick on the context bar, and quota windows become chips. Their
 * status text is suppressed, since it carries the same data in a second format.
 * Both are progressive: with no feed the status text renders verbatim, and the
 * whole thing can be turned off with `structuredFeeds: false`.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
	ReadonlyFooterDataProvider,
	Theme,
	ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
	buildStatusLine,
	chipBar,
	collectUsageTotals,
	contextBarSegments,
	formatTokens,
	sanitizeInlineText,
	type UsageTotals,
} from "./format.ts";
import {
	CONTEXT_TOKENS_UPDATED_EVENT,
	QUOTAS_USAGE_UPDATED_EVENT,
	parseContextFeed,
	parseQuotasFeed,
	type ContextFeed,
	type ContextTokenSeverity,
	type QuotaFeedWindow,
	type QuotaSeverity,
	type QuotasFeed,
} from "./feed.ts";
import { orderStatusEntries, readSettings, type StatuslineSettings } from "./settings.ts";
import { getWorktreeLabel, invalidateWorktreeCache } from "./worktree.ts";

/**
 * Nerd Font glyphs, chosen to be the same width.
 *
 * Terminals that draw Nerd Font icons at their natural width (Ghostty, the
 * Propo font variant) let each one spill over the cell after it, so the
 * visible gap after an icon is its spaces minus that spill. Gaps only come in
 * whole cells, so equal gaps need equally wide glyphs: every icon here draws
 * about 1.5 cells wide (branch, the narrowest, 1.35), mixing glyph families
 * where the obvious pick was off-size — Font Awesome's robot is 1.9.
 */
const ICONS = {
	model: "\u{f06a9}", // md-robot
	dir: "\uf07b", // fa-folder
	branch: "\uf126", // fa-code_branch
	worktree: "\uec7e", // cod-worktree
	context: "\uf2db", // fa-microchip
	brain: "\uee9c", // fa-brain
	reset: "\u{f02da}", // md-history
} as const;

/**
 * One space after every icon. A ~1.5-cell glyph spills half a cell into it,
 * leaving a half-cell gap; a second space would leave a cell and a half. Where
 * every glyph is exactly one cell wide, this reads as an ordinary space.
 */
const ICON_GAP = " ";

const THINKING_COLORS: Record<string, ThemeColor> = {
	off: "dim",
	minimal: "thinkingMinimal",
	low: "thinkingLow",
	medium: "thinkingMedium",
	high: "thinkingHigh",
	xhigh: "thinkingXhigh",
	max: "thinkingMax",
};

/** The thinking levels drawn as bar steps, lowest first. `off` draws nothing. */
const THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;


const CONTEXT_BAR_WIDTH = 12;
const QUOTA_BAR_WIDTH = 8;

/**
 * Between segments on the identity line, and the default between status
 * entries. Plain spaces rather than a rule: every segment already opens with an
 * icon, so a bar between them is furniture.
 */
const SEGMENT_GAP = "  ";

/**
 * pi-token-count owns the dumb-zone thresholds, so its verdict is used as given
 * rather than re-derived from the percentage.
 */
const CONTEXT_SEVERITY_COLORS: Record<ContextTokenSeverity, ThemeColor> = {
	normal: "syntaxString",
	warning: "warning",
	dumb: "error",
};

/** Mirrors pi-quotas' own getSeverityColor. */
const QUOTA_SEVERITY_COLORS: Record<QuotaSeverity, ThemeColor> = {
	none: "success",
	warning: "warning",
	high: "error",
	critical: "error",
};

/**
 * Cumulative usage memo.
 *
 * Summing every entry is O(entries) and the footer renders on every TUI frame.
 * Entries are append-only, so the totals only change when the entry count or
 * the leaf moves.
 */
interface StatsCache {
	sessionId: string;
	leafId: string | null;
	entryCount: number;
	totals: UsageTotals;
}

/** Latest payload from each feed, held across footer installs. */
interface Feeds {
	context?: ContextFeed;
	quotas?: QuotasFeed;
}

export default function piStatusline(pi: ExtensionAPI) {
	// Subscribed for the life of the instance rather than per footer, so a footer
	// installed after the last feed event — a session switch or a `/reload`
	// re-renders without re-running this factory — draws the latest data
	// immediately instead of waiting out a refresh interval.
	const feeds: Feeds = {};
	let requestRender: (() => void) | undefined;

	pi.events.on(CONTEXT_TOKENS_UPDATED_EVENT, (data) => {
		const feed = parseContextFeed(data);
		if (!feed) return;
		feeds.context = feed;
		requestRender?.();
	});

	pi.events.on(QUOTAS_USAGE_UPDATED_EVENT, (data) => {
		const feed = parseQuotasFeed(data);
		if (!feed) return;
		feeds.quotas = feed;
		requestRender?.();
	});

	pi.on("session_start", (_event, ctx) => {
		ctx.ui.setFooter((tui, theme, footerData) => {
			// Settings are read once when the footer is installed; `/reload` or a
			// new session picks up changes.
			const settings = readSettings(getCwd(ctx));
			let statsCache: StatsCache | undefined;
			requestRender = () => tui.requestRender();

			const unsubscribe = footerData.onBranchChange(() => {
				// A branch change is the best available signal that worktrees may
				// have appeared or disappeared.
				invalidateWorktreeCache();
				tui.requestRender();
			});

			function getTotals(): UsageTotals {
				const sessionManager = ctx.sessionManager;
				const sessionId = sessionManager.getSessionId();
				const leafId = sessionManager.getLeafId();
				// ReadonlySessionManager exposes getEntries() but not getEntryCount().
				const entries = sessionManager.getEntries();

				if (
					statsCache &&
					statsCache.sessionId === sessionId &&
					statsCache.leafId === leafId &&
					statsCache.entryCount === entries.length
				) {
					return statsCache.totals;
				}

				const totals = collectUsageTotals(entries);
				statsCache = { sessionId, leafId, entryCount: entries.length, totals };
				return totals;
			}

			return {
				dispose() {
					requestRender = undefined;
					unsubscribe();
				},
				invalidate() {},
				render(width: number): string[] {
					// The footer's context resolves its values lazily through getters
					// that throw once the extension runner goes inactive (session
					// switch, reload). A throw here would land inside the TUI render
					// loop, so degrade this frame instead.
					try {
						return renderFrame(width);
					} catch {
						return [truncateToWidth(theme.fg("dim", " statusline unavailable"), width)];
					}
				},
			};

			function renderFrame(width: number): string[] {
				const contextFeed = applicableContextFeed(ctx, feeds.context, settings);

				const lines = [
					renderIdentityLine(theme, footerData, ctx, width, contextFeed),
				];

				const statusLine =
					settings.statusLine && width > 0
						? renderStatusLine(theme, footerData, settings, feeds, contextFeed, width)
						: undefined;

				if (statusLine && settings.position === "top") lines.push(statusLine);
				lines.push(renderStatsLine(theme, ctx, width, getTotals()));
				if (statusLine && settings.position === "bottom") lines.push(statusLine);

				return lines;
			}
		});
	});
}

/** `model + thinking | context` on the left, `git | folder` on the right. */
function renderIdentityLine(
	theme: Theme,
	footerData: ReadonlyFooterDataProvider,
	ctx: ExtensionContext,
	width: number,
	contextFeed: ContextFeed | undefined,
): string {
	const c = (token: ThemeColor, text: string) => theme.fg(token, text);

	const cwd = getCwd(ctx);
	const branch = footerData.getGitBranch();
	const worktree = getWorktreeLabel(cwd);

	// What the current turn is: which model, at what thinking level, with how
	// much room left. Kept together on the left.
	const thinkingLevel = ctx.thinkingLevel;
	const thinking =
		!thinkingLevel || thinkingLevel === "off" ? "" : renderThinking(theme, thinkingLevel);

	const left = [
		c("syntaxType", ICONS.model + ICON_GAP + (ctx.model?.id ?? "no-model")),
		thinking,
		renderContextBar(theme, ctx, contextFeed),
	].filter(Boolean);

	// Where it is happening, pushed to the far end.
	const right = [
		branch ? c("success", ICONS.branch + ICON_GAP + branch) : "",
		worktree ? c("syntaxNumber", ICONS.worktree + ICON_GAP + worktree) : "",
		c("syntaxFunction", ICONS.dir + ICON_GAP + (cwd.split("/").pop() || cwd)),
	].filter(Boolean);

	const leftText = left.join(theme.fg("dim", SEGMENT_GAP));
	const rightText = right.join(theme.fg("dim", SEGMENT_GAP));
	const padding = " ".repeat(
		Math.max(1, width - visibleWidth(leftText) - visibleWidth(rightText)),
	);
	return truncateToWidth(leftText + padding + rightText, width);
}

/**
 * The thinking level as a bar in the same style as the context and quota bars:
 * one cell per level, `━━━━──` at high.
 *
 * The lit run takes the current level's colour, like the brain beside it, and
 * the unlit track stays dim to show the headroom. A level the table does not
 * know, from a newer pi, falls back to its name.
 */
function renderThinking(theme: Theme, level: string): string {
	const color = THINKING_COLORS[level] ?? "dim";
	const icon = theme.fg(color, ICONS.brain + ICON_GAP);
	const lit = THINKING_LEVELS.indexOf(level as (typeof THINKING_LEVELS)[number]);
	if (lit < 0) return icon + theme.fg(color, level);

	const unlit = "─".repeat(THINKING_LEVELS.length - lit - 1);
	return icon + theme.fg(color, "━".repeat(lit + 1)) + (unlit ? theme.fg("dim", unlit) : "");
}

/**
 * Context progress bar, with the dumb-zone threshold ticked onto it.
 *
 * The fill is the used fraction and the tick marks where the dumb zone starts,
 * both measured against the same window, so the two are directly comparable.
 * Colour, icon included, comes from pi-token-count's verdict when it is
 * available, and from absolute fullness otherwise.
 */
function renderContextBar(
	theme: Theme,
	ctx: ExtensionContext,
	contextFeed: ContextFeed | undefined,
): string {
	const contextWindow = contextWindowOf(ctx);
	if (contextWindow <= 0) return "";

	const usage = ctx.getContextUsage();
	const percent = usage?.percent ?? 0;
	const segments = contextBarSegments(
		Math.min(1, percent / 100),
		CONTEXT_BAR_WIDTH,
		contextFeed
			? { start: contextFeed.dumbZoneStart, window: contextWindow }
			: undefined,
	);

	const barToken: ThemeColor = contextFeed
		? CONTEXT_SEVERITY_COLORS[contextFeed.severity]
		: percent >= 90
			? "error"
			: percent >= 70
				? "warning"
				: "syntaxString";

	const bar =
		theme.fg(barToken, segments.before) +
		(segments.tick ? theme.fg("dim", segments.tick) : "") +
		theme.fg(barToken, segments.after);

	return (
		theme.fg(barToken, ICONS.context + ICON_GAP) +
		bar +
		theme.fg(barToken, " " + Math.round(percent) + "%") +
		// Unknown right after compaction, until the next response reports usage.
		(usage?.tokens != null
			? theme.fg("dim", "·") +
				theme.fg(barToken, formatTokens(usage.tokens)) +
				theme.fg("dim", "/" + formatTokens(contextWindow))
			: "")
	);
}

/** Right-aligned, dimmed token totals and context percentage. */
function renderStatsLine(
	theme: Theme,
	ctx: ExtensionContext,
	width: number,
	totals: UsageTotals,
): string {
	const parts: string[] = [];
	if (totals.input) parts.push("↑" + formatTokens(totals.input));
	if (totals.output) parts.push("↓" + formatTokens(totals.output));
	if (totals.cacheRead) parts.push("R" + formatTokens(totals.cacheRead));
	if (totals.cacheWrite) parts.push("W" + formatTokens(totals.cacheWrite));
	if (totals.cost) parts.push("$" + totals.cost.toFixed(3));

	const contextWindow = contextWindowOf(ctx);
	const percent = ctx.getContextUsage()?.percent;
	const contextText = `${percent != null ? percent.toFixed(1) : "?"}%/${formatTokens(contextWindow)}`;
	const contextColored =
		percent != null && percent > 90
			? theme.fg("error", contextText)
			: percent != null && percent > 70
				? theme.fg("warning", contextText)
				: contextText;
	parts.push(contextColored);

	const stats = parts.join(" ");
	// Dim the padding and the uncoloured parts separately: the context segment
	// may end in a reset that would clear an outer dim wrapper.
	const padding = " ".repeat(Math.max(0, width - visibleWidth(stats)));
	return truncateToWidth(theme.fg("dim", padding) + theme.fg("dim", stats), width);
}

/**
 * The status line, or `undefined` when nothing has published a status.
 *
 * Quota chips lead the line, then every remaining status verbatim. A status the
 * feeds supersede is dropped, so the same data is not printed twice in two
 * formats.
 */
function renderStatusLine(
	theme: Theme,
	footerData: ReadonlyFooterDataProvider,
	settings: StatuslineSettings,
	feeds: Feeds,
	contextFeed: ContextFeed | undefined,
	width: number,
): string | undefined {
	const superseded = new Set<string>();
	if (contextFeed) superseded.add(contextFeed.statusKey);

	const chips = renderQuotaChips(theme, settings, feeds.quotas, superseded);
	const entries = orderStatusEntries(footerData.getExtensionStatuses(), settings.order);

	return buildStatusLine({
		entries,
		hide: [...settings.hide, ...superseded],
		separator: theme.fg("dim", settings.separator),
		width,
		ellipsis: theme.fg("dim", "..."),
		prefix: chips,
	});
}

/**
 * The quota windows as chips, or `undefined` when there are none to draw.
 *
 * Records the superseded status key only when it actually renders chips, so a
 * feed that is present but empty leaves the raw status visible.
 */
function renderQuotaChips(
	theme: Theme,
	settings: StatuslineSettings,
	quotas: QuotasFeed | undefined,
	superseded: Set<string>,
): string | undefined {
	if (!settings.structuredFeeds || !quotas || quotas.windows.length === 0) {
		return undefined;
	}

	superseded.add(quotas.statusKey);
	const chips = quotas.windows.map((window) => renderQuotaChip(theme, window));
	// The same gap the status entries use, so the whole line spaces uniformly and
	// the separator setting governs all of it.
	return chips.join(theme.fg("dim", settings.separator));
}

/**
 * One quota window: `5h ━━╸───── 34% <reset> 2h·19m`, showing percent used.
 *
 * The reset suffix, and the value text of a window without a bar, are
 * published pre-formatted by pi-quotas, so this only places them. A bar is
 * drawn only where the owning extension said one is meaningful — a count pair
 * or a currency pair prints a value a bar would contradict.
 */
function renderQuotaChip(theme: Theme, window: QuotaFeedWindow): string {
	const color = QUOTA_SEVERITY_COLORS[window.severity];
	const atRisk = window.severity !== "none";

	let chip = theme.fg(atRisk ? color : "dim", sanitizeInlineText(window.shortLabel));
	if (window.barPercent !== null) {
		// The feed carries remaining percent, and its value text prints the same
		// number. Both are flipped to used, so the chip fills as the quota is
		// consumed, the same direction as the context bar.
		const used = Math.max(0, Math.min(100, 100 - window.barPercent));
		chip += " " + theme.fg(color, chipBar(used / 100, QUOTA_BAR_WIDTH));
		chip += " " + theme.fg(color, Math.round(used) + "%");
	} else {
		chip += " " + theme.fg(color, sanitizeInlineText(window.valueText));
	}
	if (window.limited) chip += theme.fg("error", " !");
	// The reset suffix carries its own leading space, matching the footer it
	// came from. Its ↺ is not in JetBrains Mono, so the terminal squeezes a
	// fallback glyph into one cell; it is swapped for a Nerd Font icon the
	// width of the others. A suffix without the marker passes through as is.
	if (window.resetText) {
		const resetText = sanitizeInlineText(window.resetText).replace(
			/^ ↺ /u,
			" " + ICONS.reset + ICON_GAP,
		);
		chip += theme.fg("dim", resetText);
	}

	return chip;
}

/**
 * The context feed, but only when it describes the window being drawn.
 *
 * pi-token-count recomputes the dumb-zone threshold per model, so a feed left
 * over from a previous model would put the tick in the wrong place. Treating it
 * as absent also keeps the raw context status visible, so the dumb-zone readout
 * is never lost while the bar cannot show it.
 */
function applicableContextFeed(
	ctx: ExtensionContext,
	feed: ContextFeed | undefined,
	settings: StatuslineSettings,
): ContextFeed | undefined {
	if (!settings.structuredFeeds || !feed) return undefined;
	if (!(feed.dumbZoneStart > 0)) return undefined;
	const contextWindow = contextWindowOf(ctx);
	if (!(contextWindow > 0) || feed.contextWindow !== contextWindow) return undefined;
	return feed;
}

/** Model context window, or 0 when unknown. */
function contextWindowOf(ctx: ExtensionContext): number {
	const contextUsage = ctx.getContextUsage();
	return contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
}

/** Session cwd, falling back to the process cwd for a stale context. */
function getCwd(ctx: ExtensionContext): string {
	try {
		return ctx.cwd || process.cwd();
	} catch {
		return process.cwd();
	}
}
