# Worktree Continuity

Switch between git worktrees **within a single VS Code window** — with **no
extension-host restart**, so Claude Code (and every other extension) keeps its
live state: chat sessions, terminals, language servers, all survive the switch.
Your open editor tabs are carried over to the equivalent files in the target
worktree, with cursor and scroll position preserved.

## How switching works (and why nothing restarts)

Changing the **first** workspace folder restarts the VS Code extension host —
which would tear down Claude Code and re-index everything. Changing a
**non-first** folder does not. So Worktree Continuity:

1. Pins a small, empty **anchor folder** at workspace-folder **index 0**
   (it appears as `⚓ worktrees` at the top of the Explorer).
2. Makes the **active worktree folder[1]**, so its files show as a normal
   top-level root.
3. Switching swaps **only folder[1]** → no extension-host restart.

The one exception is the very **first** switch in a window, which establishes
the `[anchor, worktree]` layout and therefore changes folder[0] once. From then
on, switches are restart-free.

Because each worktree is its own workspace folder (at its own absolute path),
**language servers scope to the active worktree** — clangd resolves each file
against the nearest `compile_commands.json`, and so on. However, many language
servers (clangd included) **keep the previous worktree's index in memory across
a folder swap**, which would make Go to Definition resolve a shared symbol to the
wrong worktree's copy. So on switch the extension **restarts the relevant
language servers** (debounced) to force a clean re-scope — see
`languageServerRestartCommands` below. This restarts the language server, not the
extension host, so Claude Code and other state are untouched; the cost is a brief
re-index after each switch.

## The Worktrees view

A **Worktrees** panel in the Explorer sidebar lists every worktree. Click one to
switch (tabs carry over). The active worktree is marked **green** with a ✓. A
refresh button re-runs discovery (e.g. after adding/removing worktrees).

## Tab carry

Switching closes the old worktree's tabs and reopens the equivalent files in the
new worktree, restoring per-tab cursor/scroll and focus. To restore background
tabs (which have no live editor at switch time), the extension keeps a
continuous position cache keyed by `(repo common dir, repo-relative path)`,
optionally persisted across restarts.

- **Dirty tabs are never closed** (their edits may only exist in the old
  worktree); they're left open and reported.
- Files with **no equivalent** in the target worktree are closed and reported.
- Diff / notebook / custom / webview tabs are left untouched.

### Known limitations (accepted for v1)

- A cached position goes stale if the file is edited between caching and the
  switch (the same limitation VS Code core has for external reloads — see
  microsoft/vscode#23043, #2908). No diff-based re-anchoring.
- A tab never activated this session has no cached position; it reopens at
  line 1.

## Commands

- **Worktree Continuity: Switch Worktree** — pick a worktree.
- **Worktree Continuity: Refresh Worktrees**
- **Worktree Continuity: Open Terminal in Worktree**
- **Worktree Continuity: Show Logs**

## Worktree layout

Worktrees can live anywhere on disk — side-by-side siblings, or entirely
separate directories — because discovery uses `git worktree list` (absolute
paths) and the switch just makes the target folder[1]. The one arrangement to
avoid is a worktree nested **inside** another worktree's working tree (e.g.
`main/.worktrees/feature`): it works, but when the outer worktree is active, a
language server indexing it will also index the nested copy, reintroducing
duplicate indexing.

## clangd note

If you point clangd at a non-default compile-commands location, use a
**committed `.clangd` file** at the worktree root rather than the
`--compile-commands-dir` argument:

```yaml
# .clangd
CompileFlags:
  CompilationDatabase: target
```

The relative path is resolved against the `.clangd` file's directory (the
worktree root), so each worktree points at its own database automatically. A
relative `--compile-commands-dir` is instead resolved against clangd's single
working directory, which doesn't track the active worktree.

## Configuration

- `worktree-continuity.carryTabs` (default `true`) — carry tabs on switch.
- `worktree-continuity.persistPositionsAcrossRestart` (default `true`) — persist
  the position cache in `globalState`.
- `worktree-continuity.anchorOnOpen` (default `true`) — establish the anchor
  layout on open (folding the one-time setup restart into the initial load) so
  the first switch is instant.
- `worktree-continuity.languageServerRestartCommands` — command IDs run
  (debounced) to re-scope language servers to the active worktree after a switch.
  Default covers clangd, Pylance, gopls, rust-analyzer, and tsserver; only
  commands that are actually registered run, so add your server's restart command
  if it isn't listed, or set `[]` to disable. (There's no VS Code API to
  enumerate language servers, so this list is curated.)
- `worktree-continuity.languageServerReadinessExtensions` — map of `restart
  command` → `extension id`. After running a restart command, the extension
  watches the named extension's exported language client (read from `exports`
  via `getApi(1).languageClient`, `languageClient`, or `client`) to know when the
  server is Running again, so a burst of switches can fire an immediate coalesced
  follow-up restart instead of waiting a fixed ~6s gap. Default maps
  `clangd.restart` → `llvm-vs-code-extensions.vscode-clangd`. Commands without an
  entry, extensions that aren't installed, and clients that can't be found all
  fall back to the fixed gap — nothing breaks.
- `workbench.colorCustomizations` → `worktreeContinuity.currentWorktreeForeground`
  overrides the green used for the current worktree.

## Development

```sh
npm install
npm test          # vitest unit tests (pure logic: tabmap, positionCache, worktrees, git)
npm run check-types
npm run lint
npm run compile   # or: node esbuild.js --production
```

The pure, unit-tested logic lives in `src/tabmap.ts` (remap planning),
`src/positionCache.ts`, `src/worktrees.ts`, and `src/git.ts` — none import the
vscode API. `src/extension.ts` wires them to commands and events, and
`src/worktreeView.ts` is the tree view. `src/test/` holds a vscode integration
test for the tab close/reopen path.

## Attribution

The git worktree discovery and porcelain-parsing plumbing (`src/git.ts` and the
discovery helpers in `src/extension.ts` / `src/worktrees.ts`) is derived from
[tmokmss/vscode-git-worktree-switcher](https://github.com/tmokmss/vscode-git-worktree-switcher)
(MIT). The multi-root switch, tab-carry, position cache, and view are new.
