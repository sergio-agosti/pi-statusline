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

const RED = "\u001b[31m";
const RESET = "\u001b[0m";

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

function createContext(options: {
	session: FakeSession;
	statuses: Map<string, string>;
	cwd: string;
	percent?: number;
	contextWindow?: number;
	modelId?: string;
	thinkingLevel?: string;
}): { ctx: ExtensionContext; factory: () => FooterFactory } {
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
			tokens: 1000,
			contextWindow: options.contextWindow ?? 200000,
		}),
		sessionManager: {
			getEntries: () => options.session.entries,
			getSessionId: () => options.session.sessionId,
			getLeafId: () => options.session.leafId,
		},
	} as unknown as ExtensionContext;

	const pi = {
		on(event: string, handler: (event: unknown, ctx: ExtensionContext) => void) {
			if (event === "session_start") handler({ type: "session_start", reason: "startup" }, ctx);
		},
	} as unknown as ExtensionAPI;

	statuslineExtension(pi);

	return {
		ctx,
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
	it("adds a third line carrying every extension status", () => {
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
		expect(lines[2]).toContain("160.0k ◆");
		expect(lines[2]).toContain("5h: 85%/93% (2h)");
	});

	it("omits the third line when no extension published a status", () => {
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

		const line = renderWith(built, statuses).lines[2];
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

	it("places the status line above the stats line when configured to", () => {
		writeFileSync(
			join(agentDir.path, "settings.json"),
			JSON.stringify({ piStatusline: { position: "top" } }),
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
		expect(lines[1]).toContain("160.0k ◆");
		expect(lines[2]).toContain("↑100");
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

		const line = renderWith(built, statuses).lines[2];
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

	it("shows the thinking level", () => {
		const statuses = new Map<string, string>();
		const built = createContext({
			session: { entries: [], sessionId: "s1", leafId: null },
			statuses,
			cwd: workDir,
			thinkingLevel: "high",
		});

		expect(renderWith(built, statuses).lines[0]).toContain("◐ high");
	});

	it("hides the thinking indicator when thinking is off", () => {
		const statuses = new Map<string, string>();
		const built = createContext({
			session: { entries: [], sessionId: "s1", leafId: null },
			statuses,
			cwd: workDir,
			thinkingLevel: "off",
		});

		expect(renderWith(built, statuses).lines[0]).not.toContain("◐");
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
