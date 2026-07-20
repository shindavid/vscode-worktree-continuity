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
