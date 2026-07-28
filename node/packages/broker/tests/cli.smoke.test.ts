import { afterAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdtempSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { mcpCall } from "./streamable.helper";

/**
 * Runs the **published artifact**, not the sources.
 *
 * Every other test imports from `src/`, where vitest resolves modules its own
 * way. That leaves a whole class of bugs invisible: anything that depends on
 * the shape of `dist/`. Bundling flattens the module tree, so an asset read at
 * runtime through `import.meta.url` can sit at the wrong path in `dist` while
 * every unit test still passes: which is exactly how the broker's grammars
 * once shipped broken.
 *
 * So this spawns the real CLI and asks it to answer a real request.
 */

const here = dirname(fileURLToPath(import.meta.url));
const BIN = join(here, "..", "dist", "bin.js");

/** Reserves a free TCP port by binding and immediately releasing it. */
function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const probe = createServer();
        probe.unref();
        probe.on("error", reject);
        probe.listen(0, "127.0.0.1", () => {
            const { port } = probe.address() as { port: number };
            probe.close(() => resolve(port));
        });
    });
}

/** Polls until the broker answers, or gives up. */
async function waitForListening(url: string, proc: ChildProcess, timeoutMs = 20_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        if (proc.exitCode !== null) throw new Error(`CLI exited early with code ${proc.exitCode}`);
        try {
            await fetch(url, { method: "OPTIONS" });
            return;
        } catch {
            if (Date.now() > deadline) throw new Error("CLI never started listening");
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
    }
}

let proc: ChildProcess | null = null;

afterAll(() => {
    proc?.kill();
    proc = null;
});

// `dist/` only exists after a build. CI builds before testing; a bare local
// `npm test` does not, and failing there would blame the wrong thing.
const built = existsSync(BIN);

describe.skipIf(!built)("published CLI", () => {
    it("starts and serves its own `_broker` slot from the built layout", async () => {
        const port = await freePort();

        // A scratch cwd: the CLI reads `./.mcp-broker/config.json`, and the
        // developer's own config must not leak into the test.
        const cwd = mkdtempSync(join(tmpdir(), "mcp-broker-smoke-"));

        const output: string[] = [];
        proc = spawn(process.execPath, [BIN], {
            cwd,
            env: { ...process.env, MCP_BROKER_PORT: String(port), MCP_BROKER_HOST: "127.0.0.1", MCP_BROKER_OPEN: "" },
            stdio: ["ignore", "pipe", "pipe"],
        });
        proc.stdout?.on("data", (chunk: Buffer) => output.push(chunk.toString()));
        proc.stderr?.on("data", (chunk: Buffer) => output.push(chunk.toString()));

        const base = `http://127.0.0.1:${port}`;
        await waitForListening(`${base}/_broker/mcp`, proc);

        // The reserved `_broker` slot is an in-process MCP server that reads its
        // grammars from disk at startup. A real tools/list proves both that the
        // slot came up and that those files were found next to the bundle.
        const res = await mcpCall(base, "_broker", JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }), { "content-type": "application/json" });
        expect(res.status).toBe(200);

        const body = (await res.json()) as { result?: { tools?: { name: string }[] }; error?: { message: string } };
        expect(body.error).toBeUndefined();
        expect(body.result?.tools?.length).toBeGreaterThan(0);

        // Startup diagnostics are printed, not thrown, so a failed subsystem
        // would otherwise leave the process happily running and the test green.
        const log = output.join("");
        expect(log).not.toMatch(/failed to start|Error:/);
    }, 30_000);
});
