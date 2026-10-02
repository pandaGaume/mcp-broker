import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LimitController, validateLimitsConfig, type ILimitContext } from "../src/limits/controller";
const context: ILimitContext = { subjects: ["user:alice"], provider: "lan", providerId: "net", capability: "network.discover", resource: "/ot/site/lan", requestId: "r1" };
const dirs: string[] = [];
const controllers: LimitController[] = [];
function make(...args: ConstructorParameters<typeof LimitController>): LimitController {
    const c = new LimitController(...args);
    controllers.push(c);
    return c;
}
function file(): string {
    const d = mkdtempSync(join(tmpdir(), "broker-limits-"));
    dirs.push(d);
    return join(d, "state.json");
}
afterEach(() => {
    for (const c of controllers.splice(0)) c.close();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true });
});
describe("limits transactions", () => {
    it("intersects rules atomically without debiting a refused call", () => {
        let now = 0;
        const c = make(
            {
                rules: [
                    { id: "global", calls: { max: 2, windowMs: 1000 } },
                    { id: "alice", match: { subject: "user:alice" }, calls: { max: 1, windowMs: 1000 } },
                ],
            },
            () => now
        );
        expect(c.admit(context, []).allowed).toBe(true);
        expect(c.admit(context, [])).toMatchObject({ allowed: false, error: { ruleId: "alice", retryAfterMs: 1000 } });
        expect(c.admit({ ...context, subjects: ["user:bob"] }, []).allowed).toBe(true);
        expect(c.admit({ ...context, subjects: ["user:bob"] }, []).allowed).toBe(false);
        now = 1000;
        expect(c.admit(context, []).allowed).toBe(true);
    });
    it("shares concurrency across callers and retains it until confirmed completion", () => {
        const c = make({ rules: [{ id: "one", concurrency: 1 }] });
        expect(c.admit(context, []).allowed).toBe(true);
        expect(c.admit({ ...context, subjects: ["user:bob"] }, []).allowed).toBe(false);
        c.complete("other-slot", "r1");
        expect(c.admit(context, []).allowed).toBe(false);
        c.complete("lan", "r1");
        expect(c.admit({ ...context, requestId: "r2" }, []).allowed).toBe(true);
    });
    it("groups users by stable identity, not changing group claims", () => {
        const c = make({ rules: [{ id: "users", groupBy: ["subject"], calls: { max: 1, windowMs: 1000 } }] });
        expect(c.admit(context, []).allowed).toBe(true);
        expect(c.admit({ ...context, subjects: ["group:new", "user:alice"] }, []).allowed).toBe(false);
        expect(c.admit({ ...context, subjects: ["user:bob"] }, []).allowed).toBe(true);
    });
    it("requires declared reservation support before dispatch", () => {
        const c = make({ rules: [{ id: "operations", budget: { unit: "packet", max: 2, windowMs: 1000 }, requireReservation: true }] });
        expect(c.admit(context, [])).toMatchObject({ allowed: false, error: { reason: "reservation-unsupported" } });
        expect(c.admit(context, ["packet"]).allowed).toBe(true);
    });
    it("reserves all budgets atomically, deduplicates and never refunds uncertain work", () => {
        let now = 0;
        const c = make(
            {
                rules: [
                    { id: "a", budget: { unit: "packet", max: 3, windowMs: 1000 } },
                    { id: "b", budget: { unit: "packet", max: 2, windowMs: 1000 } },
                ],
            },
            () => now
        );
        expect(c.reserve(context, "packet", 3, "large", "d0").allowed).toBe(false);
        const grant = c.reserve(context, "packet", 2, "k", "d1");
        expect(grant.allowed).toBe(true);
        if (!grant.allowed) throw Error("no grant");
        expect(c.reserve(context, "packet", 2, "k", "d2")).toMatchObject({ value: { ...grant.value, replayed: true } });
        expect(c.reserve(context, "packet", 1, "k", "d3")).toMatchObject({ error: { reason: "idempotency-conflict" } });
        expect(c.settle("intruder", "lan", grant.value.reservationId, 0, "refused").allowed).toBe(false);
        expect(c.settle("net", "other", grant.value.reservationId, 0, "refused").allowed).toBe(false);
        expect(c.settle("net", "lan", grant.value.reservationId, 0, "refused").allowed).toBe(true);
        expect(c.settle("net", "lan", grant.value.reservationId, 0, "refused").allowed).toBe(true);
        expect(c.settle("net", "lan", grant.value.reservationId, 1, "refused").allowed).toBe(false);
        expect(c.reserve(context, "packet", 1, "another", "d3").allowed).toBe(false);
        now = 1000;
        expect(c.reserve(context, "packet", 2, "fresh", "d4").allowed).toBe(true);
    });
    it("preserves debits, pending calls and idempotency across restart, with exclusive ownership", () => {
        const storeFile = file(),
            cfg = { storeFile, rules: [{ id: "all", concurrency: 1, budget: { unit: "packet", max: 1, windowMs: 86400000 } }] };
        const c = make(cfg);
        c.admit(context, []);
        const grant = c.reserve(context, "packet", 1, "k", "d");
        expect(() => new LimitController(cfg)).toThrow();
        c.close();
        const resumed = make(cfg);
        expect(resumed.admit(context, []).allowed).toBe(false);
        expect(resumed.reserve(context, "packet", 1, "k", "d")).toMatchObject({ ...grant, value: { ...(grant.allowed ? grant.value : {}), replayed: true } });
        expect(resumed.reserve(context, "packet", 1, "new", "d").allowed).toBe(false);
    });
    it("fails closed on corrupt storage or policy drift", () => {
        const storeFile = file();
        const c = make({ storeFile, rules: [] });
        c.close();
        expect(() => new LimitController({ storeFile, rules: [{ id: "new", concurrency: 1 }] })).toThrow(/migration/);
        writeFileSync(storeFile, "broken");
        expect(() => new LimitController({ storeFile, rules: [] })).toThrow();
    });
    it("does not confirm a reservation if persistence fails", () => {
        const storeFile = file();
        const c = make({ storeFile, rules: [{ id: "b", budget: { unit: "packet", max: 1, windowMs: 1000 } }] });
        // Occupy the temporary path with a directory, causing an actual write failure.
        const { mkdirSync } = requireFs;
        mkdirSync(storeFile + ".tmp");
        expect(c.reserve(context, "packet", 1, "k", "d")).toMatchObject({ error: { reason: "storage-unavailable" } });
        expect(c.admit(context, [])).toMatchObject({ error: { reason: "storage-unavailable" } });
        expect(JSON.parse(readFileSync(storeFile, "utf8")).entries).toHaveLength(0);
    });
    it("rejects unknown limit fields and invalid values at startup", () => {
        for (const rules of [[{ id: "a", concurrency: 0 }], [{ id: "a", calls: { max: 2, windowMs: 0 } }], [{ id: "a", rateLimit: 5 }], [{ id: "a", requireReservation: true }]]) {
            expect(() => validateLimitsConfig({ rules })).toThrow();
        }
    });
});
import * as requireFs from "node:fs";
