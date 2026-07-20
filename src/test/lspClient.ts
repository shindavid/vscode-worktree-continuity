import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import * as fs from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

// Minimal stdio JSON-RPC LSP client, no external deps. Built to interrogate a
// real clangd process: spawn it, drive initialize/didOpen/definition, observe
// $/progress (background-index) notifications, and shut it down cleanly or hard
// kill it (mirroring what vscode-clangd's `clangd.restart` does).

export interface Position {
    line: number;
    character: number;
}

export interface LspLocation {
    uri: string;
    range?: {
        start: Position;
        end: Position;
    };
}

interface ProgressValue {
    kind?: "begin" | "report" | "end";
    title?: string;
    message?: string;
    percentage?: number;
}

export interface ProgressEvent {
    token: string;
    kind: string;
    title?: string;
    message?: string;
    at: number;
}

interface PendingRequest {
    resolve(value: unknown): void;
    reject(reason: unknown): void;
}

// clangd's background-index progress token. Match loosely so a version bump that
// tweaks the token name still counts.
const BACKGROUND_INDEX_TOKEN = "backgroundIndexProgress";
function isBackgroundToken(token: string): boolean {
    return token === BACKGROUND_INDEX_TOKEN || /background|index/i.test(token);
}

export interface SpawnOpts {
    binary: string;
    args: string[];
    cwd: string;
}

export class LspClient {
    private readonly proc: ChildProcessWithoutNullStreams;
    private readonly pending = new Map<number, PendingRequest>();
    private nextId = 1;
    private buffer = Buffer.alloc(0);
    private stderrBuf = "";
    private exited = false;

    // Progress bookkeeping for waitForBackgroundIndexDone().
    readonly progressEvents: ProgressEvent[] = [];
    private sawAnyBegin = false;
    private backgroundEnded = false;
    private lastProgressAt = 0;

    constructor(opts: SpawnOpts) {
        this.proc = spawn(opts.binary, opts.args, {
            cwd: opts.cwd,
            stdio: ["pipe", "pipe", "pipe"],
        });
        this.proc.stdout.on("data", (chunk: Buffer) => this.onStdout(chunk));
        this.proc.stderr.on("data", (chunk: Buffer) => {
            this.stderrBuf += chunk.toString("utf8");
        });
        this.proc.on("exit", () => {
            this.exited = true;
        });
    }

    static spawn(opts: SpawnOpts): LspClient {
        return new LspClient(opts);
    }

    get stderr(): string {
        return this.stderrBuf;
    }

    get sawBackgroundIndexProgress(): boolean {
        return this.progressEvents.some((e) => isBackgroundToken(e.token));
    }

    /** Number of background-index `begin` events seen so far (cycle count). */
    get backgroundIndexCycles(): number {
        return this.progressEvents.filter((e) => isBackgroundToken(e.token) && e.kind === "begin")
            .length;
    }

    /**
     * Re-arm waitForBackgroundIndexDone so a subsequent call waits for the NEXT
     * indexing cycle rather than short-circuiting on a latched end from a prior
     * one. Keeps the progressEvents log intact for evidence. Call before the
     * second (and later) didOpen in a reused session.
     */
    resetBackgroundWait(): void {
        this.sawAnyBegin = false;
        this.backgroundEnded = false;
        this.lastProgressAt = 0;
    }

    // ---- framing / transport -------------------------------------------------

    private onStdout(chunk: Buffer): void {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        for (;;) {
            const headerEnd = this.buffer.indexOf("\r\n\r\n");
            if (headerEnd === -1) {
                return;
            }
            const header = this.buffer.subarray(0, headerEnd).toString("ascii");
            const match = /Content-Length:\s*(\d+)/i.exec(header);
            if (!match) {
                // Malformed header; drop it and resync.
                this.buffer = this.buffer.subarray(headerEnd + 4);
                continue;
            }
            const len = Number(match[1]);
            const bodyStart = headerEnd + 4;
            if (this.buffer.length < bodyStart + len) {
                return;
            }
            const body = this.buffer.subarray(bodyStart, bodyStart + len).toString("utf8");
            this.buffer = this.buffer.subarray(bodyStart + len);
            try {
                this.dispatch(JSON.parse(body));
            } catch {
                // ignore parse errors on a single frame
            }
        }
    }

    private send(msg: unknown): void {
        const json = JSON.stringify(msg);
        const payload = Buffer.from(json, "utf8");
        const header = Buffer.from(`Content-Length: ${payload.length}\r\n\r\n`, "ascii");
        this.proc.stdin.write(Buffer.concat([header, payload]));
    }

    private request<T = unknown>(method: string, params?: unknown): Promise<T> {
        const id = this.nextId++;
        const p = new Promise<T>((resolve, reject) => {
            this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
        });
        this.send({ jsonrpc: "2.0", id, method, params });
        return p;
    }

    private notify(method: string, params?: unknown): void {
        this.send({ jsonrpc: "2.0", method, params });
    }

    private dispatch(msg: {
        id?: number | string;
        method?: string;
        params?: unknown;
        result?: unknown;
        error?: unknown;
    }): void {
        // Response to one of our requests.
        if (msg.id !== undefined && msg.method === undefined) {
            const pending = this.pending.get(Number(msg.id));
            if (pending) {
                this.pending.delete(Number(msg.id));
                if (msg.error) {
                    pending.reject(msg.error);
                } else {
                    pending.resolve(msg.result);
                }
            }
            return;
        }

        // Server -> client request. We must reply to window/workDoneProgress/create.
        if (msg.id !== undefined && msg.method !== undefined) {
            if (msg.method === "window/workDoneProgress/create") {
                this.send({ jsonrpc: "2.0", id: msg.id, result: null });
            } else {
                // Unknown server request: reply null so the server isn't blocked.
                this.send({ jsonrpc: "2.0", id: msg.id, result: null });
            }
            return;
        }

        // Notification.
        if (msg.method === "$/progress") {
            this.onProgress(msg.params as { token?: string; value?: ProgressValue });
        }
    }

    private onProgress(params: { token?: string; value?: ProgressValue }): void {
        const token = String(params?.token ?? "");
        const value = params?.value ?? {};
        const kind = String(value.kind ?? "");
        this.lastProgressAt = Date.now();
        this.progressEvents.push({
            token,
            kind,
            title: value.title,
            message: value.message,
            at: this.lastProgressAt,
        });
        if (kind === "begin") {
            this.sawAnyBegin = true;
        }
        if (kind === "end" && isBackgroundToken(token)) {
            this.backgroundEnded = true;
        }
    }

    // ---- LSP methods ---------------------------------------------------------

    async initialize(anchorDir: string, worktreeRoot: string): Promise<unknown> {
        const anchorUri = pathToFileURL(anchorDir).href;
        const worktreeUri = pathToFileURL(worktreeRoot).href;
        const result = await this.request("initialize", {
            processId: process.pid,
            clientInfo: { name: "wtc-harness", version: "0.0.0" },
            // Mirror the extension's [anchor, worktree] layout: anchor is folder[0].
            rootUri: anchorUri,
            capabilities: {
                window: { workDoneProgress: true },
                textDocument: {
                    synchronization: { dynamicRegistration: false, didSave: true },
                    definition: { dynamicRegistration: false, linkSupport: true },
                    hover: { dynamicRegistration: false },
                },
                workspace: { workspaceFolders: true },
            },
            workspaceFolders: [
                { uri: anchorUri, name: "anchor" },
                { uri: worktreeUri, name: worktreeRoot.split("/").pop() ?? "worktree" },
            ],
        });
        this.notify("initialized", {});
        return result;
    }

    didOpen(filePath: string, languageId = "cpp"): void {
        const text = fs.readFileSync(filePath, "utf8");
        this.notify("textDocument/didOpen", {
            textDocument: {
                uri: pathToFileURL(filePath).href,
                languageId,
                version: 1,
                text,
            },
        });
    }

    async definition(filePath: string, pos: Position): Promise<LspLocation[]> {
        const result = await this.request("textDocument/definition", {
            textDocument: { uri: pathToFileURL(filePath).href },
            position: pos,
        });
        return normalizeLocations(result);
    }

    /**
     * Resolve when clangd's background index reports done, tolerating three real
     * cases:
     *   1. We saw a begin and then an end for the background token -> resolve.
     *   2. We saw a begin but progress went quiet for ~settleMs -> resolve.
     *   3. Indexing finished before we subscribed (no progress at all) -> after a
     *      short settle delay, resolve anyway.
     * Always bounded by timeoutMs.
     */
    async waitForBackgroundIndexDone(timeoutMs = 30000): Promise<{
        endObserved: boolean;
        anyProgress: boolean;
    }> {
        const start = Date.now();
        const settleAfterQuietMs = 2000;
        const noProgressSettleMs = 3000;
        return new Promise((resolve) => {
            const tick = (): void => {
                const now = Date.now();
                if (this.exited) {
                    resolve({ endObserved: this.backgroundEnded, anyProgress: this.sawAnyBegin });
                    return;
                }
                if (this.backgroundEnded) {
                    resolve({ endObserved: true, anyProgress: true });
                    return;
                }
                if (this.sawAnyBegin) {
                    if (now - this.lastProgressAt > settleAfterQuietMs) {
                        resolve({ endObserved: false, anyProgress: true });
                        return;
                    }
                } else if (now - start > noProgressSettleMs) {
                    // Never saw a begin: indexing likely finished before we hooked
                    // in, or the project needed none. Settle.
                    resolve({ endObserved: false, anyProgress: false });
                    return;
                }
                if (now - start > timeoutMs) {
                    resolve({ endObserved: this.backgroundEnded, anyProgress: this.sawAnyBegin });
                    return;
                }
                setTimeout(tick, 100);
            };
            tick();
        });
    }

    async shutdown(timeoutMs = 3000): Promise<void> {
        if (this.exited) {
            return;
        }
        try {
            // Race the shutdown handshake against a timeout: a half-dead server
            // may never answer, and we must not hang the caller.
            await Promise.race([
                this.request("shutdown"),
                new Promise((resolve) => setTimeout(resolve, timeoutMs)),
            ]);
            this.notify("exit");
        } catch {
            // best-effort; caller kills afterward
        }
    }

    kill(): void {
        try {
            this.proc.kill("SIGKILL");
        } catch {
            // already dead
        }
    }
}

function normalizeLocations(result: unknown): LspLocation[] {
    if (!result) {
        return [];
    }
    const arr = Array.isArray(result) ? result : [result];
    const out: LspLocation[] = [];
    for (const item of arr) {
        if (!item || typeof item !== "object") {
            continue;
        }
        const rec = item as Record<string, unknown>;
        // Location has `uri`; LocationLink has `targetUri`.
        const uri = (rec.uri ?? rec.targetUri) as string | undefined;
        if (typeof uri === "string") {
            const range = (rec.range ?? rec.targetSelectionRange ?? rec.targetRange) as
                | LspLocation["range"]
                | undefined;
            out.push({ uri, range });
        }
    }
    return out;
}

export function uriToPath(uri: string): string {
    try {
        return fileURLToPath(uri);
    } catch {
        return uri;
    }
}
