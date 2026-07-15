import * as vscode from "vscode";
import type { Worktree } from "./git";
import { worktreeLabel, type RepoSnapshot } from "./worktrees";

export const WORKTREE_VIEW_ID = "worktreeContinuity.worktrees";
export const SWITCH_TO_WORKTREE_COMMAND = "worktree-continuity.switchToWorktree";

/** Theme color used to tint the current worktree (defined in package.json). */
const CURRENT_COLOR_ID = "worktreeContinuity.currentWorktreeForeground";

/**
 * Custom URI scheme for the current worktree's tree item. Using a non-file
 * scheme scopes the green FileDecoration to our view only — a file:// URI would
 * also color the same folder in the file explorer.
 */
const CURRENT_WORKTREE_SCHEME = "worktree-continuity";

/** Normalize a path for comparison (drop trailing separators). */
function norm(p: string | null): string | null {
    return p === null ? null : p.replace(/[/\\]+$/, "");
}

function currentWorktreeUri(worktreePath: string): vscode.Uri {
    return vscode.Uri.from({
        scheme: CURRENT_WORKTREE_SCHEME,
        authority: "current",
        path: "/" + encodeURIComponent(worktreePath),
    });
}

/**
 * Colors the current worktree's tree item green. Decorations are matched by the
 * item's resourceUri; ours use a private scheme so nothing else is affected.
 */
export class CurrentWorktreeDecorationProvider implements vscode.FileDecorationProvider {
    provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
        if (uri.scheme === CURRENT_WORKTREE_SCHEME && uri.authority === "current") {
            return {
                color: new vscode.ThemeColor(CURRENT_COLOR_ID),
                tooltip: "Current worktree",
            };
        }
        return undefined;
    }
}

type RepoNode = { kind: "repo"; repo: RepoSnapshot };
type WorktreeNode = {
    kind: "worktree";
    repo: RepoSnapshot;
    worktree: Worktree;
    isCurrent: boolean;
};
export type WorktreeTreeNode = RepoNode | WorktreeNode;

/**
 * A tree view for the Explorer sidebar that lists every worktree and lets the
 * user switch with a single click. The currently-focused worktree is marked and
 * is not itself clickable.
 */
export class WorktreeViewProvider implements vscode.TreeDataProvider<WorktreeTreeNode> {
    private readonly emitter = new vscode.EventEmitter<WorktreeTreeNode | undefined>();
    readonly onDidChangeTreeData = this.emitter.event;
    private cached: RepoSnapshot[];
    private activePath: string | null;

    /**
     * @param initial repos to render immediately (e.g. primed from persisted state).
     * @param activePath fsPath of the active worktree, marked "current"/green.
     */
    constructor(initial: RepoSnapshot[] = [], activePath: string | null = null) {
        this.cached = initial;
        this.activePath = activePath;
    }

    /** Replace the rendered repo set and re-render. */
    setRepos(repos: RepoSnapshot[]): void {
        this.cached = repos;
        this.emitter.fire(undefined);
    }

    /** Set which worktree is marked current (green) and re-render. */
    setActive(activePath: string | null): void {
        this.activePath = activePath;
        this.emitter.fire(undefined);
    }

    /** Re-render from the current cache. */
    refresh(): void {
        this.emitter.fire(undefined);
    }

    getTreeItem(node: WorktreeTreeNode): vscode.TreeItem {
        if (node.kind === "repo") {
            const item = new vscode.TreeItem(
                node.repo.name,
                vscode.TreeItemCollapsibleState.Expanded
            );
            item.iconPath = new vscode.ThemeIcon("repo");
            item.contextValue = "repo";
            return item;
        }

        const { worktree, isCurrent } = node;
        const item = new vscode.TreeItem(worktreeLabel(worktree), vscode.TreeItemCollapsibleState.None);
        item.description = isCurrent ? "current" : undefined;
        item.tooltip = isCurrent
            ? `${worktree.path} (current)`
            : `Switch to ${worktree.path} (carries open tabs)`;
        item.contextValue = isCurrent ? "worktree-current" : "worktree";
        if (isCurrent) {
            // resourceUri drives the green FileDecoration on the label; the icon
            // is tinted with the same theme color.
            item.resourceUri = currentWorktreeUri(worktree.path);
            item.iconPath = new vscode.ThemeIcon("check", new vscode.ThemeColor(CURRENT_COLOR_ID));
        } else {
            item.iconPath = new vscode.ThemeIcon("git-branch");
            item.command = {
                command: SWITCH_TO_WORKTREE_COMMAND,
                title: "Switch Worktree",
                arguments: [node],
            };
        }
        return item;
    }

    getChildren(element?: WorktreeTreeNode): WorktreeTreeNode[] {
        if (element) {
            if (element.kind === "repo") {
                return this.worktreeNodes([element.repo]);
            }
            return [];
        }

        const withWorktrees = this.cached.filter((r) => r.worktrees.some((w) => !w.bare));
        // Empty → return nothing so the declarative viewsWelcome content shows
        // (that content also renders during the ext-host restart on a switch,
        // when no provider is registered at all).
        if (withWorktrees.length === 0) {
            return [];
        }
        if (withWorktrees.length === 1) {
            return this.worktreeNodes(withWorktrees);
        }
        return withWorktrees.map((repo) => ({ kind: "repo", repo }));
    }

    private worktreeNodes(repos: RepoSnapshot[]): WorktreeNode[] {
        const active = norm(this.activePath);
        const nodes: WorktreeNode[] = [];
        for (const repo of repos) {
            for (const worktree of repo.worktrees) {
                if (worktree.bare) {continue;}
                nodes.push({
                    kind: "worktree",
                    repo,
                    worktree,
                    isCurrent: active !== null && norm(worktree.path) === active,
                });
            }
        }
        return nodes;
    }
}
