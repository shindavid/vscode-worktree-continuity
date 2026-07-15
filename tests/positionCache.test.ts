import { describe, expect, it } from "vitest";
import { PositionCache, type PersistentStore } from "../src/positionCache";

const KEY = "worktree-continuity.positions.v1";

class FakeStore implements PersistentStore {
    data: Record<string, unknown> = {};
    get<T>(key: string): T | undefined {
        return this.data[key] as T | undefined;
    }
    update(key: string, value: unknown): Promise<void> {
        this.data[key] = value;
        return Promise.resolve();
    }
}

describe("PositionCache", () => {
    it("records and retrieves by (commonDir, relPath)", () => {
        const c = new PositionCache(undefined);
        c.record("/repo/.git", "src/a.ts", { topLine: 3 });
        expect(c.get("/repo/.git", "src/a.ts")).toEqual({ topLine: 3 });
    });

    it("namespaces identical relative paths by common dir", () => {
        const c = new PositionCache(undefined);
        c.record("/repoA/.git", "src/index.ts", { topLine: 1 });
        c.record("/repoB/.git", "src/index.ts", { topLine: 99 });
        expect(c.get("/repoA/.git", "src/index.ts")).toEqual({ topLine: 1 });
        expect(c.get("/repoB/.git", "src/index.ts")).toEqual({ topLine: 99 });
    });

    it("merges partial updates (selection then scroll)", () => {
        const c = new PositionCache(undefined);
        const sel = { anchorLine: 5, anchorChar: 0, activeLine: 5, activeChar: 2 };
        c.record("/r/.git", "a.ts", { selection: sel });
        c.record("/r/.git", "a.ts", { topLine: 4 });
        expect(c.get("/r/.git", "a.ts")).toEqual({ selection: sel, topLine: 4 });
    });

    it("ignores records while suspended", () => {
        const c = new PositionCache(undefined);
        c.record("/r/.git", "a.ts", { topLine: 1 });
        c.suspend();
        c.record("/r/.git", "a.ts", { topLine: 2 });
        expect(c.get("/r/.git", "a.ts")).toEqual({ topLine: 1 });
        c.resume();
        c.record("/r/.git", "a.ts", { topLine: 3 });
        expect(c.get("/r/.git", "a.ts")).toEqual({ topLine: 3 });
    });

    it("loads previously persisted positions from the store", () => {
        const store = new FakeStore();
        store.data[KEY] = { "/r/.git": { "a.ts": { topLine: 7 } } };
        const c = new PositionCache(store);
        expect(c.get("/r/.git", "a.ts")).toEqual({ topLine: 7 });
    });

    it("flushes the serialized shape to the store", async () => {
        const store = new FakeStore();
        const c = new PositionCache(store);
        c.record("/r/.git", "a.ts", { topLine: 2 });
        await c.flush();
        expect(store.data[KEY]).toEqual({ "/r/.git": { "a.ts": { topLine: 2 } } });
    });

    it("does not touch the store when constructed without one", () => {
        // Purely in-memory: flush is a no-op and must not throw.
        const c = new PositionCache(undefined);
        c.record("/r/.git", "a.ts", { topLine: 1 });
        expect(() => c.dispose()).not.toThrow();
    });
});
