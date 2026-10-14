/**
 * Mirrored contract for the structured feeds other extensions publish.
 *
 * pi-statusline cannot import from pi-quotas or pi-token-count: they are
 * separately-installed packages with no dependency relationship, and the event
 * bus carries `unknown`. So the channel names and the fields we render are
 * mirrored here, and every payload is validated on arrival. The real risk is
 * version skew between independently-updated packages, not a malformed
 * producer — a field renamed upstream should degrade to verbatim status text,
 * not render as `undefined%`.
 *
 * Only the fields pi-statusline draws are mirrored. A producer may carry more.
 */

export const CONTEXT_TOKENS_UPDATED_EVENT = "context-tokens:updated";
export const QUOTAS_USAGE_UPDATED_EVENT = "quotas:usage:updated";
export const SELF_COMPACT_UPDATED_EVENT = "self-compact:updated";

export type ContextTokenSeverity = "normal" | "warning" | "dumb";

export interface ContextFeed {
	/** The status key this feed supersedes. */
	statusKey: string;
	tokens: number | null;
	contextWindow: number;
	dumbZoneStart: number;
	severity: ContextTokenSeverity;
}

export type QuotaWindowKind =
	| "hours"
	| "day"
	| "week"
	| "month"
	| "balance"
	| "cap"
	| "other";

export type QuotaSeverity = "none" | "warning" | "high" | "critical";

export interface QuotaFeedWindow {
	shortLabel: string;
	kind: QuotaWindowKind;
	/** The value as the owning extension's footer prints it, uncoloured. */
	valueText: string;
	/** Remaining percent when a bar is meaningful, otherwise null. */
	barPercent: number | null;
	severity: QuotaSeverity;
	/** Reset suffix including its leading space, e.g. " ↺ 2h·19m". */
	resetText: string | null;
	limited: boolean;
}

export interface QuotasFeed {
	/** The status key this feed supersedes. */
	statusKey: string;
	windows: QuotaFeedWindow[];
}

/**
 * The self-compact thresholds that apply to the active model, as token counts.
 *
 * Only the hard cutoff is drawn: it is the line where self-compact blocks every
 * tool except its own, which is the one that changes what the session can do.
 * The notice and warning lines are carried by the extension's phase tag instead,
 * which already turns when they are crossed.
 */
export interface SelfCompactFeed {
	/** The status key this feed supersedes. */
	statusKey: string;
	/** The window the threshold is measured against, for the staleness check. */
	contextWindow: number;
	/** Where self-compact blocks every other tool, or null when unresolved. */
	forcedTokens: number | null;
	level: string;
	/** The extension's own phase tag, e.g. NOTICE, FORCED, COMPACTING. */
	phase: string | null;
}

export function parseSelfCompactFeed(data: unknown): SelfCompactFeed | undefined {
	if (!isRecord(data)) return undefined;

	const { statusKey, contextWindow, forcedTokens, level, phase } = data;
	if (typeof statusKey !== "string") return undefined;
	if (!isFiniteNumber(contextWindow) || contextWindow <= 0) return undefined;
	if (forcedTokens !== null && !isFiniteNumber(forcedTokens)) return undefined;
	if (typeof level !== "string") return undefined;
	if (phase !== null && typeof phase !== "string") return undefined;

	return {
		statusKey,
		contextWindow,
		forcedTokens,
		level,
		phase,
	};
}

const CONTEXT_SEVERITIES: readonly ContextTokenSeverity[] = [
	"normal",
	"warning",
	"dumb",
];

const QUOTA_SEVERITIES: readonly QuotaSeverity[] = [
	"none",
	"warning",
	"high",
	"critical",
];

const WINDOW_KINDS: readonly QuotaWindowKind[] = [
	"hours",
	"day",
	"week",
	"month",
	"balance",
	"cap",
	"other",
];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

export function parseContextFeed(data: unknown): ContextFeed | undefined {
	if (!isRecord(data)) return undefined;

	const { statusKey, contextWindow, dumbZoneStart, severity, tokens } = data;
	if (typeof statusKey !== "string") return undefined;
	if (!isFiniteNumber(contextWindow) || contextWindow < 0) return undefined;
	if (!isFiniteNumber(dumbZoneStart) || dumbZoneStart < 0) return undefined;
	if (!CONTEXT_SEVERITIES.includes(severity as ContextTokenSeverity)) {
		return undefined;
	}
	if (tokens !== null && !isFiniteNumber(tokens)) return undefined;

	return {
		statusKey,
		tokens,
		contextWindow,
		dumbZoneStart,
		severity: severity as ContextTokenSeverity,
	};
}

function parseQuotaWindow(value: unknown): QuotaFeedWindow | undefined {
	if (!isRecord(value)) return undefined;

	const { shortLabel, kind, valueText, severity, limited, barPercent, resetText } = value;
	if (typeof shortLabel !== "string") return undefined;
	if (!WINDOW_KINDS.includes(kind as QuotaWindowKind)) return undefined;
	if (typeof valueText !== "string") return undefined;
	if (!QUOTA_SEVERITIES.includes(severity as QuotaSeverity)) return undefined;
	if (typeof limited !== "boolean") return undefined;
	if (barPercent !== null && !isFiniteNumber(barPercent)) return undefined;
	if (resetText !== null && typeof resetText !== "string") return undefined;

	return {
		shortLabel,
		kind: kind as QuotaWindowKind,
		valueText,
		barPercent: barPercent as number | null,
		severity: severity as QuotaSeverity,
		resetText: resetText as string | null,
		limited,
	};
}

export function parseQuotasFeed(data: unknown): QuotasFeed | undefined {
	if (!isRecord(data)) return undefined;

	const { statusKey, windows } = data;
	if (typeof statusKey !== "string") return undefined;
	if (!Array.isArray(windows)) return undefined;

	const parsed: QuotaFeedWindow[] = [];
	for (const raw of windows) {
		const window = parseQuotaWindow(raw);
		if (!window) return undefined;
		parsed.push(window);
	}

	return { statusKey, windows: parsed };
}
