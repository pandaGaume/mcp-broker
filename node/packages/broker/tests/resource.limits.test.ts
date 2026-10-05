import { describe, expect, it, vi } from "vitest";
import { BrokerAuthority } from "../src/authority/broker.authority";
import { compileRegex, compileResourceLimits, intersectLimits, LimitPattern, LimitPatternIndex, type IResourceLimitRule } from "../src/authority/resource.limits";
import { ResourcePath } from "../src/authorization/resource.path";
import { compileAuthorizationPolicy } from "../src/authorization/runtime";
import { LimitController } from "../src/limits/controller";
import { WsTunnelBuilder } from "../src/index";
import { BrokerInfoAdapter } from "../src/broker/adapters/broker.adapter.info";
import { diagnoseBroker } from "../src/broker/broker.diagnostics";

const origin = { slot: "scada", principal: { id: "scada", subjects: ["service:scada"], allowedResources: ["/nord/**"] } };
const manifest = {
    version: "1",
    domain: "scada",
    namespace: { resource: "/nord" },
    capabilities: ["scada.write"],
    budgetUnits: ["write"],
    resources: [
        { resourcePattern: "/nord/valves/{id}", limits: { minValue: 0, maxValue: 100 } },
        { resourcePattern: "/nord/valves/{id}", where: { id: "V-1\\d{2}" }, limits: { maxValue: 60 } },
        { resource: "valve:V-012", resourcePath: "/nord/valves/V-012", limits: { maxValue: 40 } },
    ],
};
const maintenance = { id: "maintenance", pattern: "/nord/valves/{id}", where: { id: "V-0\\d{2}" }, limits: { maxValue: 80 } };
function authority(resourceLimits: readonly IResourceLimitRule[] = [maintenance]) {
    const policy = compileAuthorizationPolicy({
        roles: { operator: { capabilities: ["scada.write"] } },
        assignments: [{ subject: "service:scada", role: "operator", resource: "/nord/**" }],
    });
    return new BrokerAuthority({ authorization: policy, slotResources: policy.slotResourceResolver, resourceLimits });
}
function decide(a: BrokerAuthority, id: string, resource = `valve:${id}`, principal: unknown = { type: "provider" }) {
    const reply = a.authorize({ principal, checks: [{ capability: "scada.write", resource, resourcePath: `/nord/valves/${id}` }] }, origin, () => true);
    if ("error" in reply) throw new Error(reply.error.message);
    return (reply.result as { decisions: Record<string, unknown>[] }).decisions[0];
}

describe("engineering limits by resource path", () => {
    it("intersects concrete, provider and operator limits, and audits every source", () => {
        const audit = vi.spyOn(console, "error").mockImplementation(() => {});
        try {
            const a = authority();
            expect(a.declare(manifest, origin)).toHaveProperty("result");
            expect(decide(a, "V-123")).toMatchObject({ effect: "allow-with-constraints", allowed: false, obligations: { constraints: { minValue: 0, maxValue: 60 } } });
            expect(decide(a, "V-013")).toMatchObject({ obligations: { constraints: { minValue: 0, maxValue: 80 } } });
            expect(decide(a, "V-012")).toMatchObject({ obligations: { constraints: { minValue: 0, maxValue: 40 } } });
            expect(decide(a, "V-999")).toMatchObject({ obligations: { constraints: { minValue: 0, maxValue: 100 } } });
            expect(decide(a, "V-013", "valve:V-012")).toMatchObject({ effect: "deny", reason: "undeclared-resource" });
            const events = audit.mock.calls
                .map(([line]) => String(line))
                .filter((line) => line.includes('"phase":"decision"'))
                .map((line) => JSON.parse(line.slice(line.indexOf("{"))));
            expect(events.find((e) => e.nativeResource === "valve:V-012" && e.allowed)).toHaveProperty("limitSources", [
                "declaration:/nord/valves/{id}",
                "declaration:valve:V-012",
                "security:maintenance",
            ]);
            expect(a.info().resourceLimits).toEqual([{ ...maintenance }]);
            expect(a.info().declarations[0].resourcePatterns).toHaveLength(2);
        } finally {
            audit.mockRestore();
        }
    });

    it("denies empty intersections, includes the sources in diagnosis, and preserves policy denies", () => {
        const a = authority([{ ...maintenance, where: undefined, limits: { maxValue: -1 } }]);
        a.declare(manifest, origin);
        expect(decide(a, "V-123")).toMatchObject({ effect: "deny", reason: "empty-limits" });
        expect(decide(a, "V-123")).not.toHaveProperty("obligations");
        expect(a.info().limitProblems?.[0]).toMatchObject({ reason: "empty-limits", sources: ["declaration:/nord/valves/{id}", "security:maintenance"] });
    });

    it("reuses the same intersection for budgets and never reserves an empty intersection", () => {
        const a = authority();
        a.declare(manifest, origin);
        const ref = a.issueRef("scada", "pending", "scada", { ids: ["service:scada"] }, "00000000000000000000000000000001");
        const ledger = new LimitController({ rules: [{ id: "writes", budget: { unit: "write", max: 10, windowMs: 60000 } }] });
        const params = {
            principal: { type: "caller-ref", ref: ref.ref },
            capability: "scada.write",
            resource: "valve:V-123",
            resourcePath: "/nord/valves/V-123",
            unit: "write",
            quantity: 1,
            idempotencyKey: "one",
        };
        expect(a.reserveBudget(params, origin, () => true, ledger)).toMatchObject({
            result: { effect: "allow-with-constraints", obligations: { constraints: { minValue: 0, maxValue: 60 } } },
        });
        a.declare({ ...manifest, resources: [...manifest.resources, { resourcePattern: "/nord/**", limits: { minValue: 101 } }] }, origin);
        expect(a.reserveBudget({ ...params, idempotencyKey: "two" }, origin, () => true, ledger)).toHaveProperty("error");
    });

    it.each([
        { resourcePattern: "/sud/{id}", limits: { maxValue: 1 } },
        { resourcePattern: "/nord/{id}", resource: "native", resourcePath: "/nord/a" },
        { resourcePattern: "/nord/{id}", where: { other: "a" } },
        { resourcePattern: "/nord/{id}/{id}" },
        { resourcePattern: "/nord/**/a" },
        { resourcePattern: "/nord/V-1*" },
        { resourcePattern: "/nord/{id}", where: { id: "(?=a)" } },
        { resourcePattern: "/nord/{id}", where: { id: "(a)\\1" } },
        { resource: "native", resourcePath: "/nord/a", where: {} },
    ])("refuses invalid declarations atomically: %j", (entry) => {
        const a = authority();
        a.declare(manifest, origin);
        const version = a.policyVersion;
        expect(a.declare({ ...manifest, resources: [entry] }, origin)).toHaveProperty("error");
        expect(a.policyVersion).toBe(version);
        expect(decide(a, "V-123")).toHaveProperty("effect", "allow-with-constraints");
    });

    it("records RE2 refusals and exposes authority as a live MCP resource", async () => {
        const tunnel = new WsTunnelBuilder().withPort(0).withResourceLimits([maintenance]).build();
        const adapter = new BrokerInfoAdapter(tunnel);
        expect(JSON.parse((await adapter.readResourceAsync("broker://authority"))!.text!)).toHaveProperty("resourceLimits", [maintenance]);
        const a = authority();
        a.declare({ ...manifest, resources: [{ resourcePattern: "/nord/{id}", where: { id: "(?=a)" } }] }, origin);
        const context = Object.create(tunnel) as typeof tunnel;
        context.getAuthorityInfo = () => a.info();
        expect(diagnoseBroker(context)!.problems).toContainEqual(expect.objectContaining({ id: "invalid-limit-pattern" }));
    });
});

describe("pattern matching and intersections", () => {
    it("matches named segments entirely, recursive zero segments, exact casing and anonymous wildcards", () => {
        const p = new LimitPattern("/nord/{id}/**", { maxValue: 1 }, "test", { id: "V-1\\d{2}" });
        expect(p.matches(ResourcePath.parse("/nord/V-123"))).toBe(true);
        expect(p.matches(ResourcePath.parse("/nord/V-123/a"))).toBe(true);
        expect(p.matches(ResourcePath.parse("/nord/V-123x"))).toBe(false);
        expect(p.matches(ResourcePath.parse("/nord/v-123"))).toBe(false);
        expect(new LimitPattern("/nord/*", undefined, "test").matches(ResourcePath.parse("/nord/a/b"))).toBe(false);
    });
    it("intersects all lists and ranges regardless of input order", () => {
        const entries = [
            { source: "a", limits: { minValue: 0, maxValue: 100, allowedValues: [0, 30, 60], destinations: ["device", "source"] } },
            { source: "b", limits: { minValue: 10, maxValue: 40, allowedValues: [60, 30], destinations: ["source"] } },
        ];
        expect(intersectLimits(entries)).toEqual(intersectLimits([...entries].reverse()));
        expect(intersectLimits(entries)).toMatchObject({ empty: false, limits: { minValue: 10, maxValue: 40, allowedValues: [30], destinations: ["source"] } });
        expect(
            intersectLimits([
                { source: "a", limits: { destinations: ["a"] } },
                { source: "b", limits: { destinations: ["b"] } },
            ]).empty
        ).toBe(true);
        expect(
            intersectLimits([
                { source: "a", limits: { allowedValues: [1] } },
                { source: "b", limits: { allowedValues: [2] } },
            ]).empty
        ).toBe(true);
    });
    it("indexes 1000 prefixes and rejects malformed operator rules", () => {
        const index = new LimitPatternIndex(Array.from({ length: 1000 }, (_, i) => new LimitPattern(`/site${i}/{id}`, { maxValue: i }, String(i))));
        expect(index.matching(ResourcePath.parse("/site500/valve"))).toHaveLength(1);
        expect(() => compileResourceLimits([{ ...maintenance, typo: 1 }])).toThrow(/unknown key/);
        expect(() => compileResourceLimits([maintenance, maintenance])).toThrow(/unique/);
        expect(() => compileResourceLimits([{ ...maintenance, limits: {} }])).toThrow(/empty/);
    });
    it("rejects unsupported origin regexes at build and evaluates a hostile input with RE2", () => {
        expect(() => new WsTunnelBuilder().withAllowedOrigins(/(?=a)/).build()).toThrow(/RE2/);
        expect(() => new WsTunnelBuilder().withAllowedOrigins({ pattern: "(?=a)" }).build()).toThrow(/RE2/);
        const expression = compileRegex("^(a+)+$");
        expect(expression.matcher("a".repeat(10000) + "!").find()).toBe(false);
    });
});
