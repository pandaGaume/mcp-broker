import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DirectTransport, MultiplexTransport } from "../src/index";
import { decodeEnvelope, encodeEnvelopeMessage, encodeErrorEnvelope, TUNNEL_REGISTER_METHOD, TunnelErrorCodes } from "../src/protocol/index";

// ---------------------------------------------------------------------------
// A WebSocket stand-in the test drives by hand
// ---------------------------------------------------------------------------

class FakeWebSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;

    /** Every socket built since the last reset, in construction order. */
    static instances: FakeWebSocket[] = [];

    readyState: number = FakeWebSocket.CONNECTING;
    readonly sent: string[] = [];

    onopen: (() => void) | null = null;
    onmessage: ((event: MessageEvent<string>) => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;

    constructor(readonly url: string) {
        FakeWebSocket.instances.push(this);
    }

    send(data: string): void {
        this.sent.push(data);
    }

    close(): void {
        this.readyState = FakeWebSocket.CLOSED;
        this.onclose?.();
    }

    // ── Test drivers ────────────────────────────────────────────────────────

    /** Completes the handshake, as a server accepting the connection would. */
    accept(): void {
        this.readyState = FakeWebSocket.OPEN;
        this.onopen?.();
    }

    /** Delivers a raw frame from the peer. */
    deliver(raw: string): void {
        this.onmessage?.({ data: raw } as MessageEvent<string>);
    }

    /** Decoded view of everything this socket sent. */
    get envelopes() {
        return this.sent.map((frame) => decodeEnvelope(frame));
    }
}

const realWebSocket = globalThis.WebSocket;

beforeEach(() => {
    FakeWebSocket.instances = [];
    (globalThis as { WebSocket: unknown }).WebSocket = FakeWebSocket;
});

afterEach(() => {
    (globalThis as { WebSocket: unknown }).WebSocket = realWebSocket;
});

/** Unique per test: MultiplexSocket caches one shared socket per URL. */
let urlCounter = 0;
function tunnelUrl(): string {
    return `ws://localhost:3000/providers?t=${urlCounter++}`;
}

function lastSocket(): FakeWebSocket {
    return FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
}

// ---------------------------------------------------------------------------
// MultiplexTransport
// ---------------------------------------------------------------------------

describe("MultiplexTransport", () => {
    it("claims its slot as soon as the tunnel opens", () => {
        const transport = MultiplexTransport.create("scene-1", tunnelUrl());
        transport.connect();
        lastSocket().accept();

        expect(lastSocket().envelopes).toHaveLength(1);
        expect(lastSocket().envelopes[0]).toEqual({
            provider: "scene-1",
            payload: { jsonrpc: "2.0", method: TUNNEL_REGISTER_METHOD },
        });
    });

    it("wraps outgoing frames in an envelope carrying its slot name", () => {
        const transport = MultiplexTransport.create("scene-1", tunnelUrl());
        transport.connect();
        const socket = lastSocket();
        socket.accept();

        transport.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }));

        expect(socket.envelopes[1]).toEqual({
            provider: "scene-1",
            payload: { jsonrpc: "2.0", id: 1, method: "tools/list" },
        });
    });

    it("drops outgoing frames while the tunnel is not open", () => {
        const transport = MultiplexTransport.create("scene-1", tunnelUrl());
        transport.connect();
        const socket = lastSocket();

        transport.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
        expect(socket.sent).toHaveLength(0);
        expect(transport.isOpen).toBe(false);
    });

    it("unwraps an incoming envelope and routes it to the matching slot", () => {
        const url = tunnelUrl();
        const first = MultiplexTransport.create("scene-1", url);
        const second = MultiplexTransport.create("scene-2", url);

        const toFirst: string[] = [];
        const toSecond: string[] = [];
        first.onMessage = (data) => toFirst.push(data);
        second.onMessage = (data) => toSecond.push(data);

        first.connect();
        second.connect();
        const socket = lastSocket();
        socket.accept();

        // One socket for both slots, even though the second registered while
        // the handshake was still in flight, and each announced itself on it.
        expect(FakeWebSocket.instances).toHaveLength(1);
        expect(socket.envelopes.map((e) => e?.provider)).toEqual(["scene-1", "scene-2"]);

        const response = { jsonrpc: "2.0", id: 1, result: { tools: [] } };
        socket.deliver(encodeEnvelopeMessage("scene-2", response));

        expect(toFirst).toEqual([]);
        expect(toSecond).toEqual([JSON.stringify(response)]);
    });

    it.each([
        ["a malformed frame", "{not json"],
        ["an envelope for an unknown slot", encodeEnvelopeMessage("someone-else", { jsonrpc: "2.0", id: 1, result: {} })],
    ])("drops %s", (_label, raw) => {
        const transport = MultiplexTransport.create("scene-1", tunnelUrl());
        const received: string[] = [];
        transport.onMessage = (data) => received.push(data);
        transport.connect();
        lastSocket().accept();

        lastSocket().deliver(raw);
        expect(received).toEqual([]);
    });

    it("surfaces a refused registration as an error instead of swallowing it", () => {
        const transport = MultiplexTransport.create("scene-1", tunnelUrl());
        const received: string[] = [];
        const errors: string[] = [];
        transport.onMessage = (data) => received.push(data);
        transport.onError = (error) => errors.push(error.message);
        transport.connect();
        lastSocket().accept();

        lastSocket().deliver(encodeErrorEnvelope("scene-1", TunnelErrorCodes.RegistrationForbidden, "Provider registration forbidden"));

        // Forwarding it would have reached an MCP server, which classifies an
        // id-less frame as an unknown notification and drops it silently.
        expect(received).toEqual([]);
        expect(errors).toHaveLength(1);
        expect(errors[0]).toContain("-32001");
        expect(errors[0]).toContain("Provider registration forbidden");
    });

    it("still forwards a genuine JSON-RPC error response, which carries an id", () => {
        const transport = MultiplexTransport.create("scene-1", tunnelUrl());
        const received: string[] = [];
        const errors: string[] = [];
        transport.onMessage = (data) => received.push(data);
        transport.onError = (error) => errors.push(error.message);
        transport.connect();
        lastSocket().accept();

        const failure = { jsonrpc: "2.0", id: 7, error: { code: -32601, message: "Method not found" } };
        lastSocket().deliver(encodeEnvelopeMessage("scene-1", failure));

        expect(errors).toEqual([]);
        expect(received).toEqual([JSON.stringify(failure)]);
    });

    it("notifies every slot when the tunnel closes", () => {
        const url = tunnelUrl();
        const first = MultiplexTransport.create("scene-1", url);
        const second = MultiplexTransport.create("scene-2", url);

        let closed = 0;
        first.onClose = () => closed++;
        second.onClose = () => closed++;

        first.connect();
        second.connect();
        lastSocket().accept();
        lastSocket().close();

        expect(closed).toBe(2);
    });
});

// ---------------------------------------------------------------------------
// DirectTransport
// ---------------------------------------------------------------------------

describe("DirectTransport", () => {
    it("opens one socket of its own and reports readiness", () => {
        const transport = new DirectTransport("ws://localhost:3000/provider/scene-1");
        let opened = 0;
        transport.onOpen = () => opened++;

        transport.connect();
        expect(transport.isOpen).toBe(false);

        lastSocket().accept();
        expect(opened).toBe(1);
        expect(transport.isOpen).toBe(true);
        expect(lastSocket().url).toBe("ws://localhost:3000/provider/scene-1");
    });

    it("sends frames verbatim, with no envelope", () => {
        const transport = new DirectTransport("ws://localhost:3000/provider/scene-1");
        transport.connect();
        lastSocket().accept();

        const frame = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
        transport.send(frame);
        expect(lastSocket().sent).toEqual([frame]);
    });

    it("drops frames sent before the socket is open", () => {
        const transport = new DirectTransport("ws://localhost:3000/provider/scene-1");
        transport.connect();

        transport.send("{}");
        expect(lastSocket().sent).toEqual([]);
    });

    it("forwards incoming frames untouched", () => {
        const transport = new DirectTransport("ws://localhost:3000/provider/scene-1");
        const received: string[] = [];
        transport.onMessage = (data) => received.push(data);

        transport.connect();
        lastSocket().accept();
        lastSocket().deliver('{"jsonrpc":"2.0","id":1,"result":{}}');

        expect(received).toEqual(['{"jsonrpc":"2.0","id":1,"result":{}}']);
    });
});
