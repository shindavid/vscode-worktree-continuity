import { describe, expect, it } from "vitest";
import {
    extractLanguageClient,
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

describe("extractLanguageClient", () => {
    const onDidChangeState = (): { dispose(): void } => ({ dispose: () => undefined });

    it("extracts via getApi(1).languageClient (clangd shape)", () => {
        const client = { state: RUNNING, onDidChangeState };
        const exports = { getApi: (v: number) => (v === 1 ? { languageClient: client } : undefined) };
        expect(extractLanguageClient(exports)).toBe(client);
    });

    it("extracts via exports.languageClient", () => {
        const client = { state: RUNNING, onDidChangeState };
        expect(extractLanguageClient({ languageClient: client })).toBe(client);
    });

    it("extracts via exports.client", () => {
        const client = { state: RUNNING };
        expect(extractLanguageClient({ client })).toBe(client);
    });

    it("prefers getApi over the other shapes", () => {
        const apiClient = { state: RUNNING, onDidChangeState };
        const other = { state: RUNNING };
        const exports = {
            getApi: () => ({ languageClient: apiClient }),
            languageClient: other,
            client: other,
        };
        expect(extractLanguageClient(exports)).toBe(apiClient);
    });

    it("returns null for junk exports", () => {
        expect(extractLanguageClient(undefined)).toBeNull();
        expect(extractLanguageClient(null)).toBeNull();
        expect(extractLanguageClient(42)).toBeNull();
        expect(extractLanguageClient({})).toBeNull();
        expect(extractLanguageClient({ foo: "bar" })).toBeNull();
    });

    it("returns null when the candidate lacks a numeric state", () => {
        expect(extractLanguageClient({ languageClient: { onDidChangeState } })).toBeNull();
        expect(extractLanguageClient({ client: { state: "running" } })).toBeNull();
    });

    it("returns null when onDidChangeState is present but not callable", () => {
        expect(extractLanguageClient({ client: { state: RUNNING, onDidChangeState: 5 } })).toBeNull();
    });

    it("ignores a throwing getApi and falls back to other shapes", () => {
        const client = { state: RUNNING };
        const exports = {
            getApi: () => {
                throw new Error("unsupported version");
            },
            client,
        };
        expect(extractLanguageClient(exports)).toBe(client);
    });
});
