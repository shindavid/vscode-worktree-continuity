# Warnings

## Files from multiple worktrees open at once

**What you'll see:** a warning that "files from another worktree are open," and
symptoms like **Go to Definition jumping to the wrong worktree's copy** of a
symbol.

**Why it happens:** language servers like clangd serve *any* open file using
that file's own project configuration (its nearest `.clangd` /
`compile_commands.json`), **regardless of which worktree is the active workspace
folder**. So if a tab from another worktree is open, the language server loads
that worktree's project too. Because a symbol's identity (clangd's "USR") is its
name and signature — not its file path — the *same* function in two worktrees
looks like *one* symbol with two definitions. Go to Definition then can't tell
which worktree you mean, and may pick the wrong one. Once it opens a file in the
other worktree, that reinforces the confusion.

**How Worktree Continuity avoids it:** it keeps a single worktree's files open at
a time — carrying tabs to the active worktree on switch, reconciling stray tabs
on window open, and restarting the language server so it re-scopes to the active
worktree. The one case it can't prevent automatically is when you **manually**
open a file from another worktree mid-session.

**How to fix it:** click **Reconcile** on the warning — it remaps the stray tabs
to the active worktree and restarts the language server. Or run
**Worktree Continuity: Switch Worktree** to any worktree and back, which closes
other-worktree files as part of the switch. Manually, you can close the
other-worktree tab(s) and then run **clangd: Restart language server**.

**How to avoid it:** don't open files from a non-active worktree directly. Switch
to that worktree instead (the Worktrees view, or the switch command).

## What a language-server restart actually fixes (measured)

A headless clangd harness (`src/test/clangdScope.test.ts`) measured the restart's
effect against a two-worktree C++ fixture and the `wt-demo` repro repo.

**Restart works.** A freshly spawned clangd scoped to the active worktree
resolves Go to Definition into *that* worktree — including cross-translation-unit
definitions — as long as the worktree has its own compilation database
(`compile_flags.txt`, or `.clangd` → `compile_commands.json`). The previous
worktree's persisted `.cache/clangd` does **not** hijack it.

**Without a restart**, a session that has already indexed another worktree answers
identical-symbol (USR) queries from its warmed index, and can land in *either*
worktree — the tie-break is order-dependent, so it can look "stuck" on the wrong
one.

**Two setups defeat the restart.** A pinned `--compile-commands-dir` argument
survives restarts and keeps loading the old worktree's database (already flagged
in the README). And *navigating during the restart window*: vscode-clangd's
stop→start takes ~5 seconds, so a Go to Definition issued seconds after a switch
may be answered by the dying or mid-start session — the wrong result reopens an
other-worktree tab and re-contaminates the fresh session. That loop is what the
`wt-demo` log captured.

**Consequence:** the reconcile→restart coupling stays — the restart is the
remedy, not the cost.
