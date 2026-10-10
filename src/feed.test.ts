import { describe, expect, it } from "vitest";
import { parseContextFeed, parseQuotasFeed } from "./feed.ts";

describe("parseContextFeed", () => {
	it("accepts a well-formed payload", () => {
		expect(
			parseContextFeed({
				statusKey: "context-tokens",
				tokens: 152340,
				contextWindow: 200000,
				dumbZoneStart: 160000,
				severity: "warning",
			}),
		).toEqual({
			statusKey: "context-tokens",
			tokens: 152340,
			contextWindow: 200000,
			dumbZoneStart: 160000,
			severity: "warning",
		});
	});

	it("accepts a null token count, which means no reading yet", () => {
		const feed = parseContextFeed({
			statusKey: "context-tokens",
			tokens: null,
			contextWindow: 200000,
			dumbZoneStart: 0,
			severity: "normal",
		});
		expect(feed?.tokens).toBeNull();
	});

	it("rejects a payload whose shape drifted", () => {
		const base = {
			statusKey: "context-tokens",
			tokens: 1,
			contextWindow: 200000,
			dumbZoneStart: 160000,
			severity: "normal",
		};
		// A severity renamed upstream must not render as an unknown colour.
		expect(parseContextFeed({ ...base, severity: "urgent" })).toBeUndefined();
		expect(parseContextFeed({ ...base, contextWindow: "200000" })).toBeUndefined();
		expect(parseContextFeed({ ...base, statusKey: undefined })).toBeUndefined();
		expect(parseContextFeed({ ...base, tokens: Number.NaN })).toBeUndefined();
		expect(parseContextFeed({ ...base, dumbZoneStart: -1 })).toBeUndefined();
	});

	it("rejects anything that is not a payload object", () => {
		expect(parseContextFeed(undefined)).toBeUndefined();
		expect(parseContextFeed(null)).toBeUndefined();
		expect(parseContextFeed("context-tokens")).toBeUndefined();
		expect(parseContextFeed([1, 2, 3])).toBeUndefined();
	});
});

describe("parseQuotasFeed", () => {
	const window = {
		shortLabel: "5h",
		kind: "hours",
		valueText: "34%",
		barPercent: 34,
		severity: "none",
		resetText: " ↺ 2h·19m",
		limited: false,
	};

	it("accepts a well-formed payload", () => {
		const feed = parseQuotasFeed({
			statusKey: "pi-quotas-usage",
			windows: [window],
		});
		expect(feed?.statusKey).toBe("pi-quotas-usage");
		expect(feed?.windows).toHaveLength(1);
		expect(feed?.windows[0]!.valueText).toBe("34%");
	});

	it("accepts a null bar and reset, which is how non-percentage windows arrive", () => {
		const feed = parseQuotasFeed({
			statusKey: "pi-quotas-usage",
			windows: [{ ...window, barPercent: null, resetText: null }],
		});
		expect(feed?.windows[0]!.barPercent).toBeNull();
		expect(feed?.windows[0]!.resetText).toBeNull();
	});

	it("accepts an empty window list, which is how a clear arrives", () => {
		expect(parseQuotasFeed({ statusKey: "pi-quotas-usage", windows: [] })).toEqual({
			statusKey: "pi-quotas-usage",
			windows: [],
		});
	});

	it("rejects the whole payload if any window drifted", () => {
		// Dropping one bad window would silently hide a quota the user has.
		expect(
			parseQuotasFeed({
				statusKey: "pi-quotas-usage",
				windows: [window, { ...window, kind: "fortnight" }],
			}),
		).toBeUndefined();
		expect(
			parseQuotasFeed({ statusKey: "pi-quotas-usage", windows: [{ shortLabel: "5h" }] }),
		).toBeUndefined();
		expect(
			parseQuotasFeed({
				statusKey: "pi-quotas-usage",
				windows: [{ ...window, severity: "critical-ish" }],
			}),
		).toBeUndefined();
		expect(
			parseQuotasFeed({ statusKey: "pi-quotas-usage", windows: [{ ...window, limited: "no" }] }),
		).toBeUndefined();
	});

	it("rejects anything that is not a payload object", () => {
		expect(parseQuotasFeed(undefined)).toBeUndefined();
		expect(parseQuotasFeed({ statusKey: "pi-quotas-usage" })).toBeUndefined();
		expect(parseQuotasFeed({ windows: [] })).toBeUndefined();
	});
});
