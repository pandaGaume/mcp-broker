import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBrokerServer } from "../src/broker/index.js";
import type { BrokerContext } from "../src/broker/index.js";
import type { IMessageTransport, IMcpServer } from "@cyanmycelium/mcp-core";

// ---------------------------------------------------------------------------
// Lightweight BrokerContext stub. The grammar wiring is exercised end-to-end
// through `startBrokerServer`'s loopback transport, but the broker context is
// only read by the BrokerInfoBehavior / BrokerProvidersBehavior at runtime,
// so a minimal stub suffices for the grammar tests.
// ---------------------------------------------------------------------------

function makeContext(): BrokerContext {
    return {
        version: "test",
        name: "test-broker",
        startedAt: null,
        uptimeSeconds: 0,
        host: undefined,
        port: 0,
        tls: false,
        paths: { provider: "/provider", providers: "/providers", client: "/", mcp: "/mcp", sse: "/sse", messages: "/messages" },
        getProvidersInfo: () => [],
        getProviderInfo: () => undefined,
    };
}

// JSON-RPC helpers driving the loopback transport returned by startBrokerServer.

interface JsonRpcMessage {
    jsonrpc: "2.0";
    id?: number;
    method?: string;
    params?: unknown;
    result?: unknown;
    error?: { code: number; message: string };
}

/**
 * Sends a JSON-RPC request through the broker's client-side loopback
 * transport and resolves with the matching response. The broker's response
 * arrives synchronously over the in-process transport, but we still gate on
 * the receive callback to model the real wire protocol.
 */
function rpc(transport: IMessageTransport): {
    request(method: string, params?: unknown): Promise<JsonRpcMessage>;
} {
    let nextId = 1;
    const pending = new Map<number, (msg: JsonRpcMessage) => void>();

    transport.onMessage = (raw) => {
        const msg = JSON.parse(raw) as JsonRpcMessage;
        if (typeof msg.id === "number" && pending.has(msg.id)) {
            pending.get(msg.id)?.(msg);
            pending.delete(msg.id);
        }
    };

    return {
        request(method, params) {
            const id = nextId++;
            return new Promise((resolve) => {
                pending.set(id, resolve);
                transport.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
            });
        },
    };
}

interface ToolEntry {
    name: string;
    description?: string;
}

function findToolDescription(toolsList: JsonRpcMessage, name: string): string | undefined {
    const result = toolsList.result as { tools?: ToolEntry[] } | undefined;
    return result?.tools?.find((t) => t.name === name)?.description;
}

// ---------------------------------------------------------------------------
// Test setup: start the broker server once per test so each session boots
// fresh and the locale env variable can be controlled per case.
// ---------------------------------------------------------------------------

let server: IMcpServer | undefined;
let transport: IMessageTransport | undefined;
let tempGrammarDir: string | undefined;

afterEach(async () => {
    await server?.stop();
    server = undefined;
    transport = undefined;
    delete process.env["MCP_BROKER_LOCALE"];
    if (tempGrammarDir) {
        rmSync(tempGrammarDir, { recursive: true, force: true });
        tempGrammarDir = undefined;
    }
});

/**
 * Creates a temp grammar directory, drops one JSON file at
 * `<userAgent>/<filename>` and returns the directory path so the test
 * can pass it as `localGrammarsDir`. Honors the broker's filename
 * convention: pass `<locale>.json` or `<locale>@<version>.json`.
 */
function makeTempGrammarDir(entries: Array<{ userAgent: string; filename: string; data: unknown }>): string {
    const root = mkdtempSync(join(tmpdir(), "broker-grammar-test-"));
    tempGrammarDir = root;
    for (const entry of entries) {
        const uaDir = join(root, entry.userAgent);
        mkdirSync(uaDir, { recursive: true });
        writeFileSync(join(uaDir, entry.filename), JSON.stringify(entry.data), "utf-8");
    }
    return root;
}

async function bootBroker(opts: Parameters<typeof startBrokerServer>[1] = {}): Promise<{ rpcClient: ReturnType<typeof rpc> }> {
    const out = await startBrokerServer(makeContext(), opts);
    server = out.server;
    transport = out.clientTransport;
    return { rpcClient: rpc(transport) };
}

// ---------------------------------------------------------------------------
// Defaults: MCP_BROKER_LOCALE drives the selected grammar
// ---------------------------------------------------------------------------

describe("startBrokerServer — default localeSource reads MCP_BROKER_LOCALE", () => {
    it("returns the English baseline when MCP_BROKER_LOCALE is unset", async () => {
        const { rpcClient } = await bootBroker();
        await rpcClient.request("initialize", { clientInfo: { name: "test-client", version: "0.0.0" } });
        const list = await rpcClient.request("tools/list");
        expect(findToolDescription(list, "broker_info")).toMatch(/^Returns the broker's name/);
    });

    it("returns the French grammar when MCP_BROKER_LOCALE=fr", async () => {
        process.env["MCP_BROKER_LOCALE"] = "fr";
        const { rpcClient } = await bootBroker();
        await rpcClient.request("initialize", { clientInfo: { name: "test-client", version: "0.0.0" } });
        const list = await rpcClient.request("tools/list");
        const desc = findToolDescription(list, "broker_info");
        expect(desc).toBeDefined();
        expect(desc).not.toMatch(/^Returns the broker's name/);
    });
});

// ---------------------------------------------------------------------------
// grammarResolverOptions passthrough: a host can override localeSource etc.
// ---------------------------------------------------------------------------

describe("startBrokerServer — grammarResolverOptions overrides", () => {
    it("uses a custom localeSource provided by the host instead of the env var", async () => {
        process.env["MCP_BROKER_LOCALE"] = "en";
        const { rpcClient } = await bootBroker({
            grammarResolverOptions: { localeSource: () => "fr" },
        });
        await rpcClient.request("initialize", { clientInfo: { name: "test-client", version: "0.0.0" } });
        const list = await rpcClient.request("tools/list");
        const desc = findToolDescription(list, "broker_info");
        expect(desc).toBeDefined();
        expect(desc).not.toMatch(/^Returns the broker's name/);
    });

    it("falls back to the en baseline when localeSource resolves an unknown locale", async () => {
        const { rpcClient } = await bootBroker({
            grammarResolverOptions: { localeSource: () => "xx-YY" },
        });
        await rpcClient.request("initialize", { clientInfo: { name: "unknown-client", version: "0.0.0" } });
        const list = await rpcClient.request("tools/list");
        expect(findToolDescription(list, "broker_info")).toMatch(/^Returns the broker's name/);
    });

    it("routes a Claude client to claude/<locale>.json when shipped on disk", async () => {
        // claude/fr.json exists in the packaged grammars; en for claude does not, so
        // we expect the chain to walk claude:fr first.
        const { rpcClient } = await bootBroker({
            grammarResolverOptions: { localeSource: () => "fr" },
        });
        await rpcClient.request("initialize", { clientInfo: { name: "Claude-Desktop", version: "1.0" } });
        const list = await rpcClient.request("tools/list");
        const desc = findToolDescription(list, "broker_info");
        expect(desc).toBeDefined();
    });
});

// ---------------------------------------------------------------------------
// Explicit grammar version requested by the WS client via capabilities
// ---------------------------------------------------------------------------

describe("startBrokerServer — client requests a grammar version via capabilities", () => {
    it("loads <locale>@<version>.json from disk and applies it when the client asks for that version", async () => {
        // Drop a versioned grammar in a temp local override directory. The
        // broker's iterBrokerGrammarsFrom parses <locale>@<version>.json and
        // composes the key `default:fr@v2`, matching mcp-core's chain.
        const dir = makeTempGrammarDir([
            {
                userAgent: "default",
                filename: "fr@v2.json",
                data: { tools: { broker_info: { description: "FR v2 explicit description" } } },
            },
        ]);

        const { rpcClient } = await bootBroker({
            localGrammarsDir: dir,
            grammarResolverOptions: {
                localeSource: () => "fr",
                versionFrom: (_c, caps) => (caps as { grammarVersion?: string } | undefined)?.grammarVersion,
            },
        });

        // Client explicitly asks for v2 by declaring it in capabilities.
        await rpcClient.request("initialize", {
            clientInfo: { name: "test-client", version: "0.0.0" },
            capabilities: { grammarVersion: "v2" },
        });
        const list = await rpcClient.request("tools/list");
        expect(findToolDescription(list, "broker_info")).toBe("FR v2 explicit description");
    });

    it("falls back gracefully when the requested version has no matching grammar", async () => {
        // Boot with versionFrom wired, but no @v2 grammar on disk. The chain
        // should narrow from `default:fr@v2` (absent) down to `default:fr`
        // (present in packaged grammars).
        const { rpcClient } = await bootBroker({
            grammarResolverOptions: {
                localeSource: () => "fr",
                versionFrom: (_c, caps) => (caps as { grammarVersion?: string } | undefined)?.grammarVersion,
            },
        });

        await rpcClient.request("initialize", {
            clientInfo: { name: "test-client", version: "0.0.0" },
            capabilities: { grammarVersion: "v2" },
        });
        const list = await rpcClient.request("tools/list");
        const desc = findToolDescription(list, "broker_info");
        // Whatever the packaged default/fr.json says, it must NOT be the v2
        // marker and it must NOT be the English baseline.
        expect(desc).toBeDefined();
        expect(desc).not.toBe("FR v2 explicit description");
        expect(desc).not.toMatch(/^Returns the broker's name/);
    });

    it("ignores the version when the client omits it (returns non-versioned grammar)", async () => {
        // Same wiring as above (versionFrom configured), but the client does
        // not put grammarVersion in capabilities. versionFrom returns undefined
        // → the version dimension is bypassed → chain emits non-versioned keys.
        const dir = makeTempGrammarDir([
            {
                userAgent: "default",
                filename: "fr@v2.json",
                data: { tools: { broker_info: { description: "FR v2 should NOT appear" } } },
            },
        ]);

        const { rpcClient } = await bootBroker({
            localGrammarsDir: dir,
            grammarResolverOptions: {
                localeSource: () => "fr",
                versionFrom: (_c, caps) => (caps as { grammarVersion?: string } | undefined)?.grammarVersion,
            },
        });

        await rpcClient.request("initialize", {
            clientInfo: { name: "test-client", version: "0.0.0" },
            capabilities: {},
        });
        const list = await rpcClient.request("tools/list");
        expect(findToolDescription(list, "broker_info")).not.toBe("FR v2 should NOT appear");
    });
});
