/**
 * Pure, vscode-free logic for restart-command guards.
 *
 * "Command is registered" is not a sufficient gate for running a restart
 * command: several language-server extensions keep their restart command
 * registered while the server itself is configured off, and respond to it
 * with UI instead of a no-op — vscode-clangd (0.6.0) with `clangd.enable:
 * false` pops "Language features from Clangd are currently disabled. Would
 * you like to enable them?", and cpptools with `C_Cpp.intelliSenseEngine:
 * "disabled"` shows a warning toast. A guard maps a restart command to the
 * server's own enable-setting so those restarts are skipped entirely.
 */

export interface RestartGuard {
    /** Full setting ID to inspect, e.g. `clangd.enable`. */
    setting: string;
    /** If the setting's current value is one of these, skip the restart. */
    skipValues: unknown[];
}

/** Validate one raw guard entry from user config; null if malformed. */
export function parseRestartGuard(raw: unknown): RestartGuard | null {
    if (!raw || typeof raw !== "object") {
        return null;
    }
    const r = raw as Record<string, unknown>;
    if (typeof r.setting !== "string" || r.setting.length === 0) {
        return null;
    }
    if (!Array.isArray(r.skipValues)) {
        return null;
    }
    return { setting: r.setting, skipValues: r.skipValues };
}

/** Whether the guarded setting's current value means "server is off, skip". */
export function guardSaysSkip(guard: RestartGuard, value: unknown): boolean {
    return guard.skipValues.some((sv) => sv === value);
}
