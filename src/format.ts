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
 * Flatten a status entry onto one line.
 *
 * A status is arbitrary extension-authored text, so a newline or tab in it
 * would desynchronise the footer's line count from what the TUI reserves.
 * Mirrors pi's own footer sanitisation.
 */
export function sanitizeStatusText(text: string): string {
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
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

export interface StatusLineOptions {
	entries: Iterable<[string, string]>;
	/** Keys to omit. */
	hide: readonly string[];
	/** Separator placed between entries, already theme-styled. */
	separator: string;
	width: number;
	/** Ellipsis used when the line overflows, already theme-styled. */
	ellipsis: string;
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

	if (texts.length === 0) return undefined;

	// Entries carry ANSI codes, so measure and cut on visible width rather than
	// string length; truncateToWidth keeps escape sequences intact.
	const line = texts.join(options.separator);
	return visibleWidth(line) <= options.width
		? line
		: truncateToWidth(line, options.width, options.ellipsis);
}
