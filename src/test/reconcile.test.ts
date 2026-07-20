import * as assert from "assert";
import * as path from "node:path";
import * as vscode from "vscode";
import { __test } from "../extension";
import { makeWorktreeFixture, type WorktreeFixture } from "./fixtures";

const LS_CMD = "worktree-continuity.test.lsRestart";

async function waitUntil(pred: () => boolean, timeoutMs = 8000): Promise<void> {
    const start = Date.now();
    while (!pred()) {
        if (Date.now() - start > timeoutMs) {
            throw new Error("waitUntil: timed out");
        }
        await new Promise((r) => setTimeout(r, 25));
    }
}

function openTabPaths(): string[] {
    const out: string[] = [];
    for (const g of vscode.window.tabGroups.all) {
        for (const t of g.tabs) {
            if (t.input instanceof vscode.TabInputText) {
                out.push(t.input.uri.fsPath);
            }
        }
    }
    return out;
}
const isOpen = (p: string): boolean => openTabPaths().includes(p);

suite("reconcile + language-server restart (integration)", () => {
    let fx: WorktreeFixture;
    let lsRestartCount = 0;
    let cmdReg: vscode.Disposable;

    suiteSetup(async () => {
        fx = makeWorktreeFixture();
        // This suite deliberately opens sibling-worktree tabs and expects them to
        // persist; Feature 1 interception would remap them away, so turn it off
        // here (the dedicated interception suite turns it back on).
        __test.setInterceptionEnabled(false);
        cmdReg = vscode.commands.registerCommand(LS_CMD, () => {
            lsRestartCount++;
        });
        await vscode.workspace
            .getConfiguration()
            .update(
                "worktree-continuity.languageServerRestartCommands",
                [LS_CMD],
                vscode.ConfigurationTarget.Global
            );
    });

    suiteTeardown(async () => {
        __test.setInterceptionEnabled(true);
        cmdReg.dispose();
        await vscode.workspace
            .getConfiguration()
            .update(
                "worktree-continuity.languageServerRestartCommands",
                undefined,
                vscode.ConfigurationTarget.Global
            );
        await vscode.commands.executeCommand("workbench.action.closeAllEditors");
        fx.cleanup();
    });

    setup(async () => {
        await __test.loadReposFrom(fx.featureRoot);
        __test.setActiveWorktree(fx.featureRoot);
        lsRestartCount = 0;
        __test.resetLsRestartState();
    });

    teardown(async () => {
        await vscode.commands.executeCommand("workbench.action.closeAllEditors");
        await waitUntil(() => vscode.window.tabGroups.all.every((g) => g.tabs.length === 0));
    });

    test("a sibling-worktree tab (simulated cross-worktree navigation) is detected", async () => {
        const mainCpp = path.join(fx.mainRoot, "src", "greeting.cpp");
        await vscode.window.showTextDocument(vscode.Uri.file(mainCpp), { preview: false });
        await waitUntil(() => isOpen(mainCpp));
        const sib = __test.siblingWorktreeTabs();
        assert.strictEqual(sib.length, 1, "the main-worktree tab is a sibling of active feature");
        assert.strictEqual(sib[0].path, mainCpp);
    });

    test("reconcile remaps a sibling tab to the active worktree exactly once, leaving none", async () => {
        const mainCpp = path.join(fx.mainRoot, "src", "greeting.cpp");
        const featCpp = path.join(fx.featureRoot, "src", "greeting.cpp");
        await vscode.window.showTextDocument(vscode.Uri.file(mainCpp), { preview: false });
        await waitUntil(() => isOpen(mainCpp));

        const repos = await __test.loadReposFrom(fx.featureRoot);
        const remapped = await __test.reconcileOpenTabs(repos);

        assert.strictEqual(remapped, 1, "exactly one tab remapped");
        await waitUntil(() => !isOpen(mainCpp) && isOpen(featCpp));
        assert.strictEqual(
            __test.siblingWorktreeTabs().length,
            0,
            "no sibling tabs remain after reconcile"
        );
    });

    test("snapshot-primed reconcile converges: a second pass over fresh discovery remaps 0", async () => {
        const mainCpp = path.join(fx.mainRoot, "src", "greeting.cpp");
        const featCpp = path.join(fx.featureRoot, "src", "greeting.cpp");
        await vscode.window.showTextDocument(vscode.Uri.file(mainCpp), { preview: false });
        await waitUntil(() => isOpen(mainCpp));

        // Pass 1: driven from the persisted snapshot (loadReposFrom stands in for
        // the primed snapshot — no discovery on the critical path).
        const snapshot = await __test.loadReposFrom(fx.featureRoot);
        const n1 = await __test.reconcileOpenTabs(snapshot);
        assert.strictEqual(n1, 1, "snapshot pass remaps the one stray");
        await waitUntil(() => !isOpen(mainCpp) && isOpen(featCpp));

        // Pass 2: authoritative discovery re-drives reconcile — must find 0 strays
        // (idempotent convergence), so no double-remap / churn.
        const fresh = await __test.loadReposFrom(fx.featureRoot);
        const n2 = await __test.reconcileOpenTabs(fresh);
        assert.strictEqual(n2, 0, "discovery pass finds nothing left to remap");
        assert.strictEqual(__test.siblingWorktreeTabs().length, 0, "no sibling tabs remain");
    });

    test("restartLanguageServers runs each configured, registered command once", async () => {
        await __test.restartLanguageServers();
        assert.strictEqual(lsRestartCount, 1, "the fake LS restart command ran exactly once");
    });

    test("scheduleLanguageServerRestart coalesces rapid triggers into a single restart", async () => {
        __test.scheduleLanguageServerRestart();
        __test.scheduleLanguageServerRestart();
        __test.scheduleLanguageServerRestart();
        await waitUntil(() => lsRestartCount >= 1, 8000);
        await new Promise((r) => setTimeout(r, 1500));
        assert.strictEqual(lsRestartCount, 1, "debounce + min-gap collapse the burst to one restart");
    });

    test("readiness gate: a trigger during an in-flight restart fires exactly one follow-up", async () => {
        // Fake readiness probe we resolve by hand, so the restart stays "in
        // flight" until we say the server is ready.
        let probeCalls = 0;
        let resolveReady: ((v: "ready" | "timeout" | "unobservable") => void) | undefined;
        __test.setLsReadinessProbe(
            () =>
                new Promise((r) => {
                    probeCalls++;
                    resolveReady = r;
                })
        );
        try {
            __test.resetLsRestartState();
            lsRestartCount = 0;

            // First trigger → after debounce, one restart runs, then blocks on
            // readiness (held unresolved).
            __test.scheduleLanguageServerRestart();
            await waitUntil(() => lsRestartCount === 1, 4000);
            await waitUntil(() => probeCalls === 1, 2000);

            // A trigger while in flight must NOT run another restart yet.
            __test.scheduleLanguageServerRestart();
            await new Promise((r) => setTimeout(r, 800));
            assert.strictEqual(lsRestartCount, 1, "no extra restart while readiness is unresolved");

            // Readiness resolves → the pending trigger runs exactly one more restart.
            resolveReady!("ready");
            await waitUntil(() => lsRestartCount === 2, 4000);
            await waitUntil(() => probeCalls === 2, 2000);

            // Let the second cycle settle; assert it did not spawn a third.
            resolveReady!("ready");
            await new Promise((r) => setTimeout(r, 800));
            assert.strictEqual(lsRestartCount, 2, "pending restart fired exactly once");
        } finally {
            __test.setLsReadinessProbe(undefined);
            __test.resetLsRestartState();
        }
    });
});
