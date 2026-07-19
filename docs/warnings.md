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
