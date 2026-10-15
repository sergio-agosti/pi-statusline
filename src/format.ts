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
 * The glyph marking a threshold on the context bar. Every threshold uses the
 * same dot — colour is what tells them apart — so the bar keeps one mark and
 * one meaning: this is where something happens.
 */
const TICK = "·";

/** A threshold to mark on the bar, positioned in tokens against `window`. */
export interface ContextBarTick {
	/** The threshold's position, in tokens. */
	at: number;
	/** The window `at` is measured against. */
	window: number;
	/**
	 * Which threshold this is, so the caller can colour it. Weakest first: a
	 * tick later in the list wins a cell two thresholds share, mirroring
	 * self-compact's own `|` > `!` > `~` rule.
	 */
	id: string;
}

/**
 * A run of the bar: either the cells, or one threshold's tick glyph.
 *
 * Runs come back in bar order so the caller can colour each and join them.
 */
export type ContextBarRun =
	| { kind: "fill"; text: string }
	| { kind: "tick"; id: string; text: string };

function barCells(fillRatio: number, width: number): string[] {
	const filled = Math.round(Math.max(0, Math.min(1, fillRatio)) * width);
	return Array.from({ length: width }, (_, index) => (index < filled ? "━" : "─"));
}

/**
 * Where a threshold sits, as a bar cell index. Clamped to the bar, since a
 * threshold past the window would otherwise fall off the end.
 */
function tickIndexFor(at: number, window: number, width: number): number {
	return Math.max(0, Math.min(width - 1, Math.round((at / window) * width)));
}

/**
 * Bar cells filled to `fillRatio`, with a tick replacing the cell at each
 * threshold.
 *
 * A tick replaces the cell at its index rather than being inserted, so the bar
 * keeps its width and everything left of it stays aligned. A threshold that is
 * unknown, unset or past the end of the window is skipped, which leaves a plain
 * bar rather than a mark in the wrong place.
 */
export function contextBarRuns(
	fillRatio: number,
	width: number,
	ticks: readonly ContextBarTick[] = [],
): ContextBarRun[] {
	const cells = barCells(fillRatio, width);
	const marks: (string | undefined)[] = new Array<string | undefined>(width).fill(undefined);
	for (const tick of ticks) {
		if (!(tick.window > 0) || !(tick.at > 0)) continue;
		if (!Number.isFinite(tick.at) || !Number.isFinite(tick.window)) continue;
		marks[tickIndexFor(tick.at, tick.window, width)] = tick.id;
	}

	const runs: ContextBarRun[] = [];
	let fill = "";
	for (let index = 0; index < width; index += 1) {
		const mark = marks[index];
		if (mark === undefined) {
			fill += cells[index];
			continue;
		}
		if (fill) runs.push({ kind: "fill", text: fill });
		fill = "";
		runs.push({ kind: "tick", id: mark, text: TICK });
	}
	if (fill) runs.push({ kind: "fill", text: fill });
	return runs;
}

/**
 * Whether a quota window's short label is a model name, which pi-quotas uses
 * for a model-scoped window: a lowercase word longer than the standard tags.
 */
export function isModelLabel(label: string): boolean {
	return label.length > 3 && /^[a-z]+$/u.test(label);
}

/**
 * A quota chip's label, kept to the two letters of its neighbours.
 *
 * pi-quotas tags the standard windows `5h`, `wk`, `mo` and so on, but tags a
 * model-scoped window with the lowercased model name: `fable`, `opus`. Those
 * collapse to their first letter and the next consonant — `fb`, `op`, `sn` —
 * which keeps the letters that carry the word. Any other label, which
 * pi-quotas passes through in the provider's own case, is left alone.
 */
export function chipLabel(label: string): string {
	if (!isModelLabel(label)) return label;
	const consonant = label.slice(1).match(/[^aeiou]/u)?.[0];
	return label[0] + (consonant ?? label[1]);
}

/**
 * A quota chip's bar: filled to `fillRatio` with a cap glyph at the fill
 * boundary, so a barely-used allowance still shows a start rather than a flat
 * track.
 *
 * The fill rounds down, never up, so the bar is full only once the allowance
 * is used up. Any fill at all draws the cap, though: 1% of an 8-cell bar floors
 * to no cells, and a quota barely touched must still read as started rather
 * than as untouched.
 */
export function chipBar(fillRatio: number, width: number): string {
	if (width <= 0) return "";
	const ratio = Math.max(0, Math.min(1, fillRatio));
	if (ratio <= 0) return "─".repeat(width);

	const filled = Math.floor(ratio * width);
	if (filled >= width) return "━".repeat(width);
	// The cap sits at the fill boundary, so the cell the fill ends inside reads
	// as part-full rather than empty. ╾ rather than ╸: its light right half joins
	// the empty track, where ╸ leaves a blank half-cell that reads as a gap.
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
