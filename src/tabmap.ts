import * as path from "node:path";

/**
 * Pure tab-remap planning. This module has NO dependency on the vscode API so it
 * can be unit-tested the same way worktrees.ts is. All I/O (does the target file
 * exist?) and all cache lookups are injected as predicates, mirroring the
 * `isAlive` injection in worktrees.ts#planWorkspaceRecovery.
 */

/** A cursor selection, stored 0-based to match vscode.Position. */
export type CachedSelection = {
    anchorLine: number;
    anchorChar: number;
    activeLine: number;
    activeChar: number;
};

export type CachedPosition = {
    selection?: CachedSelection;
    /** 0-based line of the topmost visible line, for scroll restoration. */
    topLine?: number;
};

/**
 * A plain snapshot of a single open editor tab. The caller builds these from
 * vscode.window.tabGroups, having already filtered to tabs whose input is a
 * TabInputText (diff / notebook / custom / webview tabs are left untouched and
 * are never passed in).
 */
export type TabSnapshot = {
    /** Absolute fsPath of the file this tab is open against. */
    path: string;
    /** 1-based ViewColumn number the tab lives in. */
    viewColumn: number;
    /** Position of the tab within its group, left-to-right. */
    tabIndex: number;
    /** Whether this tab is the active (foreground) tab of its group. */
    isActiveInGroup: boolean;
    /** Whether this tab's group is the globally-active tab group. */
    groupIsActive: boolean;
    /** Whether the tab has unsaved changes. */
    isDirty: boolean;
};

export type ReopenAction = {
    /** Old-worktree absolute path of the tab to close. */
    sourcePath: string;
    /** New-worktree absolute path to open. */
    targetPath: string;
    /** Path relative to the worktree root (the cache key). */
    relPath: string;
    viewColumn: number;
    tabIndex: number;
    /** Restore this tab as the active tab of its group. */
    makeActiveInGroup: boolean;
    /** Exactly one action (the active tab of the active group) sets this. */
    focusGlobally: boolean;
    /** Cached position, or undefined to fall back to line 1. */
    position?: CachedPosition;
};

export type DroppedTab = {
    sourcePath: string;
    relPath: string;
    viewColumn: number;
};

export type TabRemapPlan = {
    /** Tabs to close then reopen at the equivalent path in the new worktree. */
    reopen: ReopenAction[];
    /** Tabs with no equivalent in the new worktree: closed, not reopened, reported. */
    closeMissing: DroppedTab[];
    /** Dirty tabs: left open & untouched (closing risks losing edits), reported. */
    skipDirty: DroppedTab[];
};

/**
 * Path of `p` relative to `root`, or null if `p` is not strictly inside `root`.
 */
export function relPathUnder(root: string, p: string): string | null {
    const rel = path.relative(root, p);
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
        return null;
    }
    return rel;
}

/**
 * The equivalent absolute path in `newRoot` for a file at `tabPath` in `oldRoot`,
 * or null if `tabPath` is not inside `oldRoot`.
 */
export function targetPathFor(oldRoot: string, newRoot: string, tabPath: string): string | null {
    const rel = relPathUnder(oldRoot, tabPath);
    if (rel === null) {
        return null;
    }
    return path.join(newRoot, rel);
}

export type PlanInput = {
    tabs: TabSnapshot[];
    oldRoot: string;
    newRoot: string;
    /** Does the equivalent file exist in the new worktree? */
    exists: (targetPath: string) => boolean;
    /** Cached position for a repo-relative path, if any. */
    getPosition: (relPath: string) => CachedPosition | undefined;
};

/**
 * Given the open tabs, the old/new worktree roots, an existence predicate and a
 * position lookup, decide what to do with each tab. Tabs not inside `oldRoot`
 * (e.g. files belonging to a different repo in a multi-root workspace) are
 * ignored entirely.
 */
export function planTabRemap(input: PlanInput): TabRemapPlan {
    const { tabs, oldRoot, newRoot, exists, getPosition } = input;
    const plan: TabRemapPlan = { reopen: [], closeMissing: [], skipDirty: [] };

    for (const tab of tabs) {
        const rel = relPathUnder(oldRoot, tab.path);
        if (rel === null) {
            continue; // belongs to another folder/repo; leave untouched
        }

        // Never close a dirty tab: its edits may only exist in the old worktree.
        if (tab.isDirty) {
            plan.skipDirty.push({ sourcePath: tab.path, relPath: rel, viewColumn: tab.viewColumn });
            continue;
        }

        const targetPath = path.join(newRoot, rel);
        if (!exists(targetPath)) {
            plan.closeMissing.push({ sourcePath: tab.path, relPath: rel, viewColumn: tab.viewColumn });
            continue;
        }

        plan.reopen.push({
            sourcePath: tab.path,
            targetPath,
            relPath: rel,
            viewColumn: tab.viewColumn,
            tabIndex: tab.tabIndex,
            makeActiveInGroup: tab.isActiveInGroup,
            focusGlobally: tab.isActiveInGroup && tab.groupIsActive,
            position: getPosition(rel),
        });
    }

    return plan;
}

/**
 * Order the reopen actions of a single view column so that background tabs are
 * materialized first (each briefly becomes the column's active editor and
 * captures its cached position/scroll) and the group's active tab is opened
 * last, ending up in the foreground. Within the background set, original
 * left-to-right tab order is preserved.
 */
export function orderColumnReopens(actions: ReopenAction[]): ReopenAction[] {
    return [...actions].sort((a, b) => {
        if (a.makeActiveInGroup !== b.makeActiveInGroup) {
            return a.makeActiveInGroup ? 1 : -1; // active tab goes last
        }
        return a.tabIndex - b.tabIndex;
    });
}
