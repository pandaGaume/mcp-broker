import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DirectTransport, MultiplexTransport } from "../src/index";
import { decodeEnvelope, encodeEnvelopeMessage, encodeErrorEnvelope, TUNNEL_REGISTER_METHOD, TunnelErrorCodes } from "../src/protocol/index";
import { PENDING_FRAME_LIMIT } from "../src/transport.support";

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
    onclose: ((event: CloseEvent) => void) | null = null;
    onerror: (() => void) | null = null;

    constructor(readonly url: string) {
        FakeWebSocket.instances.push(this);
    }

    send(data: string): void {
        this.sent.push(data);
    }

    /**
     * A close carries a code and a reason in every browser, and the transports
     * read them, so the fake must supply them too. `1000` is what a browser
     * reports for an application-initiated `close()` with no arguments.
     */
    close(code = 1000, reason = ""): void {
        this.readyState = FakeWebSocket.CLOSED;
        this.onclose?.({ code, reason } as CloseEvent);
    }

    // ── Test drivers ────────────────────────────────────────────────────────

    /** Completes the handshake, as a server accepting the connection would. */
    accept(): void {
        this.readyState = FakeWebSocket.OPEN;
        this.onopen?.();
    }

    /** A close driven by the peer, e.g. the broker refusing a slot with 1008. */
    closedByPeer(code: number, reason = ""): void {
        this.close(code, reason);
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

/**
 * The transports diagnose themselves on the console, which is the only place a
 * browser-hosted provider hears about a mis-wired tunnel. Captured rather than
 * printed, so the assertions can read it and the test output stays clean.
 */
const logged = { warn: [] as string[], error: [] as string[] };

beforeEach(() => {
    FakeWebSocket.instances = [];
    (globalThis as { WebSocket: unknown }).WebSocket = FakeWebSocket;

    logged.warn = [];
    logged.error = [];
    vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => void logged.warn.push(args.join(" ")));
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void logged.error.push(args.join(" ")));
});

afterEach(() => {
    (globalThis as { WebSocket: unknown }).WebSocket = realWebSocket;
    vi.restoreAllMocks();
    vi.useRealTimers();
});

/** Unique per test: MultiplexSocket caches one shared socket per URL. */
let urlCounter = 0;
function tunnelUrl(): string {
    return `ws://localhost:3000/providers?t=${urlCounter++}`;
}

/** A slot-scoped URL, which belongs to DirectTransport rather than to the tunnel. */
function slotUrl(name = "scene-1"): string {
    return `ws://localhost:3000/provider/${name}?t=${urlCounter++}`;
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

    it("queues outgoing frames while the tunnel is not open, and flushes them after the registrations", () => {
        const transport = MultiplexTransport.create("scene-1", tunnelUrl());
        transport.connect();
        const socket = lastSocket();

        const frame = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
        transport.send(frame);
        expect(socket.sent).toHaveLength(0);
        expect(transport.isOpen).toBe(false);

        socket.accept();

        // The slot is claimed first: traffic arriving before the broker knows
        // the slot exists is answered with "provider not connected".
        expect(socket.envelopes.map((e) => e?.payload)).toEqual([{ jsonrpc: "2.0", method: TUNNEL_REGISTER_METHOD }, JSON.parse(frame)]);
    });

    it("carries the aggregate opt-in on its registration when asked for it", () => {
        const transport = MultiplexTransport.create("scene-1", tunnelUrl(), { aggregate: true });
        transport.connect();
        lastSocket().accept();

        expect(lastSocket().envelopes[0]).toEqual({
            provider: "scene-1",
            payload: { jsonrpc: "2.0", method: TUNNEL_REGISTER_METHOD, params: { aggregate: true } },
        });
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

    it("ignores an orphaned socket instead of closing the live one out from under the server", () => {
        vi.useFakeTimers();

        const transport = MultiplexTransport.create("scene-1", tunnelUrl());
        let closed = 0;
        transport.onClose = () => closed++;
        transport.connect();

        const first = lastSocket();
        first.accept();
        first.closedByPeer(1006, "network drop");
        expect(closed).toBe(1);

        // The shared socket reconnects on its own, with back-off and jitter.
        vi.advanceTimersByTime(1_000);
        const second = lastSocket();
        expect(second).not.toBe(first);
        second.accept();
        expect(transport.isOpen).toBe(true);

        // A late event from the replaced socket must not speak for the instance.
        // Unguarded it nulls the shared socket, after which `isOpen` reads false
        // on a live tunnel and an MCP server silently stops answering.
        first.closedByPeer(1006, "late close from the orphan");
        expect(transport.isOpen).toBe(true);
        expect(closed).toBe(1);
        expect(FakeWebSocket.instances).toHaveLength(2);
    });

    it("names the framing mismatch when a plain JSON-RPC frame arrives", () => {
        const transport = MultiplexTransport.create("scene-1", tunnelUrl());
        transport.connect();
        lastSocket().accept();

        lastSocket().deliver('{"jsonrpc":"2.0","id":1,"result":{}}');

        expect(logged.error).toHaveLength(1);
        expect(logged.error[0]).toContain("not a tunnel envelope");
        expect(logged.error[0]).toContain("/provider/<name>");
        expect(logged.error[0]).toContain("DirectTransport");
    });

    it("names the slot and the registered ones when an envelope arrives for an unknown provider", () => {
        const transport = MultiplexTransport.create("scene-1", tunnelUrl());
        transport.connect();
        lastSocket().accept();

        lastSocket().deliver(encodeEnvelopeMessage("someone-else", { jsonrpc: "2.0", id: 1, result: {} }));

        expect(logged.error).toHaveLength(1);
        expect(logged.error[0]).toContain('"someone-else"');
        expect(logged.error[0]).toContain('"scene-1"');
    });

    it("says a refusal on the console too, the only place a browser provider hears it", () => {
        const transport = MultiplexTransport.create("scene-1", tunnelUrl());
        transport.connect();
        lastSocket().accept();

        lastSocket().deliver(encodeErrorEnvelope("scene-1", TunnelErrorCodes.RegistrationForbidden, "Provider registration forbidden"));

        // An MCP server overwrites `onError` when it starts and reports through
        // it only while it is not yet running, so without this line the refusal
        // is invisible to the developer.
        expect(logged.error).toHaveLength(1);
        expect(logged.error[0]).toContain("-32001");
        expect(logged.error[0]).toContain("Provider registration forbidden");
    });

    it("throttles a repeated diagnostic instead of flooding the console", () => {
        const transport = MultiplexTransport.create("scene-1", tunnelUrl());
        transport.connect();
        lastSocket().accept();

        for (let i = 0; i < 51; i++) {
            lastSocket().deliver('{"jsonrpc":"2.0","id":1,"result":{}}');
        }

        // The first occurrence in full, then one in fifty, and the repeat says
        // how many it stands for.
        expect(logged.error).toHaveLength(2);
        expect(logged.error[0]).not.toContain("occurrence");
        expect(logged.error[1]).toContain("occurrence 50");
    });

    it("names a frame written after the tunnel was closed", () => {
        const transport = MultiplexTransport.create("scene-1", tunnelUrl());
        transport.connect();
        lastSocket().accept();
        transport.close();

        transport.send(JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list" }));

        // Nothing will ever flush a queue on a closed tunnel, so this one is a
        // genuine drop, and saying so is the whole point.
        expect(logged.warn).toHaveLength(1);
        expect(logged.warn[0]).toContain("after the tunnel was closed");
        expect(logged.warn[0]).toContain("id 9");
    });

    it("warns when a transport closed earlier is reactivated onto a tunnel another instance now owns", () => {
        const url = tunnelUrl();
        const first = MultiplexTransport.create("scene-1", url);
        first.connect();
        lastSocket().accept();

        // The last transport leaving tears the shared socket down and gives up
        // the URL, so the next `create` builds a different instance for it.
        first.close();

        const second = MultiplexTransport.create("scene-2", url);
        second.connect();
        lastSocket().accept();

        // Reusing the closed transport reaches the instance it captured at
        // construction, which would quietly open a rival socket to the same URL.
        first.connect();

        expect(logged.warn).toHaveLength(1);
        expect(logged.warn[0]).toContain("reactivated");
    });

    it("warns when it is pointed at a slot-scoped URL, which carries no envelopes", () => {
        const transport = MultiplexTransport.create("scene-1", slotUrl());
        transport.connect();

        expect(logged.warn).toHaveLength(1);
        expect(logged.warn[0]).toContain("slot-scoped");
        expect(logged.warn[0]).toContain("DirectTransport");
        expect(logged.warn[0]).toContain("ws://localhost:3000/providers");
        // Never a throw: the broker's paths are configurable, so the heuristic
        // is allowed to be wrong.
        expect(transport.isOpen).toBe(false);
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

    it("queues frames written before the socket is open, then flushes them", () => {
        const transport = new DirectTransport("ws://localhost:3000/provider/scene-1");
        transport.connect();
        const socket = lastSocket();

        // The whole window between connect() and open used to be a silent hole:
        // an MCP server writes its handshake as soon as it is told to start.
        transport.send("{}");
        expect(socket.sent).toEqual([]);

        socket.accept();
        expect(socket.sent).toEqual(["{}"]);
    });

    it("caps the queue and drops the oldest frame with a warning naming it", () => {
        const transport = new DirectTransport("ws://localhost:3000/provider/scene-1");
        transport.connect();
        const socket = lastSocket();

        for (let id = 0; id <= PENDING_FRAME_LIMIT; id++) {
            transport.send(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/list" }));
        }
        socket.accept();

        expect(socket.sent).toHaveLength(PENDING_FRAME_LIMIT);
        expect(JSON.parse(socket.sent[0]).id).toBe(1);
        expect(logged.warn).toHaveLength(1);
        expect(logged.warn[0]).toContain("outbound queue full");
        expect(logged.warn[0]).toContain("id 0");
    });

    it("names a frame written after close() rather than queueing it forever", () => {
        const transport = new DirectTransport("ws://localhost:3000/provider/scene-1");
        transport.connect();
        lastSocket().accept();
        transport.close();

        transport.send(JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/call" }));

        expect(lastSocket().sent).toEqual([]);
        expect(logged.warn).toHaveLength(1);
        expect(logged.warn[0]).toContain("after close()");
        expect(logged.warn[0]).toContain("id 4");
    });

    it("claims the aggregate slot on open when asked, before anything it queued", () => {
        const transport = new DirectTransport("ws://localhost:3000/provider/scene-1", { aggregate: true });
        transport.connect();
        const socket = lastSocket();

        transport.send('{"jsonrpc":"2.0","id":1,"method":"tools/list"}');
        socket.accept();

        // Registration first: the broker runs `initialize` against a newly
        // aggregated provider straight away.
        expect(socket.sent).toEqual(['{"jsonrpc":"2.0","method":"notifications/register","params":{"aggregate":true}}', '{"jsonrpc":"2.0","id":1,"method":"tools/list"}']);
    });

    it("sends nothing on open when no aggregate membership was asked for", () => {
        const transport = new DirectTransport("ws://localhost:3000/provider/scene-1");
        transport.connect();
        lastSocket().accept();

        // The slot-scoped path registers from the URL at connect time, so a
        // registration frame would be redundant.
        expect(lastSocket().sent).toEqual([]);
    });

    it("surfaces a refusal's close code and reason, and reports it before the close", () => {
        const transport = new DirectTransport("ws://localhost:3000/provider/scene-1");
        const events: string[] = [];
        transport.onError = (error) => events.push(`error: ${error.message}`);
        transport.onClose = () => events.push("close");

        transport.connect();
        lastSocket().accept();
        lastSocket().closedByPeer(1008, 'Provider "scene-1" is already connected');

        // Order is load-bearing: an MCP server clears its running flag on close
        // and throws away anything reported afterwards.
        expect(events).toHaveLength(2);
        expect(events[0]).toContain("1008");
        expect(events[0]).toContain('Provider "scene-1" is already connected');
        expect(events[0]).toContain("policy refusal");
        expect(events[1]).toBe("close");
    });

    it("stays quiet on a normal close", () => {
        const transport = new DirectTransport("ws://localhost:3000/provider/scene-1");
        const events: string[] = [];
        transport.onError = (error) => events.push(`error: ${error.message}`);
        transport.onClose = () => events.push("close");

        transport.connect();
        lastSocket().accept();
        lastSocket().closedByPeer(1000, "");

        expect(events).toEqual(["close"]);
    });

    it("ignores a socket superseded by a second connect()", () => {
        const transport = new DirectTransport("ws://localhost:3000/provider/scene-1");
        let closed = 0;
        transport.onClose = () => closed++;

        transport.connect();
        const first = lastSocket();
        transport.connect();
        const second = lastSocket();
        second.accept();

        first.closedByPeer(1006, "late close from the orphan");

        expect(closed).toBe(0);
        expect(transport.isOpen).toBe(true);
    });

    it("warns when it is pointed at the shared multiplex base, which speaks envelopes", () => {
        const transport = new DirectTransport("ws://localhost:3000/providers");
        transport.connect();

        expect(logged.warn).toHaveLength(1);
        expect(logged.warn[0]).toContain("multiplex endpoint");
        expect(logged.warn[0]).toContain("MultiplexTransport.create");
        expect(logged.warn[0]).toContain("ws://localhost:3000/provider/<name>");
        // A warning, never a throw: the broker's paths are configurable.
        expect(transport.isOpen).toBe(false);
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
