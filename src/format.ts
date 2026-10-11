/**
 * Pure formatting helpers for the status line. No theme or terminal access, so
 * these are straightforward to unit test.
 */

import type { Usage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** Compact token counts, matching the built-in footer: 999, 1.2k, 12k, 1.2M. */
export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return (count / 1000).toFixed(1) + "k";
	if (count < 1000000) return Math.round(count / 1000) + "k";
	if (count < 10000000) return (count / 1000000).toFixed(1) + "M";
	return Math.round(count / 1000000) + "M";
}

/**
 * Replace line-breaking characters with spaces, leaving horizontal spacing
 * alone. For text assembled into a line whose spacing is deliberate — a chip's
 * reset suffix carries a leading space on purpose.
 */
export function sanitizeInlineText(text: string): string {
	return text.replace(/[\r\n\t]/g, " ");
}

/**
 * Flatten a status entry onto one line.
 *
 * A status is arbitrary extension-authored text, so a newline or tab in it
 * would desynchronise the footer's line count from what the TUI reserves.
 * Mirrors pi's own footer sanitisation.
 */
export function sanitizeStatusText(text: string): string {
	return sanitizeInlineText(text).replace(/ +/g, " ").trim();
}

export interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

export function createUsageTotals(): UsageTotals {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

export function addUsageToTotals(totals: UsageTotals, usage: Usage): void {
	totals.input += usage.input;
	totals.output += usage.output;
	totals.cacheRead += usage.cacheRead;
	totals.cacheWrite += usage.cacheWrite;
	totals.cost += usage.cost.total;
}

/**
 * Cumulative usage across every entry in the session.
 *
 * Counts assistant messages, standalone `usage` entries (cache warming and
 * similar) and tool results that report usage. pi-deck summed assistant
 * messages only, which undercounts tokens and cost whenever the provider bills
 * those other paths.
 */
export function collectUsageTotals(entries: readonly SessionEntry[]): UsageTotals {
	const totals = createUsageTotals();
	for (const entry of entries) {
		if (entry.type === "usage") {
			addUsageToTotals(totals, entry.usage);
		} else if (entry.type === "message" && entry.message.role === "assistant") {
			addUsageToTotals(totals, entry.message.usage);
		} else if (
			entry.type === "message" &&
			entry.message.role === "toolResult" &&
			entry.message.usage
		) {
			addUsageToTotals(totals, entry.message.usage);
		}
	}
	return totals;
}

/**
 * The glyph marking where the dumb zone starts, from pi-token-count. A dot
 * rather than a cross, so it marks the threshold without crowding the bar.
 */
const DUMB_ZONE_TICK = "·";

/** A context bar split around the dumb-zone tick so each part can be coloured. */
export interface ContextBarSegments {
	before: string;
	/** The tick glyph, or "" when the dumb zone is unknown. */
	tick: string;
	after: string;
}

function barCells(fillRatio: number, width: number): string[] {
	const filled = Math.round(Math.max(0, Math.min(1, fillRatio)) * width);
	return Array.from({ length: width }, (_, index) => (index < filled ? "━" : "─"));
}

/**
 * Where the dumb-zone tick sits, as a bar cell index. Clamped to the bar, since
 * a threshold past the window would otherwise fall off the end.
 */
function tickIndexFor(dumbZoneStart: number, contextWindow: number, width: number): number {
	const ratio = dumbZoneStart / contextWindow;
	return Math.max(0, Math.min(width - 1, Math.round(ratio * width)));
}

/**
 * Bar cells filled to `fillRatio`, with an optional tick marking where the dumb
 * zone starts.
 *
 * The tick replaces the cell at its index rather than being inserted, so the bar
 * keeps its width and everything after it stays aligned. `dumbZone` is omitted
 * when the threshold is unknown, which leaves a plain bar.
 */
export function contextBarSegments(
	fillRatio: number,
	width: number,
	dumbZone?: { start: number; window: number },
): ContextBarSegments {
	const cells = barCells(fillRatio, width);
	const index =
		dumbZone && dumbZone.window > 0 && dumbZone.start > 0
			? tickIndexFor(dumbZone.start, dumbZone.window, width)
			: undefined;

	if (index === undefined) return { before: cells.join(""), tick: "", after: "" };
	return {
		before: cells.slice(0, index).join(""),
		tick: DUMB_ZONE_TICK,
		after: cells.slice(index + 1).join(""),
	};
}

/**
 * A quota chip's bar: filled to `fillRatio` with a cap glyph at the fill
 * boundary, so a barely-used allowance still shows a start rather than a flat
 * track.
 *
 * The fill rounds down, never up, so the bar is full only once the allowance
 * is used up.
 */
export function chipBar(fillRatio: number, width: number): string {
	const filled = Math.floor(Math.max(0, Math.min(1, fillRatio)) * width);
	if (filled >= width) return "━".repeat(width);
	if (filled <= 0) return "─".repeat(width);
	// ╾ rather than ╸: its light right half joins the empty track, where ╸
	// leaves a blank half-cell that reads as a gap.
	return "━".repeat(filled) + "╾" + "─".repeat(width - filled - 1);
}

export interface StatusLineOptions {
	entries: Iterable<[string, string]>;
	/** Keys to omit. */
	hide: readonly string[];
	/** Separator placed between entries, already theme-styled. */
	separator: string;
	width: number;
	/** Ellipsis used when the line overflows, already theme-styled. */
	ellipsis: string;
	/**
	 * Rendered ahead of the entries, already theme-styled. Not sanitised: its
	 * spacing is deliberate, and any foreign text inside it was sanitised where
	 * it was assembled.
	 */
	prefix?: string;
}

/**
 * Assemble the extension status line, or `undefined` when there is nothing to
 * show so the caller can omit the line entirely.
 *
 * Entries are rendered verbatim. Each extension colours its own status before
 * handing it to `setStatus`, and those colours carry meaning — a dumb-zone
 * readout turning red, a usage bar turning amber — so the line must not be
 * wrapped in an outer colour that an entry's trailing reset would clear.
 */
export function buildStatusLine(options: StatusLineOptions): string | undefined {
	if (options.width <= 0) return undefined;

	const hide = new Set(options.hide);
	const texts = [...options.entries]
		.filter(([key]) => !hide.has(key))
		.map(([, text]) => sanitizeStatusText(text))
		.filter((text) => text.length > 0);

	const segments = options.prefix ? [options.prefix, ...texts] : texts;
	if (segments.length === 0) return undefined;

	// Entries carry ANSI codes, so measure and cut on visible width rather than
	// string length; truncateToWidth keeps escape sequences intact.
	const line = segments.join(options.separator);
	return visibleWidth(line) <= options.width
		? line
		: truncateToWidth(line, options.width, options.ellipsis);
}
