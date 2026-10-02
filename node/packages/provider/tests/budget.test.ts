import { describe, expect, it, vi } from "vitest";
import { BrokerClient } from "../src/broker.client";
const query = {
    principal: { type: "caller-ref" as const, ref: "cr_abcdefgh" },
    capability: "network.scan",
    resource: "lan",
    resourcePath: "/lan",
    unit: "packet",
    quantity: 1,
    idempotencyKey: "key",
};
describe("budget helper", () => {
    it("does not execute a replayed grant and preserves work errors without refunds", async () => {
        const client = new BrokerClient(() => {});
        const work = vi.fn(async () => 42);
        vi.spyOn(client, "reserveBudget").mockResolvedValue({ reservationId: "r", expiresAt: Date.now() + 10000, quantity: 1, decisionId: "d", replayed: true });
        await expect(client.withBudget(query, work)).rejects.toThrow(/replayed/);
        expect(work).not.toHaveBeenCalled();
        vi.mocked(client.reserveBudget).mockResolvedValue({ reservationId: "r", expiresAt: Date.now() + 10000, quantity: 1, decisionId: "d", replayed: false });
        const settle = vi.spyOn(client, "settleBudget").mockRejectedValue(new Error("lost reply"));
        const error = new Error("native work failed");
        await expect(
            client.withBudget(query, async () => {
                throw error;
            })
        ).rejects.toBe(error);
        expect(settle).toHaveBeenCalledWith({ reservationId: "r", used: 1, result: "failure" });
    });
    it("waits for durable settlement before returning success", async () => {
        const client = new BrokerClient(() => {});
        vi.spyOn(client, "reserveBudget").mockResolvedValue({ reservationId: "r", expiresAt: Date.now() + 10000, quantity: 1, decisionId: "d", replayed: false });
        const settle = vi.spyOn(client, "settleBudget").mockResolvedValue({ settled: true });
        expect(await client.withBudget(query, async () => 42)).toBe(42);
        expect(settle).toHaveBeenCalledWith({ reservationId: "r", used: 1, result: "success" });
    });
});
