import { describe, expect, it } from "vitest";
import { guardSaysSkip, parseRestartGuard } from "../src/lsGuards";

describe("parseRestartGuard", () => {
    it("accepts a well-formed guard", () => {
        const g = parseRestartGuard({ setting: "clangd.enable", skipValues: [false] });
        expect(g).toEqual({ setting: "clangd.enable", skipValues: [false] });
    });

    it("accepts mixed-type skipValues", () => {
        const g = parseRestartGuard({
            setting: "C_Cpp.intelliSenseEngine",
            skipValues: ["disabled", "Disabled"],
        });
        expect(g?.skipValues).toEqual(["disabled", "Disabled"]);
    });

    it.each([
        ["undefined", undefined],
        ["null", null],
        ["a string", "clangd.enable"],
        ["missing setting", { skipValues: [false] }],
        ["empty setting", { setting: "", skipValues: [false] }],
        ["non-string setting", { setting: 3, skipValues: [false] }],
        ["missing skipValues", { setting: "clangd.enable" }],
        ["non-array skipValues", { setting: "clangd.enable", skipValues: false }],
    ])("rejects %s", (_name, raw) => {
        expect(parseRestartGuard(raw)).toBeNull();
    });
});

describe("guardSaysSkip", () => {
    const clangd = { setting: "clangd.enable", skipValues: [false] };
    const cpptools = {
        setting: "C_Cpp.intelliSenseEngine",
        skipValues: ["disabled", "Disabled"],
    };

    it("skips when the value matches", () => {
        expect(guardSaysSkip(clangd, false)).toBe(true);
        expect(guardSaysSkip(cpptools, "disabled")).toBe(true);
        expect(guardSaysSkip(cpptools, "Disabled")).toBe(true);
    });

    it("runs when the value differs", () => {
        expect(guardSaysSkip(clangd, true)).toBe(false);
        expect(guardSaysSkip(clangd, undefined)).toBe(false);
        expect(guardSaysSkip(cpptools, "default")).toBe(false);
    });

    it("uses strict equality, no coercion", () => {
        expect(guardSaysSkip(clangd, "false")).toBe(false);
        expect(guardSaysSkip(clangd, 0)).toBe(false);
        expect(guardSaysSkip(clangd, null)).toBe(false);
    });
});
