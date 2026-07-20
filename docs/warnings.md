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
on window open, and **intercepting a sibling-worktree file the moment it opens**
(e.g. a Go to Definition that resolves into another worktree): it remaps the open
to the active worktree's equivalent at the same cursor position and closes the
stray tab, before a shared language server can latch onto the other worktree.
After a switch or remap it restarts the language server so it re-scopes cleanly,
and it waits for the server to report ready before allowing another restart (so
a rapid sequence of switches can't leave a restart racing a half-started server).

The one case interception can't silently handle is a file that exists **only** in
the other worktree (no equivalent to remap to) — then the tab is left open and
the one-click warning below appears.

**How to fix it:** interception handles the common case automatically. If the
warning does appear, click **Reconcile** — it remaps the stray tabs to the active
worktree and restarts the language server. Or run **Worktree Continuity: Switch
Worktree** to any worktree and back, which closes other-worktree files as part of
the switch. Manually, you can close the other-worktree tab(s) and then run
**clangd: Restart language server**.

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
