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
 *   line 1   model | dir | branch | worktree            [context bar] ◐ thinking
 *   line 2                              ↑in ↓out Rcache Wcache $cost 45%/200k
 *   line 3   160.0k ◆  5h: 85%/93% (2h) · wk: 12% (3d)
 *
 * Line 3 appears only when at least one extension has set a status.
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
	collectUsageTotals,
	formatTokens,
	type UsageTotals,
} from "./format.ts";
import { orderStatusEntries, readSettings, type StatuslineSettings } from "./settings.ts";
import { getWorktreeLabel, invalidateWorktreeCache } from "./worktree.ts";

/** Nerd Font glyphs, matching pi-deck. */
const ICONS = {
	model: "\uee0d ",
	dir: "\uf4d3 ",
	branch: "\uf126",
	worktree: "\u{f0405}",
	context: "\uf2db",
} as const;

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

export default function piStatusline(pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		ctx.ui.setFooter((tui, theme, footerData) => {
			// Settings are read once when the footer is installed; `/reload` or a
			// new session picks up changes.
			const settings = readSettings(ctx.cwd);
			let statsCache: StatsCache | undefined;

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
				dispose: unsubscribe,
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
				const lines = [renderIdentityLine(theme, footerData, ctx, width)];

				const statusLine =
					settings.statusLine && width > 0
						? renderStatusLine(theme, footerData, settings, width)
						: undefined;

				if (statusLine && settings.position === "top") lines.push(statusLine);
				lines.push(renderStatsLine(theme, ctx, width, getTotals()));
				if (statusLine && settings.position === "bottom") lines.push(statusLine);

				return lines;
			}
		});
	});
}

/** `model | dir | branch | worktree` on the left, context bar and thinking on the right. */
function renderIdentityLine(
	theme: Theme,
	footerData: ReadonlyFooterDataProvider,
	ctx: ExtensionContext,
	width: number,
): string {
	const c = (token: ThemeColor, text: string) => theme.fg(token, text);

	const cwd = getCwd(ctx);
	const branch = footerData.getGitBranch();
	const worktree = getWorktreeLabel(cwd);

	const left = [
		c("syntaxType", " " + ICONS.model + " " + (ctx.model?.id ?? "no-model")),
		c("syntaxFunction", ICONS.dir + " " + (cwd.split("/").pop() || cwd)),
		branch ? c("success", ICONS.branch + " " + branch) : "",
		worktree ? c("syntaxNumber", ICONS.worktree + " " + worktree) : "",
	].filter(Boolean);

	const thinkingLevel = ctx.thinkingLevel;
	const thinking =
		!thinkingLevel || thinkingLevel === "off"
			? ""
			: theme.fg(THINKING_COLORS[thinkingLevel] ?? "dim", "◐ " + thinkingLevel);

	const right = [renderContextBar(theme, ctx), thinking]
		.filter(Boolean)
		.join(theme.fg("dim", "  "));

	const leftText = left.join(theme.fg("dim", " | "));
	const padding = " ".repeat(
		Math.max(1, width - visibleWidth(leftText) - visibleWidth(right)),
	);
	return truncateToWidth(leftText + padding + right, width);
}

/** Context progress bar, coloured by how full the window is. */
function renderContextBar(theme: Theme, ctx: ExtensionContext): string {
	const contextUsage = ctx.getContextUsage();
	const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
	if (contextWindow <= 0) return "";

	const percent = contextUsage?.percent ?? 0;
	const filled = Math.round(Math.min(1, percent / 100) * CONTEXT_BAR_WIDTH);
	const bar = "━".repeat(filled) + "─".repeat(CONTEXT_BAR_WIDTH - filled);
	const barToken = percent >= 90 ? "error" : percent >= 70 ? "warning" : "syntaxString";

	return (
		theme.fg("syntaxString", ICONS.context + " ") +
		theme.fg(barToken, bar) +
		theme.fg("syntaxString", " " + Math.round(percent) + "%")
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

	const contextUsage = ctx.getContextUsage();
	const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
	const percent = contextUsage?.percent;
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

/** The extension status line, or `undefined` when nothing has published a status. */
function renderStatusLine(
	theme: Theme,
	footerData: ReadonlyFooterDataProvider,
	settings: StatuslineSettings,
	width: number,
): string | undefined {
	const entries = orderStatusEntries(footerData.getExtensionStatuses(), settings.order);
	return buildStatusLine({
		entries,
		hide: settings.hide,
		separator: theme.fg("dim", settings.separator),
		width,
		ellipsis: theme.fg("dim", "..."),
	});
}

/** Session cwd, falling back to the process cwd for a stale context. */
function getCwd(ctx: ExtensionContext): string {
	try {
		return ctx.cwd || process.cwd();
	} catch {
		return process.cwd();
	}
}
