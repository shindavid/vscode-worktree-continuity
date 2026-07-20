import * as path from "node:path";
import type { Worktree } from "./git";

export type RepoSnapshot = { commonDir: string; name: string; worktrees: Worktree[] };

export function worktreeLabel(w: Worktree): string {
    if (w.bare) {return `${path.basename(w.path)} (bare)`;}
    if (w.detached) {return `${path.basename(w.path)} (detached)`;}
    return w.branch ?? path.basename(w.path);
}

/**
 * Given a repo snapshot list and the active worktree root, find the repo that
 * owns the active worktree and return its non-bare sibling roots (the ones a
 * reconcile would remap FROM). Pure so the snapshot-primed reconcile path can be
 * unit-tested without a live workspace. `sameRoot` defaults to strict equality;
 * the extension injects a trailing-slash-tolerant comparator.
 */
export function siblingWorktreeRoots(
    repos: RepoSnapshot[],
    activeRoot: string,
    sameRoot: (a: string, b: string) => boolean = (a, b) => a === b
): { commonDir: string; siblings: string[] } | null {
    const repo = repos.find((r) => r.worktrees.some((w) => !w.bare && sameRoot(w.path, activeRoot)));
    if (!repo) {
        return null;
    }
    const siblings = repo.worktrees
        .filter((w) => !w.bare && !sameRoot(w.path, activeRoot))
        .map((w) => w.path);
    return { commonDir: repo.commonDir, siblings };
}

export function repoDisplayName(commonDir: string, worktrees: Worktree[]): string {
    const main = worktrees.find((w) => !w.bare);
    if (main) {return path.basename(main.path);}
    const parent = path.dirname(commonDir);
    return path.basename(parent) || "repo";
}

const SKIP_DIRS = new Set([
    "node_modules",
    "dist",
    "build",
    "out",
    "target",
    "vendor",
    "tmp",
    "coverage",
    ".next",
    ".cache",
]);

export function shouldDescendInto(dirName: string): boolean {
    if (dirName.startsWith(".")) {return false;}
    if (SKIP_DIRS.has(dirName)) {return false;}
    return true;
}
