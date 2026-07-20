import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { getGitCommonDir, getSuperprojectPath, listWorktrees, type Worktree } from "./git";
import { waitForClientReady, type ObservableClient } from "./lsReady";
import { PositionCache } from "./positionCache";
import {
    focusTarget,
    orderReopens,
    planSiblingIntercept,
    planTabRemap,
    relPathUnder,
    shouldConsiderIntercept,
    targetPathFor,
    type CachedPosition,
    type ReopenAction,
    type TabRemapPlan,
    type TabSnapshot,
} from "./tabmap";
import {
    repoDisplayName,
    shouldDescendInto,
    siblingWorktreeRoots,
    worktreeLabel,
    type RepoSnapshot,
} from "./worktrees";
import {
    CurrentWorktreeDecorationProvider,
    WorktreeViewProvider,
    WORKTREE_VIEW_ID,
    SWITCH_TO_WORKTREE_COMMAND,
    type WorktreeTreeNode,
} from "./worktreeView";

const REPO_DISCOVERY_MAX_DEPTH = 2;
const CACHE_TTL_MS = 60_000;

let repoCache: { repos: RepoSnapshot[]; timestamp: number } | null = null;
let lastKnownRepos: RepoSnapshot[] = [];

let positionCache: PositionCache | null = null;
let worktreeView: WorktreeViewProvider | null = null;
let extensionContext: vscode.ExtensionContext | null = null;
let activeWorktreePath: string | null = null;

let worktreeWatchers: vscode.FileSystemWatcher[] = [];
let watchedCommonDirs = "";
let watcherRefreshTimer: ReturnType<typeof setTimeout> | undefined;

const PRIMED_REPOS_KEY = "worktree-continuity.lastRepos.v1";
// Persisted per-window so the next session can drive the first reconcile without
// waiting for git discovery. Worktree map: globalState (shared, keyed by repo
// common dir). Active worktree: workspaceState (this window's).
const ACTIVE_WORKTREE_KEY = "worktree-continuity.activeWorktree.v1";

function persistActiveWorktree(): void {
    if (!extensionContext) {return;}
    void extensionContext.workspaceState.update(ACTIVE_WORKTREE_KEY, activeWorktreePath ?? undefined);
}

function loadPersistedActiveWorktree(context: vscode.ExtensionContext): string | null {
    return context.workspaceState.get<string>(ACTIVE_WORKTREE_KEY) ?? null;
}

/**
 * Watch each repo's `<git-common-dir>/worktrees/` directory so the view updates
 * automatically when a worktree is added or removed. `git worktree add` doesn't
 * change workspace folders, but it does create an admin directory there — the
 * same signal git itself uses.
 */
function updateWorktreeWatchers(repos: RepoSnapshot[]): void {
    const dirs = [...new Set(repos.map((r) => r.commonDir))].sort();
    const key = dirs.join("\n");
    if (key === watchedCommonDirs) {return;}
    watchedCommonDirs = key;

    for (const w of worktreeWatchers) {
        w.dispose();
    }
    worktreeWatchers = dirs.map((dir) => {
        const watcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(vscode.Uri.file(dir), "worktrees/**")
        );
        watcher.onDidCreate(scheduleWatcherRefresh);
        watcher.onDidDelete(scheduleWatcherRefresh);
        return watcher;
    });
    log(`Worktree watchers: watching ${dirs.length} common dir(s)`);
}

function scheduleWatcherRefresh(): void {
    if (watcherRefreshTimer) {clearTimeout(watcherRefreshTimer);}
    watcherRefreshTimer = setTimeout(async () => {
        watcherRefreshTimer = undefined;
        repoCache = null;
        await getRepos(true);
        worktreeView?.refresh();
        log(`Worktree watcher: refreshed after git worktree change`);
    }, 400);
}

/** fsPath of the pinned anchor folder (globalStorage/anchor), computed sync. */
function anchorPath(): string | null {
    if (!extensionContext) {return null;}
    return vscode.Uri.joinPath(extensionContext.globalStorageUri, "anchor").fsPath;
}

/**
 * The active worktree is authoritative from the workspace folders themselves:
 * folder[1] when the anchor layout is set up, else the sole worktree folder.
 * Deriving it (rather than persisting a separate copy) keeps the green "current"
 * marker always in sync with what's actually open.
 */
function deriveActiveWorktree(): string | null {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) {return null;}
    const anchor = anchorPath();
    if (anchor && folders.length >= 2 && folders[0].uri.fsPath === anchor) {
        return folders[1].uri.fsPath;
    }
    // Pre-setup: a worktree opened directly as a single folder.
    if (folders.length === 1) {return folders[0].uri.fsPath;}
    return folders[folders.length - 1].uri.fsPath;
}

/** Recompute the active worktree from the workspace and update the view/title. */
function refreshActiveFromFolders(): void {
    activeWorktreePath = deriveActiveWorktree();
    log(`Active worktree = ${activeWorktreePath ?? "<none>"}`);
    worktreeView?.setActive(activeWorktreePath);
    persistActiveWorktree();
    void updateWindowTitle();
}

function samePath(a: string, b: string): boolean {
    const strip = (p: string) => p.replace(/[/\\]+$/, "");
    return strip(a) === strip(b);
}

const WARNINGS_DOC_URL =
    "https://github.com/shindavid/vscode-worktree-continuity/blob/main/docs/warnings.md";

let mixedWarningShown = false;
let mixedCheckTimer: ReturnType<typeof setTimeout> | undefined;

// >0 while applyTabRemap is mutating tabs, so tab open/close events can be
// attributed to the extension itself rather than to the user or a language
// server. A counter (not a bool) because reconcile applies remaps in sequence.
let applyRemapDepth = 0;

// Feature 1: intercept a sibling-worktree file being opened (typically a
// Go-to-Definition landing in the wrong worktree) and immediately remap it to
// the active worktree's equivalent, before the stray tab can re-contaminate a
// freshly re-scoped language server. Enabled by default; suites that need stray
// tabs to persist turn it off via __test.setInterceptionEnabled.
let interceptSiblingOpens = true;
// URIs currently being remapped, so the target-open / stray-close churn we
// generate doesn't re-enter interception (and so the didOpen + tab-open triggers
// dedupe to a single remap per stray).
const inFlightIntercepts = new Set<string>();
// True during a worktree switch's critical section (from before the switch's own
// applyTabRemap until the active worktree is updated). During that window the
// switch itself opens NEW-worktree tabs while activeWorktreePath still points at
// the OLD root, so sibling/active classification is inverted — interception must
// stand down or it bounces the switch's own carried tabs back (log4.txt L70–95).
let switchInProgress = false;
// False until the activation-path reconcile-on-open has run once (or a safety
// timeout elapses). During the grace window, per-tab interception stays off so
// VS Code's session-restored sibling tabs get ONE quiet batched reconcile instead
// of N individual intercepts racing it.
let startupReconcileDone = false;
// Safety net: never keep interception off forever if reconcile never runs (e.g.
// carryTabs off, or no repo). Measured startup well under this.
const STARTUP_GRACE_MS = 10_000;

function markStartupReconcileDone(): void {
    if (startupReconcileDone) {return;}
    startupReconcileDone = true;
    log("Startup grace complete: sibling-open interception enabled");
}

/** The discovered non-bare worktree that contains `fsPath` (longest match), if any. */
function worktreeOfPath(fsPath: string): { commonDir: string; path: string; label: string } | null {
    let best: { commonDir: string; path: string; label: string } | null = null;
    for (const repo of lastKnownRepos) {
        for (const w of repo.worktrees) {
            if (w.bare) {continue;}
            if (relPathUnder(w.path, fsPath) === null) {continue;}
            if (!best || w.path.length > best.path.length) {
                best = { commonDir: repo.commonDir, path: w.path, label: worktreeLabel(w) };
            }
        }
    }
    return best;
}

/** Open text tabs that belong to a sibling worktree of the active one. */
function siblingWorktreeTabs(): { path: string; label: string }[] {
    if (!activeWorktreePath) {return [];}
    const active = activeWorktreePath;
    const out: { path: string; label: string }[] = [];
    for (const group of vscode.window.tabGroups.all) {
        for (const t of group.tabs) {
            if (!(t.input instanceof vscode.TabInputText)) {continue;}
            const p = t.input.uri.fsPath;
            const wt = worktreeOfPath(p);
            if (wt && !samePath(wt.path, active)) {
                out.push({ path: p, label: wt.label });
            }
        }
    }
    return out;
}

function hasMixedWorktreeTabs(): boolean {
    return siblingWorktreeTabs().length > 0;
}

/** One-line description of a tab: worktree-relative tag + path (for logs). */
function describeTab(t: vscode.Tab): string {
    if (!(t.input instanceof vscode.TabInputText)) {return "<non-text tab>";}
    const uri = t.input.uri;
    if (uri.scheme !== "file") {return `${uri.scheme}:${uri.fsPath}`;}
    const p = uri.fsPath;
    const wt = worktreeOfPath(p);
    const active = deriveActiveWorktree();
    const tag = !wt
        ? "OUTSIDE-any-worktree"
        : active && samePath(wt.path, active)
          ? `ACTIVE(${wt.label})`
          : `SIBLING(${wt.label})`;
    return `[${tag}] ${p}`;
}

/**
 * Log tab open/close events with provenance so we can tell an extension-driven
 * remap apart from an external open (user navigation such as Go-to-Definition,
 * or a language server revealing a document). A SIBLING tab opened while we are
 * NOT remapping is almost always cross-worktree navigation — the exact case the
 * mixed-worktree warning exists to catch — so it gets an explicit hint.
 */
function logTabChanges(e: vscode.TabChangeEvent): void {
    const origin = applyRemapDepth > 0 ? "self/remap" : "external";
    for (const t of e.opened) {
        const desc = describeTab(t);
        const hint =
            applyRemapDepth === 0 && desc.startsWith("[SIBLING")
                ? " (likely cross-worktree navigation)"
                : "";
        log(`Tab opened (${origin}): ${desc}${hint}`);
    }
    for (const t of e.closed) {
        log(`Tab closed (${origin}): ${describeTab(t)}`);
    }
}

/** Log a full snapshot of state for diagnosing worktree/language-server issues. */
function dumpDebugState(reason: string): void {
    log(`===== debug dump (${reason}) =====`);
    log(`anchorPath = ${anchorPath() ?? "<none>"}`);
    const folders = vscode.workspace.workspaceFolders ?? [];
    log(`workspace folders (${folders.length}):`);
    folders.forEach((f, i) => log(`  [${i}] "${f.name}" = ${f.uri.fsPath}`));
    const active = deriveActiveWorktree();
    log(`activeWorktreePath(var) = ${activeWorktreePath ?? "<none>"}`);
    log(`deriveActiveWorktree()  = ${active ?? "<none>"}`);
    log(`discovered repos (${lastKnownRepos.length}):`);
    for (const repo of lastKnownRepos) {
        log(`  repo ${repo.commonDir} "${repo.name}":`);
        for (const w of repo.worktrees) {
            const tag = active && samePath(w.path, active) ? " <ACTIVE>" : "";
            log(`    - [${worktreeLabel(w)}] ${w.path}${w.bare ? " (bare)" : ""}${tag}`);
        }
    }
    log(`open text tabs:`);
    for (const group of vscode.window.tabGroups.all) {
        for (const t of group.tabs) {
            if (!(t.input instanceof vscode.TabInputText)) {
                log(`  col${group.viewColumn}   <non-text tab>`);
                continue;
            }
            const p = t.input.uri.fsPath;
            const wt = worktreeOfPath(p);
            let tag = "OUTSIDE-any-worktree";
            if (wt) {
                tag = active && samePath(wt.path, active) ? `ACTIVE(${wt.label})` : `SIBLING(${wt.label})`;
            }
            log(`  col${group.viewColumn}${t.isActive ? " *" : "  "} [${tag}] ${p}`);
        }
    }
    log(`===== end debug dump =====`);
    outputChannel?.show(true);
}

/**
 * Debounced check for tabs from another worktree. Having them open lets a shared
 * language server (e.g. clangd) load the other worktree's project and resolve
 * symbols to the wrong copy. Warn once per episode, with a one-click fix.
 */
function scheduleMixedWorktreeCheck(): void {
    if (mixedCheckTimer) {clearTimeout(mixedCheckTimer);}
    mixedCheckTimer = setTimeout(async () => {
        mixedCheckTimer = undefined;
        const siblings = siblingWorktreeTabs();
        if (siblings.length === 0) {
            mixedWarningShown = false;
            return;
        }
        log(
            `Mixed-worktree tabs detected (${siblings.length}): ` +
                siblings.map((s) => `[${s.label}] ${s.path}`).join(" | ")
        );
        if (mixedWarningShown) {return;}
        mixedWarningShown = true;
        const choice = await vscode.window.showWarningMessage(
            "Worktree Continuity: files from another worktree are open. This can confuse " +
                "language servers — e.g. Go to Definition may jump to the wrong worktree's copy.",
            "Reconcile",
            "Learn more"
        );
        if (choice === "Reconcile") {
            const repos = await getRepos();
            const remapped = await reconcileOpenTabs(repos);
            if (remapped > 0) {scheduleLanguageServerRestart();}
        } else if (choice === "Learn more") {
            void vscode.env.openExternal(vscode.Uri.parse(WARNINGS_DOC_URL));
        }
    }, 1000);
}

/**
 * On workspace open, VS Code restores editor tabs by absolute path, which can
 * leave tabs pointing at a sibling worktree that isn't the active one (e.g. a
 * tab left over from a previous session). Remap any such tab to the equivalent
 * file in the active worktree so the open editors match what's focused. Unlike a
 * switch, this never closes tabs that have no equivalent — it only remaps the
 * ones it can, so nothing is lost on startup.
 */
async function reconcileOpenTabs(repos: RepoSnapshot[]): Promise<number> {
    const carryTabs = vscode.workspace
        .getConfiguration()
        .get<boolean>("worktree-continuity.carryTabs", true);
    if (!carryTabs || !activeWorktreePath) {return 0;}
    const active = activeWorktreePath;

    const found = siblingWorktreeRoots(repos, active, samePath);
    if (!found) {return 0;}
    const { commonDir, siblings } = found;

    let remapped = 0;
    for (const sibling of siblings) {
        try {
            const { plan, tabByKey } = await buildTabRemapPlan(sibling, active, (rel) =>
                positionCache?.get(commonDir, rel)
            );
            if (plan.reopen.length === 0) {continue;}
            // Only remap tabs that have an equivalent; leave orphan tabs open.
            const remapOnly: TabRemapPlan = { reopen: plan.reopen, closeMissing: [], skipDirty: [] };
            log(`Reconcile on open: ${sibling} → ${active} (remap ${plan.reopen.length} tab(s))`);
            await applyTabRemap(remapOnly, tabByKey, positionCache ?? undefined);
            remapped += plan.reopen.length;
        } catch (e) {
            log(`Reconcile failed for ${sibling}: ${e instanceof Error ? e.message : String(e)}`);
        }
    }
    return remapped;
}

/** The open text tab (and its column) for a uri, if any. */
function findTextTab(uri: vscode.Uri): { tab: vscode.Tab; viewColumn: number } | null {
    const uriStr = uri.toString();
    for (const group of vscode.window.tabGroups.all) {
        for (const t of group.tabs) {
            if (t.input instanceof vscode.TabInputText && t.input.uri.toString() === uriStr) {
                return { tab: t, viewColumn: group.viewColumn };
            }
        }
    }
    return null;
}

/** Whether a uri is currently shown inside a diff editor (never intercept those). */
function hasDiffTabFor(uri: vscode.Uri): boolean {
    const uriStr = uri.toString();
    for (const group of vscode.window.tabGroups.all) {
        for (const t of group.tabs) {
            if (
                t.input instanceof vscode.TabInputTextDiff &&
                (t.input.original.toString() === uriStr || t.input.modified.toString() === uriStr)
            ) {
                return true;
            }
        }
    }
    return false;
}

/** Bounded wait for a visible editor on `uri` to materialize (go-to-def target). */
function waitForVisibleEditor(
    uri: vscode.Uri,
    timeoutMs: number
): Promise<vscode.TextEditor | undefined> {
    const uriStr = uri.toString();
    const find = (): vscode.TextEditor | undefined =>
        vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === uriStr);
    const existing = find();
    if (existing) {return Promise.resolve(existing);}
    return new Promise((resolve) => {
        let done = false;
        const finish = (ed: vscode.TextEditor | undefined): void => {
            if (done) {return;}
            done = true;
            clearTimeout(timer);
            clearInterval(poll);
            sub.dispose();
            resolve(ed);
        };
        const sub = vscode.window.onDidChangeActiveTextEditor(() => {
            const f = find();
            if (f) {finish(f);}
        });
        const poll = setInterval(() => {
            const f = find();
            if (f) {finish(f);}
        }, 25);
        const timer = setTimeout(() => finish(find()), timeoutMs);
    });
}

function positionFromEditor(editor: vscode.TextEditor): CachedPosition {
    const s = editor.selection;
    const cp: CachedPosition = {
        selection: {
            anchorLine: s.anchor.line,
            anchorChar: s.anchor.character,
            activeLine: s.active.line,
            activeChar: s.active.character,
        },
    };
    const top = editor.visibleRanges[0]?.start.line;
    if (top !== undefined) {cp.topLine = top;}
    return cp;
}

/**
 * When a file from a sibling worktree is opened (e.g. Go-to-Definition resolving
 * into the wrong worktree), immediately remap it to the active worktree's
 * equivalent at the same cursor position — showing the correct editor first,
 * then closing the stray tab — so a shared language server can't be
 * re-contaminated. This is the live-case replacement for the slower
 * reconcile-on-detection loop; periodic reconcile stays as a backstop.
 */
async function interceptSiblingOpen(doc: vscode.TextDocument): Promise<void> {
    const active = activeWorktreePath;
    const uriStr = doc.uri.toString();
    const carryTabs = vscode.workspace
        .getConfiguration()
        .get<boolean>("worktree-continuity.carryTabs", true);
    // Cheap, state-only pre-plan gate (pure). Notably: never intercept while a
    // switch is in flight or while the extension itself is opening tabs
    // (applyRemapDepth>0) — both invert or self-trigger the classification.
    if (
        !shouldConsiderIntercept({
            enabled: interceptSiblingOpens,
            startupGracePassed: startupReconcileDone,
            switchInProgress,
            extensionDrivenOpen: applyRemapDepth > 0,
            scheme: doc.uri.scheme,
            carryTabs,
            hasActiveWorktree: !!active,
            alreadyInFlight: inFlightIntercepts.has(uriStr),
            isDirty: doc.isDirty,
        })
    ) {
        return;
    }
    const p = doc.uri.fsPath;
    const wt = worktreeOfPath(p);
    const plan = planSiblingIntercept(p, active, wt?.path ?? null, samePath);
    if (!plan.intercept) {return;}
    // Claim this URI synchronously, before any await, so the didOpen and tab-open
    // triggers for the same stray can't both slip past the in-flight check.
    inFlightIntercepts.add(uriStr);
    try {
        const target = plan.targetPath;
        const rel = plan.relPath;
        if (!(await pathExists(target))) {return;}

        // Position fidelity: wait briefly for the stray editor so we can read the
        // go-to-def selection; fall back to the position cache otherwise.
        await waitForVisibleEditor(doc.uri, 150);
        if (hasDiffTabFor(doc.uri)) {
            log(`Intercept skipped (diff editor): ${p}`);
            return;
        }
        const stray = findTextTab(doc.uri);
        if (!stray) {return;} // no tab to remap (never painted, or already gone)

        // Re-read the LIVE editor's selection as late as possible — a go-to-def
        // target selection can land after the initial open, so latest wins.
        const liveEditor = vscode.window.visibleTextEditors.find(
            (e) => e.document.uri.toString() === uriStr
        );
        const viewColumn = liveEditor?.viewColumn ?? stray.viewColumn;
        let position: CachedPosition | undefined;
        if (liveEditor) {
            position = positionFromEditor(liveEditor);
        } else {
            const key = resolveCacheKey(target);
            position = key ? positionCache?.get(key.commonDir, key.relPath) : undefined;
        }
        const sel = position?.selection;
        const line = sel ? sel.activeLine : 0;
        const character = sel ? sel.activeChar : 0;

        const action: ReopenAction = {
            sourcePath: p,
            targetPath: target,
            relPath: rel,
            viewColumn,
            tabIndex: 0,
            makeActiveInGroup: true,
            focusGlobally: true,
            position,
        };

        applyRemapDepth++;
        positionCache?.suspend();
        try {
            // Show the correct editor FIRST (minimizes perceived flash), then close
            // the stray tab.
            await openReopenAction(action, false);
            await vscode.window.tabGroups.close(stray.tab, true);
        } finally {
            positionCache?.resume();
            applyRemapDepth--;
        }
        log(`Intercepted sibling open: ${p} → ${target} @${line}:${character}`);
    } catch (e) {
        log(`Intercept failed for ${p}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
        inFlightIntercepts.delete(uriStr);
    }
}

/**
 * Trigger interception from a newly-opened tab (Defect 2 in log4.txt): a
 * Go-to-Definition into a document that was ALREADY loaded earlier in the session
 * fires no onDidOpenTextDocument, so only a tab opens. Feed those external text
 * tabs through the same interceptor; the in-flight set dedupes against the
 * didOpen trigger.
 */
function interceptSiblingTabOpen(e: vscode.TabChangeEvent): void {
    if (applyRemapDepth > 0) {return;} // our own remap churn
    for (const t of e.opened) {
        if (!(t.input instanceof vscode.TabInputText)) {continue;}
        const uri = t.input.uri;
        if (uri.scheme !== "file") {continue;}
        const doc = vscode.workspace.textDocuments.find(
            (d) => d.uri.toString() === uri.toString()
        );
        if (doc) {void interceptSiblingOpen(doc);}
    }
}

// Fire quickly after a switch (small window where the language server still has
// the old worktree's index). Rather than a fixed minimum gap between restarts —
// which either wastes time or races an in-flight startup — we gate the next
// restart on an OBSERVED readiness signal: a restart is "in flight" from the
// moment its commands are issued until the server reports Running again (or we
// give up). Restarting while a server is still starting double-registers its
// commands and errors ("command 'clangd.applyFix' already exists"), so a trigger
// that arrives mid-flight is coalesced into a single follow-up restart.
const LS_RESTART_DEBOUNCE_MS = 400;
// Cap on how long we wait for the readiness signal before treating the restart
// as settled anyway.
const LS_READY_TIMEOUT_MS = 15_000;
// When readiness is unobservable (the language-server extension/API isn't
// present), fall back to a fixed time gap. Measured clangd stop→start is ~5s.
const LS_UNOBSERVABLE_GAP_MS = 6_000;
// If the client is already Running when we attach, how long to wait for it to
// leave Running before concluding the restart already completed.
const LS_READY_GRACE_MS = 2_000;

type LsReadiness = "ready" | "timeout" | "unobservable";

let lsRestartTimer: ReturnType<typeof setTimeout> | undefined;
// True from when a restart's commands are issued until its readiness resolves.
let lsRestartInFlight = false;
// A trigger that arrived while a restart was in flight; runs exactly one more
// restart once the current one settles.
let lsRestartPending = false;
// Generation token so a reset (test isolation) makes any in-flight cycle abort
// instead of acting on stale state.
let lsRestartGen = 0;
let lsUnobservableTimer: ReturnType<typeof setTimeout> | undefined;
let lsUnobservableResolve: (() => void) | undefined;

/**
 * Readiness probe. Resolves 'ready' when the language server is Running again,
 * 'timeout' if it doesn't within the budget, or 'unobservable' if there's no API
 * to observe. Injectable via __test so integration tests can fake it (the
 * clangd extension isn't installed in the test host).
 */
let lsReadyProbe: (timeoutMs: number) => Promise<LsReadiness> = clangdWaitForLsReady;

function waitForLsReady(timeoutMs: number): Promise<LsReadiness> {
    return lsReadyProbe(timeoutMs);
}

/**
 * clangd-specific readiness probe: the extension/API lookup plus the
 * 'unobservable' path; the transition-aware waiting is delegated to the pure
 * `waitForClientReady`. `extensions.getExtension(id)?.exports` exposes
 * `getApi(1) -> { languageClient }`, a vscode-languageclient `LanguageClient`
 * with `.state` (State.Running === 2) and `.onDidChangeState`.
 *
 * Version note (vscode-clangd 0.6.0): its `clangd.restart` handler disposes the
 * old client (fire-and-forget `stop()`) but `await`s creation of the NEW client
 * and repoints the exported `languageClient` at it before the command resolves —
 * so by the time we read it here the client is the fresh one, already Running,
 * with no further transition. The stale-Running race is therefore latent for
 * 0.6.0 (the graceMs branch resolves 'ready' for it), but live for any handler
 * that resolves the command while the SAME client is still winding down; the
 * transition-aware wait guards that case.
 */
async function clangdWaitForLsReady(timeoutMs: number): Promise<LsReadiness> {
    try {
        const ext = vscode.extensions.getExtension("llvm-vs-code-extensions.vscode-clangd");
        if (!ext) {return "unobservable";}
        const exports = ext.isActive ? ext.exports : await ext.activate();
        const client = exports?.getApi?.(1)?.languageClient as ObservableClient | undefined;
        if (!client) {return "unobservable";}
        return await waitForClientReady(client, { timeoutMs, graceMs: LS_READY_GRACE_MS });
    } catch (e) {
        log(`LS readiness probe failed: ${e instanceof Error ? e.message : String(e)}`);
        return "unobservable";
    }
}

function delayUnobservableGap(ms: number): Promise<void> {
    return new Promise((resolve) => {
        lsUnobservableResolve = resolve;
        lsUnobservableTimer = setTimeout(() => {
            lsUnobservableTimer = undefined;
            lsUnobservableResolve = undefined;
            resolve();
        }, ms);
    });
}

/**
 * Schedule a debounced language-server re-scope. Many servers (clangd included)
 * keep the previous worktree's index across a folder swap, so after a switch we
 * restart them to force a clean re-scope. Rapid triggers within the debounce
 * window coalesce into one; a trigger that arrives while a restart is still in
 * flight sets a pending flag so exactly one follow-up restart runs once the
 * current one is ready.
 */
function scheduleLanguageServerRestart(): void {
    if (lsRestartInFlight) {
        lsRestartPending = true;
        return;
    }
    if (lsRestartTimer) {clearTimeout(lsRestartTimer);}
    lsRestartTimer = setTimeout(() => {
        lsRestartTimer = undefined;
        void runLanguageServerRestartCycle();
    }, LS_RESTART_DEBOUNCE_MS);
}

/**
 * Issue a restart, then hold "in flight" until the server is observed ready (or
 * the budget elapses, or readiness is unobservable → fixed gap). If a trigger
 * arrived meanwhile, run exactly one more cycle.
 */
async function runLanguageServerRestartCycle(): Promise<void> {
    const gen = lsRestartGen;
    lsRestartInFlight = true;
    lsRestartPending = false;
    try {
        await restartLanguageServers();
    } catch (e) {
        log(`LS restart cycle error: ${e instanceof Error ? e.message : String(e)}`);
    }
    const readiness = await waitForLsReady(LS_READY_TIMEOUT_MS);
    if (gen !== lsRestartGen) {return;} // reset during the wait; abort
    log(`LS restart: readiness = ${readiness}`);
    if (readiness === "unobservable") {
        await delayUnobservableGap(LS_UNOBSERVABLE_GAP_MS);
        if (gen !== lsRestartGen) {return;}
    }
    lsRestartInFlight = false;
    if (lsRestartPending) {
        lsRestartPending = false;
        await runLanguageServerRestartCycle();
    }
}

/**
 * Dump the state that decides where a shared C/C++ language server resolves
 * symbols, so we can see *why* Go-to-Definition lands in the wrong worktree
 * after a switch. clangd keys its project on the nearest compilation database
 * (compile_commands.json / compile_flags.txt / .clangd) and a persisted index
 * under `.cache/clangd`; if the active worktree lacks one — or clangd was
 * launched with a `--compile-commands-dir` pinned at another worktree — it will
 * keep resolving against the original (e.g. `main`) copy even after a restart.
 */
async function logLanguageServerScope(): Promise<void> {
    const anchor = anchorPath();
    const folders = vscode.workspace.workspaceFolders ?? [];
    log(`LS scope: workspace folders (${folders.length}):`);
    folders.forEach((f, i) => {
        const tag = f.uri.fsPath === anchor ? " (anchor)" : "";
        log(`LS scope:   [${i}] "${f.name}" = ${f.uri.fsPath}${tag}`);
    });
    const active = deriveActiveWorktree();
    log(`LS scope: active worktree = ${active ?? "<none>"}`);

    // Compilation-database / index markers that clangd keys its project on.
    const markers = [
        "compile_commands.json",
        "compile_flags.txt",
        ".clangd",
        "build/compile_commands.json",
        ".cache/clangd",
    ];
    const roots = new Set<string>();
    if (active) {roots.add(active);}
    for (const f of folders) {
        if (f.uri.fsPath !== anchor) {roots.add(f.uri.fsPath);}
    }
    for (const root of roots) {
        const present = (
            await Promise.all(
                markers.map(async (m) => ((await pathExists(path.join(root, m))) ? m : null))
            )
        ).filter((m): m is string => m !== null);
        log(`LS scope:   ${root} → ${present.length ? present.join(", ") : "<no clangd project markers>"}`);
    }

    // A pinned --compile-commands-dir (or a fixed clangd.path) overrides the
    // workspace root entirely and is a prime suspect for wrong-worktree resolution.
    const clangdCfg = vscode.workspace.getConfiguration("clangd");
    const clangdArgs = clangdCfg.get<string[]>("arguments", []) ?? [];
    const pinned = clangdArgs.filter((a) => /--compile-commands-dir|--index-file|--path-mappings/.test(a));
    if (pinned.length > 0) {
        log(`LS scope: clangd.arguments pins: ${pinned.join(" ")}`);
    } else if (clangdArgs.length > 0) {
        log(`LS scope: clangd.arguments = ${clangdArgs.join(" ")}`);
    }
}

async function restartLanguageServers(): Promise<void> {
    const commands = vscode.workspace
        .getConfiguration()
        .get<string[]>("worktree-continuity.languageServerRestartCommands", []);
    if (!commands || commands.length === 0) {return;}
    await logLanguageServerScope();
    const available = new Set(await vscode.commands.getCommands(true));
    for (const command of commands) {
        if (!available.has(command)) {
            log(`LS restart: command not present, skipping: ${command}`);
            continue;
        }
        try {
            await vscode.commands.executeCommand(command);
            log(`LS restart: ran ${command}`);
        } catch (e) {
            log(`LS restart: ${command} failed: ${e instanceof Error ? e.message : String(e)}`);
        }
    }
}

/**
 * Load the last-persisted repo snapshot so the tree view can render instantly on
 * activation. Only used if it relates to this window (one of its worktrees is a
 * current workspace folder or lives under one), so a different window's repo
 * never shows.
 */
function loadPrimedRepos(context: vscode.ExtensionContext): RepoSnapshot[] {
    const stored = context.globalState.get<RepoSnapshot[]>(PRIMED_REPOS_KEY);
    if (!stored || stored.length === 0) {return [];}
    const wsPaths = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
    const relevant = stored.some((r) =>
        r.worktrees.some(
            (w) => wsPaths.includes(w.path) || wsPaths.some((ws) => relPathUnder(ws, w.path) !== null)
        )
    );
    return relevant ? stored : [];
}

function persistRepos(repos: RepoSnapshot[]): void {
    if (!extensionContext || repos.length === 0) {return;}
    void extensionContext.globalState.update(PRIMED_REPOS_KEY, repos);
}

let outputChannel: vscode.OutputChannel | null = null;
function log(msg: string): void {
    if (!outputChannel) {
        outputChannel = vscode.window.createOutputChannel("Worktree Continuity");
    }
    const ts = new Date().toISOString().slice(11, 23);
    outputChannel.appendLine(`[${ts}] ${msg}`);
    // Mirror to the Debug Console so diagnostics survive even if the output
    // channel view is showing a stale instance.
    console.log(`[worktree-continuity ${ts}] ${msg}`);
}

export function activate(context: vscode.ExtensionContext) {
    log("Worktree Continuity activating");
    extensionContext = context;

    // Register the tree view first, primed from persisted state, so it renders
    // instantly (no async discovery on the render path).
    activeWorktreePath = deriveActiveWorktree() ?? loadPersistedActiveWorktree(context);
    const primedRepos = loadPrimedRepos(context);
    if (primedRepos.length > 0) {lastKnownRepos = primedRepos;}
    worktreeView = new WorktreeViewProvider(primedRepos, activeWorktreePath);
    context.subscriptions.push(
        vscode.window.registerTreeDataProvider(WORKTREE_VIEW_ID, worktreeView),
        vscode.window.registerFileDecorationProvider(new CurrentWorktreeDecorationProvider())
    );

    const persist = vscode.workspace
        .getConfiguration()
        .get<boolean>("worktree-continuity.persistPositionsAcrossRestart", true);
    positionCache = new PositionCache(persist ? context.globalState : undefined);

    const cmd = (name: string, fn: (...args: unknown[]) => Promise<void> | void) =>
        vscode.commands.registerCommand(name, async (...args: unknown[]) => {
            log(`Command invoked: ${name}`);
            try {
                await fn(...args);
            } catch (e) {
                const msg = e instanceof Error ? e.stack ?? e.message : String(e);
                log(`Command ${name} threw: ${msg}`);
                vscode.window.showErrorMessage(`Worktree Continuity: ${name} failed — see logs.`);
            }
        });

    context.subscriptions.push(
        cmd("worktree-continuity.switchWorktree", () => switchWorktreeCommand()),
        cmd(SWITCH_TO_WORKTREE_COMMAND, (node) => switchToWorktreeCommand(node as WorktreeTreeNode)),
        cmd("worktree-continuity.refreshWorktrees", () => refreshCommand()),
        cmd("worktree-continuity.refreshView", () => refreshViewCommand()),
        cmd("worktree-continuity.openTerminalInWorktree", () => openTerminalInWorktreeCommand()),
        vscode.commands.registerCommand("worktree-continuity.showLogs", () => {
            if (!outputChannel) {outputChannel = vscode.window.createOutputChannel("Worktree Continuity");}
            outputChannel.show();
        }),
        vscode.commands.registerCommand("worktree-continuity.debugDump", () => dumpDebugState("manual")),
        vscode.workspace.onDidChangeWorkspaceFolders(async () => {
            log(`Workspace folders changed`);
            repoCache = null;
            refreshActiveFromFolders();
            await getRepos(true);
            // clangd does NOT re-scope on a folder[1] swap — it keeps the old
            // worktree's index, so Go to Definition resolves shared symbols to
            // the wrong worktree. Restart it (debounced, so it can't race a
            // language-server startup and double-register commands).
            scheduleLanguageServerRestart();
        }),
        // Position-cache feeders. These run continuously so background tabs
        // (which have no live TextEditor at switch time) still have a recorded
        // position to restore.
        vscode.window.onDidChangeActiveTextEditor((editor) => {
            if (editor) {
                recordEditorPosition(editor, true);
                if (editor.document.uri.scheme === "file") {
                    const active = deriveActiveWorktree();
                    const wt = worktreeOfPath(editor.document.uri.fsPath);
                    const tag = !wt
                        ? "OUTSIDE-any-worktree"
                        : active && samePath(wt.path, active)
                          ? `ACTIVE(${wt.label})`
                          : `SIBLING(${wt.label})`;
                    log(`Active editor focus → [${tag}] ${editor.document.uri.fsPath}`);
                }
            }
        }),
        vscode.window.onDidChangeTextEditorSelection((e) => {
            recordEditorPosition(e.textEditor, false);
        }),
        vscode.window.onDidChangeTextEditorVisibleRanges((e) => {
            recordEditorTopLine(e.textEditor);
        }),
        // Feature 1: intercept a sibling-worktree open (e.g. Go-to-Definition
        // landing in the wrong worktree) at the earliest pre-paint signal and
        // remap it to the active worktree, before it re-contaminates the server.
        vscode.workspace.onDidOpenTextDocument((doc) => {
            void interceptSiblingOpen(doc);
        }),
        // Warn (with a one-click fix) if tabs from another worktree get opened,
        // which can make a shared language server resolve symbols to the wrong copy.
        vscode.window.tabGroups.onDidChangeTabs((e) => {
            logTabChanges(e);
            // Also intercept from the tab-open signal: a nav into an already-loaded
            // document fires no onDidOpenTextDocument (Defect 2). Deduped by URI.
            interceptSiblingTabOpen(e);
            scheduleMixedWorktreeCheck();
        }),
        { dispose: () => positionCache?.dispose() }
    );

    // Safety net: enable interception even if the reconcile path below never runs
    // (anchoring restart, carryTabs off, no repo), so it can't stay off forever.
    const graceTimer = setTimeout(markStartupReconcileDone, STARTUP_GRACE_MS);
    context.subscriptions.push({ dispose: () => clearTimeout(graceTimer) });

    // Start the open-time reconcile IMMEDIATELY — no defer. onStartupFinished
    // already fires late (after the window paints with restored stale tabs), so
    // every extra millisecond is a visible rearrangement on a settled window.
    void runStartupReconcile(primedRepos);
}

/**
 * Open-time reconcile, run as early as possible. Two passes:
 *   1. From the persisted worktree snapshot (no git discovery), so stray
 *      session-restored tabs are remapped before discovery latency elapses.
 *   2. From authoritative git discovery, which re-drives reconcile (idempotent —
 *      normally 0 strays), refreshes the view, and persists a fresh snapshot.
 * Reconcile is idempotent, so a stale snapshot converges once discovery corrects
 * it. Interception stays off (startup grace) until this completes, so restored
 * tabs get one batched reconcile instead of N racing per-tab intercepts.
 */
async function runStartupReconcile(primed: RepoSnapshot[]): Promise<void> {
    try {
        // Establish the anchor layout if a single worktree was opened directly.
        // That triggers a one-time host restart; the reactivated host runs this
        // again with the [anchor, worktree] layout.
        if (await ensureAnchoredLayout()) {return;}

        // Pass 1 — snapshot-primed, no discovery on the critical path.
        if (primed.length > 0) {
            const n = await reconcileOpenTabs(primed);
            if (n > 0) {
                log(`Startup reconcile (snapshot): remapped ${n} tab(s)`);
                scheduleLanguageServerRestart();
            }
        }

        // Pass 2 — authoritative discovery re-drives the reconcile.
        const repos = await getRepos();
        worktreeView?.refresh();
        const n2 = await reconcileOpenTabs(repos);
        if (n2 > 0) {
            log(`Startup reconcile (discovery): remapped ${n2} more tab(s)`);
            scheduleLanguageServerRestart();
        }
        await updateWindowTitle();
    } catch (e) {
        log(`Startup reconcile failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
        // Initial reconcile has run once — per-tab interception may now engage.
        markStartupReconcileDone();
    }
}

export function deactivate() {
    for (const w of worktreeWatchers) {
        w.dispose();
    }
    worktreeWatchers = [];
    positionCache?.dispose();
    try {
        void vscode.workspace
            .getConfiguration("window")
            .update("title", undefined, vscode.ConfigurationTarget.Workspace);
    } catch {
        // best-effort cleanup
    }
}

// ---------------------------------------------------------------------------
// Position cache: recording
// ---------------------------------------------------------------------------

/**
 * Resolve a file path to its (repo common dir, repo-relative path) cache key,
 * using the most-specific (longest) worktree root that contains it. Uses the
 * last known repo snapshot so it can run synchronously in high-frequency
 * selection/scroll handlers.
 */
function resolveCacheKey(fsPath: string): { commonDir: string; relPath: string } | null {
    let best: { commonDir: string; relPath: string; rootLen: number } | null = null;
    for (const repo of lastKnownRepos) {
        for (const w of repo.worktrees) {
            if (w.bare) {continue;}
            const rel = relPathUnder(w.path, fsPath);
            if (rel === null) {continue;}
            if (!best || w.path.length > best.rootLen) {
                best = { commonDir: repo.commonDir, relPath: rel, rootLen: w.path.length };
            }
        }
    }
    return best ? { commonDir: best.commonDir, relPath: best.relPath } : null;
}

function selectionOf(editor: vscode.TextEditor): CachedPosition["selection"] {
    const s = editor.selection;
    return {
        anchorLine: s.anchor.line,
        anchorChar: s.anchor.character,
        activeLine: s.active.line,
        activeChar: s.active.character,
    };
}

function topLineOf(editor: vscode.TextEditor): number | undefined {
    const r = editor.visibleRanges[0];
    return r ? r.start.line : undefined;
}

function recordEditorPosition(editor: vscode.TextEditor, includeTopLine: boolean): void {
    if (!positionCache) {return;}
    if (editor.document.uri.scheme !== "file") {return;}
    const key = resolveCacheKey(editor.document.uri.fsPath);
    if (!key) {return;}
    const partial: CachedPosition = { selection: selectionOf(editor) };
    if (includeTopLine) {
        const top = topLineOf(editor);
        if (top !== undefined) {partial.topLine = top;}
    }
    positionCache.record(key.commonDir, key.relPath, partial);
}

function recordEditorTopLine(editor: vscode.TextEditor): void {
    if (!positionCache) {return;}
    if (editor.document.uri.scheme !== "file") {return;}
    const top = topLineOf(editor);
    if (top === undefined) {return;}
    const key = resolveCacheKey(editor.document.uri.fsPath);
    if (!key) {return;}
    positionCache.record(key.commonDir, key.relPath, { topLine: top });
}

// ---------------------------------------------------------------------------
// Switch pipeline: carry tabs from the old worktree to the new one
// ---------------------------------------------------------------------------

function tabKey(viewColumn: number, fsPath: string): string {
    return `${viewColumn}\0${fsPath}`;
}

/**
 * Snapshot the currently open text tabs, resolve which have an equivalent file
 * in the target worktree, and produce a remap plan. Runs before the folder swap
 * (it needs the live tab state and the old root).
 */
export async function buildTabRemapPlan(
    oldRoot: string,
    newRoot: string,
    getPosition: (relPath: string) => CachedPosition | undefined
): Promise<{ plan: TabRemapPlan; tabByKey: Map<string, vscode.Tab> }> {
    const snapshots: TabSnapshot[] = [];
    const tabByKey = new Map<string, vscode.Tab>();
    const activeGroup = vscode.window.tabGroups.activeTabGroup;

    for (const group of vscode.window.tabGroups.all) {
        const col = group.viewColumn;
        group.tabs.forEach((t, idx) => {
            if (!(t.input instanceof vscode.TabInputText)) {return;}
            const uri = t.input.uri;
            if (uri.scheme !== "file") {return;}
            const fsPath = uri.fsPath;
            snapshots.push({
                path: fsPath,
                viewColumn: col,
                tabIndex: idx,
                isActiveInGroup: t.isActive,
                groupIsActive: group === activeGroup,
                isDirty: t.isDirty,
            });
            tabByKey.set(tabKey(col, fsPath), t);
        });
    }

    // Stat the candidate target paths up front so the planner stays pure.
    const targets = new Set<string>();
    for (const s of snapshots) {
        const tp = targetPathFor(oldRoot, newRoot, s.path);
        if (tp) {targets.add(tp);}
    }
    const existing = new Set<string>();
    await Promise.all(
        [...targets].map(async (tp) => {
            if (await pathExists(tp)) {existing.add(tp);}
        })
    );

    log(
        `buildTabRemapPlan: ${snapshots.length} text tab(s); ${targets.size} under oldRoot; ` +
            `${existing.size} exist in newRoot. sample=${snapshots.slice(0, 3).map((s) => s.path).join(", ")}`
    );

    const plan = planTabRemap({
        tabs: snapshots,
        oldRoot,
        newRoot,
        exists: (p) => existing.has(p),
        getPosition,
    });
    return { plan, tabByKey };
}

async function openReopenAction(action: ReopenAction, preserveFocus: boolean): Promise<void> {
    const uri = vscode.Uri.file(action.targetPath);
    const sel = action.position?.selection;
    const selection = sel
        ? new vscode.Selection(sel.anchorLine, sel.anchorChar, sel.activeLine, sel.activeChar)
        : undefined;
    try {
        const editor = await vscode.window.showTextDocument(uri, {
            viewColumn: action.viewColumn,
            preserveFocus,
            preview: false,
            selection,
        });
        // Restore scroll independently of the selection reveal. Only possible
        // while the editor is materialized (which it is, right here).
        const top = action.position?.topLine;
        if (top !== undefined) {
            editor.revealRange(new vscode.Range(top, 0, top, 0), vscode.TextEditorRevealType.AtTop);
        }
    } catch (e) {
        log(`Reopen failed for ${action.targetPath}: ${e instanceof Error ? e.message : String(e)}`);
    }
}

/**
 * Apply a remap plan. Stable-strip choreography — the tab strip peaks at N+1
 * (not 2N) and the focused editor's visible content never changes:
 *   (1) if the globally-active tab is a remapped stray, open ITS replacement
 *       first WITH focus (identical content + restored position → perceived no-op
 *       in the editor area, and focus is settled before any close);
 *   (2) batch-close ALL strays (reopened + no-target, minus dirty-skips) in one
 *       tabGroups.close call;
 *   (3) open the remaining replacements in the background (preserveFocus), in
 *       (column, tabIndex) order.
 * If the active tab isn't a stray, step (1) is skipped and focus never moves —
 * the remaining replacements just open in the background batch.
 * Remap semantics (dirty-skip, closeMissing, relative order, restored position)
 * are unchanged. The whole sequence stays inside the applyRemapDepth window so
 * every open/close reads as self/remap, not external.
 */
export async function applyTabRemap(
    plan: TabRemapPlan,
    tabByKey: Map<string, vscode.Tab>,
    cache?: { suspend(): void; resume(): void }
): Promise<void> {
    applyRemapDepth++;
    cache?.suspend();
    try {
        // (1) The replacement of the previously globally-active stray, if any.
        const focus = focusTarget(plan);
        // Remember the pre-remap active editor so, if the active tab was NOT a
        // remapped stray, we can restore focus to it (a background open of a
        // replacement still becomes the active editor, so we must put it back).
        const preActiveUri = vscode.window.activeTextEditor?.document.uri;
        if (focus) {
            await openReopenAction(focus, false);
        }

        // (2) Close all strays (reopened + no-target) in one batch. Dirty tabs
        // (plan.skipDirty) are deliberately left open.
        const toClose: vscode.Tab[] = [];
        for (const a of [...plan.reopen, ...plan.closeMissing]) {
            const t = tabByKey.get(tabKey(a.viewColumn, a.sourcePath));
            if (t) {toClose.push(t);}
        }
        if (toClose.length > 0) {
            await vscode.window.tabGroups.close(toClose, true);
        }

        // (3) Open the remaining replacements in the background, ordered by
        // (column, tabIndex). revealRange still restores scroll on a non-focused
        // editor. `focus` (if any) is already open, so skip it.
        const rest = focus ? plan.reopen.filter((a) => a !== focus) : plan.reopen;
        for (const a of orderReopens(rest)) {
            await openReopenAction(a, true);
        }

        // (4) Settle focus deterministically. Background opens above change the
        // active editor, so re-assert it exactly once: to the active stray's
        // replacement, or — if the active tab wasn't a stray — back to it.
        if (focus) {
            await openReopenAction(focus, false);
        } else if (rest.length > 0 && preActiveUri && isUriOpen(preActiveUri)) {
            try {
                await vscode.window.showTextDocument(preActiveUri, {
                    preserveFocus: false,
                    preview: false,
                });
            } catch {
                // best-effort focus restore
            }
        }
    } finally {
        cache?.resume();
        applyRemapDepth--;
    }
}

/** Whether a uri currently has an open text tab. */
function isUriOpen(uri: vscode.Uri): boolean {
    const s = uri.toString();
    for (const group of vscode.window.tabGroups.all) {
        for (const t of group.tabs) {
            if (t.input instanceof vscode.TabInputText && t.input.uri.toString() === s) {
                return true;
            }
        }
    }
    return false;
}

function summarizeDropped(plan: TabRemapPlan): string | null {
    const parts: string[] = [];
    const list = (tabs: { relPath: string }[]) => {
        const names = tabs.map((t) => t.relPath);
        const shown = names.slice(0, 5).join(", ");
        return names.length > 5 ? `${shown}, +${names.length - 5} more` : shown;
    };
    if (plan.closeMissing.length > 0) {
        parts.push(
            `${plan.closeMissing.length} tab(s) with no match in the target worktree were closed: ${list(plan.closeMissing)}`
        );
    }
    if (plan.skipDirty.length > 0) {
        parts.push(
            `${plan.skipDirty.length} unsaved tab(s) left open in the old worktree: ${list(plan.skipDirty)}`
        );
    }
    return parts.length > 0 ? parts.join(". ") : null;
}

async function switchWorktreeCommand(): Promise<void> {
    const repos = await getRepos();
    if (repos.length === 0) {
        vscode.window.showErrorMessage("No git repositories found in this workspace.");
        return;
    }

    const items = buildWorktreePickItems(repos);
    if (items.length === 0) {
        vscode.window.showErrorMessage("No worktrees found.");
        return;
    }

    const picked = await vscode.window.showQuickPick(items, {
        placeHolder: "Switch to a worktree (open tabs are carried over)",
        matchOnDescription: true,
    });
    if (!picked) {return;}

    await performSwitch(picked.repo, picked.worktree);
}

/** Handler for a click on a worktree in the tree view. */
async function switchToWorktreeCommand(node: WorktreeTreeNode | undefined): Promise<void> {
    if (!node || node.kind !== "worktree") {return;}
    if (node.isCurrent) {return;}
    await performSwitch(node.repo, node.worktree);
}

async function refreshViewCommand(): Promise<void> {
    repoCache = null;
    await getRepos(true);
    worktreeView?.refresh();
}

const ANCHOR_FOLDER_NAME = "⚓ worktrees";

/**
 * Ensure the stable anchor directory exists and return its fsPath. The anchor is
 * an (essentially empty) folder kept permanently at workspace-folder index 0 so
 * that swapping the active worktree at index 1 never changes index 0 — and thus
 * never restarts the extension host. It lives in the extension's global storage,
 * outside any repo, so language servers don't index it.
 */
async function ensureAnchorDir(): Promise<string | null> {
    if (!extensionContext) {return null;}
    const anchor = vscode.Uri.joinPath(extensionContext.globalStorageUri, "anchor");
    try {
        await vscode.workspace.fs.createDirectory(anchor);
        const readme = vscode.Uri.joinPath(anchor, "README.md");
        try {
            await vscode.workspace.fs.stat(readme);
        } catch {
            await vscode.workspace.fs.writeFile(
                readme,
                Buffer.from(
                    "# Worktree Continuity anchor\n\n" +
                        "This empty folder is pinned as the first workspace folder so that " +
                        "switching worktrees (which swaps the *second* folder) never restarts " +
                        "the extension host. You can ignore it.\n"
                )
            );
        }
    } catch (e) {
        log(`ensureAnchorDir failed: ${e instanceof Error ? e.message : String(e)}`);
        return null;
    }
    return anchor.fsPath;
}

/**
 * If a single git worktree is open as the workspace (not yet the anchor layout),
 * establish [anchor, worktree] now — on open — instead of deferring it to the
 * first switch. This is the one setup that changes folder[0] and restarts the
 * extension host; doing it during the initial load means every later switch is a
 * restart-free folder[1] swap. Returns true if it triggered the setup (a restart
 * is imminent, so callers should stop).
 */
async function ensureAnchoredLayout(): Promise<boolean> {
    const enabled = vscode.workspace
        .getConfiguration()
        .get<boolean>("worktree-continuity.anchorOnOpen", true);
    if (!enabled) {return false;}

    const folders = vscode.workspace.workspaceFolders ?? [];
    // Only auto-anchor a plain single-folder workspace; never disturb an
    // existing anchor layout or a user's own multi-root workspace.
    if (folders.length !== 1) {return false;}
    const worktree = folders[0].uri.fsPath;
    if (worktree === anchorPath()) {return false;}

    // Only anchor if the folder really is a git worktree.
    try {
        await getGitCommonDir(worktree);
    } catch {
        return false;
    }

    const anchor = await ensureAnchorDir();
    if (!anchor) {return false;}

    log(`Anchoring workspace on open: [anchor, ${worktree}] (one-time restart)`);
    vscode.workspace.updateWorkspaceFolders(
        0,
        folders.length,
        { uri: vscode.Uri.file(anchor), name: ANCHOR_FOLDER_NAME },
        { uri: vscode.Uri.file(worktree), name: path.basename(worktree) }
    );
    return true;
}

/**
 * Switch the active worktree by carrying open tabs to the equivalent files and
 * making the target worktree workspace-folder[1] (with the anchor pinned at
 * folder[0]). Swapping a non-first folder does NOT restart the extension host,
 * so Claude Code and everything else stay live. The one exception is the very
 * first switch, which must establish the [anchor, worktree] layout and therefore
 * changes folder[0] once. Shared by the palette command and the tree view.
 */
async function performSwitch(repo: RepoSnapshot, worktree: Worktree): Promise<void> {
    const newRoot = worktree.path;
    const folders = vscode.workspace.workspaceFolders ?? [];

    // Determine the worktree we're leaving. Normally it's the recorded active
    // one; on the first-ever switch (nothing recorded yet) infer it from an open
    // workspace folder that is one of this repo's worktrees, so tabs still carry.
    let oldRoot = activeWorktreePath;
    if (!oldRoot) {
        const wsPaths = new Set(folders.map((f) => f.uri.fsPath));
        oldRoot = repo.worktrees.find((w) => !w.bare && wsPaths.has(w.path))?.path ?? null;
    }

    if (oldRoot === newRoot) {
        log(`Already on ${newRoot}; nothing to switch`);
        return;
    }

    const anchor = await ensureAnchorDir();
    if (!anchor) {
        vscode.window.showErrorMessage("Worktree Continuity: could not create the anchor folder.");
        return;
    }

    const isSetUp = folders.length >= 2 && folders[0].uri.fsPath === anchor;

    const carryTabs = vscode.workspace
        .getConfiguration()
        .get<boolean>("worktree-continuity.carryTabs", true);
    const shouldCarry = carryTabs && !!oldRoot && oldRoot !== newRoot;

    log(
        `Switch: newRoot=${newRoot} oldRoot=${oldRoot ?? "<none>"} isSetUp=${isSetUp} ` +
            `shouldCarry=${shouldCarry}`
    );

    // Suspend interception across the whole critical section: while we carry tabs
    // the switch opens NEW-worktree tabs but activeWorktreePath still points at the
    // OLD root, so the interceptor would classify them as siblings and bounce them
    // back (log4.txt). Stays suspended until the active worktree is updated below.
    switchInProgress = true;
    try {
        // Carry tabs BEFORE touching workspace folders. On the one-time setup switch
        // this matters (it changes folder[0] → a restart that would kill this
        // command); on subsequent index-1 swaps there's no restart, so it's just
        // consistent ordering.
        let dropped: string | null = null;
        if (shouldCarry && oldRoot) {
            try {
                const commonDir = repo.commonDir;
                const { plan, tabByKey } = await buildTabRemapPlan(oldRoot, newRoot, (rel) =>
                    positionCache?.get(commonDir, rel)
                );
                log(
                    `Plan: reopen=${plan.reopen.length} closeMissing=${plan.closeMissing.length} ` +
                        `skipDirty=${plan.skipDirty.length}`
                );
                await applyTabRemap(plan, tabByKey, positionCache ?? undefined);
                log(`applyTabRemap complete (reopened ${plan.reopen.length} tab(s))`);
                dropped = summarizeDropped(plan);
            } catch (e) {
                log(`tab carry failed: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
            }
        }

        // Optimistically mark the target active for instant green feedback; the
        // onDidChangeWorkspaceFolders handler re-derives it authoritatively after
        // the swap (and after a setup restart, activate() derives it from folders).
        // From this point, sibling/active classification is correct again.
        activeWorktreePath = newRoot;
        worktreeView?.setActive(newRoot);
        persistActiveWorktree();
        await positionCache?.flush();

        const label = worktreeLabel(worktree);
        const base = `Switched to ${label}`;
        if (dropped) {
            vscode.window.showWarningMessage(`${base}. ${dropped}.`);
        } else {
            vscode.window.showInformationMessage(base);
        }

        const anchorEntry = { uri: vscode.Uri.file(anchor), name: ANCHOR_FOLDER_NAME };
        const worktreeEntry = { uri: vscode.Uri.file(newRoot), name: label };
        if (isSetUp) {
            // Swap only folder[1..] → the target worktree. folder[0] (anchor) stays,
            // so NO extension-host restart.
            log(`Swapping worktree at folder index 1 (expecting NO restart)`);
            vscode.workspace.updateWorkspaceFolders(1, folders.length - 1, worktreeEntry);
        } else {
            // One-time: establish [anchor, worktree]. This changes folder[0] → a
            // single restart. From here on, switches are restart-free.
            log(`Establishing [anchor, worktree] layout (one-time restart)`);
            vscode.workspace.updateWorkspaceFolders(0, folders.length, anchorEntry, worktreeEntry);
        }
    } finally {
        switchInProgress = false;
    }
}

// ---------------------------------------------------------------------------
// Below: discovery / recovery plumbing, adapted from
// tmokmss/vscode-git-worktree-switcher (MIT).
// ---------------------------------------------------------------------------

async function updateWindowTitle(): Promise<void> {
    let rootName: string | null = null;
    try {
        const repos = await getRepos();
        if (repos.length > 0) {
            rootName = repos[0].name;
        }
    } catch (e) {
        log(`updateWindowTitle: getRepos failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    if (!rootName) {
        const folders = vscode.workspace.workspaceFolders ?? [];
        if (folders.length === 0) {return;}
        rootName = path.basename(folders[0].uri.fsPath);
    }

    // Append the active worktree so the title makes the current worktree obvious.
    if (activeWorktreePath) {
        rootName = `${rootName} — ${path.basename(activeWorktreePath)}`;
    }

    const safe = rootName.replace(/\$\{/g, "$ {");
    const title = `\${dirty}\${activeEditorShort}\${separator}${safe}\${separator}\${profileName}\${separator}\${appName}`;

    try {
        await vscode.workspace
            .getConfiguration("window")
            .update("title", title, vscode.ConfigurationTarget.Workspace);
        log(`Set window.title rootName="${rootName}"`);
    } catch (e) {
        log(`Failed to set window.title: ${e instanceof Error ? e.message : String(e)}`);
    }
}

async function getRepoSnapshot(cwd: string): Promise<RepoSnapshot | undefined> {
    try {
        const [commonDir, worktrees, superproject] = await Promise.all([
            getGitCommonDir(cwd),
            listWorktrees(cwd),
            getSuperprojectPath(cwd),
        ]);
        if (superproject) {
            log(`Skipping submodule at ${cwd} (superproject=${superproject})`);
            return undefined;
        }
        const realWorktrees = await filterRealWorktrees(worktrees);
        return {
            commonDir,
            name: repoDisplayName(commonDir, realWorktrees),
            worktrees: realWorktrees,
        };
    } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        log(`getRepoSnapshot failed at ${cwd}: ${msg}`);
        return undefined;
    }
}

async function filterRealWorktrees(worktrees: Worktree[]): Promise<Worktree[]> {
    const checks = await Promise.all(
        worktrees.map(async (w) => {
            if (w.bare) {return { w, keep: true };}
            const isInsideGitDir = w.path.includes("/.git/");
            const isWorking = await isGitWorkingDir(w.path);
            const keep = !isInsideGitDir && isWorking;
            if (!keep) {
                log(`Filtered out non-working-tree worktree: ${w.path} (isInsideGitDir=${isInsideGitDir}, isWorking=${isWorking})`);
            }
            return { w, keep };
        })
    );
    return checks.filter((c) => c.keep).map((c) => c.w);
}

async function isGitWorkingDir(p: string): Promise<boolean> {
    try {
        await fs.stat(path.join(p, ".git"));
        return true;
    } catch {
        return false;
    }
}

async function findNestedRepos(start: string, maxDepth: number): Promise<string[]> {
    const found: string[] = [];

    const walk = async (dir: string, depth: number): Promise<void> => {
        if (depth > 0 && (await isGitWorkingDir(dir))) {
            found.push(dir);
            return;
        }
        if (depth >= maxDepth) {return;}

        let entries: import("node:fs").Dirent[];
        try {
            entries = await fs.readdir(dir, { withFileTypes: true });
        } catch (e: unknown) {
            log(`readdir failed: ${dir} (${e instanceof Error ? e.message : String(e)})`);
            return;
        }

        const subdirs = entries
            .filter((e) => e.isDirectory() && shouldDescendInto(e.name))
            .map((e) => path.join(dir, e.name));

        await Promise.all(subdirs.map((sub) => walk(sub, depth + 1)));
    };

    await walk(start, 0);
    return found;
}

async function getRepos(forceRefresh = false): Promise<RepoSnapshot[]> {
    if (!forceRefresh && repoCache && Date.now() - repoCache.timestamp < CACHE_TTL_MS) {
        log(`Cache hit (age=${Date.now() - repoCache.timestamp}ms, repos=${repoCache.repos.length})`);
        return repoCache.repos;
    }
    log(`Cache miss, running discovery`);
    const repos = await discoverReposFromWorkspace();
    repoCache = { repos, timestamp: Date.now() };
    if (repos.length > 0) {
        lastKnownRepos = repos;
        worktreeView?.setRepos(repos);
        persistRepos(repos);
        updateWorktreeWatchers(repos);
    }
    return repos;
}

async function pathExists(p: string): Promise<boolean> {
    try {
        await fs.stat(p);
        return true;
    } catch {
        return false;
    }
}

async function refreshCommand(): Promise<void> {
    repoCache = null;
    const t0 = Date.now();
    const repos = await getRepos(true);
    worktreeView?.refresh();
    log(`Refresh: ${repos.length} repo(s) in ${Date.now() - t0}ms`);
    vscode.window.showInformationMessage(
        `Refreshed ${repos.length} repo(s) in ${Date.now() - t0}ms`
    );
}

async function discoverReposFromWorkspace(): Promise<RepoSnapshot[]> {
    const anchor = anchorPath();
    const folders = (vscode.workspace.workspaceFolders ?? []).filter(
        (f) => f.uri.fsPath !== anchor
    );
    const t0 = Date.now();
    log(`Discovery: scanning ${folders.length} workspace folder(s) (maxDepth=${REPO_DISCOVERY_MAX_DEPTH})`);

    const perFolder = await Promise.all(
        folders.map(async (f) => {
            const direct = getRepoSnapshot(f.uri.fsPath);
            const nested = findNestedRepos(f.uri.fsPath, REPO_DISCOVERY_MAX_DEPTH);
            const [directSnap, nestedPaths] = await Promise.all([direct, nested]);
            const nestedSnaps = await Promise.all(nestedPaths.map((p) => getRepoSnapshot(p)));
            return { directSnap, nestedSnaps };
        })
    );

    const seen = new Map<string, RepoSnapshot>();
    for (const { directSnap, nestedSnaps } of perFolder) {
        if (directSnap && !seen.has(directSnap.commonDir)) {seen.set(directSnap.commonDir, directSnap);}
        for (const snap of nestedSnaps) {
            if (snap && !seen.has(snap.commonDir)) {seen.set(snap.commonDir, snap);}
        }
    }

    log(`Discovery: total ${seen.size} unique repo(s) in ${Date.now() - t0}ms`);
    return [...seen.values()];
}

type WorktreePick = {
    label: string;
    description: string;
    repo: RepoSnapshot;
    worktree: Worktree;
};

function buildWorktreePickItems(repos: RepoSnapshot[]): WorktreePick[] {
    const showRepoPrefix = repos.length > 1;
    const items: WorktreePick[] = [];
    for (const repo of repos) {
        for (const w of repo.worktrees) {
            if (w.bare) {continue;}
            const branchLabel = worktreeLabel(w);
            items.push({
                label: showRepoPrefix ? `${repo.name} / ${branchLabel}` : branchLabel,
                description: w.path,
                repo,
                worktree: w,
            });
        }
    }
    return items;
}

async function openTerminalInWorktreeCommand(): Promise<void> {
    const repos = await getRepos();
    if (repos.length === 0) {
        vscode.window.showErrorMessage("No git repositories found in this workspace.");
        return;
    }

    const items = buildWorktreePickItems(repos);
    if (items.length === 0) {
        vscode.window.showErrorMessage("No worktrees found.");
        return;
    }

    const picked = await vscode.window.showQuickPick(items, {
        placeHolder: "Open a new terminal in a worktree (workspace focus is unchanged)",
        matchOnDescription: true,
    });
    if (!picked) {return;}

    const terminal = vscode.window.createTerminal({
        name: picked.label,
        cwd: picked.worktree.path,
    });
    terminal.show();
    log(`Opened terminal in ${picked.worktree.path}`);
}

// ---------------------------------------------------------------------------
// Test-only surface. NOT part of the extension's public API — used by the
// integration harness (src/test) to drive the reactive logic deterministically
// without a live language server or GUI gestures.
// ---------------------------------------------------------------------------
export const __test = {
    reconcileOpenTabs,
    restartLanguageServers,
    scheduleLanguageServerRestart,
    interceptSiblingOpen,
    siblingWorktreeTabs,
    deriveActiveWorktree,
    getActiveWorktree(): string | null {
        return activeWorktreePath;
    },
    setActiveWorktree(p: string | null): void {
        activeWorktreePath = p;
        worktreeView?.setActive(p);
    },
    async loadReposFrom(cwd: string): Promise<RepoSnapshot[]> {
        const snap = await getRepoSnapshot(cwd);
        lastKnownRepos = snap ? [snap] : [];
        return lastKnownRepos;
    },
    resetLsRestartState(): void {
        lsRestartGen++;
        if (lsRestartTimer) {
            clearTimeout(lsRestartTimer);
            lsRestartTimer = undefined;
        }
        if (lsUnobservableTimer) {
            clearTimeout(lsUnobservableTimer);
            lsUnobservableTimer = undefined;
        }
        if (lsUnobservableResolve) {
            const r = lsUnobservableResolve;
            lsUnobservableResolve = undefined;
            r();
        }
        lsRestartInFlight = false;
        lsRestartPending = false;
    },
    /** Inject a fake readiness probe; pass undefined to restore the real one. */
    setLsReadinessProbe(fn: ((timeoutMs: number) => Promise<LsReadiness>) | undefined): void {
        lsReadyProbe = fn ?? clangdWaitForLsReady;
    },
    /** Toggle sibling-open interception (suites that need strays to persist turn it off). */
    setInterceptionEnabled(enabled: boolean): void {
        interceptSiblingOpens = enabled;
    },
    /** Simulate the switch critical section for tests (interception stands down). */
    setSwitchInProgress(value: boolean): void {
        switchInProgress = value;
    },
    /** Drive the startup-grace flag: interception is inert until this is true. */
    setStartupReconcileDone(value: boolean): void {
        startupReconcileDone = value;
    },
    interceptSiblingTabOpen,
};

