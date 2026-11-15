import { afterEach, describe, expect, it } from "vitest";
import { DirectTransport } from "@cyanmycelium/mcp-broker-provider";
import { BrokerAuthority, type IBrokerMethodOrigin } from "../src/authority/broker.authority";
import { compileConfiguredDomains } from "../src/authority/domains";
import { compileAuthorizationPolicy } from "../src/authorization/runtime";
import { startTestBroker, type ITestBroker } from "../src/testing/index";
import { WsTunnelBuilder } from "../src/index";
import { mcpCall } from "./streamable.helper";

/**
 * E7 of the mcp-scada broker evolution brief: one domain, several owners, one
 * UNS subtree each. A domain is a capability vocabulary; the place is the
 * resource path. Test names carry the brief's acceptance numbers.
 */

const site = (n: number) => ({ id: `history-site${n}`, subjects: [`service:history-site${n}`], allowedResources: [`/production/site${n}/**`] });
const central = { id: "history-central", subjects: ["service:history-central"], allowedResources: ["/production/**"] };

function origin(principal: { id: string; subjects: string[]; allowedResources: string[] }, slot = principal.id): IBrokerMethodOrigin {
    return { slot, principal };
}

function history(namespace: string, capabilities = ["history.read", "history.record"], resultsRequired: string[] = []) {
    return { version: "1", domain: "history", namespace: { resource: namespace }, capabilities, resultsRequired };
}

function authority(domains?: ConstructorParameters<typeof BrokerAuthority>[0]["domains"]) {
    const policy = compileAuthorizationPolicy({
        roles: { historian: { capabilities: ["history.read", "history.record"] } },
        assignments: [{ subject: "service:history-site1", role: "historian", resource: "/production/**" }],
    });
    return new BrokerAuthority({ authorization: policy, slotResources: policy.slotResourceResolver, domains });
}

function errorsOf(outcome: unknown): string {
    return ((outcome as { error?: { data?: { errors?: string[] } } }).error?.data?.errors ?? []).join("\n");
}

function decide(a: BrokerAuthority, from: IBrokerMethodOrigin, resourcePath: string): Record<string, unknown> {
    const answer = a.authorize({ principal: { type: "provider" }, checks: [{ capability: "history.read", resource: `uns:/${resourcePath}`, resourcePath }] }, from, () => true);
    if ("error" in answer) return answer as unknown as Record<string, unknown>;
    return (answer.result as { decisions: Record<string, unknown>[] }).decisions[0]!;
}

describe("E7: one domain, one owner per subtree", () => {
    it("T23: accepts two identities on sibling subtrees; each decides only in its own", () => {
        const a = authority();
        expect(a.declare(history("/production/site1"), origin(site(1)))).toHaveProperty("result.accepted", true);
        expect(a.declare(history("/production/site2"), origin(site(2)))).toHaveProperty("result.accepted", true);

        expect(decide(a, origin(site(1)), "/production/site1/line1/tank")).toMatchObject({ reason: "role-grant" });
        expect(decide(a, origin(site(1)), "/production/site2/line1/tank")).toMatchObject({ allowed: false, reason: "undeclared-resource" });
        expect(decide(a, origin(site(2)), "/production/site1/line1/tank")).toMatchObject({ allowed: false, reason: "undeclared-resource" });

        expect(a.info().domains).toEqual([
            {
                domain: "history",
                capabilities: ["history.read", "history.record"],
                owners: [
                    { owner: "history-site1", namespace: "/production/site1", slot: "history-site1", declared: true, configured: false, connected: true },
                    { owner: "history-site2", namespace: "/production/site2", slot: "history-site2", declared: true, configured: false, connected: true },
                ],
            },
        ]);
    });

    it("T24: refuses, whole, a subtree that contains or is contained in another owner's, naming it", () => {
        const a = authority();
        a.declare(history("/production/site1"), origin(site(1)));

        const parent = a.declare(history("/production"), origin(central));
        expect(errorsOf(parent)).toContain('overlaps "/production/site1", owned by provider "history-site1"');
        const child = a.declare(history("/production/site1/line1"), origin({ ...site(1), id: "history-line1" }));
        expect(errorsOf(child)).toContain('owned by provider "history-site1"');
        expect(a.info().declarations.map((d) => d.principalId)).toEqual(["history-site1"]);
    });

    it("T25: refuses a declaration whose capabilities or resultsRequired differ from the domain's", () => {
        const a = authority();
        a.declare(history("/production/site1"), origin(site(1)));
        expect(errorsOf(a.declare(history("/production/site2", ["history.read"]), origin(site(2))))).toContain("capability vocabulary differs from the domain's");
        expect(errorsOf(a.declare(history("/production/site2", ["history.read", "history.record"], ["history.record"]), origin(site(2))))).toContain(
            "capability vocabulary differs"
        );
        // The sole owner may still change the vocabulary: nobody else holds roles on it.
        expect(a.declare(history("/production/site1", ["history.read"]), origin(site(1)))).toHaveProperty("result.accepted", true);
    });

    it("T26: with domains in the security file, only listed identities and subtrees declare", () => {
        const a = authority({
            history: [
                { owner: "history-site1", namespace: "/production/site1" },
                { owner: "history-site2", namespace: "/production/site2" },
            ],
        });
        expect(errorsOf(a.declare(history("/production/site3"), origin(site(3))))).toContain('provider "history-site3" is not one of its owners');
        const wide = { ...site(1), allowedResources: ["/production/**"] };
        expect(errorsOf(a.declare(history("/production/site2/line9"), origin(wide, "elsewhere")))).toContain(
            'namespace "/production/site2/line9" is outside the subtree the security file assigns provider "history-site1"'
        );
        expect(a.declare(history("/production/site1/line1"), origin(site(1)))).toHaveProperty("result.accepted", true);
        // Configured owners that have not declared yet show up too.
        expect(a.info().domains[0]!.owners).toEqual([
            expect.objectContaining({ owner: "history-site1", namespace: "/production/site1/line1", declared: true, configured: true }),
            expect.objectContaining({ owner: "history-site2", namespace: "/production/site2", declared: false, configured: true, connected: false }),
        ]);
        // Unlisted domains keep first come, first served.
        expect(a.declare({ ...history("/production/site3"), domain: "cache", capabilities: ["cache.read"] }, origin(site(3)))).toHaveProperty("result.accepted", true);
    });

    it("T26: overlapping configured subtrees prevent the start", () => {
        const overlapping = {
            history: [
                { owner: "a", namespace: "/production" },
                { owner: "b", namespace: "/production/site1" },
            ],
        };
        expect(compileConfiguredDomains(overlapping).problems.join("\n")).toContain('"/production/site1" (b) overlaps "/production" (a)');
        expect(() => authority(overlapping)).toThrow(/authorization.domains cannot be enforced/);
        expect(() =>
            new WsTunnelBuilder()
                .withPort(0)
                .withProviderPrincipals([{ id: "a", secret: "s-aaaaaaaaaaaaaaaa", allowedResources: ["/production/**"] }])
                .withDomains({
                    history: [
                        { owner: "a", namespace: "/production" },
                        { owner: "ghost", namespace: "/other" },
                    ],
                })
                .build()
        ).toThrow(/"ghost" is not in the providers table/);
        expect(() =>
            new WsTunnelBuilder()
                .withPort(0)
                .withDomains({ history: [{ owner: "a", namespace: "/p" }] })
                .build()
        ).toThrow(/provider authentication is off/);
        expect(compileConfiguredDomains({ broker: [{ owner: "a", namespace: "/p" }] }).problems.join()).toContain("reserved");
        expect(compileConfiguredDomains({ history: [{ owner: "a", namespace: "/" }] }).problems.join()).toContain('cannot be "/"');
    });

    it("T27: with one owner and no domains section, refusals and ownership behave as before", () => {
        const a = authority();
        a.declare(history("/production/site1"), origin(site(1)));
        // Replacing the slot's declaration with another domain keeps the first one owned...
        a.declare({ ...history("/production/site1"), domain: "cache", capabilities: ["cache.read"] }, origin(site(1)));
        expect(errorsOf(a.declare(history("/production/site1"), origin({ ...site(2), allowedResources: ["/production/**"] })))).toContain('owned by provider "history-site1"');
        expect(a.info().domains.find((d) => d.domain === "history")!.owners).toEqual([expect.objectContaining({ owner: "history-site1", declared: false })]);
        // ...until it is withdrawn, which frees every subtree that slot held.
        expect(a.withdraw({}, origin(site(1)))).toMatchObject({ result: { withdrawn: true, domain: "cache", domains: expect.arrayContaining(["history", "cache"]) } });
        expect(a.declare(history("/production/site1"), origin({ ...site(2), allowedResources: ["/production/**"] }))).toHaveProperty("result.accepted", true);
    });

    it("frees a replaced domain through the administrative withdrawal too", () => {
        const a = authority();
        a.declare(history("/production/site1"), origin(site(1)));
        a.declare({ ...history("/production/site1"), domain: "cache", capabilities: ["cache.read"] }, origin(site(1)));
        expect(a.withdrawDeclarations("history-site1", undefined, ["user:ops"])).toEqual(
            expect.arrayContaining([
                { principalId: "history-site1", slot: "history-site1", domain: "history" },
                { principalId: "history-site1", slot: "history-site1", domain: "cache", version: "1" },
            ])
        );
        expect(a.info().domains).toEqual([]);
    });
});

describe("T31: broker://domains", () => {
    let broker: ITestBroker | null = null;
    const transports: DirectTransport[] = [];
    afterEach(async () => {
        for (const t of transports.splice(0)) t.close();
        await broker?.stop();
        broker = null;
    });

    async function declare(id: string, namespace: string): Promise<void> {
        const transport = new DirectTransport(broker!.providerUrl(id), { secret: broker!.providerSecret(id) });
        transports.push(transport);
        transport.onMessage = (raw) => {
            const msg = JSON.parse(raw) as { id?: string; method?: string };
            if (msg.id !== undefined) transport.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }));
        };
        const opened = new Promise<void>((resolve) => (transport.onOpen = resolve));
        transport.connect();
        await opened;
        await transport.broker.declare(history(namespace));
    }

    async function read(caller: string): Promise<{ domains: { domain: string; owners: { namespace: string; slot?: string }[] }[] }> {
        const response = await mcpCall(
            broker!.url,
            "_broker",
            JSON.stringify({ jsonrpc: "2.0", id: 1, method: "resources/read", params: { uri: "broker://domains" } }),
            broker!.bearer(caller)
        );
        const body = (await response.json()) as { result?: { contents: { text: string }[] }; error?: unknown };
        expect(body.error, JSON.stringify(body.error)).toBeUndefined();
        return JSON.parse(body.result!.contents[0]!.text);
    }

    it("shows a client only the subtrees it holds one of the domain's capabilities on", async () => {
        broker = await startTestBroker({
            callers: { alice: { groups: ["historians-site1"] }, ops: { groups: ["ops"] }, bob: {} },
            providers: { "history-site1": site(1), "history-site2": site(2) },
            domains: { history: [{ owner: "history-site1", namespace: "/production/site1" }] },
            policy: {
                slotResources: { "history-site1": "/production/site1/history", "history-site2": "/production/site2/history" },
                roles: {
                    reader: { capabilities: ["broker.providers.read"] },
                    historian: { inherits: ["reader"], capabilities: ["history.read"] },
                    admin: { inherits: ["reader"], capabilities: ["broker.authorization.admin"] },
                },
                assignments: [
                    { subject: "group:historians-site1", role: "historian", resource: "/production/site1/**" },
                    { subject: "group:historians-site1", role: "reader", resource: "/_system/**" },
                    { subject: "group:ops", role: "admin", resource: "/_system/**" },
                    { subject: "user:bob", role: "reader", resource: "/_system/**" },
                ],
            },
        });
        await declare("history-site1", "/production/site1");
        // history-site2 is not a configured owner: refused, so not listed.
        await expect(declare("history-site2", "/production/site2")).rejects.toMatchObject({ code: -32602 });

        expect((await read("alice")).domains).toEqual([
            expect.objectContaining({ domain: "history", owners: [expect.objectContaining({ namespace: "/production/site1", slot: "history-site1" })] }),
        ]);
        expect((await read("bob")).domains).toEqual([]);
        expect((await read("ops")).domains[0]!.owners).toEqual([expect.objectContaining({ namespace: "/production/site1", slot: "history-site1", connected: true })]);
    });
});
