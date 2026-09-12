/**
 * Locates the `mcp-broker` CLI inside the installed
 * `@cyanmycelium/mcp-broker` package, and starts it as a child process.
 *
 * Why not just `spawn("mcp-broker")`: that only works when npm put
 * `node_modules/.bin` on PATH, which it does for `npm run <script>` and does
 * not do for a bare `node samples/<x>/run.mjs`. Resolving the package's own
 * entry point and walking to its sibling `bin.js` works in both cases, and it
 * is also how you would locate the broker from inside a larger application.
 */
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import * as path from "node:path";
import * as url from "node:url";

const require = createRequire(import.meta.url);

/**
 * Absolute path to the broker's CLI entry point (`dist/bin.js`).
 *
 * The package's `exports` map publishes only `"."`, so the package root cannot
 * be required directly; resolving `"."` lands on `dist/index.js`, and `bin.js`
 * is its sibling. That is the same file the `mcp-broker` bin shim points at.
 */
export function brokerBinPath() {
    try {
        const entry = require.resolve("@cyanmycelium/mcp-broker");
        return path.join(path.dirname(entry), "bin.js");
    } catch (err) {
        throw new Error(
            `Cannot find @cyanmycelium/mcp-broker. Run "npm install" in the samples/ directory first ` +
                `(it links this repo's node/packages/broker). Underlying error: ${err.message}`
        );
    }
}

/**
 * Spawns the broker with `env` merged over the current environment.
 *
 * `stdio: "inherit"` on purpose: the startup banner and every diagnostic the
 * broker prints are half of what these samples are for. Reading them is the
 * point, so nothing is captured or filtered.
 *
 * @param {Record<string, string>} env  MCP_BROKER_* variables for this run.
 * @param {object} [options]
 * @param {string} [options.cwd]        Working directory for the child.
 * @returns {import("node:child_process").ChildProcess}
 */
export function startBroker(env, options = {}) {
    const child = spawn(process.execPath, [brokerBinPath()], {
        stdio: "inherit",
        cwd: options.cwd ?? process.cwd(),
        env: { ...process.env, ...env },
    });

    // Ctrl+C in the terminal reaches the whole process group on POSIX but not
    // reliably on Windows, so the parent forwards it. Without this the broker
    // survives the sample runner and holds the port, which is exactly the
    // EADDRINUSE the broker's own error message then has to explain.
    const stop = () => {
        if (!child.killed) child.kill("SIGINT");
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    process.on("exit", stop);

    child.on("exit", (code) => process.exit(code ?? 0));
    return child;
}

/** Absolute path of the directory holding the calling module. */
export function dirOf(importMetaUrl) {
    return path.dirname(url.fileURLToPath(importMetaUrl));
}
