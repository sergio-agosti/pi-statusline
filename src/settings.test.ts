import { describe, expect, it } from "vitest";
import { orderStatusEntries } from "./settings.ts";

describe("orderStatusEntries", () => {
	it("sorts alphabetically by key when no order is configured", () => {
		// This is what the built-in footer does, and what extensions that pick a
		// self-sorting key such as "context-tokens" rely on.
		const entries: Array<[string, string]> = [
			["pi-quotas-usage", "usage"],
			["context-tokens", "tokens"],
			["pi-quotas-token-status", "costs"],
		];

		expect(orderStatusEntries(entries, []).map(([key]) => key)).toEqual([
			"context-tokens",
			"pi-quotas-token-status",
			"pi-quotas-usage",
		]);
	});

	it("places configured keys first, in the configured sequence", () => {
		const entries: Array<[string, string]> = [
			["a", "1"],
			["b", "2"],
			["c", "3"],
		];

		expect(orderStatusEntries(entries, ["c", "a"]).map(([key]) => key)).toEqual([
			"c",
			"a",
			"b",
		]);
	});

	it("appends unlisted keys alphabetically after the configured ones", () => {
		const entries: Array<[string, string]> = [
			["z", "1"],
			["m", "2"],
			["pinned", "3"],
			["a", "4"],
		];

		expect(orderStatusEntries(entries, ["pinned"]).map(([key]) => key)).toEqual([
			"pinned",
			"a",
			"m",
			"z",
		]);
	});

	it("ignores configured keys that have no matching entry", () => {
		const entries: Array<[string, string]> = [["b", "2"], ["a", "1"]];
		expect(orderStatusEntries(entries, ["missing"]).map(([key]) => key)).toEqual(["a", "b"]);
	});

	it("preserves the value alongside the key", () => {
		expect(orderStatusEntries([["k", "v"]], [])).toEqual([["k", "v"]]);
	});
});
