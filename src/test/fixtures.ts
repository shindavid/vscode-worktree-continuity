import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface WorktreeFixture {
    dir: string;
    mainRoot: string;
    featureRoot: string;
    cleanup(): void;
}

const FILE_LINES = 200;
const body = (name: string): string =>
    Array.from({ length: FILE_LINES }, (_, i) => `// ${name} line ${i}`).join("\n") + "\n";

/**
 * Build a temp git repo with a `main` worktree and an added `feature` worktree,
 * both containing the same src/greeting.h, src/greeting.cpp, and a.ts (committed
 * on main, so `feature` checks out identical copies). Mirrors the wt-demo setup
 * used to reproduce wrong-worktree Go-to-Definition.
 */
export function makeWorktreeFixture(): WorktreeFixture {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wtc-fix-"));
    const mainRoot = path.join(dir, "main");
    const git = (args: string[]): void => {
        execFileSync("git", args, { cwd: mainRoot, stdio: "pipe" });
    };
    fs.mkdirSync(path.join(mainRoot, "src"), { recursive: true });
    fs.writeFileSync(path.join(mainRoot, "src", "greeting.h"), body("greeting.h"));
    fs.writeFileSync(path.join(mainRoot, "src", "greeting.cpp"), body("greeting.cpp"));
    fs.writeFileSync(path.join(mainRoot, "a.ts"), body("a.ts"));
    git(["init", "-b", "main"]);
    git(["config", "user.email", "test@example.com"]);
    git(["config", "user.name", "Test"]);
    git(["add", "-A"]);
    git(["commit", "-m", "init"]);
    const featureRoot = path.join(dir, "feature");
    git(["worktree", "add", featureRoot, "-b", "feature"]);
    return {
        dir,
        mainRoot,
        featureRoot,
        cleanup(): void {
            try {
                fs.rmSync(dir, { recursive: true, force: true });
            } catch {
                // best-effort
            }
        },
    };
}

export interface CppWorktreeFixture {
    /** temp dir containing the repo, the feature worktree, and the anchor. */
    dir: string;
    /** the main worktree (repo root). */
    mainRoot: string;
    /** the added `feature` worktree. */
    featureRoot: string;
    /** stable empty dir mirroring the extension's always-folder[0] anchor. */
    anchor: string;
    /** path (relative to a worktree root) of the file with the call site. */
    useCppRelPath: string;
    /** 0-based line/character of the `greeting` call in use.cpp. */
    callSite: { line: number; character: number };
    cleanup(): void;
}

const GREETING_H = [
    "#ifndef GREETING_H",
    "#define GREETING_H",
    "const char* greeting();",
    "#endif",
    "",
].join("\n");

const GREETING_CPP = ['#include "greeting.h"', 'const char* greeting() { return "hi"; }', ""].join(
    "\n"
);

const USE_CPP_LINES = [
    '#include "greeting.h"',
    "",
    "int main() {",
    "    greeting();",
    "    return 0;",
    "}",
    "",
];

/**
 * Write a real compile_commands.json into a worktree root — one entry per .cpp
 * under src/ (directory=worktreeRoot, absolute file, `clang++ -std=c++17 -c
 * <file>`). This is what a build system would generate in the working tree; it
 * is NOT committed. Returns the path written. Use removeCompileCommands() to
 * clean it up so it doesn't leak between scenarios.
 */
export function writeCompileCommands(worktreeRoot: string): string {
    const srcDir = path.join(worktreeRoot, "src");
    const cpps = fs
        .readdirSync(srcDir)
        .filter((f) => f.endsWith(".cpp"))
        .sort();
    const db = cpps.map((f) => {
        const abs = path.join(srcDir, f);
        return {
            directory: worktreeRoot,
            file: abs,
            command: `clang++ -std=c++17 -c ${abs}`,
        };
    });
    const out = path.join(worktreeRoot, "compile_commands.json");
    fs.writeFileSync(out, JSON.stringify(db, null, 2));
    return out;
}

export function removeCompileCommands(worktreeRoot: string): void {
    fs.rmSync(path.join(worktreeRoot, "compile_commands.json"), { force: true });
}

/**
 * Locate the `greeting` call site inside use.cpp so tests don't hardcode magic
 * line/char numbers. Returns 0-based coordinates pointing at the `g` of the call.
 */
function findCallSite(): { line: number; character: number } {
    for (let line = 0; line < USE_CPP_LINES.length; line++) {
        const character = USE_CPP_LINES[line].indexOf("greeting(");
        if (character !== -1) {
            return { line, character };
        }
    }
    throw new Error("makeCppWorktreeFixture: could not locate greeting() call site");
}

/**
 * Build a temp git repo with a REAL, hermetic C++ project committed on `main`
 * and checked out into an added `feature` worktree. The project uses a
 * compile_flags.txt marker (no absolute paths), so each worktree is an
 * independent clangd project. Also creates a standalone `anchor` empty dir (not
 * in the repo) mirroring the extension's [anchor, activeWorktree] layout.
 *
 * Left deliberately separate from makeWorktreeFixture so the existing
 * integration tests that depend on it are untouched.
 */
export function makeCppWorktreeFixture(): CppWorktreeFixture {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wtc-cpp-"));
    const mainRoot = path.join(dir, "main");
    const git = (args: string[]): void => {
        execFileSync("git", args, { cwd: mainRoot, stdio: "pipe" });
    };
    fs.mkdirSync(path.join(mainRoot, "src"), { recursive: true });
    fs.writeFileSync(path.join(mainRoot, "src", "greeting.h"), GREETING_H);
    fs.writeFileSync(path.join(mainRoot, "src", "greeting.cpp"), GREETING_CPP);
    fs.writeFileSync(path.join(mainRoot, "src", "use.cpp"), USE_CPP_LINES.join("\n"));
    // Hermetic compilation-database marker: applies per-worktree, no abs paths.
    fs.writeFileSync(path.join(mainRoot, "compile_flags.txt"), "-std=c++17\n");
    git(["init", "-b", "main"]);
    git(["config", "user.email", "test@example.com"]);
    git(["config", "user.name", "Test"]);
    git(["add", "-A"]);
    git(["commit", "-m", "init"]);
    const featureRoot = path.join(dir, "feature");
    git(["worktree", "add", featureRoot, "-b", "feature"]);

    // Anchor lives beside the worktrees, NOT inside the repo.
    const anchor = path.join(dir, "anchor");
    fs.mkdirSync(anchor, { recursive: true });

    return {
        dir,
        mainRoot,
        featureRoot,
        anchor,
        useCppRelPath: path.join("src", "use.cpp"),
        callSite: findCallSite(),
        cleanup(): void {
            try {
                fs.rmSync(dir, { recursive: true, force: true });
            } catch {
                // best-effort
            }
        },
    };
}
