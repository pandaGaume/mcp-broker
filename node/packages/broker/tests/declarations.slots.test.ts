import { describe, expect, it, vi } from "vitest";
import { BrokerAuthority, type IBrokerMethodOrigin } from "../src/authority/broker.authority";
import { compileAuthorizationPolicy } from "../src/authorization/runtime";
import { LimitController } from "../src/limits/controller";

const principal = { id: "api", subjects: ["service:api"], allowedResources: ["/site/**"] };
const valves = { slot: "valves", principal };
const pumps = { slot: "pumps", principal };
const manifest = (domain: string, maxValue: number, budgetUnits = [domain]) => ({
    version: "1",
    domain,
    namespace: { resource: "/site/nord" },
    capabilities: [`${domain}.write`],
    budgetUnits,
    resources: [{ resourcePattern: "/site/nord/assets/{id}", limits: { minValue: 0, maxValue } }],
});
function start() {
    const policy = compileAuthorizationPolicy({
        roles: { writer: { capabilities: ["vannes.write", "pompes.write", "replaced.write"] } },
        assignments: [{ subject: "service:api", role: "writer", resource: "/site/**" }],
    });
    return new BrokerAuthority({
        authorization: policy,
        slotResources: policy.slotResourceResolver,
        resultTimeoutMs: 1,
        resourceLimits: [{ id: "maintenance", pattern: "/site/**", limits: { maxValue: 50 } }],
    });
}
function decide(
    authority: BrokerAuthority,
    origin: IBrokerMethodOrigin,
    capability: string,
    resourcePath = "/site/nord/assets/A",
    resource = `${capability.split(".")[0]}:${resourcePath}`,
    asked: unknown = { type: "provider" }
) {
    const answer = authority.authorize({ principal: asked, checks: [{ capability, resource, resourcePath }] }, origin, () => true);
    if ("error" in answer) return answer;
    return (answer.result as { decisions: Record<string, unknown>[] }).decisions[0];
}

describe("declarations belong to a provider identity and slot", () => {
    it("keeps two domains with overlapping paths and replaces only the declaring slot", () => {
        const a = start();
        expect(a.declare(manifest("vannes", 60), valves)).toHaveProperty("result");
        expect(a.declare(manifest("pompes", 30), pumps)).toHaveProperty("result");
        expect(decide(a, valves, "vannes.write")).toMatchObject({ obligations: { constraints: { minValue: 0, maxValue: 50 } } });
        expect(decide(a, pumps, "pompes.write")).toMatchObject({ obligations: { constraints: { minValue: 0, maxValue: 30 } } });
        expect(decide(a, valves, "pompes.write")).toMatchObject({ reason: "undeclared-capability" });
        expect(decide(a, { ...valves, slot: "undeclared" }, "vannes.write")).toHaveProperty("error.code", -32003);
        expect(a.declarationOf("api")).toBeUndefined();
        a.declare(manifest("vannes", 10), valves);
        expect(decide(a, valves, "vannes.write")).toMatchObject({ obligations: { constraints: { maxValue: 10 } } });
        expect(decide(a, pumps, "pompes.write")).toMatchObject({ obligations: { constraints: { maxValue: 30 } } });
        expect(a.info().declarations).toEqual(
            expect.arrayContaining([expect.objectContaining({ slot: "valves", domain: "vannes" }), expect.objectContaining({ slot: "pumps", domain: "pompes" })])
        );
        expect(a.info(new Set(["vannes.write", "pompes.write"])).undeclaredCapabilities).toEqual([]);
    });

    it("accepts the same domain on two slots of its owner and retains ownership after replacement", () => {
        const a = start();
        a.declare(manifest("vannes", 60), valves);
        expect(a.declare(manifest("vannes", 20), pumps)).toHaveProperty("result");
        expect(decide(a, pumps, "vannes.write")).toMatchObject({ obligations: { constraints: { maxValue: 20 } } });
        a.declare(manifest("replaced", 10), valves);
        a.declare(manifest("pompes", 30), pumps);
        const other = { slot: "other", principal: { ...principal, id: "other" } };
        expect(a.declare(manifest("vannes", 90), other)).toHaveProperty(
            "error.data.errors",
            expect.arrayContaining([expect.stringContaining('already declared by provider "api"')])
        );
    });

    it("keeps concrete resource escape checks scoped to their declaration", () => {
        const a = start();
        a.declare({ ...manifest("vannes", 60), resources: [{ resource: "same-id", resourcePath: "/site/nord/valve", limits: { maxValue: 40 } }] }, valves);
        a.declare({ ...manifest("pompes", 30), resources: [{ resource: "same-id", resourcePath: "/site/nord/pump", limits: { maxValue: 20 } }] }, pumps);
        expect(decide(a, valves, "vannes.write", "/site/nord/valve", "same-id")).toHaveProperty("effect", "allow-with-constraints");
        expect(decide(a, pumps, "pompes.write", "/site/nord/pump", "same-id")).toHaveProperty("effect", "allow-with-constraints");
        expect(decide(a, valves, "vannes.write", "/site/nord/pump", "same-id")).toHaveProperty("reason", "undeclared-resource");
    });

    it("isolates budget units and constraints by slot", () => {
        const a = start();
        a.declare(manifest("vannes", 40), valves);
        a.declare(manifest("pompes", 20), pumps);
        const ledger = new LimitController({ rules: [{ id: "writes", budget: { unit: "vannes", max: 5, windowMs: 60000 } }] });
        const ref = a.issueRef("valves", "pending", "api", { ids: ["service:api"] }, "00000000000000000000000000000001");
        const params = {
            principal: { type: "caller-ref", ref: ref.ref },
            capability: "vannes.write",
            resource: "vannes:/site/nord/assets/A",
            resourcePath: "/site/nord/assets/A",
            quantity: 1,
            unit: "vannes",
            idempotencyKey: "one",
        };
        expect(a.reserveBudget(params, valves, () => true, ledger)).toMatchObject({ result: { obligations: { constraints: { maxValue: 40 } } } });
        expect(a.reserveBudget({ ...params, unit: "pompes", idempotencyKey: "two" }, valves, () => true, ledger)).toHaveProperty("error.code", -32602);
        expect(a.reserveBudget(params, pumps, () => true, ledger)).toHaveProperty("error.code", -32602);
    });

    it("tracks result promises and reports on the decision's slot, and audits its domain", () => {
        vi.useFakeTimers();
        const audit = vi.spyOn(console, "error").mockImplementation(() => {});
        try {
            const a = start();
            a.declare({ ...manifest("vannes", 40), resultsRequired: ["vannes.write"] }, valves);
            a.declare(manifest("pompes", 20), pumps);
            const valve = decide(a, valves, "vannes.write") as { decisionId: string };
            const pump = decide(a, pumps, "pompes.write") as { decisionId: string };
            vi.advanceTimersByTime(2);
            expect(a.info().results.overdue).toEqual([expect.objectContaining({ slot: "valves", decisionId: valve.decisionId })]);
            a.recordResult({ decisionId: valve.decisionId, result: "success" }, pumps);
            expect(a.info().results.unmatched).toBe(1);
            expect(a.info().results.awaited).toBe(1);
            a.recordResult({ decisionId: valve.decisionId, result: "success" }, valves);
            a.recordResult({ decisionId: pump.decisionId, result: "success" }, pumps);
            expect(a.info().results.awaited).toBe(0);
            const events = audit.mock.calls.map(([line]) => JSON.parse(String(line).slice(String(line).indexOf("{"))));
            expect(events).toContainEqual(expect.objectContaining({ slot: "valves", domain: "vannes", phase: "decision" }));
            expect(events).toContainEqual(expect.objectContaining({ slot: "pumps", domain: "pompes", phase: "result" }));
        } finally {
            audit.mockRestore();
            vi.useRealTimers();
        }
    });

    it("preserves protected slot confirmations when a sibling declaration changes", () => {
        const policy = compileAuthorizationPolicy({});
        const a = new BrokerAuthority({
            authorization: policy,
            slotResources: policy.slotResourceResolver,
            protectedSlots: { "site/bench": { declaredBy: "api", publishedBy: "device" } },
        });
        a.declare({ ...manifest("vannes", 50), protects: ["site/bench"] }, valves);
        a.declare(manifest("pompes", 20), pumps);
        expect(a.info().protectedSlots[0].confirmed).toBe(true);
        a.declare(manifest("pompes", 10), pumps);
        expect(a.info().protectedSlots[0].confirmed).toBe(true);
        a.declare(manifest("vannes", 40), valves);
        expect(a.info().protectedSlots[0].confirmed).toBe(false);
    });
});
