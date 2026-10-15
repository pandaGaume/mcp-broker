import { createRequire } from "node:module";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { IMessageTransport } from "@cyanmycelium/mcp-core";
import type { IProviderPrincipal } from "./auth/provider.auth";
import { compileProviderAllowedResources } from "./auth/provider.auth";
import type { ILoopbackProviderHandle } from "./ws/ws.interfaces";
import type { WsTunnel } from "./ws/ws.tunnel";

export interface IBrokerPluginConfig {
    readonly id: string;
    /** Installed package export, or local module path relative to the config. */
    readonly module: string;
    /** Identity from the security file, never a principal supplied by the plugin. */
    readonly provider: string;
    readonly aggregate?: boolean;
    /** Default true. A required plugin failure aborts startup and rolls back all plugins. */
    readonly required?: boolean;
    readonly config?: unknown;
}

export interface IBrokerPluginContext {
    readonly baseDir: string;
    registerSlot(name: string, transport: IMessageTransport): ILoopbackProviderHandle;
    /** Register disposals immediately, including resources acquired before start resolves. */
    onCleanup(dispose: () => void | Promise<void>): void;
    log(message: string): void;
}

export interface IBrokerPluginHandle {
    stop(): void | Promise<void>;
}

/** Trusted in-process code. The contract is a lifecycle API, not a security sandbox. */
export interface IBrokerPlugin {
    readonly apiVersion: 1;
    start(context: IBrokerPluginContext, config: unknown): IBrokerPluginHandle | Promise<IBrokerPluginHandle>;
}

export interface IBrokerPluginOptions {
    readonly tunnel: Pick<WsTunnel, "registerLoopbackProvider">;
    readonly baseDir: string;
    /** Bare package exports resolve from this deployment-owned directory. */
    readonly moduleDirectory?: string;
    readonly principals: ReadonlyMap<string, IProviderPrincipal>;
    readonly log?: (message: string) => void;
}

function validate(entries: unknown): asserts entries is readonly IBrokerPluginConfig[] {
    if (!Array.isArray(entries)) throw new Error("plugins must be an array");
    const ids = new Set<string>();
    for (const entry of entries) {
        if (!entry || typeof entry !== "object") throw new Error("each plugin must be an object");
        for (const key of ["id", "module", "provider"] as const) {
            if (typeof entry[key] !== "string" || !entry[key].trim()) throw new Error(`plugin ${key} must be a non-empty string`);
        }
        if (ids.has(entry.id)) throw new Error(`duplicate plugin id "${entry.id}"`);
        ids.add(entry.id);
        for (const key of ["required", "aggregate"] as const) {
            if (entry[key] !== undefined && typeof entry[key] !== "boolean") throw new Error(`plugin "${entry.id}": ${key} must be a boolean`);
        }
    }
}

function moduleUrl(specifier: string, options: IBrokerPluginOptions): string {
    if (isAbsolute(specifier) || specifier.startsWith("./") || specifier.startsWith("../")) return pathToFileURL(resolve(options.baseDir, specifier)).href;
    if (specifier.includes(":") || specifier.startsWith("#")) throw new Error("plugin module must be an installed package or a local file path");
    const require = createRequire(resolve(options.moduleDirectory ?? options.baseDir, "package.json"));
    return pathToFileURL(require.resolve(specifier)).href;
}

/** Starts explicitly configured modules only; never downloads or discovers executable code. */
export async function startBrokerPlugins(entries: readonly IBrokerPluginConfig[], options: IBrokerPluginOptions): Promise<IBrokerPluginHandle> {
    validate(entries);
    const running: IBrokerPluginHandle[] = [];
    let stopping: Promise<void> | undefined;
    const stop = (): Promise<void> =>
        (stopping ??= (async () => {
            const failures: unknown[] = [];
            for (const handle of running.reverse()) {
                try {
                    await handle.stop();
                } catch (error) {
                    failures.push(error);
                }
            }
            if (failures.length) throw new AggregateError(failures, "plugin shutdown failed");
        })());

    for (const entry of entries) {
        const cleanups: Array<() => void | Promise<void>> = [];
        let active = true;
        let cleanupPromise: Promise<void> | undefined;
        const cleanup = (): Promise<void> => {
            active = false;
            return (cleanupPromise ??= (async () => {
                const failures: unknown[] = [];
                for (const dispose of cleanups.reverse()) {
                    try {
                        await dispose();
                    } catch (error) {
                        failures.push(error);
                    }
                }
                if (failures.length) throw new AggregateError(failures, `plugin "${entry.id}" cleanup failed`);
            })());
        };
        const log = (message: string): void => (options.log ?? console.info)(`[plugin:${entry.id}] ${message}`);
        try {
            const configured = options.principals.get(entry.provider);
            if (!configured) throw new Error(`provider "${entry.provider}" is not configured in the security file`);
            // Do not hand a credential or mutable security-file object to a plugin.
            const principal: IProviderPrincipal = Object.freeze({
                id: configured.id,
                subjects: Object.freeze([...(configured.subjects ?? [])]),
                allowedResources: Object.freeze([...(configured.allowedResources ?? [])]),
            });
            compileProviderAllowedResources(principal.allowedResources!);
            const namespace = (await import(moduleUrl(entry.module, options))) as { default?: IBrokerPlugin };
            const plugin = namespace.default;
            if (!plugin || plugin.apiVersion !== 1 || typeof plugin.start !== "function") throw new Error("module must default-export a plugin with apiVersion: 1 and start()");
            const handle = await plugin.start(
                {
                    baseDir: options.baseDir,
                    log,
                    onCleanup(dispose) {
                        if (!active) throw new Error("plugin has stopped");
                        cleanups.push(dispose);
                    },
                    registerSlot(name, transport) {
                        if (!active) throw new Error("plugin has stopped");
                        if (!name || name.startsWith("_")) throw new Error(`plugin cannot register reserved slot "${name}"`);
                        const registration = options.tunnel.registerLoopbackProvider(name, transport, { principal, aggregate: entry.aggregate ?? false });
                        const detach = transport.onClose;
                        let attached = true;
                        transport.onClose = () => {
                            if (!attached) return;
                            attached = false;
                            detach?.();
                        };
                        cleanups.push(() => {
                            try {
                                transport.close();
                            } finally {
                                transport.onClose?.();
                            }
                        });
                        return registration;
                    },
                },
                entry.config
            );
            if (!handle || typeof handle.stop !== "function") throw new Error("plugin start() must return a stop() handle");
            cleanups.push(() => handle.stop());
            running.push({ stop: cleanup });
            log("started");
        } catch (error) {
            let failure: unknown = error;
            try {
                await cleanup();
            } catch (cleanupError) {
                failure = new AggregateError([error, cleanupError], `plugin "${entry.id}" startup and cleanup failed`);
            }
            if (entry.required !== false || failure !== error) {
                try {
                    await stop();
                } catch (stopError) {
                    throw new AggregateError([failure, stopError], `required plugin "${entry.id}" failed`);
                }
                throw new Error(`required plugin "${entry.id}" failed: ${failure instanceof Error ? failure.message : String(failure)}`, { cause: failure });
            }
            log(`optional plugin refused: ${failure instanceof Error ? failure.message : String(failure)}`);
        }
    }
    return { stop };
}
