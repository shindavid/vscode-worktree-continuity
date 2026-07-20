import * as assert from "assert";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { LspClient, type LspLocation, uriToPath } from "./lspClient";
import {
    type CppWorktreeFixture,
    makeCppWorktreeFixture,
    removeCompileCommands,
    writeCompileCommands,
} from "./fixtures";

// Evidence-gathering harness: does killing+respawning clangd (what
// vscode-clangd's `clangd.restart` does) re-scope Go-to-Definition to the active
// git worktree, or does it keep resolving into the previous worktree's copy?
// Every scenario logs a greppable `EVIDENCE <name>: ...` line. Only baseline-main
// asserts (it validates the harness itself); the rest just log raw evidence.

const SUITE_TIMEOUT_MS = 60000;

function resolveClangd(): string {
    if (fs.existsSync("/usr/bin/clangd")) {
        return "/usr/bin/clangd";
    }
    try {
        const found = execFileSync("which", ["clangd"], { stdio: "pipe" }).toString().trim();
        if (found) {
            return found;
        }
    } catch {
        // fall through to throw
    }
    throw new Error(
        "clangd not found: expected /usr/bin/clangd or a `clangd` on PATH. " +
            "Install clangd (e.g. `apt-get install clangd-17`) to run the clangd-scope evidence suite."
    );
}

function isUnder(p: string, root: string): boolean {
    return p === root || p.startsWith(root + path.sep);
}

function cachePath(root: string): string {
    return path.join(root, ".cache", "clangd");
}

function wipeCache(root: string): void {
    fs.rmSync(cachePath(root), { recursive: true, force: true });
}

suite("clangd worktree re-scope (evidence)", function () {
    this.timeout(SUITE_TIMEOUT_MS);

    let clangd: string;
    let fx: CppWorktreeFixture;
    const live: LspClient[] = [];

    function spawnClient(extraArgs: string[] = []): LspClient {
        const client = LspClient.spawn({
            binary: clangd,
            args: ["--background-index", ...extraArgs],
            cwd: fx.anchor,
        });
        live.push(client);
        return client;
    }

    function classify(uri: string): "main" | "feature" | "other" {
        const p = uriToPath(uri);
        if (isUnder(p, fx.mainRoot)) {
            return "main";
        }
        if (isUnder(p, fx.featureRoot)) {
            return "feature";
        }
        return "other";
    }

    function logEvidence(scenario: string, locations: LspLocation[]): string {
        if (locations.length === 0) {
            console.log(`EVIDENCE ${scenario}: definition -> [] (worktree: none)`);
            return "none";
        }
        const uris = locations.map((l) => l.uri);
        const classes = uris.map(classify);
        const uniq = [...new Set(classes)];
        const wt = uniq.length === 1 ? uniq[0] : uniq.join("+");
        console.log(`EVIDENCE ${scenario}: definition -> ${uris.join(", ")} (worktree: ${wt})`);
        return wt;
    }

    function logProgress(scenario: string, client: LspClient): void {
        const bg = client.sawBackgroundIndexProgress;
        const kinds = client.progressEvents.map((e) => `${e.token}:${e.kind}`).join(" ");
        console.log(
            `EVIDENCE ${scenario}: backgroundIndexProgress observed=${bg} events=[${kinds}]`
        );
    }

    function logStderr(scenario: string, client: LspClient, re: RegExp, max = 6): void {
        const lines = client.stderr
            .split("\n")
            .filter((l) => re.test(l))
            .slice(0, max);
        if (lines.length === 0) {
            console.log(`EVIDENCE ${scenario}: stderr /${re.source}/ -> <none>`);
            return;
        }
        for (const l of lines) {
            console.log(`EVIDENCE ${scenario}: stderr | ${l.trim()}`);
        }
    }

    // Assert which worktree Go-to-Definition landed in, with a loud, informative
    // message. Returns the classified worktree string.
    function assertLandedIn(
        wt: string,
        locations: LspLocation[],
        expected: "main" | "feature",
        note: string
    ): void {
        assert.strictEqual(
            wt,
            expected,
            `Go-to-Definition landed in "${wt}" but expected "${expected}". ${note} ` +
                `URIs: ${locations.map((l) => l.uri).join(", ") || "<none>"}`
        );
    }

    // Assert the resolved definition file's basename (e.g. distinguishing the
    // cross-TU .cpp definition from the .h declaration).
    function assertDefFile(locations: LspLocation[], basename: string, note: string): void {
        const uris = locations.map((l) => l.uri);
        assert.ok(
            uris.some((u) => u.endsWith(`/src/${basename}`)),
            `Expected the definition at src/${basename}. ${note} URIs: ${uris.join(", ") || "<none>"}`
        );
    }

    // Warm a fresh clangd on main: spawn (cwd=anchor, folders=[anchor, main]),
    // open main/use.cpp, wait for the background index, and confirm the call
    // resolves. Returns the live client and the definition locations.
    async function warmOnMain(
        extraArgs: string[] = []
    ): Promise<{ client: LspClient; locations: LspLocation[] }> {
        const client = spawnClient(extraArgs);
        await client.initialize(fx.anchor, fx.mainRoot);
        const useCpp = path.join(fx.mainRoot, fx.useCppRelPath);
        client.didOpen(useCpp);
        await client.waitForBackgroundIndexDone();
        const locations = await client.definition(useCpp, fx.callSite);
        return { client, locations };
    }

    suiteSetup(function () {
        clangd = resolveClangd();
        console.log(`EVIDENCE setup: clangd = ${clangd}`);
        try {
            const v = execFileSync(clangd, ["--version"], { stdio: "pipe" }).toString().trim();
            console.log(`EVIDENCE setup: ${v.split("\n")[0]}`);
        } catch {
            // non-fatal
        }
        fx = makeCppWorktreeFixture();
        console.log(
            `EVIDENCE setup: callSite line=${fx.callSite.line} char=${fx.callSite.character}`
        );
    });

    suiteTeardown(function () {
        for (const c of live) {
            c.kill();
        }
        fx.cleanup();
    });

    teardown(function () {
        // Hard-kill any clients the finished test left alive. Scenarios that need
        // a graceful shutdown do it inline; cleanup only needs to reap processes.
        for (const c of live.splice(0)) {
            c.kill();
        }
    });

    // A -----------------------------------------------------------------------
    test("baseline-main: warm on main resolves under mainRoot (harness sanity)", async function () {
        wipeCache(fx.mainRoot);
        wipeCache(fx.featureRoot);
        const { client, locations } = await warmOnMain();
        logProgress("baseline-main", client);
        const wt = logEvidence("baseline-main", locations);
        assert.strictEqual(locations.length, 1, `expected exactly 1 definition, got ${locations.length}`);
        assert.strictEqual(wt, "main", `expected definition under mainRoot, got ${wt}`);
    });

    // B -----------------------------------------------------------------------
    test("switch-no-restart: same session, then open feature/use.cpp", async function () {
        wipeCache(fx.mainRoot);
        wipeCache(fx.featureRoot);
        const { client } = await warmOnMain();
        // Same clangd session: now open the FEATURE copy and ask there.
        const featUse = path.join(fx.featureRoot, fx.useCppRelPath);
        client.didOpen(featUse);
        await client.waitForBackgroundIndexDone(10000);
        const locations = await client.definition(featUse, fx.callSite);
        logProgress("switch-no-restart", client);
        const wt = logEvidence("switch-no-restart", locations);
        // Regression guard: with only compile_flags.txt (no cross-TU index),
        // include/preamble resolution follows the open file's own worktree.
        assertLandedIn(wt, locations, "feature", "Include/preamble resolution should follow the open file.");
    });

    // C -----------------------------------------------------------------------
    test("switch-with-restart: kill main-scoped clangd, respawn scoped to feature (NO cache wipe)", async function () {
        // Wipe ONLY before the warm phase; the restart itself keeps on-disk cache.
        wipeCache(fx.mainRoot);
        wipeCache(fx.featureRoot);

        const warm = await warmOnMain();
        logEvidence("switch-with-restart(warm)", warm.locations);
        // Emulate clangd.restart: graceful shutdown + hard kill. NO cache wipe.
        await warm.client.shutdown();
        warm.client.kill();

        const featClient = spawnClient();
        await featClient.initialize(fx.anchor, fx.featureRoot);
        const featUse = path.join(fx.featureRoot, fx.useCppRelPath);
        featClient.didOpen(featUse);
        await featClient.waitForBackgroundIndexDone();
        const locations = await featClient.definition(featUse, fx.callSite);
        logProgress("switch-with-restart", featClient);
        const wt = logEvidence("switch-with-restart", locations);
        // Regression guard: kill+respawn re-scopes to the active worktree in
        // compile_flags.txt mode.
        assertLandedIn(wt, locations, "feature", "Restart should re-scope to the active worktree.");

        const mainCache = fs.existsSync(cachePath(fx.mainRoot));
        const featCache = fs.existsSync(cachePath(fx.featureRoot));
        console.log(
            `EVIDENCE switch-with-restart: .cache/clangd main=${mainCache} feature=${featCache}`
        );
    });

    // D -----------------------------------------------------------------------
    test("feature-missing-markers: feature has no compile_flags.txt", async function () {
        wipeCache(fx.mainRoot);
        wipeCache(fx.featureRoot);
        const featFlags = path.join(fx.featureRoot, "compile_flags.txt");
        const hadFlags = fs.existsSync(featFlags);
        const savedFlags = hadFlags ? fs.readFileSync(featFlags, "utf8") : null;
        // Remove the marker from the WORKING TREE only (main keeps its own).
        fs.rmSync(featFlags, { force: true });
        try {
            const warm = await warmOnMain();
            logEvidence("feature-missing-markers(warm)", warm.locations);
            await warm.client.shutdown();
            warm.client.kill();

            const featClient = spawnClient();
            await featClient.initialize(fx.anchor, fx.featureRoot);
            const featUse = path.join(fx.featureRoot, fx.useCppRelPath);
            featClient.didOpen(featUse);
            await featClient.waitForBackgroundIndexDone();
            const locations = await featClient.definition(featUse, fx.callSite);
            logProgress("feature-missing-markers", featClient);
            const wt = logEvidence("feature-missing-markers", locations);
            logStderr("feature-missing-markers", featClient, /compile|flags|database/i);
            // Regression guard: with no markers clangd falls back to in-tree
            // parsing and resolves within the active worktree (header decl).
            assertLandedIn(wt, locations, "feature", "No-marker fallback should stay in the active worktree.");
        } finally {
            // Restore the working-tree marker for later scenarios.
            if (savedFlags !== null) {
                fs.writeFileSync(featFlags, savedFlags);
            }
        }
    });

    // E (last: pins compile_commands.json into mainRoot) ----------------------
    test("pinned-compile-commands-dir: --compile-commands-dir=mainRoot survives restart", async function () {
        wipeCache(fx.mainRoot);
        wipeCache(fx.featureRoot);
        writeCompileCommands(fx.mainRoot);
        try {
            const pin = [`--compile-commands-dir=${fx.mainRoot}`];
            const warm = await warmOnMain(pin);
            logEvidence("pinned-compile-commands-dir(warm)", warm.locations);
            await warm.client.shutdown();
            warm.client.kill();

            const featClient = spawnClient(pin);
            await featClient.initialize(fx.anchor, fx.featureRoot);
            const featUse = path.join(fx.featureRoot, fx.useCppRelPath);
            featClient.didOpen(featUse);
            await featClient.waitForBackgroundIndexDone();
            const locations = await featClient.definition(featUse, fx.callSite);
            logProgress("pinned-compile-commands-dir", featClient);
            const wt = logEvidence("pinned-compile-commands-dir", locations);
            logStderr("pinned-compile-commands-dir", featClient, /compile|flags|database/i);
            // Documents known clangd failure mode: a pinned --compile-commands-dir
            // defeats restart re-scoping (README anti-pattern). Lands in MAIN.
            assertLandedIn(wt, locations, "main", "Pinned --compile-commands-dir is the documented anti-pattern.");
        } finally {
            removeCompileCommands(fx.mainRoot);
        }
    });

    // F1 ----------------------------------------------------------------------
    // Real compile_commands.json in BOTH worktrees, ONE session, no restart.
    // Exercises the cross-TU index path (unlike A-D, which only did preamble
    // resolution to the header declaration).
    test("cdb-both-no-restart: CDB in both, same session, open feature/use.cpp", async function () {
        wipeCache(fx.mainRoot);
        wipeCache(fx.featureRoot);
        writeCompileCommands(fx.mainRoot);
        writeCompileCommands(fx.featureRoot);
        try {
            const { client, locations: warmLoc } = await warmOnMain();
            const warmWt = logEvidence("cdb-both-no-restart(warm)", warmLoc);
            logProgress("cdb-both-no-restart(warm)", client);
            // Harness sanity: warm def must hit main's cross-TU .cpp definition.
            assertLandedIn(warmWt, warmLoc, "main", "Warm session should resolve main's own definition.");
            assertDefFile(warmLoc, "greeting.cpp", "Warm session should hit the cross-TU definition.");

            const cyclesBefore = client.backgroundIndexCycles;
            const featUse = path.join(fx.featureRoot, fx.useCppRelPath);
            client.resetBackgroundWait();
            client.didOpen(featUse);
            await client.waitForBackgroundIndexDone(10000);
            const secondCycle = client.backgroundIndexCycles > cyclesBefore;
            const locations = await client.definition(featUse, fx.callSite);
            const wt = logEvidence("cdb-both-no-restart", locations);
            logProgress("cdb-both-no-restart", client);
            console.log(
                `EVIDENCE cdb-both-no-restart: second bg-index cycle after feature didOpen=${secondCycle}`
            );
            // Documents the wrong-worktree bug mechanism: a shared session with a
            // warmed index answers an identical-USR cross-TU query with a TU-level
            // .cpp definition (not the header decl). Which worktree wins is a
            // NON-DETERMINISTIC tie-break between the two byte-identical greeting.cpp
            // copies (measured ~60% main / ~40% feature over 10 runs), so we assert
            // only the deterministic mechanism and log the worktree as evidence.
            assert.strictEqual(locations.length, 1, `expected exactly 1 location, got ${locations.length}`);
            assertDefFile(locations, "greeting.cpp", "Shared warmed index should answer with a cross-TU definition.");
            console.log(
                `EVIDENCE cdb-both-no-restart: cross-TU tie-break landed in ${wt} ` +
                    `(non-deterministic; can be the WRONG worktree 'main')`
            );
        } finally {
            removeCompileCommands(fx.mainRoot);
            removeCompileCommands(fx.featureRoot);
        }
    });

    // F2 (core question) ------------------------------------------------------
    // CDBs in both. Warm on main, kill, respawn scoped to feature. NO cache wipe
    // between warm and post-restart (real restarts keep on-disk cache).
    test("cdb-both-with-restart: CDB in both, kill main-scoped, respawn feature-scoped", async function () {
        wipeCache(fx.mainRoot);
        wipeCache(fx.featureRoot);
        writeCompileCommands(fx.mainRoot);
        writeCompileCommands(fx.featureRoot);
        try {
            const warm = await warmOnMain();
            const warmWt = logEvidence("cdb-both-with-restart(warm)", warm.locations);
            logProgress("cdb-both-with-restart(warm)", warm.client);
            assertLandedIn(warmWt, warm.locations, "main", "Warm session should resolve main.");
            await warm.client.shutdown();
            warm.client.kill();

            const featClient = spawnClient();
            await featClient.initialize(fx.anchor, fx.featureRoot);
            const featUse = path.join(fx.featureRoot, fx.useCppRelPath);
            featClient.didOpen(featUse);
            await featClient.waitForBackgroundIndexDone();
            const locations = await featClient.definition(featUse, fx.callSite);
            const wt = logEvidence("cdb-both-with-restart", locations);
            logProgress("cdb-both-with-restart", featClient);
            logStderr("cdb-both-with-restart", featClient, /compile|flags|database/i);
            // THE core regression guard: kill+respawn re-scopes to the active
            // worktree when it has its own CDB, resolving the cross-TU .cpp
            // definition (not the header declaration) in the correct worktree.
            assertLandedIn(wt, locations, "feature", "Restart must re-scope to the active worktree.");
            assertDefFile(locations, "greeting.cpp", "Restart must resolve the cross-TU definition.");

            const mainCache = fs.existsSync(cachePath(fx.mainRoot));
            const featCache = fs.existsSync(cachePath(fx.featureRoot));
            console.log(
                `EVIDENCE cdb-both-with-restart: .cache/clangd main=${mainCache} feature=${featCache}`
            );
        } finally {
            removeCompileCommands(fx.mainRoot);
            removeCompileCommands(fx.featureRoot);
        }
    });

    // D2 (bug-report hypothesis 1) --------------------------------------------
    // CDB in main ONLY, and feature has NO project markers at all (also delete
    // feature's compile_flags.txt from the working tree). Two probes: same
    // session, then after a feature-scoped restart.
    test("cdb-main-only: main has CDB, feature has no markers", async function () {
        wipeCache(fx.mainRoot);
        wipeCache(fx.featureRoot);
        const featFlags = path.join(fx.featureRoot, "compile_flags.txt");
        const savedFlags = fs.existsSync(featFlags) ? fs.readFileSync(featFlags, "utf8") : null;
        fs.rmSync(featFlags, { force: true });
        writeCompileCommands(fx.mainRoot);
        try {
            const { client, locations: warmLoc } = await warmOnMain();
            const warmWt = logEvidence("cdb-main-only(warm)", warmLoc);
            logProgress("cdb-main-only(warm)", client);
            assertLandedIn(warmWt, warmLoc, "main", "Warm session should resolve main.");

            // Probe 1: SAME session, open feature/use.cpp.
            const featUse = path.join(fx.featureRoot, fx.useCppRelPath);
            client.resetBackgroundWait();
            client.didOpen(featUse);
            await client.waitForBackgroundIndexDone(10000);
            const probe1 = await client.definition(featUse, fx.callSite);
            const probe1Wt = logEvidence("cdb-main-only(probe1-no-restart)", probe1);
            logStderr("cdb-main-only(probe1)", client, /compile|flags|database/i);
            // Documents failure mode: feature has no CDB, so a warmed shared
            // session answers the query from main's already-indexed TU.
            assertLandedIn(probe1Wt, probe1, "main", "No-restart shared session resolves via main's index.");
            await client.shutdown();
            client.kill();

            // Probe 2: restart scoped to feature, then def.
            const featClient = spawnClient();
            await featClient.initialize(fx.anchor, fx.featureRoot);
            featClient.didOpen(featUse);
            await featClient.waitForBackgroundIndexDone();
            const probe2 = await featClient.definition(featUse, fx.callSite);
            const probe2Wt = logEvidence("cdb-main-only(probe2-with-restart)", probe2);
            logProgress("cdb-main-only(probe2)", featClient);
            logStderr("cdb-main-only(probe2)", featClient, /compile|flags|database/i);
            // Regression guard: restart fixes worktree scope even with no markers,
            // degraded to the header declaration (feature/src/greeting.h).
            assertLandedIn(probe2Wt, probe2, "feature", "Restart must re-scope even without markers.");
            assertDefFile(probe2, "greeting.h", "No-marker restart degrades to the header declaration.");

            const mainCache = fs.existsSync(cachePath(fx.mainRoot));
            const featCache = fs.existsSync(cachePath(fx.featureRoot));
            console.log(
                `EVIDENCE cdb-main-only: .cache/clangd main=${mainCache} feature=${featCache}`
            );
        } finally {
            removeCompileCommands(fx.mainRoot);
            if (savedFlags !== null) {
                fs.writeFileSync(featFlags, savedFlags);
            }
        }
    });
});
