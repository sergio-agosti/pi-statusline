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
 *   line 1   model + thinking | context             folder | git
 *   line 2   5h ━━╸───── 34% ↺ 2h·19m  wk ━━━━━━╸─ 85% ↺ 3d
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

/** Nerd Font glyphs, matching pi-deck. */
const ICONS = {
	model: "\uee0d",
	dir: "\uf4d3",
	branch: "\uf126",
	worktree: "\u{f0405}",
	context: "\uf2db",
	brain: "\uee9c",
} as const;

/**
 * Two spaces after an icon, not one.
 *
 * The proportional JetBrainsMono Nerd Font variant (Propo) draws these glyphs
 * at 1.25–1.9x a cell, so each one bleeds over the cell that follows it and
 * swallows a single space. Two cells of gap leaves one visible. In the Mono
 * variant, where every glyph measures exactly one cell, this reads as a
 * slightly wider gap rather than a missing one.
 */
const ICON_GAP = "  ";

const THINKING_COLORS: Record<string, ThemeColor> = {
	off: "dim",
	minimal: "thinkingMinimal",
	low: "thinkingLow",
	medium: "thinkingMedium",
	high: "thinkingHigh",
	xhigh: "thinkingXhigh",
	max: "thinkingMax",
};

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

/** `model + thinking | context` on the left, `folder | git` on the right. */
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
		!thinkingLevel || thinkingLevel === "off"
			? ""
			: theme.fg(
					THINKING_COLORS[thinkingLevel] ?? "dim",
					// The brain glyph sits within its cell, so one space is enough.
					ICONS.brain + " " + thinkingLevel,
				);

	const left = [
		c("syntaxType", ICONS.model + ICON_GAP + (ctx.model?.id ?? "no-model")),
		thinking,
		renderContextBar(theme, ctx, contextFeed),
	].filter(Boolean);

	// Where it is happening, pushed to the far end.
	const right = [
		c("syntaxFunction", ICONS.dir + ICON_GAP + (cwd.split("/").pop() || cwd)),
		branch ? c("success", ICONS.branch + ICON_GAP + branch) : "",
		worktree ? c("syntaxNumber", ICONS.worktree + ICON_GAP + worktree) : "",
	].filter(Boolean);

	const leftText = left.join(theme.fg("dim", SEGMENT_GAP));
	const rightText = right.join(theme.fg("dim", SEGMENT_GAP));
	const padding = " ".repeat(
		Math.max(1, width - visibleWidth(leftText) - visibleWidth(rightText)),
	);
	return truncateToWidth(leftText + padding + rightText, width);
}

/**
 * Context progress bar, with the dumb-zone threshold ticked onto it.
 *
 * The fill is the used fraction and the tick marks where the dumb zone starts,
 * both measured against the same window, so the two are directly comparable.
 * Colour comes from pi-token-count's verdict when it is available, and from
 * absolute fullness otherwise.
 */
function renderContextBar(
	theme: Theme,
	ctx: ExtensionContext,
	contextFeed: ContextFeed | undefined,
): string {
	const contextWindow = contextWindowOf(ctx);
	if (contextWindow <= 0) return "";

	const percent = ctx.getContextUsage()?.percent ?? 0;
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
		theme.fg("syntaxString", ICONS.context + ICON_GAP) +
		bar +
		theme.fg(barToken, " " + Math.round(percent) + "%")
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
 * One quota window: `5h ━━╸───── 34% ↺ 2h·19m`.
 *
 * The value text and reset suffix are published pre-formatted by pi-quotas, so
 * this only places them. A bar is drawn only where the owning extension said
 * one is meaningful — a count pair or a currency pair prints a value a bar
 * would contradict.
 */
function renderQuotaChip(theme: Theme, window: QuotaFeedWindow): string {
	const color = QUOTA_SEVERITY_COLORS[window.severity];
	const atRisk = window.severity !== "none";

	let chip = theme.fg(atRisk ? color : "dim", sanitizeInlineText(window.shortLabel));
	if (window.barPercent !== null) {
		chip += " " + theme.fg(color, chipBar(window.barPercent / 100, QUOTA_BAR_WIDTH));
	}
	chip += " " + theme.fg(color, sanitizeInlineText(window.valueText));
	if (window.limited) chip += theme.fg("error", " !");
	// The reset suffix carries its own leading space, matching the footer it
	// came from.
	if (window.resetText) chip += theme.fg("dim", sanitizeInlineText(window.resetText));

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
