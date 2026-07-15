import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { getGitCommonDir, getSuperprojectPath, listWorktrees, type Worktree } from "./git";
import { PositionCache } from "./positionCache";
import {
    orderColumnReopens,
    planTabRemap,
    relPathUnder,
    targetPathFor,
    type CachedPosition,
    type ReopenAction,
    type TabRemapPlan,
    type TabSnapshot,
} from "./tabmap";
import {
    repoDisplayName,
    shouldDescendInto,
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

const PRIMED_REPOS_KEY = "worktree-continuity.lastRepos.v1";

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
    void updateWindowTitle();
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
    activeWorktreePath = deriveActiveWorktree();
    worktreeView = new WorktreeViewProvider(loadPrimedRepos(context), activeWorktreePath);
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
        vscode.workspace.onDidChangeWorkspaceFolders(async () => {
            log(`Workspace folders changed`);
            repoCache = null;
            refreshActiveFromFolders();
            await getRepos(true);
        }),
        // Position-cache feeders. These run continuously so background tabs
        // (which have no live TextEditor at switch time) still have a recorded
        // position to restore.
        vscode.window.onDidChangeActiveTextEditor((editor) => {
            if (editor) {recordEditorPosition(editor, true);}
        }),
        vscode.window.onDidChangeTextEditorSelection((e) => {
            recordEditorPosition(e.textEditor, false);
        }),
        vscode.window.onDidChangeTextEditorVisibleRanges((e) => {
            recordEditorTopLine(e.textEditor);
        }),
        { dispose: () => positionCache?.dispose() }
    );

    setTimeout(async () => {
        try {
            await getRepos();
            worktreeView?.refresh();
            await updateWindowTitle();
        } catch (e) {
            log(`Pre-warm failed: ${e instanceof Error ? e.message : String(e)}`);
        }
    }, 100);
}

export function deactivate() {
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
    return `${viewColumn} ${fsPath}`;
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
 * Apply a remap plan: close the resolved old-worktree tabs, then reopen the
 * equivalent files in the new worktree, restoring per-tab position and focus.
 */
export async function applyTabRemap(
    plan: TabRemapPlan,
    tabByKey: Map<string, vscode.Tab>,
    cache?: { suspend(): void; resume(): void }
): Promise<void> {
    cache?.suspend();
    try {
        // Close the tabs we're going to reopen and the ones with no target.
        // Dirty tabs (plan.skipDirty) are deliberately left open.
        const toClose: vscode.Tab[] = [];
        for (const a of [...plan.reopen, ...plan.closeMissing]) {
            const t = tabByKey.get(tabKey(a.viewColumn, a.sourcePath));
            if (t) {toClose.push(t);}
        }
        if (toClose.length > 0) {
            await vscode.window.tabGroups.close(toClose, true);
        }

        // Reopen per column: background tabs first (each materializes and
        // captures its cached position), the group's active tab last. The one
        // globally-focused tab is opened at the very end without preserveFocus.
        const byColumn = new Map<number, ReopenAction[]>();
        for (const a of plan.reopen) {
            const arr = byColumn.get(a.viewColumn) ?? [];
            arr.push(a);
            byColumn.set(a.viewColumn, arr);
        }

        let focusAction: ReopenAction | undefined;
        for (const [, actions] of byColumn) {
            for (const a of orderColumnReopens(actions)) {
                if (a.focusGlobally) {
                    focusAction = a;
                    continue; // opened last, below
                }
                await openReopenAction(a, true);
            }
        }
        if (focusAction) {
            await openReopenAction(focusAction, false);
        }
    } finally {
        cache?.resume();
    }
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
    activeWorktreePath = newRoot;
    worktreeView?.setActive(newRoot);
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
    const folders = vscode.workspace.workspaceFolders ?? [];
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

