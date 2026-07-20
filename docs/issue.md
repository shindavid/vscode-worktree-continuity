**Ask**: An extension API to restart all language servers.

**Background**: This has been requested in the past - for example, in 2019 here: https://github.com/microsoft/vscode/issues/76405

**Motivation**: Things have changed since 2019: many users now use AI agents and have them do their work in git worktrees. This presents a UI problem if a swarm of agents are working on independent worktrees. You might have N versions of a file open across N different worktrees, leading to stale language server results and wrong-worktree go-to-definition. This calls for an extension that allows for switching between worktrees, utilizing APIs for closing or opening files in the editor automatically based on the selected worktree.

In fact, there are many new extensions in the marketplace aimed at solving this: a marketplace search for "worktree switch" yields many hits, reflecting the emerging need. However, these extensions universally face the same underlying difficulties:

1. A worktree switch warrants repointing language servers at a switched root directory. A language server restart is the natural mechanism for this.
2. Individual extensions expose their own restart commands, but there is no generic way to restart all servers - the only universal option is a window reopen.
3. But, a window reopen interrupts AI agent sessions.

An API to restart all language servers would pave the way for seamless worktree switching.

**Suggested shape**: a `vscode.languages.restartLanguageServers()` API or a `workbench.action.restartLanguageServers` command.
