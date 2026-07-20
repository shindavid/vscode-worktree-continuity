import * as assert from "assert";
import * as path from "node:path";
import * as vscode from "vscode";
import { __test } from "../extension";
import { makeWorktreeFixture, type WorktreeFixture } from "./fixtures";

// Feature 1: opening a sibling-worktree file (e.g. Go-to-Definition landing in
// the wrong worktree) is intercepted and remapped to the active worktree's
// equivalent, at the same cursor position, with the stray tab closed.

async function waitUntil(pred: () => boolean, timeoutMs = 8000): Promise<void> {
    const start = Date.now();
    while (!pred()) {
        if (Date.now() - start > timeoutMs) {
            throw new Error("waitUntil: timed out");
        }
        await new Promise((r) => setTimeout(r, 25));
    }
}

function isOpen(fsPath: string): boolean {
    return vscode.window.tabGroups.all.some((g) =>
        g.tabs.some((t) => t.input instanceof vscode.TabInputText && t.input.uri.fsPath === fsPath)
    );
}

suite("sibling-open interception (integration)", () => {
    let fx: WorktreeFixture;

    suiteSetup(async () => {
        fx = makeWorktreeFixture();
        __test.setInterceptionEnabled(true);
        await __test.loadReposFrom(fx.featureRoot);
        __test.setActiveWorktree(fx.featureRoot);
    });

    suiteTeardown(async () => {
        await vscode.commands.executeCommand("workbench.action.closeAllEditors");
        fx.cleanup();
    });

    teardown(async () => {
        await vscode.commands.executeCommand("workbench.action.closeAllEditors");
        await waitUntil(() => vscode.window.tabGroups.all.every((g) => g.tabs.length === 0));
    });

    test("remaps a sibling open to the active worktree at the same position, closing the stray", async () => {
        const mainCpp = path.join(fx.mainRoot, "src", "greeting.cpp");
        const featCpp = path.join(fx.featureRoot, "src", "greeting.cpp");
        // Open the SIBLING (main) file with a selection, simulating a
        // Go-to-Definition landing at a specific line/col in the wrong worktree.
        const sel = new vscode.Selection(7, 2, 7, 2);

        const t0 = Date.now();
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(mainCpp));
        await vscode.window.showTextDocument(doc, { selection: sel, preview: false });
        // Drive the same handler the onDidOpenTextDocument listener invokes in
        // production. (The activated extension instance is a separate module from
        // the one under test, so we trigger the out/ instance directly — the same
        // pattern the reconcile suite uses to drive its exported functions.)
        await __test.interceptSiblingOpen(doc);

        // Interception should remap to the feature equivalent and close the stray.
        await waitUntil(() => isOpen(featCpp) && !isOpen(mainCpp), 6000);
        const latency = Date.now() - t0;
        console.log(`EVIDENCE interception latency: ${latency}ms (open → remapped)`);

        const active = vscode.window.activeTextEditor;
        assert.ok(active, "an editor is active after interception");
        assert.strictEqual(
            active!.document.uri.fsPath,
            featCpp,
            "the active editor is the feature-worktree equivalent"
        );
        assert.strictEqual(active!.selection.active.line, 7, "cursor line carried to the equivalent");
        assert.strictEqual(active!.selection.active.character, 2, "cursor column carried");
        assert.strictEqual(isOpen(mainCpp), false, "the stray main-worktree tab was closed");
    });

    test("does not intercept a file that IS in the active worktree", async () => {
        const featCpp = path.join(fx.featureRoot, "src", "greeting.cpp");
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(featCpp));
        await vscode.window.showTextDocument(doc, { preview: false });
        await waitUntil(() => isOpen(featCpp));
        // Interception must be a no-op for an active-worktree file.
        await __test.interceptSiblingOpen(doc);
        await new Promise((r) => setTimeout(r, 200));
        assert.strictEqual(isOpen(featCpp), true, "active-worktree file stays open, untouched");
    });
});
