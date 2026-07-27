import { createInterface } from "node:readline";

function argument(name, fallback) {
    const index = process.argv.indexOf(name);
    return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const slot = argument("--slot", "factory-machine");
const label = argument("--label", slot);
const startedAt = new Date().toISOString();
let running = false;
let baselineRevision = 3;

const tools = [
    {
        name: "get_electrical_state",
        description: `Read live electrical measurements for ${label}.`,
        inputSchema: {
            type: "object",
            properties: {},
            additionalProperties: false,
        },
    },
    {
        name: "diagnose_machine",
        description: `Run a non-destructive diagnostic on ${label}.`,
        inputSchema: {
            type: "object",
            properties: {
                depth: {
                    type: "string",
                    enum: ["quick", "full"],
                    default: "quick",
                },
            },
            additionalProperties: false,
        },
    },
    {
        name: "reset_baseline",
        description: `Recompute the analysis baseline for ${label}.`,
        inputSchema: {
            type: "object",
            properties: {
                reason: {
                    type: "string",
                    description: "Human-readable change reason.",
                },
            },
            required: ["reason"],
            additionalProperties: false,
        },
    },
    {
        name: "start_machine",
        description: `Start ${label}. This represents an operational action.`,
        inputSchema: {
            type: "object",
            properties: {
                confirmation: {
                    type: "boolean",
                    const: true,
                },
            },
            required: ["confirmation"],
            additionalProperties: false,
        },
    },
];

function result(value) {
    return {
        content: [
            {
                type: "text",
                text: JSON.stringify(value, null, 2),
            },
        ],
    };
}

function handleTool(name, args) {
    if (name === "get_electrical_state") {
        return result({
            slot,
            label,
            voltage: slot === "site-energy" ? 20000 : 400,
            current: running ? 63.8 : 8.4,
            powerKw: running ? 38.1 : 2.7,
            running,
            baselineRevision,
            sampledAt: new Date().toISOString(),
        });
    }
    if (name === "diagnose_machine") {
        return result({
            slot,
            depth: args.depth ?? "quick",
            health: slot === "critical-furnace" ? "attention" : "nominal",
            findings: slot === "critical-furnace" ? ["Safety interlock active", "Thermal drift within limit"] : ["No blocking anomaly"],
        });
    }
    if (name === "reset_baseline") {
        if (typeof args.reason !== "string" || !args.reason.trim()) {
            throw new Error("A non-empty reason is required.");
        }
        baselineRevision += 1;
        return result({
            slot,
            changed: true,
            baselineRevision,
            reason: args.reason.trim(),
        });
    }
    if (name === "start_machine") {
        if (args.confirmation !== true) {
            throw new Error("confirmation must be true.");
        }
        running = true;
        return result({
            slot,
            running,
            startedAt: new Date().toISOString(),
        });
    }
    throw new Error(`Unknown tool: ${name}`);
}

function reply(id, body) {
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, ...body })}\n`);
}

function handle(message) {
    const id = message.id;
    if (id == null) return;

    if (message.method === "initialize") {
        reply(id, {
            result: {
                protocolVersion: "2024-11-05",
                serverInfo: {
                    name: `oauth-lab-${slot}`,
                    version: "1.0.0",
                },
                capabilities: {
                    tools: {},
                    resources: {},
                    prompts: {},
                },
            },
        });
        return;
    }

    if (message.method === "ping") {
        reply(id, { result: {} });
        return;
    }

    if (message.method === "tools/list") {
        reply(id, { result: { tools } });
        return;
    }

    if (message.method === "tools/call") {
        try {
            const name = message.params?.name;
            const args = message.params?.arguments ?? {};
            reply(id, { result: handleTool(name, args) });
        } catch (error) {
            reply(id, {
                error: {
                    code: -32602,
                    message: error instanceof Error ? error.message : "Invalid tool arguments",
                },
            });
        }
        return;
    }

    if (message.method === "resources/list") {
        reply(id, {
            result: {
                resources: [
                    {
                        uri: `factory://${slot}/state`,
                        name: `${label} state`,
                        mimeType: "application/json",
                    },
                ],
            },
        });
        return;
    }

    if (message.method === "resources/read") {
        reply(id, {
            result: {
                contents: [
                    {
                        uri: `factory://${slot}/state`,
                        mimeType: "application/json",
                        text: JSON.stringify({
                            slot,
                            label,
                            running,
                            baselineRevision,
                            providerStartedAt: startedAt,
                        }),
                    },
                ],
            },
        });
        return;
    }

    if (message.method === "prompts/list") {
        reply(id, {
            result: {
                prompts: [
                    {
                        name: "inspection_brief",
                        description: `Build an inspection brief for ${label}.`,
                    },
                ],
            },
        });
        return;
    }

    if (message.method === "prompts/get") {
        reply(id, {
            result: {
                description: `Inspection brief for ${label}`,
                messages: [
                    {
                        role: "user",
                        content: {
                            type: "text",
                            text: `Review the current state of ${label} in slot ${slot}.`,
                        },
                    },
                ],
            },
        });
        return;
    }

    reply(id, {
        error: {
            code: -32601,
            message: `Method not found: ${message.method ?? "(none)"}`,
        },
    });
}

const lines = createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
});

lines.on("line", (line) => {
    if (!line.trim()) return;
    try {
        handle(JSON.parse(line));
    } catch {
        process.stderr.write(`[oauth-lab:${slot}] ignored malformed JSON-RPC input\n`);
    }
});
