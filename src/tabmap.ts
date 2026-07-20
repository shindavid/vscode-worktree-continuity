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

export interface InterceptGate {
    /** Feature toggle (off in suites that need strays to persist). */
    enabled: boolean;
    /** True during a worktree switch's critical section, where sibling/active
     * classification is inverted by design — never intercept then. */
    switchInProgress: boolean;
    /** True when the open was driven by the extension itself (applyRemapDepth>0);
     * our own tab churn must never be mistaken for a user stray. */
    extensionDrivenOpen: boolean;
    scheme: string;
    carryTabs: boolean;
    hasActiveWorktree: boolean;
    /** This URI is already being remapped (dedupes the didOpen + tab triggers). */
    alreadyInFlight: boolean;
    isDirty: boolean;
    /** False during the startup grace window, before the initial reconcile-on-open
     * has run once — restored sibling tabs get one batched reconcile instead of N
     * racing per-tab intercepts. */
    startupGracePassed: boolean;
}

/**
 * Pure pre-plan gate for sibling-open interception: the cheap, state-only checks
 * that decide whether an open is even a candidate, before the geometry
 * (planSiblingIntercept) and the filesystem existence check run. Kept pure so the
 * gating — including the switch-critical-section and self-open guards added after
 * the log4.txt repro — is unit-testable.
 */
export function shouldConsiderIntercept(g: InterceptGate): boolean {
    return (
        g.enabled &&
        g.startupGracePassed &&
        !g.switchInProgress &&
        !g.extensionDrivenOpen &&
        g.scheme === "file" &&
        g.carryTabs &&
        g.hasActiveWorktree &&
        !g.alreadyInFlight &&
        !g.isDirty
    );
}

export type SiblingInterceptPlan =
    | { intercept: false; reason: string }
    | { intercept: true; targetPath: string; relPath: string };

/**
 * Pure geometry for sibling-open interception (Feature 1): given the opened
 * file, the active worktree root, and the sibling worktree root that contains
 * the file (from the caller's longest-match lookup, or null), decide whether to
 * remap the open to the active worktree and to which equivalent path. The
 * non-geometry gates — scheme, dirtiness, config, in-flight de-dup, and whether
 * the target actually exists — are the caller's responsibility.
 */
export function planSiblingIntercept(
    docPath: string,
    activeRoot: string | null,
    containingWorktree: string | null,
    isSameRoot: (a: string, b: string) => boolean = (a, b) => a === b
): SiblingInterceptPlan {
    if (!activeRoot) {
        return { intercept: false, reason: "no active worktree" };
    }
    if (relPathUnder(activeRoot, docPath) !== null) {
        return { intercept: false, reason: "already in active worktree" };
    }
    if (!containingWorktree) {
        return { intercept: false, reason: "not under a known worktree" };
    }
    if (isSameRoot(containingWorktree, activeRoot)) {
        return { intercept: false, reason: "same as active worktree" };
    }
    const relPath = relPathUnder(containingWorktree, docPath);
    const targetPath = targetPathFor(containingWorktree, activeRoot, docPath);
    if (relPath === null || targetPath === null) {
        return { intercept: false, reason: "not inside sibling worktree" };
    }
    return { intercept: true, targetPath, relPath };
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
 * Order the reopen actions of a single view column by their original
 * left-to-right tab position, so reopening preserves the tab strip order. The
 * caller re-focuses the group's active tab afterwards (re-showing an already
 * open tab focuses it without moving it), which keeps both order and focus.
 */
export function orderColumnReopens(actions: ReopenAction[]): ReopenAction[] {
    return [...actions].sort((a, b) => a.tabIndex - b.tabIndex);
}

/**
 * Partition reopen actions into eager (remap now) vs lazy (leave for
 * interception) for the WINDOW-OPEN path. Rationale: VS Code restores background
 * tabs UNLOADED — no TextDocument exists until the tab is first revealed — so an
 * unloaded sibling-worktree stray (a) never reached the language server (it never
 * fired didOpen, so nothing to re-scope) and (b) shows a label identical to its
 * remapped equivalent. Touching it eagerly is pure visible churn with zero LS
 * benefit. So only strays whose source doc is already LOADED, or that are their
 * group's visible tab, are remapped now; the rest are left untouched and get
 * remapped by interception the moment the user reveals them (revealing loads the
 * doc → didOpen → interceptor). `loadedPaths` = fsPaths in
 * workspace.textDocuments; `visiblePaths` = each group's active tab.
 */
export function partitionReopensByLoad(
    reopens: ReopenAction[],
    loadedPaths: ReadonlySet<string>,
    visiblePaths: ReadonlySet<string>
): { eager: ReopenAction[]; lazy: ReopenAction[] } {
    const eager: ReopenAction[] = [];
    const lazy: ReopenAction[] = [];
    for (const a of reopens) {
        if (loadedPaths.has(a.sourcePath) || visiblePaths.has(a.sourcePath)) {
            eager.push(a);
        } else {
            lazy.push(a);
        }
    }
    return { eager, lazy };
}

export type GroupReopenOrder = {
    viewColumn: number;
    /** Reopens for this column, non-visible first (by tabIndex), then the
     * previously-visible one (makeActiveInGroup) LAST so it ends up revealed. */
    ordered: ReopenAction[];
    /** True if this column's previously-visible tab was itself a remapped stray
     * (so `ordered` ends with its replacement). False means the column's visible
     * tab was NOT a stray — the caller must re-show that original visible tab last
     * so a background open doesn't leave the wrong tab showing. */
    hasVisibleReopen: boolean;
};

/**
 * Group reopen actions by view column and order each column so its final-visible
 * tab is opened LAST. `showTextDocument` always reveals in its group, so opening
 * a column's previously-visible replacement last leaves that column showing the
 * right tab (fixing the non-focused-group fidelity regression), while everything
 * before it can open in the background. Columns are returned in ascending order.
 */
export function orderReopensByGroup(reopens: ReopenAction[]): GroupReopenOrder[] {
    const byCol = new Map<number, ReopenAction[]>();
    for (const a of reopens) {
        const arr = byCol.get(a.viewColumn) ?? [];
        arr.push(a);
        byCol.set(a.viewColumn, arr);
    }
    return [...byCol.keys()]
        .sort((a, b) => a - b)
        .map((viewColumn) => {
            const actions = byCol.get(viewColumn) ?? [];
            const byIndex = (a: ReopenAction, b: ReopenAction): number => a.tabIndex - b.tabIndex;
            const nonVisible = actions.filter((a) => !a.makeActiveInGroup).sort(byIndex);
            const visible = actions.filter((a) => a.makeActiveInGroup).sort(byIndex);
            return {
                viewColumn,
                ordered: [...nonVisible, ...visible],
                hasVisibleReopen: visible.length > 0,
            };
        });
}

/**
 * The one replacement that should receive focus at the end of a batched remap:
 * the equivalent of the tab that was globally active (active tab of the active
 * group) before the remap. Undefined when the active tab wasn't a remapped stray
 * (dirty-skipped, closeMissing, or belonged to another repo) — in which case the
 * caller performs no focus move and leaves focus where VS Code left it.
 */
export function focusTarget(plan: TabRemapPlan): ReopenAction | undefined {
    return plan.reopen.find((a) => a.focusGlobally);
}
