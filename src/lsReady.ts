/**
 * Pure, vscode-free readiness logic for a language client, so it can be
 * unit-tested. A "client" here is anything shaped like a vscode-languageclient
 * `LanguageClient`: a numeric `state` and an optional `onDidChangeState` event.
 */

/** vscode-languageclient State.Running. */
export const LS_STATE_RUNNING = 2;

export interface StateChange {
    newState?: number;
    oldState?: number;
}

export interface ObservableClient {
    state?: number;
    onDidChangeState?: (listener: (e: StateChange) => void) => { dispose(): void };
}

export interface WaitOpts {
    /** Overall budget; resolves 'timeout' if readiness isn't reached in time. */
    timeoutMs: number;
    /**
     * If the client is already Running at entry, how long to wait for it to
     * transition AWAY (a real restart beginning) before concluding the restart
     * already completed and resolving 'ready'.
     */
    graceMs: number;
    /** Poll interval used only when the client has no onDidChangeState event. */
    pollMs?: number;
}

/**
 * Wait until a language client is Running again after a restart — transition
 * aware, to avoid the stale-Running race: a `clangd.restart` can resolve while
 * the OLD client still reports Running for several seconds (measured stop→start
 * ≈5s), so a naive "Running at entry → ready" check opens the gate instantly and
 * lets a queued trigger fire a second restart into a stopping/starting client.
 *
 * Semantics:
 *  - Not Running at entry → wait for Running (event, or poll every pollMs) →
 *    'ready'; 'timeout' at timeoutMs.
 *  - Running at entry → wait to observe a transition AWAY from Running first,
 *    then for Running again within the remaining budget → 'ready'. If NO
 *    transition away happens within graceMs, resolve 'ready' (covers a restart
 *    that had already fully completed before we attached — e.g. vscode-clangd
 *    0.6.0, whose `clangd.restart` handler awaits the new client's creation and
 *    repoints the exported client at it before the command resolves).
 */
export function waitForClientReady(
    client: ObservableClient,
    opts: WaitOpts
): Promise<"ready" | "timeout"> {
    const pollMs = opts.pollMs ?? 250;
    const isRunning = (): boolean => client.state === LS_STATE_RUNNING;

    return new Promise((resolve) => {
        let done = false;
        // Have we yet observed the client leave Running? If it's already not
        // Running at entry, we're effectively past that point already.
        let sawAway = !isRunning();
        let sub: { dispose(): void } | undefined;
        let poll: ReturnType<typeof setInterval> | undefined;
        let graceTimer: ReturnType<typeof setTimeout> | undefined;

        const finish = (v: "ready" | "timeout"): void => {
            if (done) {
                return;
            }
            done = true;
            clearTimeout(overall);
            if (graceTimer) {
                clearTimeout(graceTimer);
            }
            if (poll) {
                clearInterval(poll);
            }
            sub?.dispose();
            resolve(v);
        };

        const onState = (): void => {
            if (done) {
                return;
            }
            if (!sawAway) {
                // Phase A: waiting to see the restart actually begin.
                if (!isRunning()) {
                    sawAway = true;
                    if (graceTimer) {
                        clearTimeout(graceTimer);
                        graceTimer = undefined;
                    }
                }
                return;
            }
            // Phase B: restart underway (or non-Running at entry) → wait for Running.
            if (isRunning()) {
                finish("ready");
            }
        };

        const overall = setTimeout(() => finish("timeout"), opts.timeoutMs);

        if (typeof client.onDidChangeState === "function") {
            sub = client.onDidChangeState(() => onState());
        } else {
            poll = setInterval(() => onState(), pollMs);
        }

        if (sawAway) {
            // Non-Running at entry: it may already be back; check now.
            onState();
        } else {
            // Running at entry: if it never leaves within graceMs, the restart
            // already completed before we attached → ready.
            graceTimer = setTimeout(() => finish("ready"), opts.graceMs);
        }
    });
}
