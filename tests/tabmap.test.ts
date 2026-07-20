import { describe, expect, it } from "vitest";
import {
    orderColumnReopens,
    planSiblingIntercept,
    planTabRemap,
    relPathUnder,
    shouldConsiderIntercept,
    targetPathFor,
    type CachedPosition,
    type InterceptGate,
    type ReopenAction,
    type TabSnapshot,
} from "../src/tabmap";

const OLD = "/repo/wt-a";
const NEW = "/repo/wt-b";

const tab = (overrides: Partial<TabSnapshot>): TabSnapshot => ({
    path: "/repo/wt-a/src/index.ts",
    viewColumn: 1,
    tabIndex: 0,
    isActiveInGroup: false,
    groupIsActive: false,
    isDirty: false,
    ...overrides,
});

const existsAll = () => true;
const existsNone = () => false;
const noPositions = () => undefined;

describe("relPathUnder", () => {
    it("returns the relative path for a file inside root", () => {
        expect(relPathUnder(OLD, "/repo/wt-a/src/index.ts")).toBe("src/index.ts");
    });

    it("returns null for a file outside root", () => {
        expect(relPathUnder(OLD, "/repo/wt-b/src/index.ts")).toBeNull();
    });

    it("returns null for the root itself", () => {
        expect(relPathUnder(OLD, OLD)).toBeNull();
    });

    it("is not fooled by a sibling with a shared prefix", () => {
        expect(relPathUnder("/repo/wt", "/repo/wt-a/x.ts")).toBeNull();
    });
});

describe("targetPathFor", () => {
    it("maps a path from old root to new root", () => {
        expect(targetPathFor(OLD, NEW, "/repo/wt-a/src/index.ts")).toBe("/repo/wt-b/src/index.ts");
    });

    it("returns null when the path is not under old root", () => {
        expect(targetPathFor(OLD, NEW, "/elsewhere/x.ts")).toBeNull();
    });
});

describe("planTabRemap", () => {
    it("reopens a clean text tab whose file exists in the new worktree", () => {
        const plan = planTabRemap({
            tabs: [tab({ path: "/repo/wt-a/src/index.ts" })],
            oldRoot: OLD,
            newRoot: NEW,
            exists: existsAll,
            getPosition: noPositions,
        });
        expect(plan.reopen).toEqual([
            expect.objectContaining({
                sourcePath: "/repo/wt-a/src/index.ts",
                targetPath: "/repo/wt-b/src/index.ts",
                relPath: "src/index.ts",
                viewColumn: 1,
                position: undefined,
            }),
        ]);
        expect(plan.closeMissing).toEqual([]);
        expect(plan.skipDirty).toEqual([]);
    });

    it("attaches the cached position for the relative path", () => {
        const pos: CachedPosition = {
            selection: { anchorLine: 10, anchorChar: 0, activeLine: 10, activeChar: 4 },
            topLine: 5,
        };
        const plan = planTabRemap({
            tabs: [tab({})],
            oldRoot: OLD,
            newRoot: NEW,
            exists: existsAll,
            getPosition: (rel) => (rel === "src/index.ts" ? pos : undefined),
        });
        expect(plan.reopen[0].position).toEqual(pos);
    });

    it("moves a tab with no equivalent in the new worktree to closeMissing", () => {
        const plan = planTabRemap({
            tabs: [tab({ path: "/repo/wt-a/only-in-a.ts" })],
            oldRoot: OLD,
            newRoot: NEW,
            exists: existsNone,
            getPosition: noPositions,
        });
        expect(plan.reopen).toEqual([]);
        expect(plan.closeMissing).toEqual([
            { sourcePath: "/repo/wt-a/only-in-a.ts", relPath: "only-in-a.ts", viewColumn: 1 },
        ]);
    });

    it("leaves a dirty tab untouched and reports it, even if missing in the new worktree", () => {
        const plan = planTabRemap({
            tabs: [tab({ path: "/repo/wt-a/draft.ts", isDirty: true })],
            oldRoot: OLD,
            newRoot: NEW,
            exists: existsNone,
            getPosition: noPositions,
        });
        expect(plan.reopen).toEqual([]);
        expect(plan.closeMissing).toEqual([]);
        expect(plan.skipDirty).toEqual([
            { sourcePath: "/repo/wt-a/draft.ts", relPath: "draft.ts", viewColumn: 1 },
        ]);
    });

    it("ignores tabs belonging to another folder/repo in the workspace", () => {
        const plan = planTabRemap({
            tabs: [tab({ path: "/other-repo/src/index.ts" })],
            oldRoot: OLD,
            newRoot: NEW,
            exists: existsAll,
            getPosition: noPositions,
        });
        expect(plan.reopen).toEqual([]);
        expect(plan.closeMissing).toEqual([]);
        expect(plan.skipDirty).toEqual([]);
    });

    it("marks the active tab of the active group for global focus", () => {
        const plan = planTabRemap({
            tabs: [
                tab({ path: "/repo/wt-a/a.ts", tabIndex: 0, isActiveInGroup: false, groupIsActive: true }),
                tab({ path: "/repo/wt-a/b.ts", tabIndex: 1, isActiveInGroup: true, groupIsActive: true }),
                tab({ path: "/repo/wt-a/c.ts", viewColumn: 2, isActiveInGroup: true, groupIsActive: false }),
            ],
            oldRoot: OLD,
            newRoot: NEW,
            exists: existsAll,
            getPosition: noPositions,
        });
        const focused = plan.reopen.filter((r) => r.focusGlobally);
        expect(focused).toHaveLength(1);
        expect(focused[0].sourcePath).toBe("/repo/wt-a/b.ts");
        // The active tab of the non-active group is restored in-group but not focused.
        const c = plan.reopen.find((r) => r.sourcePath === "/repo/wt-a/c.ts")!;
        expect(c.makeActiveInGroup).toBe(true);
        expect(c.focusGlobally).toBe(false);
    });

    it("classifies a mix of tabs across groups correctly", () => {
        const plan = planTabRemap({
            tabs: [
                tab({ path: "/repo/wt-a/keep.ts" }),
                tab({ path: "/repo/wt-a/gone.ts" }),
                tab({ path: "/repo/wt-a/dirty.ts", isDirty: true }),
                tab({ path: "/other/x.ts" }),
            ],
            oldRoot: OLD,
            newRoot: NEW,
            exists: (p) => p !== "/repo/wt-b/gone.ts",
            getPosition: noPositions,
        });
        expect(plan.reopen.map((r) => r.relPath)).toEqual(["keep.ts"]);
        expect(plan.closeMissing.map((r) => r.relPath)).toEqual(["gone.ts"]);
        expect(plan.skipDirty.map((r) => r.relPath)).toEqual(["dirty.ts"]);
    });
});

describe("orderColumnReopens", () => {
    const action = (o: Partial<ReopenAction>): ReopenAction => ({
        sourcePath: "/repo/wt-a/x.ts",
        targetPath: "/repo/wt-b/x.ts",
        relPath: "x.ts",
        viewColumn: 1,
        tabIndex: 0,
        makeActiveInGroup: false,
        focusGlobally: false,
        ...o,
    });

    it("preserves original left-to-right tab order regardless of which is active", () => {
        const ordered = orderColumnReopens([
            action({ relPath: "active.ts", tabIndex: 1, makeActiveInGroup: true }),
            action({ relPath: "third.ts", tabIndex: 2 }),
            action({ relPath: "first.ts", tabIndex: 0 }),
        ]);
        expect(ordered.map((a) => a.relPath)).toEqual(["first.ts", "active.ts", "third.ts"]);
    });
});

describe("planSiblingIntercept", () => {
    const ACTIVE = "/repo/feature";
    const SIBLING = "/repo/main";

    it("remaps a file opened under a sibling worktree to the active equivalent", () => {
        const plan = planSiblingIntercept(
            "/repo/main/src/greeting.cpp",
            ACTIVE,
            SIBLING
        );
        expect(plan).toEqual({
            intercept: true,
            targetPath: "/repo/feature/src/greeting.cpp",
            relPath: "src/greeting.cpp",
        });
    });

    it("does not intercept a file already inside the active worktree", () => {
        const plan = planSiblingIntercept("/repo/feature/src/x.cpp", ACTIVE, ACTIVE);
        expect(plan).toEqual({ intercept: false, reason: "already in active worktree" });
    });

    it("does not intercept when there is no active worktree", () => {
        const plan = planSiblingIntercept("/repo/main/src/x.cpp", null, SIBLING);
        expect(plan.intercept).toBe(false);
    });

    it("does not intercept a file outside any known worktree", () => {
        const plan = planSiblingIntercept("/elsewhere/x.cpp", ACTIVE, null);
        expect(plan).toEqual({ intercept: false, reason: "not under a known worktree" });
    });

    it("does not intercept when the containing worktree IS the active one", () => {
        const plan = planSiblingIntercept("/repo/feature/x.cpp", ACTIVE, ACTIVE);
        expect(plan.intercept).toBe(false);
    });

    it("preserves nested relative paths in the remap target", () => {
        const plan = planSiblingIntercept("/repo/main/a/b/c/deep.cpp", ACTIVE, SIBLING);
        expect(plan).toEqual({
            intercept: true,
            targetPath: "/repo/feature/a/b/c/deep.cpp",
            relPath: "a/b/c/deep.cpp",
        });
    });

    it("uses the injected same-root comparator to reject the active worktree", () => {
        // containingWorktree differs only by a trailing slash from active; a
        // slash-tolerant comparator must still treat it as the active worktree.
        const sameRoot = (a: string, b: string): boolean =>
            a.replace(/\/+$/, "") === b.replace(/\/+$/, "");
        const plan = planSiblingIntercept("/other/x.cpp", ACTIVE, ACTIVE + "/", sameRoot);
        expect(plan).toEqual({ intercept: false, reason: "same as active worktree" });
    });
});

describe("shouldConsiderIntercept", () => {
    // A gate that WOULD intercept; each test flips one field.
    const base: InterceptGate = {
        enabled: true,
        switchInProgress: false,
        extensionDrivenOpen: false,
        scheme: "file",
        carryTabs: true,
        hasActiveWorktree: true,
        alreadyInFlight: false,
        isDirty: false,
    };

    it("passes when every gate is favorable", () => {
        expect(shouldConsiderIntercept(base)).toBe(true);
    });

    it("rejects when interception is disabled", () => {
        expect(shouldConsiderIntercept({ ...base, enabled: false })).toBe(false);
    });

    it("rejects during a switch critical section (Defect 1)", () => {
        expect(shouldConsiderIntercept({ ...base, switchInProgress: true })).toBe(false);
    });

    it("rejects an extension-driven open (our own remap churn)", () => {
        expect(shouldConsiderIntercept({ ...base, extensionDrivenOpen: true })).toBe(false);
    });

    it("rejects non-file schemes", () => {
        expect(shouldConsiderIntercept({ ...base, scheme: "git" })).toBe(false);
        expect(shouldConsiderIntercept({ ...base, scheme: "output" })).toBe(false);
    });

    it("rejects when carryTabs is off, no active worktree, in-flight, or dirty", () => {
        expect(shouldConsiderIntercept({ ...base, carryTabs: false })).toBe(false);
        expect(shouldConsiderIntercept({ ...base, hasActiveWorktree: false })).toBe(false);
        expect(shouldConsiderIntercept({ ...base, alreadyInFlight: true })).toBe(false);
        expect(shouldConsiderIntercept({ ...base, isDirty: true })).toBe(false);
    });
});
