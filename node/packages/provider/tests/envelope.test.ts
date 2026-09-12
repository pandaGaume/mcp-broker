import { describe, expect, it } from "vitest";
import {
    decodeEnvelope,
    encodeEnvelope,
    encodeEnvelopeMessage,
    encodeErrorEnvelope,
    encodeRegisterEnvelope,
    encodeRegisterFrame,
    envelopeFrame,
    TUNNEL_REGISTER_METHOD,
    TunnelErrorCodes,
    tunnelErrorOf,
} from "../src/protocol/index";

const request = { jsonrpc: "2.0", id: 1, method: "tools/list" };

describe("envelope encoding", () => {
    it("produces the exact wire format both ends already speak", () => {
        // Pinned on purpose: this string is what the existing client transport
        // and the broker tunnel exchange today. Changing it breaks the tunnel.
        expect(encodeEnvelopeMessage("scene-1", request)).toBe('{"provider":"scene-1","payload":{"jsonrpc":"2.0","id":1,"method":"tools/list"}}');
    });

    it("wraps an already-serialized frame identically", () => {
        expect(encodeEnvelope("scene-1", JSON.stringify(request))).toBe(encodeEnvelopeMessage("scene-1", request));
    });

    it("throws on a frame that is not JSON, since callers just serialized it", () => {
        expect(() => encodeEnvelope("scene-1", "not json")).toThrow();
    });

    it("round-trips through decode", () => {
        const decoded = decodeEnvelope(encodeEnvelopeMessage("scene-1", request));
        expect(decoded?.provider).toBe("scene-1");
        expect(decoded?.payload).toEqual(request);
        expect(envelopeFrame(decoded!)).toBe(JSON.stringify(request));
    });
});

describe("envelope decoding", () => {
    it.each([
        ["malformed JSON", "{not json"],
        ["a JSON array", '[{"provider":"a","payload":{}}]'],
        ["a bare string", '"hello"'],
        ["null", "null"],
        ["a missing provider", '{"payload":{}}'],
        ["an empty provider", '{"provider":"","payload":{}}'],
        ["a non-string provider", '{"provider":7,"payload":{}}'],
        ["a missing payload", '{"provider":"a"}'],
    ])("drops %s", (_label, raw) => {
        expect(decodeEnvelope(raw)).toBeUndefined();
    });

    it("keeps a payload that is falsy but present", () => {
        expect(decodeEnvelope('{"provider":"a","payload":null}')).toEqual({ provider: "a", payload: null });
    });
});

describe("registration", () => {
    it("claims a slot with a plain JSON-RPC notification", () => {
        const decoded = decodeEnvelope(encodeRegisterEnvelope("scene-1"));
        expect(decoded?.provider).toBe("scene-1");
        expect(decoded?.payload).toEqual({ jsonrpc: "2.0", method: TUNNEL_REGISTER_METHOD });
    });

    it("carries no id, so a peer that ignores it owes no response", () => {
        expect(encodeRegisterEnvelope("scene-1")).not.toContain('"id"');
    });

    it("stays byte-identical when no options are passed, which brokers already pin", () => {
        expect(encodeRegisterEnvelope("scene-1")).toBe('{"provider":"scene-1","payload":{"jsonrpc":"2.0","method":"notifications/register"}}');
        expect(encodeRegisterEnvelope("scene-1", {})).toBe(encodeRegisterEnvelope("scene-1"));
    });

    it("carries the aggregate opt-in as params when asked", () => {
        expect(decodeEnvelope(encodeRegisterEnvelope("scene-1", { aggregate: true }))?.payload).toEqual({
            jsonrpc: "2.0",
            method: TUNNEL_REGISTER_METHOD,
            params: { aggregate: true },
        });
    });

    it("keeps an explicit opt-out explicit, rather than dropping it", () => {
        expect(decodeEnvelope(encodeRegisterEnvelope("scene-1", { aggregate: false }))?.payload).toEqual({
            jsonrpc: "2.0",
            method: TUNNEL_REGISTER_METHOD,
            params: { aggregate: false },
        });
    });

    it("also builds the bare frame the slot-scoped path uses, which has no envelope", () => {
        // The slot name is absent on purpose: on `/provider/<name>` the broker
        // takes it from the URL at connect time, before any frame exists.
        expect(encodeRegisterFrame()).toBe('{"jsonrpc":"2.0","method":"notifications/register"}');
        expect(encodeRegisterFrame({ aggregate: true })).toBe('{"jsonrpc":"2.0","method":"notifications/register","params":{"aggregate":true}}');
    });
});

describe("tunnel errors", () => {
    it("builds the refusal the broker returns for a forbidden slot", () => {
        const decoded = decodeEnvelope(encodeErrorEnvelope("scene-1", TunnelErrorCodes.RegistrationForbidden, "Provider registration forbidden"));
        expect(decoded?.payload).toEqual({
            jsonrpc: "2.0",
            id: null,
            error: { code: -32001, message: "Provider registration forbidden" },
        });
    });

    it("is recognisable by the client, which would otherwise drop it silently", () => {
        const decoded = decodeEnvelope(encodeErrorEnvelope("scene-1", TunnelErrorCodes.ProviderUnavailable, "unavailable"));
        expect(tunnelErrorOf(decoded?.payload)?.code).toBe(-32000);
    });

    it("does not mistake a normal message for an error", () => {
        expect(tunnelErrorOf(request)).toBeUndefined();
        expect(tunnelErrorOf({ error: "oops" })).toBeUndefined();
        expect(tunnelErrorOf(null)).toBeUndefined();
    });
});
