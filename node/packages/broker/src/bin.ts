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
 *   `mcpbBundles[*]`) are resolved against the **config file's directory**: so a config in
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
 * | MCP_BROKER_PROVIDER_PATH       | /provider| Prefix for one-slot-per-socket providers (plain frames)|
 * | MCP_BROKER_PROVIDERS_PATH      |/providers| Exact path for multiplexed providers (envelope frames) |
 * | MCP_BROKER_CLIENT_PATH         | /        | Prefix for raw WS clients                              |
 * | MCP_BROKER_MCP_PATH            | /mcp     | Suffix for Streamable HTTP transport                   |
 * | MCP_BROKER_SSE_PATH            | /sse     | Suffix for the legacy SSE stream (GET)                 |
 * | MCP_BROKER_MESSAGES_PATH       | /messages| Suffix for legacy SSE JSON-RPC posts                   |
 * | MCP_BROKER_WWW_DIR             | (none)   | Ergonomic shortcut: mount this directory at "/"        |
 * | MCP_BROKER_BUNDLE_DIR          | (none)   | Ergonomic shortcut: mount this directory at "/bundle"  |
 * | MCP_BROKER_OPEN                | (unset)  | "1" for the root URL, or a path/same-origin URL to open|
 * | MCP_BROKER_TLS_CERT            | (none)   | Path to a PEM TLS certificate                          |
 * | MCP_BROKER_TLS_KEY             | (none)   | Path to a PEM private key                              |
 * | MCP_BROKER_PROTOCOL            | auto     | "http" to force plain, "https" to force TLS, otherwise |
 * |                                |          | TLS is enabled iff cert+key are both set               |
 * | MCP_BROKER_STDIO_PROVIDER      | (none)   | When set, stdin/stdout carry JSON-RPC for the named    |
 * |                                |          | provider (Claude Desktop bridge).                      |
 * | MCP_BROKER_LOCALE              | en       | Locale used for tool descriptions on the `_broker`     |
 * |                                |          | slot. ISO 639-1 base; regional variants accepted.      |
 * | MCP_BROKER_ALLOWED_ORIGINS     | (none)   | Comma-separated browser origins allowed on the client  |
 * |                                |          | HTTP surface (`/<slot>/mcp`, `/sse`, `/messages`).     |
 * |                                |          | None means no browser origin passes.                   |
 * | MCP_BROKER_PROVIDER_HEARTBEAT_MS      | 30000 | Provider ws ping interval; 0 disables liveness.  |
 * | MCP_BROKER_PROVIDER_REQUEST_TIMEOUT_MS| 60000 | Deadline for one provider answer; 0 disables.    |
 * | MCP_BROKER_PROVIDER_TAKEOVER   | liveness | "reject" | "liveness" | "always" on slot contention |
 */
import * as fs from "fs";
import * as path from "path";
import open from "open";
import { WsTunnelBuilder, VERSION, PACKAGE_NAME, BROKER_PROVIDER_NAME, BROKER_AGGREGATE_NAME, type ProviderTakeoverMode } from "./index";
import { loadBrokerConfig, resolveOpenTarget } from "./config";
import { loadMcpbBundle } from "./mcpb/mcpb.loader";

// ---------------------------------------------------------------------------
// CLI flags
// ---------------------------------------------------------------------------
// Handled before ANY other work (config load, logging, server start) so that
// `--help` / `--version` never boot a server or bind a port.

const argv = process.argv.slice(2);

if (argv.includes("--help") || argv.includes("-h")) {
    printHelp();
    process.exit(0);
}
if (argv.includes("--version") || argv.includes("-v")) {
    process.stdout.write(`${PACKAGE_NAME} ${VERSION}\n`);
    process.exit(0);
}

function printHelp(): void {
    process.stdout.write(
        `\n${PACKAGE_NAME} ${VERSION}\n` +
            `WebSocket-based Model Context Protocol broker.\n\n` +
            `USAGE\n` +
            `  npx @cyanmycelium/mcp-broker             Start the broker (foreground)\n` +
            `  npx @cyanmycelium/mcp-broker --help      Show this help\n` +
            `  npx @cyanmycelium/mcp-broker --version   Print the version\n\n` +
            `The broker takes no positional arguments. Configure it with a\n` +
            `.mcp-broker/config.json file or MCP_BROKER_* environment variables\n` +
            `(env vars win over the file).\n\n` +
            `COMMON ENVIRONMENT VARIABLES\n` +
            `  MCP_BROKER_CONFIG           Path to a JSON config file\n` +
            `  MCP_BROKER_PORT             TCP port (default 3000)\n` +
            `  MCP_BROKER_HOST             Bind interface (default 0.0.0.0)\n` +
            `  MCP_BROKER_PROTOCOL         "http" | "https" (default: auto from TLS)\n` +
            `  MCP_BROKER_TLS_CERT         PEM certificate path (enables HTTPS/WSS)\n` +
            `  MCP_BROKER_TLS_KEY          PEM private key path\n` +
            `  MCP_BROKER_STDIO_PROVIDER   Bridge stdin/stdout to this provider ("_all" is the safe target)\n` +
            `  MCP_BROKER_LOCALE           Locale for _broker tool descriptions (default en)\n` +
            `  MCP_BROKER_ALLOWED_ORIGINS  Comma-separated browser origins allowed on /<slot>/mcp,\n` +
            `                              /<slot>/sse and /<slot>/messages (default: none pass)\n` +
            `  MCP_BROKER_WWW_DIR          Serve this directory at "/"\n` +
            `  MCP_BROKER_BUNDLE_DIR       Serve this directory at "/bundle"\n` +
            `  MCP_BROKER_OPEN             "1" to open the root in a browser, or a path such as /app/\n\n` +
            `ENDPOINT PATHS (change these only if every peer agrees)\n` +
            `  MCP_BROKER_PROVIDER_PATH    Prefix for one provider per socket (default /provider);\n` +
            `                              connect as <prefix>/<slot> with DirectTransport (plain frames)\n` +
            `  MCP_BROKER_PROVIDERS_PATH   Exact path for many providers on one socket (default /providers);\n` +
            `                              connect with MultiplexTransport (envelope frames)\n` +
            `  MCP_BROKER_CLIENT_PATH      Prefix for raw WebSocket clients (default /)\n` +
            `  MCP_BROKER_MCP_PATH         Streamable HTTP suffix (default /mcp)\n` +
            `  MCP_BROKER_SSE_PATH         Legacy SSE stream suffix (default /sse)\n` +
            `  MCP_BROKER_MESSAGES_PATH    Legacy SSE post suffix (default /messages)\n\n` +
            `PROVIDER LIVENESS\n` +
            `  MCP_BROKER_PROVIDER_HEARTBEAT_MS       Ping interval per provider socket (default 30000, 0 off)\n` +
            `  MCP_BROKER_PROVIDER_REQUEST_TIMEOUT_MS Deadline for one provider answer (default 60000, 0 off)\n` +
            `  MCP_BROKER_PROVIDER_TAKEOVER           reject | liveness | always (default liveness)\n\n` +
            `AUTHORIZATION (OAuth 2.1, opt-in)\n` +
            `  MCP_BROKER_AUTH_ENABLED     "1" to require bearer tokens on client endpoints\n` +
            `  MCP_BROKER_PUBLIC_BASE_URL  Public origin, e.g. https://mcp.example.com\n` +
            `  MCP_BROKER_JWKS             Authorization server JWKS URL\n` +
            `  MCP_BROKER_ISSUER           Expected token issuer\n` +
            `  MCP_BROKER_PROVIDER_SECRET  Shared secret required from providers\n\n` +
            `CONFIG-FILE ONLY (no env var; .mcp-broker/config.json)\n` +
            `  stdioUpstreams[]  Local MCP servers the broker spawns. NOT in _all unless "aggregate": true\n` +
            `  mcpServers[]      Remote MCP servers the broker dials out to. In _all unless "aggregate": false\n` +
            `  mcpbBundles[]     Signed .mcpb bundles, verified then spawned. In _all unless "aggregate": false\n` +
            `  www.mounts[]      Several urlPrefix -> dir mappings (the env vars above mount one each)\n` +
            `  allowedOrigins    Also accepts { "pattern": "<regexp>" }; the env var takes a list only\n` +
            `  auth.*            Roles, assignments, denies, per-slot and per-provider scopes\n` +
            `  brokerName        Library-only: no builder setter exists, so the CLI cannot forward it\n\n` +
            `RESERVED SLOTS (always present, no provider needed)\n` +
            `  _broker   Introspection: broker_info, providers_list, provider_status,\n` +
            `            broker_guide (integration docs), broker_diagnose (live problem report)\n` +
            `  _all      Live aggregate of every opted-in provider. The right target for\n` +
            `            MCP_BROKER_STDIO_PROVIDER, since it exists before any provider connects.\n\n` +
            `Start here: call broker_guide on the _broker slot for the integration guide.\n` +
            `Full reference: https://github.com/pandaGaume/mcp-broker/tree/main/node\n\n`
    );
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const { config, baseDir } = loadBrokerConfig();
const cwd = process.cwd();

/**
 * Fills an env var from the config file when the env var is not already set.
 * Used for **non-path** scalars, path-bearing fields are read directly so
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
envFromConfig("MCP_BROKER_PROVIDERS_PATH", config.paths?.providers);
envFromConfig("MCP_BROKER_CLIENT_PATH", config.paths?.client);
envFromConfig("MCP_BROKER_MCP_PATH", config.paths?.mcp);
envFromConfig("MCP_BROKER_SSE_PATH", config.paths?.sse);
envFromConfig("MCP_BROKER_MESSAGES_PATH", config.paths?.messages);
envFromConfig("MCP_BROKER_PROVIDER_HEARTBEAT_MS", config.providerHeartbeatIntervalMs);
envFromConfig("MCP_BROKER_PROVIDER_REQUEST_TIMEOUT_MS", config.providerRequestTimeoutMs);
envFromConfig("MCP_BROKER_PROVIDER_TAKEOVER", config.providerTakeover);
// `www.open` is `boolean | string`: `true` means the root, a string is a path
// or a same-origin URL. Both travel as the env string and are resolved once,
// by `resolveOpenTarget`, so the file and the env var cannot diverge.
envFromConfig("MCP_BROKER_OPEN", config.www?.open === true ? "1" : typeof config.www?.open === "string" ? config.www.open : undefined);
envFromConfig("MCP_BROKER_AUTH_ENABLED", config.auth?.enabled === true ? "1" : undefined);
envFromConfig("MCP_BROKER_PUBLIC_BASE_URL", config.auth?.publicBaseUrl);
envFromConfig("MCP_BROKER_JWKS", config.auth?.jwks);
envFromConfig("MCP_BROKER_ISSUER", config.auth?.issuer);
envFromConfig("MCP_BROKER_PROVIDER_SECRET", config.auth?.providerSecret);

const stdioProvider = process.env["MCP_BROKER_STDIO_PROVIDER"];

// In stdio mode stdout is reserved for JSON-RPC, redirect all console output to stderr.
if (stdioProvider) {
    const toStderr = (...args: unknown[]) => process.stderr.write(args.join(" ") + "\n");
    console.log = toStderr;
    console.info = toStderr;
    console.warn = toStderr;
    console.error = toStderr;
}

const port = parseInt(process.env["MCP_BROKER_PORT"] ?? "3000", 10);
const host = process.env["MCP_BROKER_HOST"];
// ── Endpoint paths ───────────────────────────────────────────────────────────
// All six resolve the same way (env, then config file, then the default) and all
// six are handed to the builder. Before this, `paths.providers` and
// `paths.messages` were read nowhere and `paths.sse` reached only the banner, so
// setting one advertised an endpoint the router did not serve.
const providerPath = process.env["MCP_BROKER_PROVIDER_PATH"] ?? "/provider";
const providersPath = process.env["MCP_BROKER_PROVIDERS_PATH"] ?? "/providers";
const clientPath = process.env["MCP_BROKER_CLIENT_PATH"] ?? "/";
const mcpPath = process.env["MCP_BROKER_MCP_PATH"] ?? "/mcp";
const ssePath = process.env["MCP_BROKER_SSE_PATH"] ?? "/sse";
const messagesPath = process.env["MCP_BROKER_MESSAGES_PATH"] ?? "/messages";

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

// ── Provider liveness knobs ──────────────────────────────────────────────────
// The defaults are correct for nearly everyone; these exist for the operator who
// has to tune them (long-running tools, a flaky link). An unusable value is
// reported and ignored rather than silently coerced, so nobody believes a
// setting is in force when it is not.

/**
 * Parses a millisecond count from an env var. Returns `undefined` (keep the
 * built-in default) when unset or unusable, after saying why.
 */
function millisFromEnv(envName: string): number | undefined {
    const raw = process.env[envName];
    if (raw === undefined || raw.trim() === "") return undefined;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) {
        console.warn(`[mcp-broker] Ignoring ${envName}="${raw}": expected a whole number of milliseconds (0 disables). Using the default.`);
        return undefined;
    }
    return Math.floor(value);
}

const providerHeartbeatIntervalMs = millisFromEnv("MCP_BROKER_PROVIDER_HEARTBEAT_MS");
const providerRequestTimeoutMs = millisFromEnv("MCP_BROKER_PROVIDER_REQUEST_TIMEOUT_MS");

const takeoverRaw = process.env["MCP_BROKER_PROVIDER_TAKEOVER"]?.trim().toLowerCase();
let providerTakeover: ProviderTakeoverMode | undefined;
if (takeoverRaw) {
    if (takeoverRaw === "reject" || takeoverRaw === "liveness" || takeoverRaw === "always") {
        providerTakeover = takeoverRaw;
    } else {
        console.warn(`[mcp-broker] Ignoring MCP_BROKER_PROVIDER_TAKEOVER="${takeoverRaw}": expected "reject", "liveness" or "always". Using "liveness".`);
    }
}

// ── Allowed browser origins for the client HTTP surface ──────────────────────
// Absent leaves the endpoint closed to browsers, which is the safe default.
// The env var only carries the list form; a pattern needs the config file,
// since a regular expression cannot survive comma-splitting.
const envOrigins = process.env["MCP_BROKER_ALLOWED_ORIGINS"]
    ?.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

let allowedOrigins: readonly string[] | RegExp | undefined;
if (envOrigins?.length) {
    allowedOrigins = envOrigins;
} else if (Array.isArray(config.allowedOrigins)) {
    allowedOrigins = config.allowedOrigins;
} else if (config.allowedOrigins) {
    try {
        allowedOrigins = new RegExp(config.allowedOrigins.pattern, config.allowedOrigins.flags);
    } catch (err) {
        // Falling back to the closed default rather than starting with a rule
        // the operator believes is in force but which never compiled.
        console.error(`[mcp-broker] Ignoring allowedOrigins.pattern: ${(err as Error).message}`);
    }
}

/**
 * One-line rendering of the resolved origin policy for the startup banner.
 *
 * Worth a banner row because the closed default is invisible otherwise: a page
 * served by this very broker still gets a 403 on `/<slot>/mcp` unless its origin
 * is listed, and nothing else says so until the request fails.
 */
function describeAllowedOrigins(): string {
    if (allowedOrigins instanceof RegExp) return `pattern ${String(allowedOrigins)}`;
    if (allowedOrigins && allowedOrigins.length > 0) return allowedOrigins.join(", ");
    return "none (set MCP_BROKER_ALLOWED_ORIGINS, or allowedOrigins in the config file). Requests carrying no Origin header (Claude Desktop, MCP Inspector, any server-side SDK) still pass";
}

// ── Env-var static mount shortcuts (relative to cwd) ─────────────────────────
const envWwwDir = process.env["MCP_BROKER_WWW_DIR"] ? path.resolve(cwd, process.env["MCP_BROKER_WWW_DIR"]) : null;
const envBundleDir = process.env["MCP_BROKER_BUNDLE_DIR"] ? path.resolve(cwd, process.env["MCP_BROKER_BUNDLE_DIR"]) : null;

/**
 * Warns when the stdio bridge is pinned to a slot this broker does not host.
 *
 * The bridge gates every frame, `initialize` included, on the slot being
 * occupied, so an MCP host that starts before the slot is claimed fails the
 * handshake and gives up: with a browser-hosted provider, which cannot be
 * connected before the host launches, this fails every single time. Naming the
 * slots the broker does have turns that into a one-line fix.
 *
 * Deliberately a warning, not an exit: a WebSocket provider may legitimately
 * claim the slot later, and a broker that refuses to start would be worse.
 */
function warnIfStdioTargetUnknown(target: string): void {
    const known = new Set<string>([
        BROKER_AGGREGATE_NAME,
        BROKER_PROVIDER_NAME,
        ...(config.stdioUpstreams ?? []).map((u) => u.name),
        ...(config.mcpServers ?? []).map((s) => s.name),
        ...(config.mcpbBundles ?? []).map((b) => b.name),
    ]);
    if (known.has(target)) return;

    const hosted = [...known].filter((name) => name !== BROKER_AGGREGATE_NAME && name !== BROKER_PROVIDER_NAME);
    console.warn(
        `[mcp-broker] MCP_BROKER_STDIO_PROVIDER="${target}" names a slot this broker does not host. ` +
            `Nothing answers on it until a WebSocket provider connects to ${providerPath}/${target} (or announces "${target}" on ${providersPath}), ` +
            `and until then every request from the MCP host, including the initial handshake, fails with 'Provider "${target}" not connected'. ` +
            `An MCP host that starts before that provider is up, which is always the case for a provider hosted in a browser page, will therefore never connect. ` +
            `Prefer MCP_BROKER_STDIO_PROVIDER="${BROKER_AGGREGATE_NAME}": it exists from startup, answers the handshake itself, unions every opted-in provider, ` +
            `and pushes notifications/tools/list_changed as providers join, so a page opened later appears live. ` +
            `Slots this broker hosts right now: ${hosted.length > 0 ? hosted.map((n) => `"${n}"`).join(", ") + `, plus the reserved "${BROKER_AGGREGATE_NAME}" and "${BROKER_PROVIDER_NAME}"` : `the reserved "${BROKER_AGGREGATE_NAME}" and "${BROKER_PROVIDER_NAME}" only`}.`
    );
}

// ---------------------------------------------------------------------------
// Server bootstrap
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
    // Local grammar overrides: when `<baseDir>/grammars/` exists, the broker
    // server merges those JSON files on top of the packaged grammars.
    const localGrammarsDir = path.join(baseDir, "grammars");
    const hasLocalGrammars = fs.existsSync(localGrammarsDir);

    const builder = new WsTunnelBuilder()
        .withPort(port)
        .withProviderPath(providerPath)
        .withProvidersPath(providersPath)
        .withClientPath(clientPath)
        .withMcpPath(mcpPath)
        .withSsePath(ssePath)
        .withMessagesPath(messagesPath);

    if (host) {
        builder.withHost(host);
    }

    if (providerHeartbeatIntervalMs !== undefined) {
        builder.withProviderHeartbeat(providerHeartbeatIntervalMs);
    }
    if (providerRequestTimeoutMs !== undefined) {
        builder.withProviderRequestTimeout(providerRequestTimeoutMs);
    }
    if (providerTakeover) {
        builder.withProviderTakeover(providerTakeover);
    }

    if (useTls) {
        // `withTlsFiles` reads both files synchronously and would otherwise
        // surface a bare ENOENT with no hint that TLS was on because a config
        // file mentioned it. That is the first wall a copied config template
        // hits, since the template ships `tls.cert`/`tls.key` but no `certs/`.
        try {
            builder.withTlsFiles(tlsCertPath!, tlsKeyPath!);
        } catch (err) {
            throw new Error(
                `TLS is enabled but the material could not be read: ${(err as Error).message}. ` +
                    `Certificate: ${tlsCertPath}, key: ${tlsKeyPath}. ` +
                    `Config-file paths are resolved against the config file's own directory, env-var paths against the current directory. ` +
                    `Generate a development pair, point tls.cert/tls.key (or MCP_BROKER_TLS_CERT/MCP_BROKER_TLS_KEY) at real files, ` +
                    `or run without TLS by removing the tls block and setting MCP_BROKER_PROTOCOL=http.`,
                { cause: err }
            );
        }
    }

    if (allowedOrigins) {
        builder.withAllowedOrigins(allowedOrigins);
    }

    // ── Static mounts ────────────────────────────────────────────────────────
    // First the env-var shortcuts (relative to cwd), then the config `www.mounts`
    // (relative to baseDir). Order matters: /bundle before / so the prefix router
    // can distinguish them. Subsequent registrations contribute additional mounts;
    // longest-prefix match wins at runtime.
    // Every prefix that actually got mounted, in registration order. The
    // browser-open check below tests the resolved path against this list rather
    // than against `config.www.mounts`, which would miss both env shortcuts and
    // would false-warn on a perfectly valid `open: "/bundle/"`.
    const mountedPrefixes: string[] = [];
    const mount = (urlPrefix: string, dir: string): void => {
        builder.withStaticMount(urlPrefix, dir);
        mountedPrefixes.push(urlPrefix);
    };

    if (envBundleDir && fs.existsSync(envBundleDir)) {
        mount("/bundle", envBundleDir);
    }
    if (envWwwDir && fs.existsSync(envWwwDir)) {
        mount("/", envWwwDir);
    }
    if (config.www?.mounts) {
        for (const entry of config.www.mounts) {
            const abs = path.resolve(baseDir, entry.dir);
            if (fs.existsSync(abs)) {
                mount(entry.urlPrefix, abs);
            } else {
                console.warn(`[mcp-broker] www.mounts entry "${entry.urlPrefix}" → ${abs} skipped (directory not found).`);
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
        warnIfStdioTargetUnknown(stdioProvider);
    }

    if (hasLocalGrammars) {
        builder.withBrokerLocalGrammarsDir(localGrammarsDir);
    }

    // ── Authorization (OAuth 2.1 resource server) ────────────────────────────
    // Opt-in: only wired when MCP_BROKER_AUTH_ENABLED / config.auth.enabled is on.
    // Env scalars win over config; array/object fields are read from config.
    const authEnabledEnv = process.env["MCP_BROKER_AUTH_ENABLED"];
    const authEnabled = authEnabledEnv === "1" || authEnabledEnv === "true";
    if (authEnabled) {
        const publicBaseUrl = process.env["MCP_BROKER_PUBLIC_BASE_URL"];
        const jwks = process.env["MCP_BROKER_JWKS"];
        const issuer = process.env["MCP_BROKER_ISSUER"];
        const authorizationServers = config.auth?.authorizationServers ?? (issuer ? [issuer] : []);
        if (!publicBaseUrl || !jwks || authorizationServers.length === 0) {
            console.error(
                "[mcp-broker] auth.enabled requires publicBaseUrl, jwks, and at least one " +
                    "authorizationServers entry (or issuer). Set them via config.auth or " +
                    "MCP_BROKER_PUBLIC_BASE_URL / MCP_BROKER_JWKS / MCP_BROKER_ISSUER."
            );
            process.exit(1);
        }
        builder.withJwtAuth({
            publicBaseUrl,
            authorizationServers,
            jwksUri: jwks,
            issuer,
            scopesSupported: config.auth?.scopesSupported,
            requiredScopes: config.auth?.requiredScopes,
            perSlotScopes: config.auth?.perSlotScopes,
            providerScopes: config.auth?.providerScopes,
            subjectMapping: config.auth?.subjectMapping,
            roles: config.auth?.roles,
            assignments: config.auth?.assignments,
            denies: config.auth?.denies,
            slotResources: config.auth?.slotResources,
            toolCapabilities: config.auth?.toolCapabilities,
            providerToolCapabilities: config.auth?.providerToolCapabilities,
            audit: config.auth?.audit,
        });
    }

    // ── Provider authentication (independent of client OAuth) ────────────────
    // Requires every provider connecting to /provider/<slot> or /providers to
    // present the shared secret, closes off slot occupation by strangers.
    const providerSecret = process.env["MCP_BROKER_PROVIDER_SECRET"];
    if (providerSecret) {
        builder.withProviderSecret(providerSecret);
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
    const messagesSuffix = messagesPath.replace(/^\//, "");

    // The two provider rows are the point of the banner: the endpoint chosen
    // decides the framing, and connecting the wrong transport to either one is
    // the single most common way an integration fails. So each row names the
    // transport class it requires, right there.
    console.log();
    console.log(`⚙️  mcp-broker started${useTls ? " (TLS)" : ""}`);
    console.log(hr);
    console.log(`📡  Provider WS direct    ${wsScheme}://localhost:${port}${providerPath}/<name>`);
    console.log(`                          one provider per socket, plain JSON-RPC frames: use DirectTransport`);
    console.log(`🧵  Provider WS multiplex ${wsScheme}://localhost:${port}${providersPath}`);
    console.log(`                          many providers per socket, envelope frames: use MultiplexTransport`);
    console.log(`🔌  MCP (Streamable HTTP) ${localhost}/<name>/${mcpSuffix}`);
    console.log(`📺  Legacy SSE            ${localhost}/<name>/${sseSuffix}  +  POST ${localhost}/<name>/${messagesSuffix}`);
    // Raw WS clients are a real, configurable route. Left off the banner it read
    // as provider-only, and `clientPath` reached the router and nothing else,
    // which is the same defect `paths.sse` had.
    console.log(`🔗  Client WS (raw)       ${wsScheme}://localhost:${port}${clientPath === "/" ? "/" : clientPath}<name>`);
    console.log(`                          bare JSON-RPC frames, no session layer; not origin-checked`);
    console.log(`🧩  Reserved slots        ${BROKER_AGGREGATE_NAME}: live aggregate of every opted-in provider`);
    console.log(`                          ${BROKER_PROVIDER_NAME}: broker_info, providers_list, provider_status, broker_guide, broker_diagnose`);
    if (mountedPrefixes.length > 0) {
        console.log(`📁  Static mounts         ${mountedPrefixes.map((prefix) => `${localhost}${prefix === "/" ? "/" : prefix + "/"}`).join("  ")}`);
    }
    if (hasLocalGrammars) {
        console.log(`🌐  Local grammars        ${localGrammarsDir}`);
    }
    console.log(`🔐  Authorization         ${authEnabled ? "OAuth 2.1 (Bearer required)" : "disabled (trusted network only)"}`);
    console.log(`🛡️   Provider auth         ${providerSecret ? "shared secret required" : "disabled"}`);
    console.log(`🌍  Browser origins       ${describeAllowedOrigins()}`);
    console.log(`                          enforced on /<name>/${mcpSuffix}, /<name>/${sseSuffix} and /<name>/${messagesSuffix}`);
    if (!allowedOrigins) {
        console.log(`                          a page this broker serves is refused too, list its origin to admit it`);
    }
    console.log(hr);
    console.log(`   New here? Call broker_guide on the ${BROKER_PROVIDER_NAME} slot: ${localhost}/${BROKER_PROVIDER_NAME}/${mcpSuffix}`);
    console.log(`   Press Ctrl+C to stop.`);
    console.log();

    // ── Auto-launch the browser ─────────────────────────────────────────────
    // Opt-in through MCP_BROKER_OPEN / www.open, and only onto a path a mount
    // actually serves: launching a browser at a 404 is worse than not launching.
    const openTarget = resolveOpenTarget(process.env["MCP_BROKER_OPEN"], localhost);
    if (openTarget.error) {
        console.warn(`[mcp-broker] ${openTarget.error}`);
    } else if (openTarget.url && openTarget.path) {
        const openUrl = openTarget.url;
        const openPath = openTarget.path;
        const covered = mountedPrefixes.some((prefix) => prefix === "/" || openPath === prefix || openPath.startsWith(prefix.endsWith("/") ? prefix : prefix + "/"));
        if (!covered) {
            console.warn(
                `[mcp-broker] Not opening ${openUrl}: no static mount serves "${openPath}", so it would 404. ` +
                    (mountedPrefixes.length > 0
                        ? `Mounted prefixes: ${mountedPrefixes.map((p) => `"${p}"`).join(", ")}.`
                        : `No directory is mounted. Add one with MCP_BROKER_WWW_DIR=<dir> (serves it at "/") or a www.mounts entry in the config file.`)
            );
        } else {
            console.log(`🚀  Opening browser: ${openUrl}`);
            console.log();
            try {
                await open(openUrl);
            } catch (err) {
                // The broker is listening and healthy; failing to spawn a browser
                // (a headless box, no default handler) must not take it down.
                console.warn(`[mcp-broker] Could not launch a browser for ${openUrl}: ${(err as Error).message}. The broker is running; open the URL yourself.`);
            }
        }
    }

    // ── Signal handlers ─────────────────────────────────────────────────────
    const shutdown = async (signal: string): Promise<void> => {
        console.log(`\n⛔  ${signal} received, shutting down…`);
        await tunnel.stop();
        process.exit(0);
    };

    process.on("SIGINT", () => void shutdown("SIGINT"));
    process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err: unknown) => {
    // `tunnel.start()` now rejects on a listen failure instead of dying as an
    // uncaught EventEmitter error, so this path is live where it used to be
    // unreachable, and the rejection carries a fully worded diagnosis (for
    // EADDRINUSE: the address, the URL to attach to the broker that already
    // holds the port, and the MCP_BROKER_PORT escape). Print the sentence, not
    // the object: `console.error("…", err)` renders a stack dump and buries it.
    //
    // In stdio mode console is redirected to stderr above, so this cannot
    // corrupt the JSON-RPC stream on stdout.
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[mcp-broker] Cannot start: ${message}`);

    // A wrapped cause keeps the original errno for anyone reading a host log.
    const cause = err instanceof Error ? err.cause : undefined;
    if (cause instanceof Error) {
        const code = (cause as NodeJS.ErrnoException).code;
        console.error(`[mcp-broker] Underlying error: ${code ? code + " " : ""}${cause.message}`);
    }

    // A bare Error with no diagnosis of its own is still worth grounding: say
    // where the broker was trying to listen, since that is the one fact the
    // reader needs to check next.
    if (!(err instanceof Error) || !message.includes(String(port))) {
        console.error(
            `[mcp-broker] Configuration in effect: host=${host ?? "0.0.0.0"} port=${port}. Set MCP_BROKER_PORT / MCP_BROKER_HOST, or "port" / "host" in .mcp-broker/config.json.`
        );
    }

    process.exit(1);
});
