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
        /** When `true`, the upstream joins the `_all` aggregate slot once connected. */
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
