# Language Servers

When you switch worktrees, Worktree Hot Swap restarts the relevant language
servers. Without this, many servers (clangd included) keep the previous
worktree's index in memory, so features like **Go to Definition** can resolve a
shared symbol to the *other* worktree's copy of a file.

Restarts are debounced, and only commands that are actually registered in your
VS Code instance are run — so having the full default list configured costs
nothing if you only use one of these languages.

## Supported out of the box

| Language | Server | Extension | Restart command |
| --- | --- | --- | --- |
| C / C++ | clangd | `llvm-vs-code-extensions.vscode-clangd` | `clangd.restart` |
| Python | Pylance | `ms-python.vscode-pylance` | `python.analysis.restartLanguageServer` |
| Go | gopls | `golang.go` | `go.languageserver.restart` |
| Rust | rust-analyzer | `rust-lang.rust-analyzer` | `rust-analyzer.restartServer` |
| TypeScript / JavaScript | tsserver | built in to VS Code | `typescript.restartTsServer` |

## Adding a language server

If your server isn't listed above, add its restart command to the
`worktree-hot-swap.languageServerRestartCommands` setting. Note that setting
an array in VS Code **replaces** the default, so keep the defaults you use:

```jsonc
// settings.json
"worktree-hot-swap.languageServerRestartCommands": [
  "clangd.restart",
  "python.analysis.restartLanguageServer",
  "go.languageserver.restart",
  "rust-analyzer.restartServer",
  "typescript.restartTsServer",
  "your-server.restartCommand"   // ← your addition
]
```

To find your server's restart command, open the Command Palette (F1), search
for "restart", and hover the matching entry — or check the extension's
documentation. Set the whole list to `[]` to disable restarts entirely.

(There is no VS Code API to enumerate running language servers, which is why
this list is curated rather than automatic.)

## Faster back-to-back switches (optional)

After issuing a restart, the extension normally waits a fixed ~6-second gap
before it will restart that server again. If your server's extension exports
its language client, you can map the restart command to the extension ID in
`worktree-hot-swap.languageServerReadinessExtensions`; the extension then
*observes* when the server is actually running again and can fire an immediate
coalesced follow-up restart during a rapid sequence of switches:

```jsonc
"worktree-hot-swap.languageServerReadinessExtensions": {
  "clangd.restart": "llvm-vs-code-extensions.vscode-clangd"  // the default
}
```

The client is read from the extension's `exports` via `getApi(1).languageClient`,
`languageClient`, or `client` (in that order). Commands without an entry,
extensions that aren't installed, and clients that can't be found all fall back
to the fixed gap — nothing breaks.

## Use relative paths in server configs (clangd example)

A restart only re-scopes the server correctly if the server's own configuration
resolves *per worktree*. Absolute paths defeat this: the restarted server dutifully
points at the same worktree it pointed at before.

For clangd, if your compilation database isn't at the worktree root, use a
**committed `.clangd` file** with a relative path rather than the
`--compile-commands-dir` argument:

```yaml
# .clangd
CompileFlags:
  CompilationDatabase: target
```

The relative path is resolved against the `.clangd` file's directory (the
worktree root), so each worktree automatically points at its own database. A
relative `--compile-commands-dir` is instead resolved against clangd's single
working directory, which doesn't track the active worktree — and an absolute
one always points at one fixed worktree.
