import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "net";
import type { IncomingMessage } from "http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AuthError, HttpAuthGuard, WsTunnelBuilder, buildDevAuth, resolveDevCallers, type IResolvedDevCaller, type WsTunnel } from "../src/index";
import { BrokerConfigError, loadSecurityConfig, type ILoadedBrokerConfig } from "../src/config";
import { mcpCall } from "./streamable.helper";

/**
 * Development mode: the hierarchical policy without an authorization server.
 * Static tokens from the environment, bound to subjects, accepted from
 * loopback clients only; the policy, the denies and the `-32001` are the
 * production ones.
 */

const AGENT_TOKEN = "agent-token-0123456789";
const OPERATOR_TOKEN = "operator-token-0123456789";
const CALLERS: IResolvedDevCaller[] = [
    { id: "agent", tokenEnv: "T_AGENT", groups: ["agents"], token: AGENT_TOKEN },
    { id: "operator", tokenEnv: "T_OPERATOR", user: "guillaume", groups: ["operators"], token: OPERATOR_TOKEN },
];

/** The demo's shape: the agent may actuate a scrubber, never power it off; the operator may do everything. */
const POLICY = {
    roles: {
        agent: { capabilities: ["mcp.tools.list", "mcp.tools.actuate", "mcp.tools.power"] },
        operator: { capabilities: ["*"] },
    },
    assignments: [
        { id: "agents-habitat", subject: "group:agents", role: "agent", resource: "/habitat/**" },
        { id: "operators-everything", subject: "group:operators", role: "operator", resource: "/**" },
    ],
    denies: [{ id: "agent-never-power", subject: "group:agents", capabilities: ["mcp.tools.power"], resource: "/habitat/**" }],
    slotResources: { scrubber: "/habitat/cabin-1/eclss/scrubber-1" },
    toolCapabilities: { "motor.set_speed": "mcp.tools.actuate", "scrubber.power": "mcp.tools.power" },
};

const call = (name: string, args: Record<string, unknown>): string => JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } });

let tunnel: WsTunnel | null = null;

async function startTunnel(): Promise<string> {
    tunnel = new WsTunnelBuilder()
        .withPort(0)
        .withHost("127.0.0.1")
        .withDevAuth({ callers: CALLERS, ...POLICY })
        .build();
    await tunnel.start();
    const server = (tunnel as unknown as { _httpServer: { address(): AddressInfo } })._httpServer;
    return `http://127.0.0.1:${server.address().port}`;
}

afterEach(async () => {
    await tunnel?.stop();
    tunnel = null;
});

describe("development authorization over HTTP", () => {
    it("challenges a request without a token, and one with an unknown token", async () => {
        const base = await startTunnel();
        expect((await fetch(`${base}/scrubber/mcp`, { method: "POST", body: call("motor.set_speed", { percent: 30 }) })).status).toBe(401);
        expect((await mcpCall(base, "scrubber", call("motor.set_speed", { percent: 30 }), { authorization: "Bearer not-a-token-at-all" })).status).toBe(401);
    });

    it("lets the agent's token through to an actuation its role grants", async () => {
        const base = await startTunnel();
        const response = await mcpCall(base, "scrubber", call("motor.set_speed", { percent: 30 }), { authorization: `Bearer ${AGENT_TOKEN}` });
        const body = (await response.json()) as { error?: { code: number; message: string } };
        // Granted: the call reaches the slot, which has no provider in this test.
        expect(body.error?.message).toContain("not connected");
    });

    it("denies the agent the power off by the explicit deny, and lets the operator through", async () => {
        const base = await startTunnel();
        const denied = (await (await mcpCall(base, "scrubber", call("scrubber.power", { on: false }), { authorization: `Bearer ${AGENT_TOKEN}` })).json()) as {
            error?: { code: number; message: string };
        };
        expect(denied.error).toMatchObject({ code: -32001, message: "Forbidden" });
        const granted = (await (await mcpCall(base, "scrubber", call("scrubber.power", { on: false }), { authorization: `Bearer ${OPERATOR_TOKEN}` })).json()) as {
            error?: { code: number; message: string };
        };
        expect(granted.error?.message).toContain("not connected");
    });
});

describe("development tokens are for loopback clients only", () => {
    const req = (remoteAddress: string, token = AGENT_TOKEN): IncomingMessage =>
        ({ headers: { authorization: `Bearer ${token}` }, socket: { remoteAddress } }) as unknown as IncomingMessage;
    const guard = new HttpAuthGuard(buildDevAuth({ callers: CALLERS, ...POLICY }), "/mcp");

    it("accepts 127.0.0.1, ::1 and the IPv4-mapped loopback", async () => {
        for (const address of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
            const principal = await guard.authorize(req(address), "scrubber");
            expect(principal.subject?.ids).toContain("group:agents");
        }
    });

    it("refuses a LAN client before reading its token, even a valid one", async () => {
        for (const address of ["192.168.4.2", "::ffff:10.0.0.7", "fe80::1", ""]) {
            await expect(guard.authorize(req(address), "scrubber")).rejects.toMatchObject({ status: 401 });
        }
        await expect(guard.authorize(req("192.168.4.2"), "scrubber")).rejects.toBeInstanceOf(AuthError);
    });
});

describe("auth.dev in the security file", () => {
    let dir: string;
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "mcp-broker-dev-"));
    });
    const loaded = (): ILoadedBrokerConfig => ({ config: { securityFile: "security.json" }, baseDir: dir, sourcePath: join(dir, "config.json") }) as unknown as ILoadedBrokerConfig;
    const write = (body: unknown): void => writeFileSync(join(dir, "security.json"), JSON.stringify(body));

    it("resolves the callers' tokens from the environment", () => {
        write({ auth: { dev: { callers: [{ id: "agent", tokenEnv: "T_AGENT", groups: ["agents"] }] }, ...POLICY } });
        const security = loadSecurityConfig(loaded(), { T_AGENT: AGENT_TOKEN })!;
        expect(security.devCallers).toEqual([{ id: "agent", tokenEnv: "T_AGENT", groups: ["agents"], token: AGENT_TOKEN }]);
    });

    it("fails closed on a token in clear, an unset or short token, a shared token, a twice-declared id, and OAuth alongside", () => {
        write({ auth: { enabled: true, dev: { callers: [{ id: "agent", tokenEnv: "T_AGENT", token: "x" }] } } });
        expect(() => loadSecurityConfig(loaded(), { T_AGENT: AGENT_TOKEN })).toThrow(BrokerConfigError);
        try {
            loadSecurityConfig(loaded(), { T_AGENT: AGENT_TOKEN });
        } catch (error) {
            expect((error as Error).message).toMatch(/exclusive/);
            expect((error as Error).message).toMatch(/secret in clear/);
        }
        const problems = resolveDevCallers(
            {
                callers: [
                    { id: "a", tokenEnv: "UNSET" },
                    { id: "b", tokenEnv: "SHORT" },
                    { id: "c", tokenEnv: "T_AGENT" },
                    { id: "d", tokenEnv: "T_AGENT" },
                    { id: "c", tokenEnv: "T_OTHER" },
                    { id: "e", tokenEnv: "T_OTHER2", role: "operator" },
                ],
            },
            { SHORT: "short", T_AGENT: AGENT_TOKEN, T_OTHER: OPERATOR_TOKEN, T_OTHER2: "another-token-0123456789" }
        ).problems.join("; ");
        expect(problems).toMatch(/UNSET is not set/);
        expect(problems).toMatch(/shorter than 16/);
        expect(problems).toMatch(/also "c"'s/);
        expect(problems).toMatch(/"c" is declared twice/);
        expect(problems).toMatch(/unknown key "role"/);
        expect(resolveDevCallers({ callers: [] }, {}).problems).toEqual(['"auth.dev.callers" must be a non-empty array']);
    });
});
