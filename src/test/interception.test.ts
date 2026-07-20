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

function findTab(fsPath: string): vscode.Tab | undefined {
    for (const g of vscode.window.tabGroups.all) {
        for (const t of g.tabs) {
            if (t.input instanceof vscode.TabInputText && t.input.uri.fsPath === fsPath) {
                return t;
            }
        }
    }
    return undefined;
}

/** fsPaths of the text tabs in a view column, left-to-right. */
function tabsInColumn(col: vscode.ViewColumn): string[] {
    const g = vscode.window.tabGroups.all.find((gr) => gr.viewColumn === col);
    return (g?.tabs ?? [])
        .filter((t): t is vscode.Tab & { input: vscode.TabInputText } =>
            t.input instanceof vscode.TabInputText
        )
        .map((t) => t.input.uri.fsPath);
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

    setup(() => {
        // Each test starts on feature, no switch in progress, past startup grace.
        __test.setActiveWorktree(fx.featureRoot);
        __test.setSwitchInProgress(false);
        __test.setStartupReconcileDone(true);
    });

    teardown(async () => {
        __test.setSwitchInProgress(false);
        __test.setStartupReconcileDone(true);
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

    // Defect 2 (log4.txt L151): a nav into an ALREADY-LOADED sibling document
    // fires no onDidOpenTextDocument, so only a tab opens — the tab trigger must
    // catch it. Reproduce: load the doc while it's NOT a sibling (active = its own
    // worktree), then flip active and re-show it (no didOpen) and drive the tab
    // trigger the production listener uses.
    test("intercepts a nav into an already-loaded sibling document via the tab trigger", async () => {
        const mainCpp = path.join(fx.mainRoot, "src", "greeting.cpp");
        const featCpp = path.join(fx.featureRoot, "src", "greeting.cpp");

        // Load main/greeting.cpp while active = main (it is NOT a sibling then).
        __test.setActiveWorktree(fx.mainRoot);
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(mainCpp));
        await vscode.window.showTextDocument(doc, { preview: false });
        await waitUntil(() => isOpen(mainCpp));
        await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
        await waitUntil(() => !isOpen(mainCpp));

        // Flip active to feature; the doc object stays loaded, so re-showing it
        // fires NO onDidOpenTextDocument — only a tab opens.
        __test.setActiveWorktree(fx.featureRoot);
        await vscode.window.showTextDocument(doc, {
            selection: new vscode.Selection(9, 1, 9, 1),
            preview: false,
        });
        await waitUntil(() => isOpen(mainCpp));
        const tab = findTab(mainCpp);
        assert.ok(tab, "the stray main tab is open");
        // Drive the tab-open trigger (the didOpen path would NOT fire here).
        __test.interceptSiblingTabOpen({ opened: [tab!], closed: [], changed: [] });

        await waitUntil(() => isOpen(featCpp) && !isOpen(mainCpp), 6000);
        const active = vscode.window.activeTextEditor;
        assert.ok(active && active.document.uri.fsPath === featCpp, "remapped to feature equivalent");
        assert.strictEqual(active!.selection.active.line, 9, "position carried via the tab trigger");
        assert.strictEqual(isOpen(mainCpp), false, "the stray main tab was closed");
    });

    // Defect 1 (log4.txt L70–95): during a switch, activeWorktreePath still points
    // at the OLD root while the switch opens NEW-root tabs, so those look like
    // siblings. Interception must stand down for the whole critical section, then
    // resume normally.
    test("stands down during the switch critical section, then resumes", async () => {
        const mainCpp = path.join(fx.mainRoot, "src", "greeting.cpp");
        const featCpp = path.join(fx.featureRoot, "src", "greeting.cpp");

        // Inverted window: active is still OLD (main) while the switch carries a
        // NEW-root (feature) tab in. Suspension must prevent a bounce to main.
        __test.setActiveWorktree(fx.mainRoot);
        __test.setSwitchInProgress(true);
        try {
            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(featCpp));
            await vscode.window.showTextDocument(doc, { preview: false });
            await waitUntil(() => isOpen(featCpp));
            await __test.interceptSiblingOpen(doc);
            await new Promise((r) => setTimeout(r, 200));
            assert.strictEqual(isOpen(featCpp), true, "new-worktree tab left intact during switch");
            assert.strictEqual(isOpen(mainCpp), false, "no bounce back to the old worktree");
        } finally {
            __test.setSwitchInProgress(false);
        }

        // After the critical section (active now feature), a genuine sibling open
        // IS intercepted.
        await vscode.commands.executeCommand("workbench.action.closeAllEditors");
        await waitUntil(() => vscode.window.tabGroups.all.every((g) => g.tabs.length === 0));
        __test.setActiveWorktree(fx.featureRoot);
        const mDoc = await vscode.workspace.openTextDocument(vscode.Uri.file(mainCpp));
        await vscode.window.showTextDocument(mDoc, { preview: false });
        await waitUntil(() => isOpen(mainCpp));
        await __test.interceptSiblingOpen(mDoc);
        await waitUntil(() => isOpen(featCpp) && !isOpen(mainCpp), 6000);
        assert.strictEqual(isOpen(mainCpp), false, "genuine sibling open intercepted after resume");
    });

    // Startup grace: interception is inert until the initial reconcile-on-open has
    // run once, then active.
    test("is inert during startup grace and active after it completes", async () => {
        const mainCpp = path.join(fx.mainRoot, "src", "greeting.cpp");
        const featCpp = path.join(fx.featureRoot, "src", "greeting.cpp");

        // Grace window: interception must NOT fire.
        __test.setStartupReconcileDone(false);
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(mainCpp));
        await vscode.window.showTextDocument(doc, { preview: false });
        await waitUntil(() => isOpen(mainCpp));
        await __test.interceptSiblingOpen(doc);
        await new Promise((r) => setTimeout(r, 200));
        assert.strictEqual(isOpen(mainCpp), true, "stray left intact during startup grace");
        assert.strictEqual(isOpen(featCpp), false, "no remap during startup grace");

        // Grace completes: the same open is now intercepted.
        __test.setStartupReconcileDone(true);
        await __test.interceptSiblingOpen(doc);
        await waitUntil(() => isOpen(featCpp) && !isOpen(mainCpp), 6000);
        assert.strictEqual(isOpen(mainCpp), false, "intercepted once startup grace completes");
    });

    // Regression: clicking a parked stray fires didOpen while the tab is still
    // loading (before it's active), so the replacement must be moved back to the
    // clicked tab's slot instead of landing at the front of the group.
    test("remaps a parked (non-active) stray back into its original tab slot", async () => {
        const col = vscode.ViewColumn.One;
        const featH = path.join(fx.featureRoot, "src", "greeting.h"); // A: active-wt, index 0
        const mainCpp = path.join(fx.mainRoot, "src", "greeting.cpp"); // stray, index 1
        const featCpp = path.join(fx.featureRoot, "src", "greeting.cpp"); // its replacement
        const featTs = path.join(fx.featureRoot, "a.ts"); // C: active-wt, index 2

        // Open A, stray, C in order so the stray is at index 1.
        await vscode.window.showTextDocument(vscode.Uri.file(featH), { viewColumn: col, preview: false });
        const strayDoc = await vscode.workspace.openTextDocument(vscode.Uri.file(mainCpp));
        await vscode.window.showTextDocument(strayDoc, { viewColumn: col, preview: false });
        await vscode.window.showTextDocument(vscode.Uri.file(featTs), { viewColumn: col, preview: false });
        await waitUntil(() => isOpen(featH) && isOpen(mainCpp) && isOpen(featTs));

        // Focus A so the stray is NOT the active tab (the didOpen-before-active case).
        await vscode.window.showTextDocument(vscode.Uri.file(featH), { viewColumn: col, preview: false });
        await waitUntil(() => vscode.window.activeTextEditor?.document.uri.fsPath === featH);
        assert.deepStrictEqual(
            tabsInColumn(col),
            [featH, mainCpp, featTs],
            "fixture: stray sits at index 1"
        );

        await __test.interceptSiblingOpen(strayDoc);

        await waitUntil(() => isOpen(featCpp) && !isOpen(mainCpp), 6000);
        await waitUntil(() => tabsInColumn(col)[1] === featCpp);
        assert.deepStrictEqual(
            tabsInColumn(col),
            [featH, featCpp, featTs],
            "replacement landed at the stray's slot (index 1), tab order preserved"
        );
        assert.strictEqual(isOpen(mainCpp), false, "the stray tab was closed");
        assert.strictEqual(
            vscode.window.activeTextEditor?.document.uri.fsPath,
            featCpp,
            "the replacement takes focus (interception opens with focus)"
        );
    });

    // Regression (log7.txt): when interception's target is ALREADY open, focus
    // that existing tab IN PLACE — do not move it to the stray's slot.
    test("focuses an already-open target in place (no move, no new tab)", async () => {
        const col = vscode.ViewColumn.One;
        const featH = path.join(fx.featureRoot, "src", "greeting.h"); // target, ALREADY open @0
        const featTs = path.join(fx.featureRoot, "a.ts"); // active-wt tab @1 (active)
        const mainH = path.join(fx.mainRoot, "src", "greeting.h"); // sibling stray of featH

        // feature/greeting.h at index 0; feature/a.ts active at index 1.
        await vscode.window.showTextDocument(vscode.Uri.file(featH), { viewColumn: col, preview: false });
        await vscode.window.showTextDocument(vscode.Uri.file(featTs), { viewColumn: col, preview: false });
        await waitUntil(() => isOpen(featH) && isOpen(featTs));
        await waitUntil(() => vscode.window.activeTextEditor?.document.uri.fsPath === featTs);
        assert.deepStrictEqual(tabsInColumn(col), [featH, featTs], "fixture: target at index 0");

        // Navigate into the sibling stray (resolves into the wrong worktree).
        const strayDoc = await vscode.workspace.openTextDocument(vscode.Uri.file(mainH));
        await vscode.window.showTextDocument(strayDoc, { viewColumn: col, preview: false });
        await waitUntil(() => isOpen(mainH));

        await __test.interceptSiblingOpen(strayDoc);

        await waitUntil(() => !isOpen(mainH), 6000);
        // The pre-existing target stayed at index 0 (NOT yanked to the stray's
        // slot), no duplicate tab was created, and it is focused.
        assert.deepStrictEqual(
            tabsInColumn(col),
            [featH, featTs],
            "existing target stayed at index 0; stray closed; no new tab"
        );
        assert.strictEqual(tabsInColumn(col)[0], featH, "feature/greeting.h still at index 0");
        assert.strictEqual(
            vscode.window.activeTextEditor?.document.uri.fsPath,
            featH,
            "the already-open target is focused in place"
        );
    });
});
