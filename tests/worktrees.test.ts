import { describe, expect, it } from "vitest";
import type { Worktree } from "../src/git";
import {
    repoDisplayName,
    shouldDescendInto,
    siblingWorktreeRoots,
    worktreeLabel,
    type RepoSnapshot,
} from "../src/worktrees";

const wt = (overrides: Partial<Worktree>): Worktree => ({
    path: "/repo/main",
    head: "abc",
    branch: "main",
    bare: false,
    detached: false,
    ...overrides,
});

describe("worktreeLabel", () => {
    it("uses branch name when present", () => {
        expect(worktreeLabel(wt({ branch: "feature-a" }))).toBe("feature-a");
    });

    it("falls back to basename when branch is null and not detached", () => {
        expect(worktreeLabel(wt({ path: "/repo/standalone", branch: null }))).toBe("standalone");
    });

    it("marks bare repos", () => {
        expect(worktreeLabel(wt({ path: "/repo/.bare", branch: null, bare: true }))).toBe(".bare (bare)");
    });

    it("marks detached worktrees", () => {
        expect(worktreeLabel(wt({ path: "/repo/wt", branch: null, detached: true }))).toBe("wt (detached)");
    });
});

describe("repoDisplayName", () => {
    it("uses the main worktree's basename", () => {
        expect(
            repoDisplayName("/repo/main/.git", [
                wt({ path: "/repo/main", branch: "main" }),
                wt({ path: "/repo/feature", branch: "feature" }),
            ])
        ).toBe("main");
    });

    it("falls back to the common dir's parent basename when only a bare repo exists", () => {
        expect(repoDisplayName("/repo/.bare", [wt({ path: "/repo/.bare", bare: true })])).toBe("repo");
    });
});

describe("shouldDescendInto", () => {
    it("skips hidden directories", () => {
        expect(shouldDescendInto(".git")).toBe(false);
        expect(shouldDescendInto(".vscode")).toBe(false);
    });

    it("skips common build/dependency directories", () => {
        expect(shouldDescendInto("node_modules")).toBe(false);
        expect(shouldDescendInto("target")).toBe(false);
        expect(shouldDescendInto("dist")).toBe(false);
    });

    it("descends into ordinary directories", () => {
        expect(shouldDescendInto("src")).toBe(true);
        expect(shouldDescendInto("packages")).toBe(true);
    });
});

describe("siblingWorktreeRoots", () => {
    const repo = (worktrees: Worktree[]): RepoSnapshot => ({
        commonDir: "/repo/main/.git",
        name: "repo",
        worktrees,
    });
    const repos: RepoSnapshot[] = [
        repo([
            wt({ path: "/repo/main", branch: "main" }),
            wt({ path: "/repo/feature", branch: "feature" }),
            wt({ path: "/repo/hotfix", branch: "hotfix" }),
            wt({ path: "/repo/.bare", bare: true }),
        ]),
    ];

    it("returns the non-bare siblings of the active worktree", () => {
        const res = siblingWorktreeRoots(repos, "/repo/feature");
        expect(res).toEqual({
            commonDir: "/repo/main/.git",
            siblings: ["/repo/main", "/repo/hotfix"],
        });
    });

    it("excludes the active worktree and any bare entry", () => {
        const res = siblingWorktreeRoots(repos, "/repo/main");
        expect(res?.siblings).toEqual(["/repo/feature", "/repo/hotfix"]);
    });

    it("returns null when no repo owns the active worktree", () => {
        expect(siblingWorktreeRoots(repos, "/elsewhere/wt")).toBeNull();
    });

    it("honors an injected same-root comparator (trailing slash)", () => {
        const sameRoot = (a: string, b: string): boolean =>
            a.replace(/\/+$/, "") === b.replace(/\/+$/, "");
        const res = siblingWorktreeRoots(repos, "/repo/feature/", sameRoot);
        expect(res?.siblings).toEqual(["/repo/main", "/repo/hotfix"]);
    });
});
