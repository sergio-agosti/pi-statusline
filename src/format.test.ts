import { describe, expect, it } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	buildStatusLine,
	chipBar,
	collectUsageTotals,
	contextBarSegments,
	formatTokens,
	sanitizeInlineText,
	sanitizeStatusText,
} from "./format.ts";

const DIM = "\u001b[2m";
const RED = "\u001b[31m";
const RESET = "\u001b[0m";

describe("formatTokens", () => {
	it("matches the built-in footer's thresholds", () => {
		expect(formatTokens(0)).toBe("0");
		expect(formatTokens(999)).toBe("999");
		expect(formatTokens(1000)).toBe("1.0k");
		expect(formatTokens(9999)).toBe("10.0k");
		expect(formatTokens(10000)).toBe("10k");
		expect(formatTokens(999999)).toBe("1000k");
		expect(formatTokens(1000000)).toBe("1.0M");
		expect(formatTokens(10000000)).toBe("10M");
	});
});

describe("sanitizeStatusText", () => {
	it("flattens a multi-line status onto one line", () => {
		// A newline would desynchronise the footer's line count from the rows the
		// TUI reserved for it.
		expect(sanitizeStatusText("line one\nline two")).toBe("line one line two");
		expect(sanitizeStatusText("tab\there")).toBe("tab here");
		expect(sanitizeStatusText("cr\rhere")).toBe("cr here");
	});

	it("collapses runs of spaces and trims", () => {
		expect(sanitizeStatusText("  a    b  ")).toBe("a b");
	});

	it("leaves colour codes intact", () => {
		expect(sanitizeStatusText(`${RED}85%${RESET}`)).toBe(`${RED}85%${RESET}`);
	});
});

describe("collectUsageTotals", () => {
	const usage = (input: number, output: number, cacheRead: number, cacheWrite: number, cost: number) => ({
		input,
		output,
		cacheRead,
		cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
	});

	it("sums assistant messages", () => {
		const entries = [
			{ type: "message", message: { role: "assistant", usage: usage(100, 10, 5, 1, 0.5) } },
			{ type: "message", message: { role: "assistant", usage: usage(200, 20, 6, 2, 0.25) } },
		] as unknown as SessionEntry[];

		const totals = collectUsageTotals(entries);
		expect(totals).toEqual({ input: 300, output: 30, cacheRead: 11, cacheWrite: 3, cost: 0.75 });
	});

	it("includes standalone usage entries, which pi-deck ignored", () => {
		// pi-deck summed assistant messages only, so cache warming and any other
		// separately-billed usage never reached the footer totals.
		const entries = [
			{ type: "message", message: { role: "assistant", usage: usage(100, 10, 0, 0, 0.1) } },
			{ type: "usage", kind: "cache_warm", usage: usage(50, 0, 400, 20, 0.4) },
		] as unknown as SessionEntry[];

		const totals = collectUsageTotals(entries);
		expect(totals.input).toBe(150);
		expect(totals.cacheRead).toBe(400);
		expect(totals.cost).toBeCloseTo(0.5);
	});

	it("includes tool results that report usage", () => {
		const entries = [
			{ type: "message", message: { role: "toolResult", usage: usage(7, 3, 0, 0, 0.02) } },
		] as unknown as SessionEntry[];

		expect(collectUsageTotals(entries).input).toBe(7);
	});

	it("ignores user messages and non-message entries", () => {
		const entries = [
			{ type: "message", message: { role: "user", content: "hi" } },
			{ type: "model_change", provider: "anthropic", modelId: "x" },
		] as unknown as SessionEntry[];

		expect(collectUsageTotals(entries)).toEqual({
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0,
		});
	});
});

describe("buildStatusLine", () => {
	const base = { hide: [], separator: "  ", width: 200, ellipsis: "..." };

	it("returns undefined when no extension has published a status", () => {
		// The footer omits the line entirely rather than leaving a blank row.
		expect(buildStatusLine({ ...base, entries: [] })).toBeUndefined();
	});

	it("returns undefined when every entry is filtered out", () => {
		expect(
			buildStatusLine({ ...base, entries: [["a", "1"]], hide: ["a"] }),
		).toBeUndefined();
	});

	it("drops entries that sanitise to nothing", () => {
		expect(buildStatusLine({ ...base, entries: [["a", "   "]] })).toBeUndefined();
	});

	it("joins entries in iteration order with the separator", () => {
		const line = buildStatusLine({
			...base,
			entries: [
				["context-tokens", "160.0k ◆"],
				["pi-quotas-usage", "5h: 85%"],
			],
		});
		expect(line).toBe("160.0k ◆  5h: 85%");
	});

	it("preserves each extension's own colours", () => {
		// The dumb-zone readout is only useful because it turns red; an outer
		// dim wrapper or a strip of the codes would destroy that signal.
		const line = buildStatusLine({
			...base,
			entries: [
				["context-tokens", `${RED}160.0k${RESET} ${DIM}◆${RESET}`],
				["pi-quotas-usage", "5h: 85%"],
			],
		});
		expect(line).toContain(RED);
		expect(line).toContain(DIM);
		expect(line).toContain(RESET);
		expect(line).toContain("5h: 85%");
	});

	it("truncates to width on visible columns, not string length", () => {
		const entries: Array<[string, string]> = [
			["a", `${RED}${"x".repeat(50)}${RESET}`],
			["b", `${DIM}${"y".repeat(50)}${RESET}`],
		];
		const line = buildStatusLine({ ...base, entries, width: 20 });

		expect(line).toBeDefined();
		expect(visibleWidth(line as string)).toBeLessThanOrEqual(20);
		// Cutting on string length would slice an escape sequence in half.
		expect(line).toContain(RESET);
	});

	it("returns the line unchanged when it fits", () => {
		const line = buildStatusLine({ ...base, entries: [["a", "short"]], width: 40 });
		expect(line).toBe("short");
	});

	it("emits nothing for a zero-width footer", () => {
		expect(buildStatusLine({ ...base, entries: [["a", "x"]], width: 0 })).toBeUndefined();
	});
});

describe("buildStatusLine prefix", () => {
	const base = { hide: [], separator: "  ", width: 120, ellipsis: "..." };

	it("renders the prefix ahead of the entries", () => {
		expect(buildStatusLine({ ...base, entries: [["a", "x"]], prefix: "P" })).toBe("P  x");
	});

	it("renders the prefix alone when there are no entries", () => {
		expect(buildStatusLine({ ...base, entries: [], prefix: "P" })).toBe("P");
	});

	it("keeps the prefix's own spacing intact", () => {
		// The chip group spaces its separators deliberately, so the prefix must not
		// go through the space-collapsing status sanitiser.
		expect(buildStatusLine({ ...base, entries: [], prefix: "a  │  b" })).toBe("a  │  b");
	});

	it("still emits nothing when there is neither a prefix nor an entry", () => {
		expect(buildStatusLine({ ...base, entries: [] })).toBeUndefined();
	});
});

describe("contextBarSegments", () => {
	it("fills the bar and leaves the remainder empty", () => {
		// Without a tick the whole bar lands in `before`, so it can be coloured as
		// one unit.
		expect(contextBarSegments(0.5, 4)).toEqual({ before: "━━──", tick: "", after: "" });
	});

	it("replaces the cell at the dumb-zone threshold rather than inserting one", () => {
		// 80% of 12 cells is cell 10, which is also where 160k of 200k falls.
		expect(contextBarSegments(0.8, 12, { start: 160000, window: 200000 })).toEqual({
			before: "━━━━━━━━━━",
			tick: "╊",
			after: "─",
		});
	});

	it("keeps the bar's width when it has a tick", () => {
		const segments = contextBarSegments(0.2, 12, { start: 1000, window: 2000 });
		expect(visibleWidth(segments.before + segments.tick + segments.after)).toBe(12);
	});

	it("omits the tick when the threshold is unknown", () => {
		expect(contextBarSegments(0.5, 4, { start: 0, window: 200000 }).tick).toBe("");
		expect(contextBarSegments(0.5, 4, { start: 160000, window: 0 }).tick).toBe("");
	});

	it("clamps a threshold past the end of the window onto the bar", () => {
		const segments = contextBarSegments(0, 4, { start: 400000, window: 200000 });
		expect(segments.before).toBe("───");
		expect(segments.tick).toBe("╊");
		expect(segments.after).toBe("");
	});
});

describe("chipBar", () => {
	it("caps the fill so a short bar still reads as a bar", () => {
		expect(chipBar(0.34, 8)).toBe("━━╸─────");
		expect(chipBar(0.85, 8)).toBe("━━━━━━╸─");
	});

	it("rounds the fill down so it never overstates what is left", () => {
		// 0.99 of 8 is 7.92; rounding up would draw a full bar.
		expect(chipBar(0.99, 8)).toBe("━━━━━━━╸");
	});

	it("handles the empty and full ends", () => {
		expect(chipBar(0, 4)).toBe("────");
		expect(chipBar(1, 4)).toBe("━━━━");
	});
});

describe("sanitizeInlineText", () => {
	it("strips line breaks without collapsing deliberate spacing", () => {
		// A chip's reset suffix carries a leading space on purpose.
		expect(sanitizeInlineText(" ↺ 2h·19m")).toBe(" ↺ 2h·19m");
		expect(sanitizeInlineText("a\nb\tc")).toBe("a b c");
	});
});
