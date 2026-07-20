import { describe, expect, it } from "vitest";
import {
    LS_STATE_RUNNING,
    waitForClientReady,
    type ObservableClient,
    type StateChange,
} from "../src/lsReady";

const RUNNING = LS_STATE_RUNNING; // 2
const STARTING = 3;
const STOPPED = 1;

/** A minimal LanguageClient-shaped fake whose state we drive by hand. */
class FakeClient implements ObservableClient {
    state: number;
    private readonly listeners = new Set<(e: StateChange) => void>();
    constructor(initial: number) {
        this.state = initial;
    }
    onDidChangeState(listener: (e: StateChange) => void): { dispose(): void } {
        this.listeners.add(listener);
        return { dispose: () => this.listeners.delete(listener) };
    }
    set(newState: number): void {
        const oldState = this.state;
        this.state = newState;
        for (const l of this.listeners) {
            l({ oldState, newState });
        }
    }
}

const later = (ms: number, fn: () => void): void => {
    setTimeout(fn, ms);
};

describe("waitForClientReady", () => {
    it("(a) not Running at entry → resolves ready once Running is observed", async () => {
        const c = new FakeClient(STARTING);
        const p = waitForClientReady(c, { timeoutMs: 1000, graceMs: 500 });
        later(20, () => c.set(RUNNING));
        await expect(p).resolves.toBe("ready");
    });

    it("(b) Running at entry → ready only after a transition away and back", async () => {
        const c = new FakeClient(RUNNING);
        const start = Date.now();
        const p = waitForClientReady(c, { timeoutMs: 1000, graceMs: 200 });
        later(20, () => c.set(STOPPED)); // restart begins (clears the grace timer)
        later(60, () => c.set(RUNNING)); // restart completes
        const result = await p;
        const elapsed = Date.now() - start;
        expect(result).toBe("ready");
        // Must reflect the full round-trip, not the 200ms grace shortcut.
        expect(elapsed).toBeGreaterThanOrEqual(55);
    });

    it("(b') Running at entry, transitions away but never returns → timeout", async () => {
        const c = new FakeClient(RUNNING);
        const p = waitForClientReady(c, { timeoutMs: 120, graceMs: 300 });
        later(20, () => c.set(STARTING)); // leaves Running, then stays there
        await expect(p).resolves.toBe("timeout");
    });

    it("(c) Running at entry, no transition within grace → ready at ~graceMs", async () => {
        const c = new FakeClient(RUNNING);
        const start = Date.now();
        const result = await waitForClientReady(c, { timeoutMs: 1000, graceMs: 50 });
        const elapsed = Date.now() - start;
        expect(result).toBe("ready");
        expect(elapsed).toBeGreaterThanOrEqual(45);
        expect(elapsed).toBeLessThan(500);
    });

    it("(d) never Running → timeout at timeoutMs", async () => {
        const c = new FakeClient(STARTING);
        const p = waitForClientReady(c, { timeoutMs: 60, graceMs: 500 });
        await expect(p).resolves.toBe("timeout");
    });

    it("(poll) client with no onDidChangeState → still resolves ready via polling", async () => {
        // A plain client object without the event forces the polling path.
        const c: ObservableClient = { state: STARTING };
        const p = waitForClientReady(c, { timeoutMs: 1000, graceMs: 500, pollMs: 10 });
        later(30, () => {
            c.state = RUNNING;
        });
        await expect(p).resolves.toBe("ready");
    });
});
