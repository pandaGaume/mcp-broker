#!/usr/bin/env node
/**
 * Standalone entry-point that starts the mcp-broker WebSocket server.
 *
 * ## Configuration sources (highest priority first)
 *
 * 1. Environment variables (`MCP_BROKER_*`).
 * 2. JSON config file. Resolved in order:
 *    a. `MCP_BROKER_CONFIG` env var.
 *    b. `./.mcp-broker/config.json` in the current working directory.
 *    c. `./mcp-broker.config.json` (legacy, with a deprecation warning).
 * 3. Built-in defaults.
 *
 * ## Path resolution
 *
 * - Env-var paths (`MCP_BROKER_*_DIR`, `MCP_BROKER_TLS_*`) are resolved
 *   against `process.cwd()`.
 * - Config-file paths (`tls.cert`, `www.mounts[*].dir`, `stdioUpstreams[*]`,
 *   `mcpbBundles[*]`) are resolved against the **config file's directory** — so a config in
 *   `./.mcp-broker/config.json` referring to `"certs/cert.pem"` points at
 *   `./.mcp-broker/certs/cert.pem`. The folder is self-contained.
 *
 * ## Local grammar overrides
 *
 * When `.mcp-broker/grammars/<userAgent>/<locale>.json` files exist next to
 * the config file, they are merged **on top of** the packaged grammars. Lets
 * users customize tool/resource descriptions for their organization without
 * forking the package.
 *
 * ## Environment variables
 *
 * | Variable                       | Default  | Notes                                                  |
 * |--------------------------------|----------|--------------------------------------------------------|
 * | MCP_BROKER_CONFIG              | (none)   | Path to a JSON config file (see above).                |
 * | MCP_BROKER_PORT                | 3000     |                                                        |
 * | MCP_BROKER_HOST                | 0.0.0.0  |                                                        |
 * | MCP_BROKER_PROVIDER_PATH       | /provider| Prefix for provider WS                                 |
 * | MCP_BROKER_CLIENT_PATH         | /        | Prefix for raw WS clients                              |
 * | MCP_BROKER_MCP_PATH            | /mcp     | Suffix for Streamable HTTP transport                   |
 * | MCP_BROKER_WWW_DIR             | (none)   | Ergonomic shortcut: mount this directory at "/"        |
 * | MCP_BROKER_BUNDLE_DIR          | (none)   | Ergonomic shortcut: mount this directory at "/bundle"  |
 * | MCP_BROKER_OPEN                | (unset)  | "1" to auto-launch the default browser at the root URL |
 * | MCP_BROKER_TLS_CERT            | (none)   | Path to a PEM TLS certificate                          |
 * | MCP_BROKER_TLS_KEY             | (none)   | Path to a PEM private key                              |
 * | MCP_BROKER_PROTOCOL            | auto     | "http" to force plain, "https" to force TLS, otherwise |
 * |                                |          | TLS is enabled iff cert+key are both set               |
 * | MCP_BROKER_STDIO_PROVIDER      | (none)   | When set, stdin/stdout carry JSON-RPC for the named    |
 * |                                |          | provider (Claude Desktop bridge).                      |
 * | MCP_BROKER_LOCALE              | en       | Locale used for tool descriptions on the `_broker`     |
 * |                                |          | slot. ISO 639-1 base; regional variants accepted.      |
 */
import * as fs from "fs";
import * as path from "path";
import open from "open";
import { WsTunnelBuilder } from "./index.js";
import { loadBrokerConfig } from "./config.js";
import { loadMcpbBundle } from "./mcpb.loader.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const { config, baseDir } = loadBrokerConfig();
const cwd = process.cwd();

/**
 * Fills an env var from the config file when the env var is not already set.
 * Used for **non-path** scalars — path-bearing fields are read directly so
 * they can be resolved against `baseDir` (config file's directory) instead
 * of `cwd` (deploy environment).
 */
function envFromConfig(envName: string, configValue: string | number | boolean | undefined): void {
    if (configValue === undefined || configValue === null) return;
    if (process.env[envName] !== undefined && process.env[envName] !== "") return;
    process.env[envName] = String(configValue);
}

envFromConfig("MCP_BROKER_PORT", config.port);
envFromConfig("MCP_BROKER_HOST", config.host);
envFromConfig("MCP_BROKER_PROTOCOL", config.protocol);
envFromConfig("MCP_BROKER_LOCALE", config.locale);
envFromConfig("MCP_BROKER_STDIO_PROVIDER", config.stdioProvider);
envFromConfig("MCP_BROKER_PROVIDER_PATH", config.paths?.provider);
envFromConfig("MCP_BROKER_CLIENT_PATH", config.paths?.client);
envFromConfig("MCP_BROKER_MCP_PATH", config.paths?.mcp);
envFromConfig("MCP_BROKER_OPEN", config.www?.open === true ? "1" : undefined);

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
const ssePath = config.paths?.sse ?? "/sse";

// ── TLS material ─────────────────────────────────────────────────────────────
// Env var (relative to cwd) wins over config (relative to baseDir).
const tlsCertPath = process.env["MCP_BROKER_TLS_CERT"] ? path.resolve(cwd, process.env["MCP_BROKER_TLS_CERT"]) : config.tls?.cert ? path.resolve(baseDir, config.tls.cert) : null;
const tlsKeyPath = process.env["MCP_BROKER_TLS_KEY"] ? path.resolve(cwd, process.env["MCP_BROKER_TLS_KEY"]) : config.tls?.key ? path.resolve(baseDir, config.tls.key) : null;

const protocolOverride = process.env["MCP_BROKER_PROTOCOL"]?.toLowerCase();
if (protocolOverride !== undefined && protocolOverride !== "http" && protocolOverride !== "https") {
    console.error(`[mcp-broker] Invalid MCP_BROKER_PROTOCOL="${protocolOverride}". Use "http" or "https".`);
    process.exit(1);
}
if (protocolOverride === "https" && (!tlsCertPath || !tlsKeyPath)) {
    console.error("[mcp-broker] MCP_BROKER_PROTOCOL=https requires TLS cert+key (via config.tls or MCP_BROKER_TLS_CERT/KEY).");
    process.exit(1);
}

const useTls = protocolOverride === "http" ? false : protocolOverride === "https" ? true : !!(tlsCertPath && tlsKeyPath);

// ── Env-var static mount shortcuts (relative to cwd) ─────────────────────────
const envWwwDir = process.env["MCP_BROKER_WWW_DIR"] ? path.resolve(cwd, process.env["MCP_BROKER_WWW_DIR"]) : null;
const envBundleDir = process.env["MCP_BROKER_BUNDLE_DIR"] ? path.resolve(cwd, process.env["MCP_BROKER_BUNDLE_DIR"]) : null;

// ---------------------------------------------------------------------------
// Server bootstrap
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
    // Local grammar overrides: when `<baseDir>/grammars/` exists, the broker
    // server merges those JSON files on top of the packaged grammars.
    const localGrammarsDir = path.join(baseDir, "grammars");
    const hasLocalGrammars = fs.existsSync(localGrammarsDir);

    const builder = new WsTunnelBuilder().withPort(port).withProviderPath(providerPath).withClientPath(clientPath).withMcpPath(mcpPath);

    if (host) {
        builder.withHost(host);
    }

    if (useTls) {
        builder.withTlsFiles(tlsCertPath!, tlsKeyPath!);
    }

    // ── Static mounts ────────────────────────────────────────────────────────
    // First the env-var shortcuts (relative to cwd), then the config `www.mounts`
    // (relative to baseDir). Order matters: /bundle before / so the prefix router
    // can distinguish them. Subsequent registrations contribute additional mounts;
    // longest-prefix match wins at runtime.
    if (envBundleDir && fs.existsSync(envBundleDir)) {
        builder.withStaticMount("/bundle", envBundleDir);
    }
    if (envWwwDir && fs.existsSync(envWwwDir)) {
        builder.withStaticMount("/", envWwwDir);
    }
    if (config.www?.mounts) {
        for (const mount of config.www.mounts) {
            const abs = path.resolve(baseDir, mount.dir);
            if (fs.existsSync(abs)) {
                builder.withStaticMount(mount.urlPrefix, abs);
            } else {
                console.warn(`[mcp-broker] www.mounts entry "${mount.urlPrefix}" → ${abs} skipped (directory not found).`);
            }
        }
    }

    // ── Stdio upstreams ──────────────────────────────────────────────────────
    if (config.stdioUpstreams) {
        for (const u of config.stdioUpstreams) {
            builder.withStdioUpstream({
                name: u.name,
                command: u.command,
                args: u.args,
                env: u.env as NodeJS.ProcessEnv | undefined,
                aggregate: u.aggregate,
            });
        }
    }

    // ── Remote MCP server upstreams (reached by URL) ─────────────────────────
    // Config-discovered remote servers join the `_all` aggregate by default;
    // an explicit `aggregate: false` opts an entry out.
    if (config.mcpServers) {
        for (const s of config.mcpServers) {
            builder.withRemoteUpstream({ ...s, aggregate: s.aggregate ?? true });
        }
    }

    // ── Local `.mcpb` bundles ────────────────────────────────────────────────
    // Each bundle is signature-verified and unpacked before it is wired in as a
    // stdio upstream. A refused bundle is skipped (loadMcpbBundle logs why); it
    // never spawns a process. Bundles join `_all` by default (opt-out per entry).
    if (config.mcpbBundles) {
        for (const b of config.mcpbBundles) {
            const upstream = await loadMcpbBundle(b, baseDir);
            if (upstream) {
                builder.withStdioUpstream(upstream);
            }
        }
    }

    if (stdioProvider) {
        builder.withStdioClient(stdioProvider);
    }

    if (hasLocalGrammars) {
        builder.withBrokerLocalGrammarsDir(localGrammarsDir);
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
    const hasWwwRoot = !!(envWwwDir && fs.existsSync(envWwwDir)) || (config.www?.mounts ?? []).some((m) => m.urlPrefix === "/");

    console.log();
    console.log(`⚙️  mcp-broker started${useTls ? " (TLS)" : ""}`);
    console.log(hr);
    console.log(`📡  Provider WebSocket    ${wsScheme}://localhost:${port}${providerPath}/<name>`);
    console.log(`🔌  MCP (Streamable HTTP) ${localhost}/<name>/${mcpSuffix}`);
    console.log(`📺  Legacy SSE            ${localhost}/<name>/${sseSuffix}`);
    if (hasLocalGrammars) {
        console.log(`🌐  Local grammars        ${localGrammarsDir}`);
    }
    console.log(hr);
    console.log(`   Press Ctrl+C to stop.`);
    console.log();

    // Auto-launch browser only if explicitly opted in via MCP_BROKER_OPEN=1
    // AND a mount at "/" is configured.
    if (hasWwwRoot && process.env["MCP_BROKER_OPEN"] === "1") {
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
