/**
 * Loads a local `.mcpb` bundle into a {@link StdioUpstreamConfig}.
 *
 * A `.mcpb` bundle is a ZIP holding a `manifest.json` whose `server.mcp_config`
 * describes a stdio MCP server process. The broker:
 *
 * 1. verifies a **detached signature** of the `.mcpb` file against a trusted
 *    public key (PEM) — integrity *and* provenance, using `node:crypto` only;
 * 2. unpacks the archive;
 * 3. reads the manifest, expands the `mcp_config` placeholders, and produces a
 *    `StdioUpstreamConfig` that the existing upstream wiring spawns.
 *
 * The broker stays compatible with the `.mcpb` format without depending on the
 * `@anthropic-ai/mcpb` package: the bundle's *own* (native PKCS#7) signature is
 * never parsed — the detached signature layer is the broker's trust anchor.
 *
 * Any failure (missing files, bad signature, malformed manifest, missing
 * `user_config` value) is logged and yields `null`: the bundle is refused and
 * no process is ever spawned. Never auto-runs an unverified bundle.
 */
import { createPublicKey, verify, X509Certificate, type KeyObject } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { unzipMcpb } from "./mcpb.unzip.js";
import type { StdioUpstreamConfig } from "./stdio.upstream.js";

/** A `.mcpb` bundle entry from the broker config file. */
export interface McpbBundleConfig {
    /** Provider slot name the bundle is bound to. */
    name: string;
    /** Path to the `.mcpb` file. */
    path: string;
    /** Path to the trusted public key (PEM) verifying the detached signature. */
    publicKey: string;
    /** Path to the detached signature file. Defaults to `<path>.sig`. */
    signature?: string;
    /** Values substituted into the manifest's `${user_config.*}` placeholders. */
    userConfig?: Record<string, string | number | boolean | Array<string | number>>;
    /** When `false`, the bundle stays out of the `_all` aggregate slot. Defaults to `true`. */
    aggregate?: boolean;
}

interface McpConfig {
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    platform_overrides?: Record<string, { command?: string; args?: string[]; env?: Record<string, string> }>;
}

/** Loads a PEM that holds either an X.509 certificate or a bare public key. */
function loadPublicKey(pem: string): KeyObject {
    if (pem.includes("BEGIN CERTIFICATE")) {
        return new X509Certificate(pem).publicKey;
    }
    return createPublicKey(pem);
}

/** Verifies the detached `signature` of `data` against `publicKey`. */
function verifyDetachedSignature(data: Buffer, signature: Buffer, publicKey: KeyObject): boolean {
    // Ed25519/Ed448 are used without a separate hash algorithm; RSA/EC need one.
    const keyType = publicKey.asymmetricKeyType;
    const algorithm = keyType === "ed25519" || keyType === "ed448" ? null : "sha256";
    return verify(algorithm, data, publicKey, signature);
}

/** Resolves a single `${...}` placeholder key, or `undefined` when unknown. */
function resolvePlaceholder(key: string, dirname: string, userConfig: McpbBundleConfig["userConfig"]): string | number | boolean | Array<string | number> | undefined {
    if (key === "__dirname") return dirname;
    if (key === "HOME") return homedir();
    if (key === "DESKTOP") return join(homedir(), "Desktop");
    if (key === "DOCUMENTS") return join(homedir(), "Documents");
    if (key === "DOWNLOADS") return join(homedir(), "Downloads");
    if (key === "pathSeparator" || key === "/") return sep;
    if (key.startsWith("user_config.")) {
        const name = key.slice("user_config.".length);
        const value = userConfig?.[name];
        if (value === undefined) throw new Error(`missing user_config value: "${name}"`);
        return value;
    }
    return undefined;
}

/** Expands placeholders in a scalar string (command, env value). */
function expandScalar(input: string, dirname: string, userConfig: McpbBundleConfig["userConfig"]): string {
    return input.replace(/\$\{([^}]+)\}/g, (match, key: string) => {
        const value = resolvePlaceholder(key, dirname, userConfig);
        if (value === undefined) return match; // unknown placeholder — leave verbatim
        if (Array.isArray(value)) throw new Error(`placeholder "\${${key}}" is multi-valued and cannot be used here`);
        return String(value);
    });
}

/** Expands one manifest argument; a standalone multi-valued placeholder spreads. */
function expandArg(arg: string, dirname: string, userConfig: McpbBundleConfig["userConfig"]): string[] {
    const standalone = /^\$\{(user_config\.[^}]+)\}$/.exec(arg);
    if (standalone) {
        const value = resolvePlaceholder(standalone[1], dirname, userConfig);
        if (Array.isArray(value)) return value.map(String);
        return [String(value)];
    }
    return [expandScalar(arg, dirname, userConfig)];
}

/**
 * Verifies, unpacks and resolves a `.mcpb` bundle into a `StdioUpstreamConfig`.
 *
 * @param cfg      The bundle entry from the broker config.
 * @param baseDir  Directory the bundle paths are resolved against.
 * @returns        A ready upstream config, or `null` when the bundle is refused.
 */
export async function loadMcpbBundle(cfg: McpbBundleConfig, baseDir: string): Promise<StdioUpstreamConfig | null> {
    const tag = `[mcp-broker] mcpb bundle "${cfg.name}"`;
    try {
        const mcpbPath = resolve(baseDir, cfg.path);
        const publicKeyPath = resolve(baseDir, cfg.publicKey);
        const signaturePath = cfg.signature ? resolve(baseDir, cfg.signature) : `${mcpbPath}.sig`;

        for (const [label, file] of [
            ["bundle", mcpbPath],
            ["public key", publicKeyPath],
            ["signature", signaturePath],
        ] as const) {
            if (!existsSync(file)) {
                console.error(`${tag}: ${label} file not found at ${file} — bundle refused.`);
                return null;
            }
        }

        // ── Signature verification (mandatory) ──────────────────────────────
        const bundleBytes = readFileSync(mcpbPath);
        const signatureBytes = readFileSync(signaturePath);
        const publicKey = loadPublicKey(readFileSync(publicKeyPath, "utf8"));
        if (!verifyDetachedSignature(bundleBytes, signatureBytes, publicKey)) {
            console.error(`${tag}: detached signature is invalid for the configured public key — bundle refused.`);
            return null;
        }

        // ── Unpack ──────────────────────────────────────────────────────────
        const outputDir = resolve(baseDir, ".cache", "mcpb", cfg.name);
        rmSync(outputDir, { recursive: true, force: true });
        unzipMcpb(mcpbPath, outputDir);

        // ── Manifest → mcp_config ───────────────────────────────────────────
        const manifestPath = join(outputDir, "manifest.json");
        if (!existsSync(manifestPath)) {
            console.error(`${tag}: manifest.json missing inside the bundle — bundle refused.`);
            return null;
        }
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { server?: { mcp_config?: McpConfig } };
        const mcpConfig = manifest.server?.mcp_config;
        if (!mcpConfig) {
            console.error(`${tag}: manifest has no server.mcp_config — bundle refused.`);
            return null;
        }

        // Platform-specific overrides replace the base fields when present.
        const override = mcpConfig.platform_overrides?.[process.platform];
        const command = override?.command ?? mcpConfig.command;
        const rawArgs = override?.args ?? mcpConfig.args ?? [];
        const rawEnv = { ...mcpConfig.env, ...override?.env };
        if (!command) {
            console.error(`${tag}: manifest mcp_config has no command — bundle refused.`);
            return null;
        }

        // ── Placeholder expansion ───────────────────────────────────────────
        const expandedCommand = expandScalar(command, outputDir, cfg.userConfig);
        const expandedArgs = rawArgs.flatMap((arg) => expandArg(arg, outputDir, cfg.userConfig));
        const expandedEnv: Record<string, string> = {};
        for (const [key, value] of Object.entries(rawEnv)) {
            expandedEnv[key] = expandScalar(value, outputDir, cfg.userConfig);
        }

        return {
            name: cfg.name,
            command: expandedCommand,
            args: expandedArgs,
            env: Object.keys(expandedEnv).length > 0 ? expandedEnv : undefined,
            aggregate: cfg.aggregate ?? true,
        };
    } catch (err) {
        console.error(`${tag}: ${(err as Error).message} — bundle refused.`);
        return null;
    }
}
