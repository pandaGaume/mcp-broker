import { describe, expect, it } from "vitest";
import { resolveOpenTarget } from "../src/config";

/**
 * `www.open` / `MCP_BROKER_OPEN` decides what URL the broker hands to the
 * platform's "open this" command at startup. The resolution lives in
 * `config.ts` rather than in `bin.ts` precisely so it can be exercised here:
 * `bin.ts` starts a server the moment it is imported.
 *
 * Two groups matter. The accepted forms have to stay byte-compatible, since
 * `MCP_BROKER_OPEN=1` is the documented spelling and is used in the wild. The
 * refusals are security-load-bearing: the opener performs no validation of its
 * own, so anything that is not provably a page on this broker must not reach it.
 */
const BASE = "http://localhost:3000";

describe("resolveOpenTarget", () => {
    it("opens nothing for every falsy spelling", () => {
        for (const raw of [undefined, null, false, "", "  ", "0", "false"]) {
            const resolved = resolveOpenTarget(raw, BASE);
            expect(resolved, `raw=${String(raw)}`).toEqual({ url: null, path: null });
        }
    });

    it("resolves the truthy spellings to the broker root", () => {
        for (const raw of [true, "1", "true", "/"]) {
            const resolved = resolveOpenTarget(raw, BASE);
            expect(resolved.error, `raw=${String(raw)}`).toBeUndefined();
            expect(resolved.url).toBe("http://localhost:3000/");
            expect(resolved.path).toBe("/");
        }
    });

    it("joins an absolute path against the broker origin and reports the path a mount must cover", () => {
        const resolved = resolveOpenTarget("/bundle/index.html?tab=1", BASE);
        expect(resolved.error).toBeUndefined();
        expect(resolved.url).toBe("http://localhost:3000/bundle/index.html?tab=1");
        // The query string must not leak into the mount-coverage check.
        expect(resolved.path).toBe("/bundle/index.html");
    });

    it("passes an absolute URL through when it is on this broker's own origin", () => {
        const resolved = resolveOpenTarget("http://localhost:3000/app/", BASE);
        expect(resolved.error).toBeUndefined();
        expect(resolved.url).toBe("http://localhost:3000/app/");
        expect(resolved.path).toBe("/app/");
    });

    it("refuses a foreign origin, naming both origins", () => {
        const resolved = resolveOpenTarget("https://evil.example/x", BASE);
        expect(resolved.url).toBeNull();
        expect(resolved.error).toContain("https://evil.example");
        expect(resolved.error).toContain("http://localhost:3000");
    });

    it("refuses a protocol-relative URL, which starts with a slash but is not local", () => {
        // `new URL("//evil.example/x", base)` resolves off-origin, so a naive
        // "starts with a slash" test would let this through.
        const resolved = resolveOpenTarget("//evil.example/x", BASE);
        expect(resolved.url).toBeNull();
        expect(resolved.error).toContain("protocol-relative");
    });

    it("refuses a non-http scheme rather than handing it to the platform opener", () => {
        for (const raw of ["file:///etc/passwd", "javascript:alert(1)", "calculator:"]) {
            const resolved = resolveOpenTarget(raw, BASE);
            expect(resolved.url, `raw=${raw}`).toBeNull();
            expect(resolved.error).toBeDefined();
        }
    });

    it("refuses a bare word instead of silently resolving it onto the broker root", () => {
        const resolved = resolveOpenTarget("indexhtml", BASE);
        expect(resolved.url).toBeNull();
        expect(resolved.error).toContain("neither a path");
    });

    it("names a way forward in every refusal", () => {
        for (const raw of ["//evil.example/x", "https://evil.example/x", "indexhtml", "file:///tmp/x"]) {
            const resolved = resolveOpenTarget(raw, BASE);
            expect(resolved.error, `raw=${raw}`).toContain("/app/index.html");
        }
    });
});
