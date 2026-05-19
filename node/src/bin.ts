#!/usr/bin/env node
/**
 * Standalone entry-point that starts the mcp-broker WebSocket server.
 *
 * ## Environment variables
 *
 * | Variable                       | Default  | Notes                                                  |
 * |--------------------------------|----------|--------------------------------------------------------|
 * | MCP_BROKER_PORT                | 3000     |                                                        |
 * | MCP_BROKER_HOST                | 0.0.0.0  |                                                        |
 * | MCP_BROKER_PROVIDER_PATH       | /provider| Prefix for provider WS                                 |
 * | MCP_BROKER_CLIENT_PATH         | /        | Prefix for raw WS clients                              |
 * | MCP_BROKER_MCP_PATH            | /mcp     | Suffix for Streamable HTTP transport                   |
 * | MCP_BROKER_WWW_DIR             | (none)   | If set, mount this directory at "/" (dev harness, etc.)|
 * | MCP_BROKER_BUNDLE_DIR          | (none)   | If set, mount this directory at "/bundle"              |
 * | MCP_BROKER_OPEN                | (unset)  | "1" to auto-launch the default browser at the root URL |
 * |                                |          | (requires MCP_BROKER_WWW_DIR to be set).               |
 * | MCP_BROKER_TLS_CERT            | (none)   | Path to a PEM TLS certificate                          |
 * | MCP_BROKER_TLS_KEY             | (none)   | Path to a PEM private key                              |
 * | MCP_BROKER_PROTOCOL            | auto     | "http" to force plain, "https" to force TLS, otherwise |
 * |                                |          | TLS is enabled iff cert+key are both set               |
 * | MCP_BROKER_STDIO_PROVIDER      | (none)   | When set, stdin/stdout carry JSON-RPC for the named    |
 * |                                |          | provider (Claude Desktop bridge). All logging is       |
 * |                                |          | redirected to stderr automatically.                    |
 *
 * Paths in *_DIR / *_CERT / *_KEY variables are resolved relative to `process.cwd()`.
 */
import * as fs from "fs";
import * as path from "path";
import open from "open";
import { WsTunnelBuilder } from "./index.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const stdioProvider = process.env["MCP_BROKER_STDIO_PROVIDER"];

// In stdio mode stdout is reserved for JSON-RPC — redirect all console output to stderr.
if (stdioProvider) {
    const toStderr = (...args: unknown[]) => process.stderr.write(args.join(" ") + "\n");
    console.log = toStderr;
    console.info = toStderr;
    console.warn = toStderr;
    console.error = toStderr;
}

const port = parseInt(process.env["MCP_BROKER_PORT"] ?? "3000", 10);
const host = process.env["MCP_BROKER_HOST"];
const providerPath = process.env["MCP_BROKER_PROVIDER_PATH"] ?? "/provider";
const clientPath = process.env["MCP_BROKER_CLIENT_PATH"] ?? "/";
const mcpPath = process.env["MCP_BROKER_MCP_PATH"] ?? "/mcp";
const ssePath = "/sse";
const tlsCertFile = process.env["MCP_BROKER_TLS_CERT"];
const tlsKeyFile = process.env["MCP_BROKER_TLS_KEY"];

// Protocol override: "http" | "https" | undefined (auto)
const protocolOverride = process.env["MCP_BROKER_PROTOCOL"]?.toLowerCase();
if (protocolOverride !== undefined && protocolOverride !== "http" && protocolOverride !== "https") {
    console.error(`[mcp-broker] Invalid MCP_BROKER_PROTOCOL="${protocolOverride}". Use "http" or "https".`);
    process.exit(1);
}
if (protocolOverride === "https" && (!tlsCertFile || !tlsKeyFile)) {
    console.error("[mcp-broker] MCP_BROKER_PROTOCOL=https requires MCP_BROKER_TLS_CERT and MCP_BROKER_TLS_KEY.");
    process.exit(1);
}

/**
 * Whether to enable TLS:
 *  - "http"  → never (ignores cert/key even if present)
 *  - "https" → always (cert+key required, validated above)
 *  - auto    → yes when both cert and key env vars are set
 */
const useTls = protocolOverride === "http" ? false : protocolOverride === "https" ? true : !!(tlsCertFile && tlsKeyFile);

// Optional static mounts (only when explicitly configured).
const wwwDir = process.env["MCP_BROKER_WWW_DIR"] ? path.resolve(process.cwd(), process.env["MCP_BROKER_WWW_DIR"]) : null;
const bundleDir = process.env["MCP_BROKER_BUNDLE_DIR"] ? path.resolve(process.cwd(), process.env["MCP_BROKER_BUNDLE_DIR"]) : null;

// ---------------------------------------------------------------------------
// Server bootstrap
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
    const builder = new WsTunnelBuilder().withPort(port).withProviderPath(providerPath).withClientPath(clientPath).withMcpPath(mcpPath);

    if (host) {
        builder.withHost(host);
    }

    if (useTls) {
        builder.withTlsFiles(path.resolve(process.cwd(), tlsCertFile!), path.resolve(process.cwd(), tlsKeyFile!));
    }

    // Mount static directories that actually exist on disk.
    // /bundle must be registered before / so the prefix router can distinguish them.
    if (bundleDir && fs.existsSync(bundleDir)) {
        builder.withStaticMount("/bundle", bundleDir);
    }
    if (wwwDir && fs.existsSync(wwwDir)) {
        builder.withStaticMount("/", wwwDir);
    }

    if (stdioProvider) {
        builder.withStdioClient(stdioProvider);
    }

    const tunnel = builder.build();
    await tunnel.start();

    // ── Startup banner ──────────────────────────────────────────────────────
    const httpScheme = useTls ? "https" : "http";
    const wsScheme = useTls ? "wss" : "ws";
    const hr = "─".repeat(64);
    const localhost = `${httpScheme}://localhost:${port}`;
    const mcpSuffix = mcpPath.replace(/^\//, "");
    const sseSuffix = ssePath.replace(/^\//, "");
    const hasWww = !!(wwwDir && fs.existsSync(wwwDir));

    console.log();
    console.log(`⚙️  mcp-broker started${useTls ? " (TLS)" : ""}`);
    console.log(hr);
    console.log(`📡  Provider WebSocket   ${wsScheme}://localhost:${port}${providerPath}/<name>`);
    console.log(`🔌  MCP (Streamable HTTP) ${localhost}/<name>/${mcpSuffix}`);
    console.log(`📺  Legacy SSE            ${localhost}/<name>/${sseSuffix}`);
    if (hasWww) {
        console.log();
        console.log(`🖥️   Static mount         ${localhost}/   →  ${wwwDir}`);
    }
    console.log(hr);
    console.log(`   Press Ctrl+C to stop.`);
    console.log();

    // Auto-launch browser only if explicitly opted in via MCP_BROKER_OPEN=1
    // AND a www mount is configured.
    if (hasWww && process.env["MCP_BROKER_OPEN"] === "1") {
        const url = `${localhost}/`;
        console.log(`🚀  Opening browser: ${url}`);
        console.log();
        await open(url);
    }

    // ── Signal handlers ─────────────────────────────────────────────────────
    const shutdown = async (signal: string): Promise<void> => {
        console.log(`\n⛔  ${signal} received — shutting down…`);
        await tunnel.stop();
        process.exit(0);
    };

    process.on("SIGINT", () => void shutdown("SIGINT"));
    process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err: unknown) => {
    console.error("[mcp-broker] Fatal error:", err);
    process.exit(1);
});
