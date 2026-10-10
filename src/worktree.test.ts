import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getWorktreeLabel, invalidateWorktreeCache } from "./worktree.ts";

function git(cwd: string, ...args: string[]): string {
	return execFileSync(
		"git",
		["-c", "user.email=test@example.com", "-c", "user.name=Test", ...args],
		{ cwd, encoding: "utf8" },
	);
}

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "pi-statusline-wt-"));
	invalidateWorktreeCache();
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
	invalidateWorktreeCache();
});

describe("getWorktreeLabel", () => {
	it("returns null outside a git repository", () => {
		expect(getWorktreeLabel(root)).toBeNull();
	});

	it("returns null for a repo with a single checkout", () => {
		// The common case: showing a worktree label here would be pure noise.
		const repo = join(root, "solo");
		git(root, "init", "-q", "-b", "main", repo);
		git(repo, "commit", "-q", "--allow-empty", "-m", "init");

		expect(getWorktreeLabel(repo)).toBeNull();
	});

	it("returns the current worktree's branch when the repo has several", () => {
		const main = join(root, "main");
		git(root, "init", "-q", "-b", "main", main);
		git(main, "commit", "-q", "--allow-empty", "-m", "init");

		const linked = join(root, "linked");
		git(main, "worktree", "add", "-q", "-b", "feat/nested", linked);
		invalidateWorktreeCache();

		expect(getWorktreeLabel(linked)).toBe("feat/nested");
		expect(getWorktreeLabel(main)).toBe("main");
	});

	it("resolves a subdirectory of a worktree to that worktree", () => {
		const main = join(root, "main");
		git(root, "init", "-q", "-b", "main", main);
		git(main, "commit", "-q", "--allow-empty", "-m", "init");
		const linked = join(root, "linked");
		git(main, "worktree", "add", "-q", "-b", "feat", linked);
		const nested = join(linked, "nested", "deeper");
		mkdirSync(nested, { recursive: true });
		invalidateWorktreeCache();

		expect(getWorktreeLabel(nested)).toBe("feat");
	});

	it("caches the result so render does not spawn git every frame", () => {
		const main = join(root, "main");
		git(root, "init", "-q", "-b", "main", main);
		git(main, "commit", "-q", "--allow-empty", "-m", "init");
		const linked = join(root, "linked");
		git(main, "worktree", "add", "-q", "-b", "feat", linked);
		invalidateWorktreeCache();

		const at = 1_000_000;
		expect(getWorktreeLabel(linked, at)).toBe("feat");

		// A worktree added after the first read is not picked up until the TTL
		// expires: the whole point is to keep git off the render path.
		git(main, "worktree", "add", "-q", "-b", "later", join(root, "later"));
		expect(getWorktreeLabel(linked, at + 1)).toBe("feat");
		expect(getWorktreeLabel(linked, at + 4_999)).toBe("feat");
	});

	it("re-reads once the TTL has elapsed", () => {
		const main = join(root, "main");
		git(root, "init", "-q", "-b", "main", main);
		git(main, "commit", "-q", "--allow-empty", "-m", "init");

		const at = 1_000_000;
		expect(getWorktreeLabel(main, at)).toBeNull();

		const linked = join(root, "linked");
		git(main, "worktree", "add", "-q", "-b", "feat", linked);

		expect(getWorktreeLabel(main, at + 5_001)).toBe("main");
	});

	it("re-reads after an explicit invalidation", () => {
		const main = join(root, "main");
		git(root, "init", "-q", "-b", "main", main);
		git(main, "commit", "-q", "--allow-empty", "-m", "init");

		expect(getWorktreeLabel(main)).toBeNull();

		git(main, "worktree", "add", "-q", "-b", "feat", join(root, "linked"));
		invalidateWorktreeCache();

		expect(getWorktreeLabel(main)).toBe("main");
	});

	it("does not reuse a cached label for a different cwd", () => {
		const one = join(root, "one");
		const two = join(root, "two");
		git(root, "init", "-q", "-b", "main", one);
		git(one, "commit", "-q", "--allow-empty", "-m", "init");
		git(one, "worktree", "add", "-q", "-b", "feat", two);
		invalidateWorktreeCache();

		expect(getWorktreeLabel(one)).toBe("main");
		expect(getWorktreeLabel(two)).toBe("feat");
	});
});
