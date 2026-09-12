import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { IAuthorizationPolicyConfig } from "./authorization/index";

export interface IBrokerAuthConfig extends IAuthorizationPolicyConfig {
    /** Master switch. Absent/`false` keeps the broker unauthenticated. */
    enabled?: boolean;
    /** Public origin the broker is reached at (e.g. `https://mcp.example.com`). */
    publicBaseUrl?: string;
    /** Authorization server issuer URL(s) advertised in the metadata. */
    authorizationServers?: string[];
    /** URL of the authorization server's JWKS document. */
    jwks?: string;
    /** Expected token issuer. Defaults to the sole `authorizationServers` entry. */
    issuer?: string;
    /** Scopes advertised in the metadata `scopes_supported`. */
    scopesSupported?: string[];
    /** Baseline scope(s) required to reach any slot. */
    requiredScopes?: string[];
    /** Per-slot required-scope overrides (e.g. an admin scope for `_broker`). */
    perSlotScopes?: Record<string, string[]>;
    /**
     * Per-provider scope requirements for the `_all` aggregate. Deprecated in
     * favor of hierarchical policy assignments.
     */
    providerScopes?: Record<string, string[]>;
    /**
     * Shared secret every provider must present to occupy a slot. Independent
     * of client authorization.
     */
    providerSecret?: string;
}

/**
 * Shape of the optional JSON config file consumed by `bin.ts` at startup.
 * Every field is optional. Environment variables (`MCP_BROKER_*`) always win
 * over file values, and file values win over the built-in defaults.
 *
 * @example
 * ```json
 * {
 *     "port": 3001,
 *     "locale": "fr",
 *     "tls": { "cert": "certs/cert.pem", "key": "certs/key.pem" },
 *     "stdioUpstreams": [
 *         { "name": "fs", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/data"] }
 *     ]
 * }
 * ```
 */
export interface IBrokerConfig {
    /** TCP port. Maps to `MCP_BROKER_PORT`. */
    port?: number;

    /** Bind host. Maps to `MCP_BROKER_HOST`. */
    host?: string;

    /** Force protocol (`http`/`https`) regardless of cert presence. Maps to `MCP_BROKER_PROTOCOL`. */
    protocol?: "http" | "https";

    /** Locale fed to the broker grammar resolver. Maps to `MCP_BROKER_LOCALE`. */
    locale?: string;

    /** Bridge stdin/stdout for a Claude-Desktop-style client. Maps to `MCP_BROKER_STDIO_PROVIDER`. */
    stdioProvider?: string;

    /**
     * Logical broker name reported by `broker_info`.
     *
     * **Library-only today.** `WsTunnel` honors it
     * (`IWsTunnelOptions.brokerName`), but `WsTunnelBuilder` has no
     * `withBrokerName()`, so the CLI cannot forward it and setting it in
     * `config.json` has no effect. Set it through the programmatic API until
     * the setter exists.
     */
    brokerName?: string;

    /**
     * How often (ms) the broker pings each connected provider socket to check
     * it is still there. `0` disables the heartbeat. Maps to
     * `MCP_BROKER_PROVIDER_HEARTBEAT_MS`.
     *
     * A provider that misses a full interval is terminated and its slot freed,
     * which is what stops a half-open socket (a killed browser tab, a slept
     * laptop, a dropped VPN) from holding a slot for the ~2 hours the OS takes
     * to give up on the TCP connection, refusing every reconnect meanwhile.
     *
     * @default 30000
     */
    providerHeartbeatIntervalMs?: number;

    /**
     * How long (ms) the broker waits for a provider to answer one request
     * before failing it with a JSON-RPC error naming the slot. `0` disables the
     * deadline. Maps to `MCP_BROKER_PROVIDER_REQUEST_TIMEOUT_MS`.
     *
     * Raise it if you host genuinely long-running tools; without it a provider
     * that stays connected and never answers (a throttled background browser
     * tab is the ordinary case) leaves the caller waiting forever.
     *
     * @default 60000
     */
    providerRequestTimeoutMs?: number;

    /**
     * What happens when a provider connects to a slot another socket already
     * holds. Maps to `MCP_BROKER_PROVIDER_TAKEOVER`.
     *
     * - `"reject"`: the incumbent always keeps the slot.
     * - `"liveness"` (default): the incumbent keeps it only while it answers
     *   the heartbeat.
     * - `"always"`: the newcomer wins, but only when provider authentication is
     *   configured and it authenticated as the same principal as the incumbent.
     *   Without provider auth the broker falls back to `"liveness"` and says so,
     *   because unconditional takeover would let anyone who can reach the URL
     *   evict the real provider.
     *
     * @default "liveness"
     */
    providerTakeover?: "reject" | "liveness" | "always";

    /**
     * Browser origins allowed to reach `/<slot>/mcp`.
     *
     * Absent means no browser origin is accepted: a request carrying an
     * `Origin` header gets `403`, one carrying none (Claude Desktop, MCP
     * Inspector, any server-side SDK) always passes. The MCP specification asks
     * for this check, since without it any web page loaded in a browser that
     * can reach the broker could drive it.
     *
     * An array lists origins matched **exactly**. An object supplies a regular
     * expression tested against the whole `Origin` header. Also maps to
     * `MCP_BROKER_ALLOWED_ORIGINS` (comma-separated list form only; a pattern
     * needs the config file).
     *
     * @example
     * ```json
     * { "allowedOrigins": ["https://app.example.com", "http://localhost:5173"] }
     * { "allowedOrigins": { "pattern": "^https://[a-z0-9-]+\\.example\\.com$" } }
     * ```
     */
    allowedOrigins?: string[] | { pattern: string; flags?: string };

    /**
     * OAuth 2.1 resource-server authorization. When `enabled` is `true`, every
     * HTTP client request to a slot must carry a valid `Authorization: Bearer`
     * token issued for that slot, and the broker publishes Protected Resource
     * Metadata (RFC 9728). Absent/`false` ⇒ no authentication (trusted-network
     * mode, the historical behavior).
     *
     * Scalars also map to env vars (which win): `MCP_BROKER_AUTH_ENABLED`,
     * `MCP_BROKER_PUBLIC_BASE_URL`, `MCP_BROKER_JWKS`, `MCP_BROKER_ISSUER`.
     */
    auth?: IBrokerAuthConfig;

    /**
     * URL paths (override the defaults). Every key is also settable through an
     * environment variable, which wins.
     *
     * Changing one moves an endpoint for **every** peer: a provider SDK, a
     * client, and the startup banner all have to agree. The two provider paths
     * are not interchangeable, they carry different framing:
     * `provider` is a prefix (`<provider>/<slot>`) speaking plain JSON-RPC
     * frames (`DirectTransport`), `providers` is matched exactly and speaks
     * multiplex envelopes (`MultiplexTransport`).
     */
    paths?: {
        /** Prefix for one-slot-per-socket provider connections. Maps to `MCP_BROKER_PROVIDER_PATH`. @default "/provider" */
        provider?: string;
        /** Exact path for multiplexed provider connections. Maps to `MCP_BROKER_PROVIDERS_PATH`. @default "/providers" */
        providers?: string;
        /** Prefix raw-WebSocket clients connect to. Maps to `MCP_BROKER_CLIENT_PATH`. @default "/" */
        client?: string;
        /** Per-slot suffix for the Streamable HTTP transport. Maps to `MCP_BROKER_MCP_PATH`. @default "/mcp" */
        mcp?: string;
        /** Per-slot suffix for the legacy SSE stream (GET). Maps to `MCP_BROKER_SSE_PATH`. @default "/sse" */
        sse?: string;
        /** Per-slot suffix for legacy SSE JSON-RPC posts. Maps to `MCP_BROKER_MESSAGES_PATH`. @default "/messages" */
        messages?: string;
    };

    /** TLS material as paths on disk. Resolved against the config file's directory. */
    tls?: {
        cert: string;
        key: string;
    };

    /**
     * Static-file serving alongside the JSON-RPC endpoints. JSON-RPC routes
     * always take precedence.
     */
    www?: {
        /**
         * Auto-launch the default browser on startup. Maps to `MCP_BROKER_OPEN`.
         *
         * - `false` / absent / `""` / `"0"`: do not open anything.
         * - `true` / `"1"`: open the broker root, `<scheme>://localhost:<port>/`.
         * - a path (`"/app/index.html"`): open that page on this broker.
         * - an absolute URL on this broker's own origin: opened as given.
         *
         * A URL on any other origin is refused with a message, and so is any
         * other string. See {@link resolveOpenTarget} for why.
         *
         * The browser opens only when a static mount actually covers the
         * resolved path; otherwise the broker says which mounts exist instead of
         * launching a browser onto a 404.
         */
        open?: boolean | string;
        /** URL-prefix → directory mappings. Longest-prefix match wins. */
        mounts?: Array<{
            urlPrefix: string;
            dir: string;
        }>;
    };

    /** Stdio upstream providers spawned by the broker at startup. */
    stdioUpstreams?: Array<{
        name: string;
        command: string;
        args?: string[];
        env?: Record<string, string>;
        /** When `true`, the upstream joins the `_all` aggregate slot once connected. */
        aggregate?: boolean;
    }>;

    /**
     * Remote MCP servers the broker connects out to and exposes as provider
     * slots. Each entry is reached by URL (Streamable HTTP / SSE / WebSocket);
     * local servers should be shipped as `.mcpb` bundles instead.
     */
    mcpServers?: Array<{
        name: string;
        url: string;
        transport?: "streamable-http" | "sse" | "websocket";
        headers?: Record<string, string>;
        /** Defaults to `true`; set to `false` to exclude this upstream from the `_all` aggregate slot. */
        aggregate?: boolean;
    }>;

    /**
     * Local `.mcpb` bundles the broker loads at startup and runs as stdio
     * provider slots. A bundle is a ZIP with a `manifest.json`; the broker
     * verifies a detached signature against a trusted public key before
     * unpacking and spawning it.
     */
    mcpbBundles?: Array<{
        /** Provider slot name the bundle is bound to. */
        name: string;
        /** Path to the `.mcpb` file (resolved against the config file's directory). */
        path: string;
        /** Path to the trusted public key (PEM) used to verify the detached signature. */
        publicKey: string;
        /** Path to the detached signature file. Defaults to `<path>.sig`. */
        signature?: string;
        /** Values substituted into the manifest's `${user_config.*}` placeholders. */
        userConfig?: Record<string, string | number | boolean | Array<string | number>>;
        /** Defaults to `true`; set to `false` to exclude this bundle from the `_all` aggregate slot. */
        aggregate?: boolean;
    }>;
}

/**
 * Returned by {@link loadBrokerConfig}. The {@link config} is the parsed JSON;
 * {@link baseDir} is the directory used to resolve relative paths inside it
 * (the directory containing the config file when one was found, otherwise
 * `process.cwd()`).
 */
export interface ILoadedBrokerConfig {
    config: IBrokerConfig;
    baseDir: string;
    /** Absolute path of the config file that was loaded, or `null` if none. */
    sourcePath: string | null;
}

/** Default folder name (relative to `process.cwd()`) holding broker-local files. */
export const DEFAULT_CONFIG_DIR = ".mcp-broker";

/** Default config filename inside {@link DEFAULT_CONFIG_DIR}. */
export const DEFAULT_CONFIG_FILENAME = "config.json";

/** Legacy flat config filename at the cwd root (pre-`.mcp-broker/` layout). */
export const LEGACY_CONFIG_FILENAME = "mcp-broker.config.json";

/**
 * Loads the broker config from a JSON file.
 *
 * Discovery order:
 * 1. The `path` argument when provided (explicit override).
 * 2. The `MCP_BROKER_CONFIG` env var.
 * 3. `./.mcp-broker/config.json` relative to `process.cwd()`.
 * 4. `./mcp-broker.config.json` relative to `process.cwd()` (legacy layout ,
 *    a deprecation warning is written to stderr).
 *
 * When no file is found, returns the built-in empty config with
 * `baseDir = process.cwd()`. On invalid JSON, logs a warning to stderr and
 * returns the same empty config, never throws.
 *
 * Paths inside the config file are intended to be resolved against
 * {@link ILoadedBrokerConfig.baseDir} by the consumer.
 */
export function loadBrokerConfig(path?: string): ILoadedBrokerConfig {
    const cwd = process.cwd();
    const envPath = process.env["MCP_BROKER_CONFIG"];

    let sourcePath: string | null = null;

    if (path) {
        sourcePath = resolve(cwd, path);
    } else if (envPath) {
        sourcePath = resolve(cwd, envPath);
    } else {
        const modern = resolve(cwd, DEFAULT_CONFIG_DIR, DEFAULT_CONFIG_FILENAME);
        const legacy = resolve(cwd, LEGACY_CONFIG_FILENAME);
        if (existsSync(modern)) {
            sourcePath = modern;
        } else if (existsSync(legacy)) {
            sourcePath = legacy;
            process.stderr.write(
                `[mcp-broker] Using legacy config at ${legacy}. ` + `Move it to ${resolve(cwd, DEFAULT_CONFIG_DIR, DEFAULT_CONFIG_FILENAME)} ` + `to silence this warning.\n`
            );
        }
    }

    if (!sourcePath || !existsSync(sourcePath)) {
        return { config: {}, baseDir: cwd, sourcePath: null };
    }

    const baseDir = dirname(sourcePath);

    try {
        const raw = readFileSync(sourcePath, "utf-8");
        const config = JSON.parse(raw) as IBrokerConfig;
        return { config, baseDir, sourcePath };
    } catch (err) {
        process.stderr.write(`[mcp-broker] Failed to parse config file at ${sourcePath}: ${(err as Error).message}\n`);
        return { config: {}, baseDir: cwd, sourcePath: null };
    }
}

/**
 * Outcome of {@link resolveOpenTarget}. Exactly one of the three states holds:
 *
 * - `{ url: null, path: null }` and no `error`: nothing should be opened.
 * - `{ url, path }`: open `url`; `path` is what a static mount has to cover.
 * - `{ url: null, path: null, error }`: the value was refused, `error` is a
 *   sentence to print verbatim that names both the fault and the fix.
 */
export interface IOpenTargetResolution {
    /** Absolute URL to hand to the platform opener, or `null` to open nothing. */
    url: string | null;
    /** Path portion of {@link url} (always starts with `/`), or `null`. */
    path: string | null;
    /** Set when the raw value was refused. Human-readable, names the fix. */
    error?: string;
}

/**
 * Resolves `www.open` / `MCP_BROKER_OPEN` into an absolute URL to launch.
 *
 * Lives here rather than in `bin.ts` because `bin.ts` starts a server the
 * moment it is imported, so nothing in it can be unit-tested.
 *
 * Accepted forms (leading/trailing whitespace is trimmed):
 *
 * | `raw`                      | result                                    |
 * |----------------------------|-------------------------------------------|
 * | `undefined`, `false`, `""`, `"0"`, `"false"` | open nothing            |
 * | `true`, `"1"`, `"true"`    | `<baseUrl>/`                              |
 * | `"/app/"`, `"/index.html"` | resolved against `baseUrl`                |
 * | `"http://localhost:3000/x"`| passed through when the origin is `baseUrl`'s |
 * | anything else              | refused, with `error` explaining why       |
 *
 * Two refusals are security-load-bearing rather than pedantic:
 *
 * - **A foreign origin is refused.** Auto-opening is a startup convenience, and
 *   a config file (or an env var inherited from a parent process) that can make
 *   the broker launch a browser at an arbitrary site is a phishing primitive
 *   with no upside: nothing about starting a broker requires visiting another
 *   host. Open it yourself, or point `open` at a page this broker serves.
 * - **`//host/path` is refused** even though it starts with `/`: it is a
 *   protocol-relative URL, so `new URL("//evil.example/x", base)` resolves to
 *   `evil.example` and a naive "starts with a slash so it is local" test lets
 *   it through.
 *
 * Anything that is neither is refused rather than forwarded, because the
 * platform opener performs no validation of its own: a typo'd relative path is
 * handed to the shell and can launch a local file or a registered application.
 *
 * @param raw     The configured value (`config.www.open`) or the raw env string.
 * @param baseUrl Origin this broker is reachable at, e.g. `http://localhost:3000`.
 */
export function resolveOpenTarget(raw: boolean | string | undefined | null, baseUrl: string): IOpenTargetResolution {
    const nothing: IOpenTargetResolution = { url: null, path: null };

    if (raw === undefined || raw === null || raw === false) return nothing;
    if (raw === true) return resolveOpenTarget("/", baseUrl);

    const value = String(raw).trim();
    if (value === "" || value === "0" || value === "false") return nothing;
    if (value === "1" || value === "true") return resolveOpenTarget("/", baseUrl);

    const refuse = (why: string): IOpenTargetResolution => ({
        url: null,
        path: null,
        error:
            `${why} Set it to true (or "1") for the broker root, to a path on this broker such as "/app/index.html", ` +
            `or to an absolute URL on ${baseUrl}. Leave it out to open nothing.`,
    });

    // Protocol-relative: starts with a slash but resolves off-origin.
    if (value.startsWith("//")) {
        return refuse(`Refusing to open "${value}": a value starting with "//" is a protocol-relative URL and points at another host, not at this broker.`);
    }

    // Only two spellings are accepted, so that a bare word (almost always a
    // typo) is reported rather than silently resolved onto the broker root.
    const isAbsolutePath = value.startsWith("/");
    const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value);
    if (!isAbsolutePath && !hasScheme) {
        return refuse(`Refusing to open "${value}": it is neither a path starting with "/" nor an absolute http(s) URL.`);
    }

    let resolved: URL;
    try {
        resolved = new URL(value, baseUrl);
    } catch {
        return refuse(`Refusing to open "${value}": it is not a valid path or URL.`);
    }

    if (hasScheme) {
        // Decide on the parsed form, not on the raw string: `localhost:3000/x`
        // looks like a host but parses with the scheme `localhost:`.
        if (resolved.protocol !== "http:" && resolved.protocol !== "https:") {
            return refuse(`Refusing to open "${value}": only http and https URLs are opened, and "${resolved.protocol}" is neither.`);
        }
        const base = new URL(baseUrl);
        if (resolved.origin !== base.origin) {
            return refuse(`Refusing to open "${value}": it points at ${resolved.origin}, which is not this broker (${base.origin}).`);
        }
    }

    return { url: resolved.toString(), path: resolved.pathname };
}

/** @deprecated Use {@link IBrokerAuthConfig}. */
export type BrokerAuthConfig = IBrokerAuthConfig;

/** @deprecated Use {@link IBrokerConfig}. */
export type BrokerConfig = IBrokerConfig;

/** @deprecated Use {@link ILoadedBrokerConfig}. */
export type LoadedBrokerConfig = ILoadedBrokerConfig;
