import type { CachedPosition } from "./tabmap";

/**
 * Minimal persistence surface. vscode.Memento (globalState) structurally
 * satisfies this, but the cache itself imports nothing from vscode so it stays
 * unit-testable.
 */
export interface PersistentStore {
    get<T>(key: string): T | undefined;
    update(key: string, value: unknown): Thenable<void> | Promise<void>;
}

const STORAGE_KEY = "worktree-hot-swap.positions.v1";
const FLUSH_DEBOUNCE_MS = 2000;

/** commonDir -> relPath -> position */
type StoreShape = Record<string, Record<string, CachedPosition>>;
type RepoCache = Map<string, CachedPosition>;

/**
 * In-memory cursor/scroll cache keyed by (repo common dir, repo-relative path).
 * Keying by relative path is what makes a position recorded while viewing a file
 * in worktree A reusable when the same relative path is reopened in worktree B;
 * namespacing by common dir keeps two repos' identical relative paths from
 * colliding in a multi-root workspace (and in shared globalState).
 *
 * Writes are debounced to the backing store because visible-range (scroll)
 * events fire very frequently.
 */
export class PositionCache {
    private readonly byRepo = new Map<string, RepoCache>();
    private readonly store: PersistentStore | undefined;
    private dirty = false;
    private flushTimer: ReturnType<typeof setTimeout> | undefined;
    private suspended = false;

    /** @param store globalState-like store, or undefined for in-memory-only. */
    constructor(store: PersistentStore | undefined) {
        this.store = store;
        const stored = store?.get<StoreShape>(STORAGE_KEY);
        if (stored) {
            for (const [commonDir, rels] of Object.entries(stored)) {
                this.byRepo.set(commonDir, new Map(Object.entries(rels)));
            }
        }
    }

    /**
     * Suspend recording during a programmatic switch: our own reopen sequence
     * activates editors and would otherwise feed stale positions back in.
     */
    suspend(): void {
        this.suspended = true;
    }

    resume(): void {
        this.suspended = false;
    }

    get(commonDir: string, relPath: string): CachedPosition | undefined {
        return this.byRepo.get(commonDir)?.get(relPath);
    }

    /** Merge a partial position (selection and/or topLine) into the cache. */
    record(commonDir: string, relPath: string, partial: CachedPosition): void {
        if (this.suspended) {
            return;
        }
        let repo = this.byRepo.get(commonDir);
        if (!repo) {
            repo = new Map();
            this.byRepo.set(commonDir, repo);
        }
        const prev = repo.get(relPath);
        repo.set(relPath, { ...prev, ...partial });
        this.scheduleFlush();
    }

    private scheduleFlush(): void {
        if (!this.store) {
            return;
        }
        this.dirty = true;
        if (this.flushTimer) {
            return;
        }
        this.flushTimer = setTimeout(() => {
            this.flushTimer = undefined;
            void this.flush();
        }, FLUSH_DEBOUNCE_MS);
    }

    async flush(): Promise<void> {
        if (!this.store || !this.dirty) {
            return;
        }
        this.dirty = false;
        const out: StoreShape = {};
        for (const [commonDir, repo] of this.byRepo) {
            if (repo.size > 0) {
                out[commonDir] = Object.fromEntries(repo);
            }
        }
        await this.store.update(STORAGE_KEY, out);
    }

    /** Flush any pending write and stop the timer. */
    dispose(): void {
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = undefined;
        }
        void this.flush();
    }
}
