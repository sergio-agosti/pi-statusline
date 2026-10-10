import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import type {
	ExtensionAPI,
	ExtensionContext,
	ReadonlyFooterDataProvider,
	Theme,
	ThemeColor,
} from "@earendil-works/pi-coding-agent";

const { agentDir } = vi.hoisted(() => ({ agentDir: { path: "" } }));

// Only `getAgentDir` is used at runtime by the extension's settings reader; the
// rest of the import surface is types, which are erased.
vi.mock("@earendil-works/pi-coding-agent", () => ({
	getAgentDir: () => agentDir.path,
}));

const statuslineExtension = (await import("./index.ts")).default;

import { CONTEXT_TOKENS_UPDATED_EVENT, QUOTAS_USAGE_UPDATED_EVENT } from "./feed.ts";

const RED = "\u001b[31m";
const RESET = "\u001b[0m";
const BRAIN = "\uee9c";
const MODEL_ICON = "\uee0d";
const DIR_ICON = "\uf4d3";
const BRANCH_ICON = "\uf126";

type FooterFactory = (
	tui: { requestRender(): void },
	theme: Theme,
	footerData: ReadonlyFooterDataProvider,
) => { render(width: number): string[]; dispose?(): void };

interface FakeTheme {
	theme: Theme;
	calls: Array<{ token: string; text: string }>;
}

/** Records which colour tokens were requested and returns text unchanged, so
 *  widths stay realistic and the status text's own ANSI codes pass through. */
function createFakeTheme(): FakeTheme {
	const calls: Array<{ token: string; text: string }> = [];
	const theme = {
		fg(token: ThemeColor, text: string) {
			calls.push({ token, text });
			return text;
		},
	} as unknown as Theme;
	return { theme, calls };
}

interface FakeSession {
	entries: unknown[];
	sessionId: string;
	leafId: string | null;
}

/** Minimal stand-in for pi's event bus, so tests can publish feeds. */
function createFakeEventBus() {
	const handlers = new Map<string, Array<(data: unknown) => void>>();
	return {
		on(channel: string, handler: (data: unknown) => void) {
			const list = handlers.get(channel) ?? [];
			list.push(handler);
			handlers.set(channel, list);
			return () => {
				handlers.set(
					channel,
					(handlers.get(channel) ?? []).filter((entry) => entry !== handler),
				);
			};
		},
		emit(channel: string, data: unknown) {
			for (const handler of handlers.get(channel) ?? []) handler(data);
		},
	};
}

function createContext(options: {
	session: FakeSession;
	statuses: Map<string, string>;
	cwd: string;
	percent?: number;
	tokens?: number | null;
	contextWindow?: number;
	modelId?: string;
	thinkingLevel?: string;
}): {
	ctx: ExtensionContext;
	factory: () => FooterFactory;
	bus: ReturnType<typeof createFakeEventBus>;
} {
	let captured: FooterFactory | undefined;

	const ctx = {
		ui: {
			setFooter(factory: FooterFactory) {
				captured = factory;
			},
		},
		cwd: options.cwd,
		thinkingLevel: options.thinkingLevel,
		model: { id: options.modelId ?? "claude-opus-5-5", contextWindow: options.contextWindow },
		getContextUsage: () => ({
			percent: options.percent ?? 0,
			tokens: options.tokens === undefined ? 1000 : options.tokens,
			contextWindow: options.contextWindow ?? 200000,
		}),
		sessionManager: {
			getEntries: () => options.session.entries,
			getSessionId: () => options.session.sessionId,
			getLeafId: () => options.session.leafId,
		},
	} as unknown as ExtensionContext;

	const bus = createFakeEventBus();
	const pi = {
		on(event: string, handler: (event: unknown, ctx: ExtensionContext) => void) {
			if (event === "session_start") handler({ type: "session_start", reason: "startup" }, ctx);
		},
		events: bus,
	} as unknown as ExtensionAPI;

	statuslineExtension(pi);

	return {
		ctx,
		bus,
		factory: () => {
			if (!captured) throw new Error("extension did not register a footer");
			return captured;
		},
	};
}

let workDir: string;

beforeEach(() => {
	workDir = mkdtempSync(join(tmpdir(), "pi-statusline-"));
	agentDir.path = join(workDir, "agent");
	mkdirSync(agentDir.path, { recursive: true });
});

afterEach(() => {
	rmSync(workDir, { recursive: true, force: true });
});

describe("status line rendering", () => {
	it("adds a second line carrying every extension status", () => {
		const statuses = new Map([
			["context-tokens", "160.0k ◆"],
			["pi-quotas-usage", "5h: 85%/93% (2h)"],
		]);
		const built = createContext({
			session: { entries: [], sessionId: "s1", leafId: null },
			statuses,
			cwd: workDir,
		});

		const lines = renderWith(built, statuses).lines;

		expect(lines).toHaveLength(3);
		expect(lines[1]).toContain("160.0k ◆");
		expect(lines[1]).toContain("5h: 85%/93% (2h)");
	});

	it("omits the second line when no extension published a status", () => {
		const statuses = new Map<string, string>();
		const built = createContext({
			session: { entries: [], sessionId: "s1", leafId: null },
			statuses,
			cwd: workDir,
		});

		expect(renderWith(built, statuses).lines).toHaveLength(2);
	});

	it("keeps each status's own colour codes", () => {
		const statuses = new Map([["context-tokens", `${RED}160.0k${RESET} ◆`]]);
		const built = createContext({
			session: { entries: [], sessionId: "s1", leafId: null },
			statuses,
			cwd: workDir,
		});

		const line = renderWith(built, statuses).lines[1];
		expect(line).toContain(RED);
		expect(line).toContain(RESET);
	});

	it("never exceeds the footer width", () => {
		const statuses = new Map([
			["a", "x".repeat(80)],
			["b", "y".repeat(80)],
		]);
		const built = createContext({
			session: { entries: [], sessionId: "s1", leafId: null },
			statuses,
			cwd: workDir,
		});

		for (const line of renderWith(built, statuses, 60).lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(60);
		}
	});

	it("puts the status line above the stats line by default", () => {
		const statuses = new Map([["context-tokens", "160.0k ◆"]]);
		const built = createContext({
			session: {
				entries: [assistantEntry(100, 10, 0, 0, 0.1)],
				sessionId: "s1",
				leafId: null,
			},
			statuses,
			cwd: workDir,
		});

		const lines = renderWith(built, statuses).lines;
		expect(lines).toHaveLength(3);
		expect(lines[1]).toContain("160.0k ◆");
		expect(lines[2]).toContain("↑100");
	});

	it("puts the status line below the stats line when configured to", () => {
		writeFileSync(
			join(agentDir.path, "settings.json"),
			JSON.stringify({ piStatusline: { position: "bottom" } }),
		);

		const statuses = new Map([["context-tokens", "160.0k ◆"]]);
		const built = createContext({
			session: {
				entries: [assistantEntry(100, 10, 0, 0, 0.1)],
				sessionId: "s1",
				leafId: null,
			},
			statuses,
			cwd: workDir,
		});

		const lines = renderWith(built, statuses).lines;
		expect(lines).toHaveLength(3);
		expect(lines[1]).toContain("↑100");
		expect(lines[2]).toContain("160.0k ◆");
	});

	it("hides configured keys", () => {
		writeFileSync(
			join(agentDir.path, "settings.json"),
			JSON.stringify({ piStatusline: { hide: ["noisy"] } }),
		);

		const statuses = new Map([
			["noisy", "skip me"],
			["context-tokens", "160.0k ◆"],
		]);
		const built = createContext({
			session: { entries: [], sessionId: "s1", leafId: null },
			statuses,
			cwd: workDir,
		});

		const line = renderWith(built, statuses).lines[1];
		expect(line).toContain("160.0k ◆");
		expect(line).not.toContain("skip me");
	});

	it("drops the status line entirely when disabled", () => {
		writeFileSync(
			join(agentDir.path, "settings.json"),
			JSON.stringify({ piStatusline: { statusLine: false } }),
		);

		const statuses = new Map([["context-tokens", "160.0k ◆"]]);
		const built = createContext({
			session: { entries: [], sessionId: "s1", leafId: null },
			statuses,
			cwd: workDir,
		});

		expect(renderWith(built, statuses).lines).toHaveLength(2);
	});

	it("survives a malformed settings file", () => {
		writeFileSync(join(agentDir.path, "settings.json"), "{ not json");

		const statuses = new Map([["context-tokens", "160.0k ◆"]]);
		const built = createContext({
			session: { entries: [], sessionId: "s1", leafId: null },
			statuses,
			cwd: workDir,
		});

		expect(renderWith(built, statuses).lines).toHaveLength(3);
	});
});

describe("structured feeds", () => {
	const contextFeed = {
		statusKey: "context-tokens",
		tokens: 152340,
		contextWindow: 200000,
		dumbZoneStart: 160000,
		severity: "warning",
	};

	const quotasFeed = {
		statusKey: "pi-quotas-usage",
		windows: [
			{
				shortLabel: "5h",
				kind: "hours",
				valueText: "34%",
				barPercent: 34,
				severity: "none",
				resetText: " ↺ 2h·19m",
				limited: false,
			},
			{
				shortLabel: "7d",
				kind: "week",
				valueText: "85%",
				barPercent: 85,
				severity: "warning",
				resetText: " ↺ 3d",
				limited: false,
			},
		],
	};

	function build(statuses: Map<string, string>, percent = 80) {
		return createContext({
			session: { entries: [], sessionId: "s1", leafId: null },
			statuses,
			cwd: workDir,
			percent,
		});
	}

	it("ticks the dumb zone onto the context bar and drops the raw status", () => {
		const statuses = new Map([["context-tokens", "152,340 tok"]]);
		const built = build(statuses);
		built.bus.emit(CONTEXT_TOKENS_UPDATED_EVENT, contextFeed);

		const lines = renderWith(built, statuses).lines;

		// 80% of 12 cells is cell 10, which is also where 160k of 200k falls.
		expect(lines[0]).toContain("━━━━━━━━━━╊─");
		expect(lines.join("\n")).not.toContain("152,340 tok");
		// Nothing left for the status line.
		expect(lines).toHaveLength(2);
	});

	it("renders quota windows as chips and drops the raw status", () => {
		const statuses = new Map([["pi-quotas-usage", "5h: 34% · 7d: 85%"]]);
		const built = build(statuses);
		built.bus.emit(QUOTAS_USAGE_UPDATED_EVENT, quotasFeed);

		const line = renderWith(built, statuses).lines[1];

		expect(line).toContain("5h");
		expect(line).toContain("━━╸─────");
		expect(line).toContain("34%");
		expect(line).toContain(" ↺ 2h·19m");
		// Chips are spaced, not ruled.
		expect(line).toContain(" ↺ 2h·19m  7d");
		expect(line).not.toContain("│");
		expect(line).not.toContain(" | ");
		expect(line).toContain("━━━━━━╸─");
		expect(line).not.toContain("5h: 34%");
	});

	it("keeps other extensions' statuses alongside the chips", () => {
		const statuses = new Map([
			["pi-quotas-usage", "5h: 34%"],
			["other", "hello"],
		]);
		const built = build(statuses);
		built.bus.emit(QUOTAS_USAGE_UPDATED_EVENT, quotasFeed);

		const line = renderWith(built, statuses).lines[1];
		expect(line).toContain("5h");
		expect(line).toContain("hello");
	});

	it("leaves statuses verbatim when no feed has arrived", () => {
		const statuses = new Map([
			["context-tokens", "152,340 tok"],
			["pi-quotas-usage", "5h: 34%"],
		]);
		const built = build(statuses);

		const lines = renderWith(built, statuses).lines;
		expect(lines[1]).toContain("152,340 tok");
		expect(lines[1]).toContain("5h: 34%");
		expect(lines[0]).not.toContain("╊");
	});

	it("ignores a context feed describing a different window", () => {
		const statuses = new Map([["context-tokens", "152,340 tok"]]);
		const built = build(statuses);
		built.bus.emit(CONTEXT_TOKENS_UPDATED_EVENT, {
			...contextFeed,
			contextWindow: 1000000,
		});

		const lines = renderWith(built, statuses).lines;
		expect(lines[0]).not.toContain("╊");
		// The readout is not lost while the bar cannot show it.
		expect(lines[1]).toContain("152,340 tok");
	});

	it("ignores a malformed feed rather than rendering its gaps", () => {
		const statuses = new Map([["pi-quotas-usage", "5h: 34%"]]);
		const built = build(statuses);
		built.bus.emit(QUOTAS_USAGE_UPDATED_EVENT, {
			statusKey: "pi-quotas-usage",
			windows: [{ shortLabel: "5h" }],
		});

		const line = renderWith(built, statuses).lines[1];
		expect(line).toContain("5h: 34%");
		expect(line).not.toContain("undefined");
	});

	it("truncates a long chip group rather than overflowing the footer", () => {
		const statuses = new Map([["pi-quotas-usage", "raw"]]);
		const built = build(statuses);
		built.bus.emit(QUOTAS_USAGE_UPDATED_EVENT, {
			statusKey: "pi-quotas-usage",
			windows: Array.from({ length: 12 }, (_, index) => ({
				shortLabel: `w${index}`,
				kind: "week",
				valueText: "99%",
				barPercent: 99,
				severity: "none",
				resetText: " ↺ 6d",
				limited: false,
			})),
		});

		const line = renderWith(built, statuses, 60).lines[1]!;
		expect(visibleWidth(line)).toBeLessThanOrEqual(60);
	});

	it("can be turned off entirely", () => {
		writeFileSync(
			join(agentDir.path, "settings.json"),
			JSON.stringify({ piStatusline: { structuredFeeds: false } }),
		);

		const statuses = new Map([
			["context-tokens", "152,340 tok"],
			["pi-quotas-usage", "5h: 34%"],
		]);
		const built = build(statuses);
		built.bus.emit(CONTEXT_TOKENS_UPDATED_EVENT, contextFeed);
		built.bus.emit(QUOTAS_USAGE_UPDATED_EVENT, quotasFeed);

		const lines = renderWith(built, statuses).lines;
		expect(lines[0]).not.toContain("╊");
		expect(lines[1]).toContain("152,340 tok");
		expect(lines[1]).toContain("5h: 34%");
	});
});

describe("core lines", () => {
	it("renders model, directory and branch", () => {
		const statuses = new Map<string, string>();
		const built = createContext({
			session: { entries: [], sessionId: "s1", leafId: null },
			statuses,
			cwd: workDir,
		});

		const line = renderWith(built, statuses).lines[0];
		expect(line).toContain("claude-opus-5-5");
		expect(line).toContain(workDir.split("/").pop());
		expect(line).toContain("main");
	});

	it("leaves a visible gap after every icon", () => {
		// The proportional Nerd Font variant draws these glyphs wider than a cell
		// and swallows a single space, so each icon is followed by two. Regressing
		// this to one space makes the label collide with the glyph.
		const statuses = new Map<string, string>();
		const built = createContext({
			session: { entries: [], sessionId: "s1", leafId: null },
			statuses,
			cwd: workDir,
		});

		const line = renderWith(built, statuses).lines[0]!;
		for (const glyph of [MODEL_ICON, DIR_ICON, BRANCH_ICON]) {
			expect(line).toContain(`${glyph}  `);
		}
	});

	it("shows the thinking level beside the model", () => {
		const statuses = new Map<string, string>();
		const built = createContext({
			session: { entries: [], sessionId: "s1", leafId: null },
			statuses,
			cwd: workDir,
			thinkingLevel: "high",
		});

		const { lines, theme } = renderWith(built, statuses);
		// Directly after the model, not out on the right where the bar lives.
		expect(lines[0]).toContain(`claude-opus-5-5  ${BRAIN} high`);
		expect(
			theme.calls.some(
				(call) => call.token === "thinkingHigh" && call.text === `${BRAIN} high`,
			),
		).toBe(true);
	});

	it("hides the thinking indicator when thinking is off", () => {
		const statuses = new Map<string, string>();
		const built = createContext({
			session: { entries: [], sessionId: "s1", leafId: null },
			statuses,
			cwd: workDir,
			thinkingLevel: "off",
		});

		expect(renderWith(built, statuses).lines[0]).not.toContain(BRAIN);
	});

	it("shows used and total tokens beside the context percentage", () => {
		const statuses = new Map<string, string>();
		const built = createContext({
			session: { entries: [], sessionId: "s1", leafId: null },
			statuses,
			cwd: workDir,
			percent: 7,
			tokens: 14200,
		});

		expect(renderWith(built, statuses).lines[0]).toContain("7% 14k/200k");
	});

	it("shows only the percentage when the token count is unknown", () => {
		const statuses = new Map<string, string>();
		const built = createContext({
			session: { entries: [], sessionId: "s1", leafId: null },
			statuses,
			cwd: workDir,
			percent: 0,
			tokens: null,
		});

		const line = renderWith(built, statuses).lines[0]!;
		expect(line).toContain("0%");
		expect(line).not.toContain("/200k");
	});

	it("colours the context percentage red past 90%", () => {
		const statuses = new Map<string, string>();
		const built = createContext({
			session: { entries: [], sessionId: "s1", leafId: null },
			statuses,
			cwd: workDir,
			percent: 95,
		});

		const { lines, theme } = renderWith(built, statuses);
		expect(lines[1]).toContain("95.0%/200k");
		expect(theme.calls.some((call) => call.token === "error" && call.text.includes("95.0%"))).toBe(
			true,
		);
	});

	it("shows cumulative usage including usage entries", () => {
		const statuses = new Map<string, string>();
		const built = createContext({
			session: {
				entries: [assistantEntry(100, 10, 0, 0, 0.1), usageEntry(50, 0, 400, 20, 0.4)],
				sessionId: "s1",
				leafId: null,
			},
			statuses,
			cwd: workDir,
		});

		const line = renderWith(built, statuses).lines[1];
		expect(line).toContain("↑150");
		expect(line).toContain("R400");
		expect(line).toContain("$0.500");
	});
});

describe("robustness", () => {
	it("degrades instead of throwing when the captured context goes stale", () => {
		const statuses = new Map<string, string>();
		const built = createContext({
			session: { entries: [], sessionId: "s1", leafId: null },
			statuses,
			cwd: workDir,
		});

		const fake = createFakeTheme();
		const component = built.factory()(
			{ requestRender: () => undefined },
			fake.theme,
			{
				getGitBranch: () => {
					throw new Error("Extension runner is not active");
				},
				getExtensionStatuses: () => statuses,
				onBranchChange: () => () => undefined,
			} as unknown as ReadonlyFooterDataProvider,
		);

		// A throw here would land inside the TUI render loop.
		const lines = component.render(120);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("statusline unavailable");
	});
});

function renderWith(
	built: ReturnType<typeof createContext>,
	statuses: Map<string, string>,
	width = 120,
): { lines: string[]; theme: FakeTheme } {
	const fake = createFakeTheme();
	const component = built.factory()(
		{ requestRender: () => undefined },
		fake.theme,
		{
			getGitBranch: () => "main",
			getExtensionStatuses: () => statuses,
			onBranchChange: () => () => undefined,
		} as unknown as ReadonlyFooterDataProvider,
	);
	return { lines: component.render(width), theme: fake };
}

function assistantEntry(input: number, output: number, cacheRead: number, cacheWrite: number, cost: number) {
	return {
		type: "message",
		message: {
			role: "assistant",
			usage: { input, output, cacheRead, cacheWrite, cost: { total: cost } },
		},
	};
}

function usageEntry(input: number, output: number, cacheRead: number, cacheWrite: number, cost: number) {
	return {
		type: "usage",
		kind: "cache_warm",
		usage: { input, output, cacheRead, cacheWrite, cost: { total: cost } },
	};
}
