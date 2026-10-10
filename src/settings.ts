/**
 * Settings for the status line, read from the `piStatusline` key of the global
 * (`<agent-dir>/settings.json`) and project (`.pi/settings.json`) settings
 * files. Project values win over global ones.
 *
 * Malformed or missing settings always fall back to defaults: a broken config
 * must never take down the footer.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const SETTINGS_KEY = "piStatusline";

/** Where the extension status line sits relative to the two core lines. */
export type StatusLinePosition = "bottom" | "top";

export interface StatuslineSettings {
	/** Render the extension status line at all. */
	statusLine: boolean;
	/** Where the status line sits: below the token stats, or above them. */
	position: StatusLinePosition;
	/** Placed between status entries. */
	separator: string;
	/** Keys to place first, in this order. Unlisted keys follow, sorted by key. */
	order: string[];
	/** Keys to omit entirely. */
	hide: string[];
	/**
	 * Draw the structured feeds other extensions publish — the dumb-zone tick on
	 * the context bar, quota chips on the status line — instead of showing their
	 * status text verbatim. Turn off to get the previous footer back.
	 */
	structuredFeeds: boolean;
}

export const DEFAULT_SETTINGS: StatuslineSettings = {
	statusLine: true,
	position: "bottom",
	separator: "  ",
	order: [],
	hide: [],
	structuredFeeds: true,
};

function readJsonObject(path: string): Record<string, unknown> | undefined {
	try {
		if (!existsSync(path)) return undefined;
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

function getObjectValue(source: Record<string, unknown> | undefined, key: string): Record<string, unknown> {
	const value = source?.[key];
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function getStringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const strings = value.filter((entry): entry is string => typeof entry === "string");
	return strings.length === value.length ? strings : undefined;
}

function getBoolean(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function getPosition(value: unknown): StatusLinePosition | undefined {
	return value === "top" || value === "bottom" ? value : undefined;
}

/** Read the merged settings for `cwd`, falling back to defaults. */
export function readSettings(cwd: string): StatuslineSettings {
	const globalSettings = readJsonObject(join(getAgentDir(), "settings.json"));
	const projectSettings = readJsonObject(join(cwd, ".pi", "settings.json"));
	const merged = {
		...getObjectValue(globalSettings, SETTINGS_KEY),
		...getObjectValue(projectSettings, SETTINGS_KEY),
	};

	return {
		statusLine: getBoolean(merged.statusLine) ?? DEFAULT_SETTINGS.statusLine,
		position: getPosition(merged.position) ?? DEFAULT_SETTINGS.position,
		separator: typeof merged.separator === "string" ? merged.separator : DEFAULT_SETTINGS.separator,
		order: getStringArray(merged.order) ?? DEFAULT_SETTINGS.order,
		hide: getStringArray(merged.hide) ?? DEFAULT_SETTINGS.hide,
		structuredFeeds:
			getBoolean(merged.structuredFeeds) ?? DEFAULT_SETTINGS.structuredFeeds,
	};
}

/**
 * Order status entries for display.
 *
 * Keys listed in `order` come first, in the configured sequence; every other
 * key follows, sorted alphabetically. The default (no configured order) is
 * plain alphabetical, which is what the built-in footer does — and what
 * extensions that pick a self-sorting key, like `context-tokens`, expect.
 */
export function orderStatusEntries(
	entries: Iterable<[string, string]>,
	order: string[],
): Array<[string, string]> {
	const rank = new Map(order.map((key, index) => [key, index]));
	return [...entries].sort(([a], [b]) => {
		const rankA = rank.get(a);
		const rankB = rank.get(b);
		if (rankA !== undefined && rankB !== undefined) return rankA - rankB;
		if (rankA !== undefined) return -1;
		if (rankB !== undefined) return 1;
		return a.localeCompare(b);
	});
}
