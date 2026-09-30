import { describe, expect, it } from "vitest";
import { ResourceSubscriptionRegistry, type IResourceSubscriptionUpstream, type SubscriptionOutcome } from "../src/index";

/**
 * The reference count the broker keeps between N clients and one provider.
 *
 * The upstream here is scripted: every call is recorded, and each answer is
 * released by the test, which is how the concurrent cases pin down what goes
 * upstream while a round trip is still in flight.
 */

interface ICall {
    slot: string;
    method: "resources/subscribe" | "resources/unsubscribe";
    uri: string;
    answer(outcome?: SubscriptionOutcome): void;
}

function scriptedUpstream(options: { auto?: boolean; connected?: boolean } = {}) {
    const calls: ICall[] = [];
    let connected = options.connected ?? true;
    const upstream: IResourceSubscriptionUpstream = {
        request(slot, method, uri) {
            return new Promise((resolve) => {
                const call: ICall = { slot, method, uri, answer: (outcome = { ok: true }) => resolve(outcome) };
                calls.push(call);
                if (options.auto !== false) call.answer();
            });
        },
        isConnected: () => connected,
    };
    return {
        upstream,
        calls,
        setConnected(value: boolean) {
            connected = value;
        },
    };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const REFUSED: SubscriptionOutcome = { ok: false, error: { code: -32002, message: "Resource not found" } };

describe("ResourceSubscriptionRegistry", () => {
    it("sends one upstream subscribe for N clients, and one unsubscribe when the last leaves", async () => {
        const { upstream, calls } = scriptedUpstream();
        const reg = new ResourceSubscriptionRegistry<string>(upstream);

        expect(await reg.subscribe("s", "a", "sink-a", "x://1")).toEqual({ ok: true });
        expect(await reg.subscribe("s", "b", "sink-b", "x://1")).toEqual({ ok: true });
        expect(calls.map((c) => c.method)).toEqual(["resources/subscribe"]);
        expect(reg.subscribers("s", "x://1").map((s) => s.client)).toEqual(["a", "b"]);

        await reg.unsubscribe("s", "a", "x://1");
        expect(calls).toHaveLength(1);
        await reg.unsubscribe("s", "b", "x://1");
        expect(calls.map((c) => c.method)).toEqual(["resources/subscribe", "resources/unsubscribe"]);
        expect(reg.stateOf("s", "x://1")).toBe("inactive");
        expect(reg.countFor("s")).toBe(0);
    });

    it("serializes concurrent subscribers behind the one upstream round trip", async () => {
        const { upstream, calls } = scriptedUpstream({ auto: false });
        const reg = new ResourceSubscriptionRegistry<string>(upstream);

        const first = reg.subscribe("s", "a", "sink-a", "x://1");
        const second = reg.subscribe("s", "b", "sink-b", "x://1");
        await flush();
        expect(calls).toHaveLength(1);
        expect(reg.stateOf("s", "x://1")).toBe("subscribing");

        calls[0].answer();
        expect(await first).toEqual({ ok: true });
        expect(await second).toEqual({ ok: true });
        expect(calls).toHaveLength(1);
        expect(reg.stateOf("s", "x://1")).toBe("active");
    });

    it("relays the provider's refusal and holds nothing afterwards", async () => {
        const { upstream, calls } = scriptedUpstream({ auto: false });
        const reg = new ResourceSubscriptionRegistry<string>(upstream);

        const pending = reg.subscribe("s", "a", "sink-a", "x://gone");
        await flush();
        calls[0].answer(REFUSED);
        expect(await pending).toEqual(REFUSED);
        expect(reg.subscribers("s", "x://gone")).toEqual([]);
        expect(reg.countFor("s")).toBe(0);
    });

    it("is idempotent: double subscribe, unknown unsubscribe, repeated removeClient", async () => {
        const { upstream, calls } = scriptedUpstream();
        const reg = new ResourceSubscriptionRegistry<string>(upstream);

        await reg.subscribe("s", "a", "sink-a", "x://1");
        await reg.subscribe("s", "a", "sink-a", "x://1");
        expect(reg.countFor("s")).toBe(1);
        expect(await reg.unsubscribe("s", "a", "x://never")).toEqual({ ok: true });
        await reg.removeClient("a");
        await reg.removeClient("a");
        await reg.removeClient("nobody");
        expect(calls.map((c) => c.method)).toEqual(["resources/subscribe", "resources/unsubscribe"]);
    });

    it("sends nothing upstream for a subscribe cancelled before its turn", async () => {
        const { upstream, calls } = scriptedUpstream({ auto: false });
        const reg = new ResourceSubscriptionRegistry<string>(upstream);

        await Promise.all([reg.subscribe("s", "a", "sink-a", "x://1"), reg.unsubscribe("s", "a", "x://1")]);
        expect(calls).toEqual([]);
        expect(reg.subscribers("s", "x://1")).toEqual([]);
    });

    it("never lets an unsubscribe overtake the subscribe in flight", async () => {
        const { upstream, calls } = scriptedUpstream({ auto: false });
        const reg = new ResourceSubscriptionRegistry<string>(upstream);

        const sub = reg.subscribe("s", "a", "sink-a", "x://1");
        await flush();
        const unsub = reg.unsubscribe("s", "a", "x://1");
        await flush();
        // The unsubscribe waits: the provider has not confirmed the subscribe yet.
        expect(calls.map((c) => c.method)).toEqual(["resources/subscribe"]);
        calls[0].answer();
        await sub;
        await flush();
        expect(calls.map((c) => c.method)).toEqual(["resources/subscribe", "resources/unsubscribe"]);
        calls[1].answer();
        await unsub;
        expect(reg.subscribers("s", "x://1")).toEqual([]);
    });

    it("enforces the per-client, per-slot and URI-length limits", async () => {
        const { upstream } = scriptedUpstream();
        const reg = new ResourceSubscriptionRegistry<string>(upstream, { maxSubscriptionsPerClient: 2, maxSubscriptionsPerSlot: 3, maxResourceUriLength: 10 });

        await reg.subscribe("s", "a", "a", "x://1");
        await reg.subscribe("s", "a", "a", "x://2");
        const perClient = await reg.subscribe("s", "a", "a", "x://3");
        expect(perClient.ok).toBe(false);
        if (!perClient.ok) expect(perClient.error.message).toContain("maxSubscriptionsPerClient");
        // Re-subscribing to what is already held is not a new subscription.
        expect(await reg.subscribe("s", "a", "a", "x://1")).toEqual({ ok: true });

        await reg.subscribe("s", "b", "b", "x://1");
        const perSlot = await reg.subscribe("s", "c", "c", "x://1");
        expect(perSlot.ok).toBe(false);
        if (!perSlot.ok) expect(perSlot.error.message).toContain("maxSubscriptionsPerSlot");

        const tooLong = await reg.subscribe("t", "d", "d", "x://0123456789");
        expect(tooLong.ok).toBe(false);
        if (!tooLong.ok) expect(tooLong.error.code).toBe(-32602);
    });

    it("keeps subscribers across a provider disconnect and replays once per URI", async () => {
        const { upstream, calls, setConnected } = scriptedUpstream();
        const reg = new ResourceSubscriptionRegistry<string>(upstream);
        await reg.subscribe("s", "a", "a", "x://1");
        await reg.subscribe("s", "b", "b", "x://1");
        await reg.subscribe("s", "a", "a", "x://2");
        calls.length = 0;

        setConnected(false);
        reg.providerDisconnected("s");
        expect(reg.stateOf("s", "x://1")).toBe("inactive");
        expect(reg.hasSubscriptions("s")).toBe(true);

        setConnected(true);
        const results = await reg.replay("s");
        expect(calls.map((c) => `${c.method} ${c.uri}`).sort()).toEqual(["resources/subscribe x://1", "resources/subscribe x://2"]);
        expect(results.every((r) => r.outcome.ok)).toBe(true);
        expect(reg.stateOf("s", "x://1")).toBe("active");
    });

    it("drops the subscribers of a URI the reconnected provider refuses", async () => {
        const { upstream, calls } = scriptedUpstream({ auto: false });
        const reg = new ResourceSubscriptionRegistry<string>(upstream);
        const sub = reg.subscribe("s", "a", "a", "x://1");
        await flush();
        calls[0].answer();
        await sub;

        reg.providerDisconnected("s");
        const replay = reg.replay("s");
        await flush();
        calls[1].answer(REFUSED);
        const [result] = await replay;
        expect(result.outcome).toEqual(REFUSED);
        expect(result.subscribers.map((s) => s.client)).toEqual(["a"]);
        expect(reg.subscribers("s", "x://1")).toEqual([]);
        expect(reg.countFor("s")).toBe(0);
    });

    it("does not call a disconnected provider when the last subscriber leaves", async () => {
        const { upstream, calls, setConnected } = scriptedUpstream();
        const reg = new ResourceSubscriptionRegistry<string>(upstream);
        await reg.subscribe("s", "a", "a", "x://1");
        setConnected(false);
        reg.providerDisconnected("s");
        await reg.removeClient("a");
        expect(calls.map((c) => c.method)).toEqual(["resources/subscribe"]);
        expect(reg.hasSubscriptions("s")).toBe(false);
    });
});
