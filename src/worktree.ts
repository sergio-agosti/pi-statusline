/**
 * Worktree label lookup for the status line.
 *
 * `git worktree list` is a subprocess spawn, and the footer renders on every
 * TUI frame — including every frame of a streaming response. Calling it from
 * `render()` therefore spawns a process per frame. The result is cached with a
 * short TTL and invalidated explicitly on branch changes, so a render never
 * blocks on a spawn more than once per TTL window.
 */

import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";

/** How long a resolved worktree label stays fresh. */
const TTL_MS = 5_000;

interface CacheEntry {
	cwd: string;
	at: number;
	value: string | null;
}

let cache: CacheEntry | undefined;

/**
 * Resolve the current worktree's branch name.
 *
 * Only reports a worktree when the repository actually has more than one, so
 * the common single-checkout case stays clean.
 */
function resolveWorktreeLabel(cwd: string): string | null {
	let porcelain: string;
	try {
		porcelain = execFileSync("git", ["worktree", "list", "--porcelain"], {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		});
	} catch {
		return null; // not a git repo, or git is unavailable
	}

	const worktrees = porcelain.trim().split("\n\n").filter(Boolean);
	if (worktrees.length <= 1) return null;

	let currentPath: string;
	try {
		currentPath = realpathSync(cwd);
	} catch {
		currentPath = cwd;
	}

	for (const worktree of worktrees) {
		const lines = worktree.split("\n");
		const path = lines.find((line) => line.startsWith("worktree "))?.slice("worktree ".length);
		if (!path) continue;

		// A worktree is "current" when cwd is the worktree root or inside it.
		let isCurrent = currentPath === path;
		if (!isCurrent) {
			let resolved: string;
			try {
				resolved = realpathSync(path);
			} catch {
				resolved = path;
			}
			isCurrent = currentPath === resolved || currentPath.startsWith(resolved + "/");
		}
		if (!isCurrent) continue;

		const branch = lines.find((line) => line.startsWith("branch "))?.slice("branch ".length);
		// "refs/heads/feat/x" -> "feat/x"; detached HEAD has no branch line.
		return branch ? branch.replace(/^refs\/heads\//, "") : null;
	}

	return null;
}

/** Cached worktree label for `cwd`, refreshing at most once per {@link TTL_MS}. */
export function getWorktreeLabel(cwd: string, now: number = Date.now()): string | null {
	if (cache && cache.cwd === cwd && now - cache.at < TTL_MS) return cache.value;

	const value = resolveWorktreeLabel(cwd);
	cache = { cwd, at: now, value };
	return value;
}

/**
 * Drop the cached label so the next render re-reads it. Called when the git
 * branch changes, which covers `git worktree add`/`remove` in the common case.
 */
export function invalidateWorktreeCache(): void {
	cache = undefined;
}
