import * as path from "node:path";
import type { Worktree } from "./git";

export type RepoSnapshot = { commonDir: string; name: string; worktrees: Worktree[] };

export function worktreeLabel(w: Worktree): string {
    if (w.bare) {return `${path.basename(w.path)} (bare)`;}
    if (w.detached) {return `${path.basename(w.path)} (detached)`;}
    return w.branch ?? path.basename(w.path);
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
