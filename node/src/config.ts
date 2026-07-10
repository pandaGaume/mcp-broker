import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

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
export interface BrokerConfig {
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

    /** Logical broker name reported by `broker_info`. */
    brokerName?: string;

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
    auth?: {
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
         * Per-provider scope requirements for the `_all` aggregate. A caller sees
         * a provider in `_all` only if it holds at least one of the listed scopes.
         * Providers not listed stay visible to every authenticated caller.
         */
        providerScopes?: Record<string, string[]>;
        /**
         * Shared secret every provider must present to occupy a slot (via
         * `X-Provider-Token` or `Authorization: Bearer`). Independent of client
         * auth. Also settable via `MCP_BROKER_PROVIDER_SECRET` (which wins).
         */
        providerSecret?: string;
    };

    /** URL paths (override the defaults). */
    paths?: {
        provider?: string;
        providers?: string;
        client?: string;
        mcp?: string;
        sse?: string;
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
        /** Auto-launch the default browser at the root URL on startup. */
        open?: boolean;
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
export interface LoadedBrokerConfig {
    config: BrokerConfig;
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
 * 4. `./mcp-broker.config.json` relative to `process.cwd()` (legacy layout —
 *    a deprecation warning is written to stderr).
 *
 * When no file is found, returns the built-in empty config with
 * `baseDir = process.cwd()`. On invalid JSON, logs a warning to stderr and
 * returns the same empty config — never throws.
 *
 * Paths inside the config file are intended to be resolved against
 * {@link LoadedBrokerConfig.baseDir} by the consumer.
 */
export function loadBrokerConfig(path?: string): LoadedBrokerConfig {
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
        const config = JSON.parse(raw) as BrokerConfig;
        return { config, baseDir, sourcePath };
    } catch (err) {
        process.stderr.write(`[mcp-broker] Failed to parse config file at ${sourcePath}: ${(err as Error).message}\n`);
        return { config: {}, baseDir: cwd, sourcePath: null };
    }
}
