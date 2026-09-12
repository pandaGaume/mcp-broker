import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { connect, type Socket } from "node:net";
import type { AddressInfo } from "net";
import { WebSocket } from "ws";
import { WsTunnelBuilder } from "../src/index";
import type { WsTunnel } from "../src/ws/ws.tunnel";

/**
 * Tunnel lifecycle: slot ownership across a reconnect, socket-level faults, a
 * failed bind, and the timers the sweepers install.
 *
 * These are the failures that used to take the whole broker down or wedge it
 * for good, and none of them had coverage. Each case asserts the *named*
 * outcome (a slot still held, a provider still relaying, a rejected promise
 * whose message carries the port) rather than merely that nothing crashed,
 * because "nothing crashed" is exactly what the broken versions also did.
 */

interface IJsonRpc {
    jsonrpc: "2.0";
    id?: string | number | null;
    method?: string;
    params?: Record<string, unknown>;
    result?: Record<string, unknown>;
    error?: { code: number; message: string };
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

let tunnel: WsTunnel | null = null;
const sockets: WebSocket[] = [];
const rawSockets: Socket[] = [];
const blockers: Server[] = [];

/** Starts a tunnel on an ephemeral port and returns its `ws://` base URL. */
async function start(configure: (b: WsTunnelBuilder) => void = () => {}): Promise<string> {
    const builder = new WsTunnelBuilder().withPort(0).withHost("127.0.0.1");
    configure(builder);
    tunnel = builder.build();
    await tunnel.start();
    return `ws://127.0.0.1:${port(tunnel)}`;
}

/** The port a started tunnel actually bound. */
function port(t: WsTunnel): number {
    const server = (t as unknown as { _httpServer: { address(): AddressInfo } })._httpServer;
    return server.address().port;
}

/** Opens a socket and tracks it for teardown, resolving once it is open. */
async function open(url: string): Promise<WebSocket> {
    const ws = new WebSocket(url);
    sockets.push(ws);
    await new Promise<void>((resolve, reject) => {
        ws.once("open", () => resolve());
        ws.once("error", (err) => reject(err));
    });
    return ws;
}

/** Resolves with the next JSON-RPC frame the socket receives. */
function nextMessage(ws: WebSocket): Promise<IJsonRpc> {
    return new Promise((resolve) => {
        ws.once("message", (raw: Buffer) => resolve(JSON.parse(raw.toString()) as IJsonRpc));
    });
}

/** Answers every request with `{ ok: <label> }`, so a relay can be proven. */
function echo(ws: WebSocket, label: string): void {
    ws.on("message", (raw: Buffer) => {
        const msg = JSON.parse(raw.toString()) as IJsonRpc;
        if (msg.id == null) return;
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { ok: label } }));
    });
}

/** The server-side socket currently registered on a slot, if any. */
function heldSocket(name: string): WebSocket | null {
    return (tunnel as unknown as { _providers: Map<string, { ws: WebSocket | null }> })._providers.get(name)?.ws ?? null;
}

afterEach(async () => {
    for (const s of sockets) {
        try {
            s.terminate();
        } catch {
            /* ignore */
        }
    }
    sockets.length = 0;
    for (const s of rawSockets) s.destroy();
    rawSockets.length = 0;
    await tunnel?.stop();
    tunnel = null;
    for (const b of blockers) await new Promise<void>((r) => b.close(() => r()));
    blockers.length = 0;
});

describe("a provider that reconnects while its predecessor is still closing", () => {
    it("keeps the slot registered to the socket that actually holds it", async () => {
        // The reproduction, made deterministic. `pause()` stops the incumbent
        // CLIENT from reading, so it never answers the close frame the server
        // sends and the SERVER-side socket sits in CLOSING for as long as we
        // want. A newcomer arriving in that window is admitted (the incumbent
        // is no longer OPEN), and the predecessor's deferred close then fires
        // *after* the newcomer took the slot.
        //
        // Without the `state.ws !== ws` guard that close nulls the newcomer's
        // registration: the socket is open and answering, `provider_status`
        // says `connected: false`, and the slot is wedged for good, because the
        // aggregate opt-in is only read once per socket.
        const base = await start();
        const incumbent = await open(`${base}/provider/wedge`);
        await delay(50);

        const held = heldSocket("wedge");
        expect(held).toBeTruthy();

        incumbent.pause();
        held!.close(1000, "server-initiated");
        await delay(50);

        // The window this test exists for. If the socket is not CLOSING the
        // scenario was never reproduced, so fail loudly rather than pass by
        // accident.
        expect(held!.readyState).toBe(WebSocket.CLOSING);

        const newcomer = await open(`${base}/provider/wedge`);
        echo(newcomer, "newcomer");
        // The newcomer was admitted and now owns the registration.
        expect(heldSocket("wedge")).not.toBe(held);

        // Let the interrupted close handshake finish. This is the moment the
        // predecessor's close handler runs.
        incumbent.resume();
        await delay(250);

        // Two facts together are the proof. The predecessor reached CLOSED, so
        // its close handler really did run, *after* the newcomer took the slot;
        // and the slot is still registered. Without the guard the second fact
        // is false precisely because the first one is true.
        expect(held!.readyState).toBe(WebSocket.CLOSED);
        expect(tunnel?.getProviderInfo("wedge")?.connected).toBe(true);

        // Not merely registered: still serving. A wedged slot reports the same
        // socket and answers nothing.
        const client = await open(`${base}/wedge`);
        const answer = nextMessage(client);
        client.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }));
        expect((await answer).result?.ok).toBe("newcomer");
    });

    it("still releases the slot when the socket that holds it closes", async () => {
        // The guard must not turn into "a close never releases anything".
        const base = await start();
        const provider = await open(`${base}/provider/plain`);
        await delay(50);
        expect(tunnel?.getProviderInfo("plain")?.connected).toBe(true);

        provider.close();
        await delay(250);
        expect(tunnel?.getProviderInfo("plain")?.connected).toBe(false);
    });
});

describe("a protocol fault on one inbound socket", () => {
    /**
     * Performs the WebSocket handshake by hand and hands back the raw socket,
     * so the test can write a frame `ws` would never produce.
     */
    async function rawUpgrade(host: string, tcpPort: number, path: string): Promise<Socket> {
        const socket = connect(tcpPort, host);
        rawSockets.push(socket);
        await new Promise<void>((resolve, reject) => {
            socket.once("connect", () => resolve());
            socket.once("error", reject);
        });
        socket.write(
            `GET ${path} HTTP/1.1\r\n` +
                `Host: ${host}:${tcpPort}\r\n` +
                `Upgrade: websocket\r\n` +
                `Connection: Upgrade\r\n` +
                `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n` +
                `Sec-WebSocket-Version: 13\r\n\r\n`
        );
        await new Promise<void>((resolve, reject) => {
            let head = "";
            const onData = (chunk: Buffer): void => {
                head += chunk.toString("latin1");
                if (!head.includes("\r\n\r\n")) return;
                socket.off("data", onData);
                if (head.startsWith("HTTP/1.1 101")) resolve();
                else reject(new Error(`upgrade refused: ${head.split("\r\n")[0]}`));
            };
            socket.on("data", onData);
        });
        return socket;
    }

    it("does not kill the process and does not disturb the other providers", async () => {
        // `ws` validates UTF-8 on every text frame it receives and emits
        // `'error'` when it fails. Node rethrows an unhandled `'error'` as an
        // uncaught exception, so before the listener was added, one malformed
        // frame from one provider took the broker down and every other provider
        // with it. Here the fault arrives on `rogue` and `healthy` must not
        // notice.
        const base = await start();
        const healthy = await open(`${base}/provider/healthy`);
        echo(healthy, "healthy");
        await delay(50);

        const rogue = await rawUpgrade("127.0.0.1", port(tunnel!), "/provider/rogue");
        await delay(50);
        expect(tunnel?.getProviderInfo("rogue")?.connected).toBe(true);

        // A masked text frame whose payload is `C3 28`, an invalid UTF-8
        // sequence. FIN + text opcode, MASK set, length 2.
        const mask = Buffer.from([0x01, 0x02, 0x03, 0x04]);
        const payload = Buffer.from([0xc3, 0x28]);
        const masked = Buffer.from([payload[0] ^ mask[0], payload[1] ^ mask[1]]);
        rogue.write(Buffer.concat([Buffer.from([0x81, 0x82]), mask, masked]));

        await delay(300);

        // The tunnel survived, the faulted slot was released, and the neighbour
        // is still relaying rather than merely still listed.
        expect(tunnel?.isListening).toBe(true);
        expect(tunnel?.getProviderInfo("rogue")?.connected).toBe(false);

        const client = await open(`${base}/healthy`);
        const answer = nextMessage(client);
        client.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }));
        expect((await answer).result?.ok).toBe("healthy");
    });

    it("survives an 'error' raised on a client socket too", async () => {
        // Every inbound socket got a listener, not only the provider ones.
        // Emitting the event directly is the assertion: an EventEmitter with no
        // `'error'` listener throws on emit.
        const base = await start();
        await open(`${base}/some-slot`);
        await delay(50);

        const providers = (tunnel as unknown as { _providers: Map<string, { wsClients: Set<WebSocket> }> })._providers;
        const socket = [...(providers.get("some-slot")?.wsClients ?? [])][0];
        expect(socket).toBeTruthy();
        expect(() => socket.emit("error", new Error("simulated receive fault"))).not.toThrow();
        expect(tunnel?.isListening).toBe(true);
    });
});

describe("a bind that cannot succeed", () => {
    it("rejects start() with a message naming the port, instead of crashing", async () => {
        // `ws` mirrors the HTTP server's `'error'` onto the WebSocketServer from
        // a listener it installs in its own constructor, and rethrows it. The
        // failure therefore used to land as an uncaught exception outside the
        // caller's `await`, where no `catch` could reach it.
        const blocker = createServer();
        blockers.push(blocker);
        await new Promise<void>((r) => blocker.listen(0, "127.0.0.1", () => r()));
        const taken = (blocker.address() as AddressInfo).port;

        const second = new WsTunnelBuilder().withPort(taken).withHost("127.0.0.1").build();
        let raised: Error | null = null;
        try {
            await second.start();
        } catch (err) {
            raised = err as Error;
        }

        expect(raised).toBeInstanceOf(Error);
        expect(raised!.message).toContain(String(taken));
        expect(raised!.message).toContain("already in use");
        // The message names the fix rather than only the fault: attach to the
        // broker that already holds the port, do not spawn a rival that shares
        // no slot with it.
        expect(raised!.message).toContain(`/_broker/mcp`);
        expect(raised!.message).toContain("MCP_BROKER_PORT");
        // The original errno survives for anything matching on it.
        expect((raised!.cause as NodeJS.ErrnoException | undefined)?.code).toBe("EADDRINUSE");

        // The caller's `finally` runs `stop()` on a tunnel that never listened.
        // That must not replace the real diagnosis with a meaningless one.
        await expect(second.stop()).resolves.toBeUndefined();
    });

    it("resolves stop() on a tunnel that was never started", async () => {
        const never = new WsTunnelBuilder().withPort(0).build();
        await expect(never.stop()).resolves.toBeUndefined();
    });
});

describe("the sweeper intervals", () => {
    it("are unref'd, so they cannot hold the process (or this suite) open", async () => {
        // A referenced interval here would hang every test file that starts a
        // tunnel, which is why this is asserted rather than assumed.
        await start((b) => b.withProviderHeartbeat(1000).withProviderRequestTimeout(1000));
        const timers = tunnel as unknown as { _heartbeatTimer: NodeJS.Timeout | null; _requestTimeoutTimer: NodeJS.Timeout | null };

        expect(timers._heartbeatTimer).toBeTruthy();
        expect(timers._heartbeatTimer!.hasRef()).toBe(false);
        expect(timers._requestTimeoutTimer).toBeTruthy();
        expect(timers._requestTimeoutTimer!.hasRef()).toBe(false);

        await tunnel!.stop();

        // And `stop()` clears them, so a restarted tunnel does not accumulate.
        expect(timers._heartbeatTimer).toBeNull();
        expect(timers._requestTimeoutTimer).toBeNull();
        tunnel = null;
    });

    it("installs neither timer when both are disabled", async () => {
        await start((b) => b.withProviderHeartbeat(0).withProviderRequestTimeout(0));
        const timers = tunnel as unknown as { _heartbeatTimer: NodeJS.Timeout | null; _requestTimeoutTimer: NodeJS.Timeout | null };
        expect(timers._heartbeatTimer).toBeNull();
        expect(timers._requestTimeoutTimer).toBeNull();
    });
});
