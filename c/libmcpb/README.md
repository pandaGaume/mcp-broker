# libmcpb

Provider client for [mcp-broker](https://www.npmjs.com/package/@cyanmycelium/mcp-broker). C99, no allocation.

The device dials out to the broker and publishes itself as a named slot:

```
ws[s]://<host>/provider/<encoded name>
one text frame = one JSON-RPC message, no envelope
```

So it needs no inbound port, no port forwarding and no fixed address: it works from behind a NAT, a phone hotspot or a plant firewall.

## Two endpoints

**Dedicated** (`mcpb_provider.h`): `ws[s]://<host>/provider/<name>`, one socket per provider, one JSON-RPC message per frame. The default, and all a device with one server needs.

**Multiplexed** (`mcpb_mux.h`): `ws[s]://<host>/providers`, one socket carrying several slots, each frame wrapped in the tunnel envelope `{"provider":"<slot>","payload":<JSON-RPC>}`. For a process that hosts several MCP servers and does not want a socket each: a game engine, a gateway. Each slot is claimed with a registration envelope when the socket opens and again at every reconnection; `aggregate` is per slot. A registration the broker refuses comes back as `MCPB_EVENT_SLOT_REFUSED` with the slot, the JSON-RPC code (`-32000` held by someone else, `-32001` forbidden) and the broker's message, and the other slots keep working.

The envelope is transport framing, not MCP, which is why it lives here without breaking "opaque bytes": the payload is located by a balanced scan of one JSON value and handed over exactly as written, never interpreted.

The multiplexed endpoint is **opt-in at build time**: `MCPB_ENABLE_MUX=1` plus the two files `mcpb_envelope.c` and `mcpb_mux.c`. Off, they are not compiled at all, so a one-provider firmware carries none of it (`cmake -DMCPB_MUX=OFF`, `make` without `MUX=1`, Kconfig `MCPB_ESP_MULTIPLEX` off). On Xtensa at `-Os` they weigh 3.4 KB of flash; and even compiled, a firmware that never calls them does not link them, since IDF builds with function sections. Including `mcpb_mux.h` without the define is a compile error that names the fix, not an undefined reference at link time.

```c
static const mcpb_mux_slot_t slots[] = { { "scene", 1 }, { "input", 0 } };  /* scene joins _all, input does not */
static char envelope[4096 + 128];

mcpb_mux_config_t mc = {0};
mc.link.host = "broker.example.com"; mc.link.port = 3000;
mc.link.rx_buffer = rx; mc.link.rx_capacity = sizeof(rx);
mc.tx_buffer = envelope; mc.tx_capacity = sizeof(envelope);
mcpb_mux_init(&mux, &my_port, &mc, slots, 2);

for (;;) {
    size_t slot; const char *msg; size_t len;
    if (mcpb_mux_poll(&mux, &slot, &msg, &len, 100) == MCPB_OK && slot != MCPB_MUX_UNKNOWN_SLOT) {
        /* msg is the bare JSON-RPC message for slots[slot]; answer with: */
        mcpb_mux_send(&mux, slot, reply, reply_len);
    }
}
```

Underneath, the multiplexed link is the same `mcpb_provider_t` on a fixed path: connection, retry window, ping and events are the ones documented below, once.

## Standalone

`libmcpb/` lifts out whole. It includes nothing from CyanMycelium, no platform header, and no third-party library. Everything system-dependent goes through `mcpb_port.h`. It declares its own error codes rather than borrowing the host's, because a library that borrows its first host's types stops being extractable.

## Linkage

`MCPB_API` prefixes the public functions and is empty by default: a static library, or sources compiled into the program, which is every embedded build. A host that packages libmcpb inside one shared library and calls it from another (an Unreal editor build is one DLL per module) defines `MCPB_BUILD_DLL` while compiling the library and `MCPB_USE_DLL` in the consumers; `mcpb.h` turns them into the platform's export and import attributes without depending on any host header.

## Porting: six functions, and a seventh you want

Fill in an `mcpb_port_t`:

| Function | Role |
|---|---|
| `open` | opens a stream to `host:port`, TLS included; it also resolves the name |
| `send` | writes **all** the bytes, or fails |
| `recv` | reads at most `n` bytes |
| `close` | closes; must tolerate an already-closed stream |
| `now_ms` | monotonic clock, no particular epoch |
| `random` | unpredictable bytes |
| `sleep_ms` | optional: blocks the task for that long, yielding the processor |

`sleep_ms` is what a poll waits with while the link is down and the next attempt is not due: there is no socket to wait on then. Leave it `NULL` and the poll returns at once in that state, so the caller's loop spins until the retry, which on an RTOS starves the idle task and trips its watchdog (the ESP32 did exactly that before the function existed). Every port in this repository fills it in.

Three conventions the library's correctness depends on:

**`recv` never returns zero.** A peer that closed returns `MCPB_ERR_CLOSED`, an elapsed timeout returns `MCPB_ERR_TIMEOUT`. Confusing the two is the most common flaw in network clients: a client that reads a close as slowness spins until its own timeout instead of reconnecting.

**`send` writes everything or fails.** A partial write reported as success desynchronises the stream for good, the peer then reading a frame length out of payload bytes.

**`open` refuses rather than falling back to plaintext.** A port without TLS returns `MCPB_ERR_UNSUPPORTED` for `tls != 0`. A silent fallback is the worst outcome, because nothing reports it.

TLS does not have to be written into every port. [`ports/tls-openssl`](../ports/tls-openssl/) is a port that takes another port's six functions and returns six of its own, encrypted; the library is handed the outer one. A port that only moves bytes gets wss:// by stacking, and `MCPB_ERR_TLS` is the code a port returns when the handshake or the certificate is what failed, so that a wrong certificate does not read as a bad cable.

## In and out

**In:** RFC 6455 handshake with `Sec-WebSocket-Accept` verification, frame codec, client masking, fragmentation, ping/pong, close, reconnection with a growing window and a randomised wait, SHA-1 and base64.

SHA-1 and base64 are built in rather than asked of the port, because every obligation removed from the port is one more project that can adopt the library without a discussion. SHA-1 has no secrecy role here: RFC 6455 uses it as a consistency check against a public constant.

**Out:** JSON. The library carries opaque bytes, so it stays independent of whatever MCP implementation sits behind it and does not embed a parser every project already has.

**Out too:** allocation. No `malloc` anywhere. Buffers come from the caller, so memory use is visible at the call site instead of buried. That is what makes it usable on an MCU with no heap.

## Usage

```c
static uint8_t rx[4096];

mcpb_provider_config_t cfg = {0};
cfg.host = "broker.example.com";
cfg.port = 3000;
cfg.name = "MAC:ACA70405A4EC";   /* encoded as MAC%3AACA70405A4EC */
cfg.aggregate = 1;               /* also join the _all aggregate slot */
cfg.rx_buffer = rx;
cfg.rx_capacity = sizeof(rx);

mcpb_provider_t provider;
mcpb_provider_init(&provider, &my_port, &cfg);

for (;;) {
    const char *msg; size_t len;
    int rc = mcpb_provider_poll(&provider, &msg, &len, 100);
    if (rc == MCPB_OK) {
        /* msg is a JSON-RPC message. Handle it, then: */
        mcpb_provider_send(&provider, reply, reply_len);
    }
    /* MCPB_ERR_TIMEOUT is the NORMAL return of an idle loop.
       Any other error is already counted and the retry scheduled. */
}
```

`mcpb_provider_init` opens nothing: the connection happens on the first `poll`, so a device booting without a network does not stall its startup on an unreachable broker.

`aggregate` sends `{"jsonrpc":"2.0","method":"notifications/register","params":{"aggregate":true}}` as the first frame after every connection, which is how a provider asks into the `_all` slot (opt-in, because `_all` is a content-confidentiality boundary). The broker then sends `initialize` at once; `poll` delivers it like any other request. Without the flag the provider is reachable on its own slot only. Needs mcp-broker 1.3.0 or later: an older broker routes the frame as ordinary traffic and the provider silently stays on its own slot.

## What the broker expects of the device

Two obligations, both broker defaults and both configurable there:

- **Poll at least every 30 s** (`providerHeartbeatIntervalMs`). The broker pings every provider socket and terminates one that misses a full interval. The Pong is answered from inside `poll`, so a device busy elsewhere for longer than that is dropped as dead; it gets its slot back on the next `poll`, but every client request in between failed.
- **Answer within 60 s** (`providerRequestTimeoutMs`). Past that the broker fails the request for the client and drops the late reply as unmatched. A tool that runs longer answers first and reports later, through a notification.

In return a device that reboots gets its slot back within one or two heartbeat intervals (30 to 60 s by default): the broker pings every provider socket at each sweep and hands a slot to a newcomer once the incumbent has missed a ping, instead of holding it until the OS gives up on the half-open TCP connection, which takes hours. Until then the newcomer is refused with close `1008` and a reason naming the held slot (`Slot already held by a live provider...`), which the retry window absorbs on its own.

## Recovery: a doubling window, a wait drawn inside it

The two halves do different jobs, and neither replaces the other.

Exponential growth bounds the **rate** of one device's attempts. It does not **decorrelate** devices: a hundred that lose the link at the same instant, on a broker restart or a site outage, share one schedule and come back in lockstep. The broker comes up, gets a hundred handshakes in the same millisecond, fails, and the next wave arrives bunched too.

The **draw** is what spreads the load. The applied wait is taken uniformly from `[0, window]`, over the whole window rather than its upper half: halving the spread halves how many devices the broker absorbs per second as it comes back up.

The bench measures it on 64 devices failing at the same instant: **63 distinct retry instants, spread from 44 to 994 ms**. A counter-test with `retry_no_jitter` checks that without the draw they all restart together.

The window is kept separate from the applied wait (`retry_window_ms`), which keeps it deterministic and observable even though the applied delay is random. It returns to its floor after a successful connection; without that reset, one isolated outage would leave the device at thirty seconds for every later recovery.

### Doubling stops, and the cap is itself bounded

Doubling stops at `retry_max_ms`, and `retry_max_ms` is clamped to `MCPB_RETRY_CEILING_MS`, one hour by default. Both bounds matter, and the second is not caution for its own sake.

One extra zero on `retry_max_ms` is invisible: the device is simply absent from the broker, which takes days to attribute to the right cause. Worse, the retry deadline is compared as a **signed** 32-bit difference so it survives counter wraparound, and that is only correct below 2^31 ms, about 24.8 days. Past that you do not get a long wait: you get a device that retries constantly, or never again, depending on the sign. The hard ceiling leaves three orders of magnitude of margin.

A deployment with real reasons to wait longer (satellite link, metered data) redefines the constant **at compile time**, so the choice stays bounded and visible in the build.

If entropy is unavailable the wait becomes the full window: degraded but working. Failing a reconnection for want of entropy would be worse than bunching it.

## Critical systems: the notification is immediate

A critical system must not learn about a lost link by noticing that replies stopped. It has to know when it happens, to raise an alarm, fall back to local autonomy, or refuse a command it could no longer report on.

> **The notification is immediate. The random wait only delays the network retry.**

Jittering the announcement too would make the moment an application learns it is isolated depend on chance, and would delay a safety alarm by seconds for no reason. The event is emitted **before** any wait, and carries the chosen delay so the caller knows when the retry will happen without polling.

```c
static void on_link(void *user, const mcpb_event_t *e)
{
    switch (e->type) {
    case MCPB_EVENT_CONNECTED:
        /* e->down_ms: how long the outage lasted. On the first
           connection, the time to service. */
        alarm_clear(ALARM_BROKER_LINK);
        break;
    case MCPB_EVENT_DISCONNECTED:
        /* The link WAS up. This is where the alarm belongs, and only
           here: e->error says why, e->next_retry_ms when the retry
           will happen. e->close_code and e->reason carry the peer's
           own account when it closed: the broker's 1008 comes with the
           sentence naming the mismatch or the policy that refused. */
        alarm_raise(ALARM_BROKER_LINK, e->error);
        log("%s (%u %s)", mcpb_strerror(e->error), e->close_code, e->reason);
        break;
    case MCPB_EVENT_RETRY_FAILED:
        /* Follow-up, not an incident: we were already offline.
           e->attempts carries the consecutive failures, which is what
           an escalation should key on. e->http_status is set when the
           server answered the handshake with a refusal: 401 or 403 is
           authentication, 400 a path the broker rejects, 404 a wrong
           prefix, 503 a broker not ready. */
        break;
    }
}

cfg.on_event = on_link;
cfg.event_user = &my_context;
```

`DISCONNECTED` and `RETRY_FAILED` are separate on purpose: the first is an incident, the second is its follow-up. Merging them would raise an alarm on every attempt.

`reason` is never NULL and is valid for the duration of the callback; copy it to keep it. Outside a refusal the three fields are 0, 0 and "".

`e->detail` is the other side of the same coin: the library's **own** account when it is the one that refused. A frame that broke a rule comes with the rule and the two header bytes it read (`rsv bits set, header C1 02`), an imposed extension, a missing or wrong `Sec-WebSocket-Accept`, a non-101 status (`HTTP 401`). Set with `MCPB_ERR_PROTOCOL`, `MCPB_ERR_UNSUPPORTED` and `MCPB_ERR_HANDSHAKE`, "" otherwise, never NULL. "protocol violation" alone names nothing; the bytes are what separates a real violation from a stream that went out of sync.

The sink is **called from the caller's own task**, inside `poll` or `send`, never from a thread the library created, since it creates none. In exchange, do not call any `mcpb_provider_*` function from the sink: the library is mid-transition. Set a flag and act in your own loop.

## Nothing is queued

`mcpb_provider_send` fails if the link is down and keeps nothing. That is a choice: a JSON-RPC reply answers a request carried by a link; once that link drops, the client on the other side has already had its error from the broker, and delivering the reply after reconnecting would hand it to an id nobody is waiting for.

## Bench

```bash
gcc -std=c99 -Wall -Wextra -Iinclude -DMCPB_ENABLE_MUX=1 -o test_mcpb \
    tests/test_mcpb.c src/*.c && ./test_mcpb
```

153 checks, no network (116 without the multiplexed endpoint): the port is filled in by a fake whose incoming bytes are written by hand. That is what lets us feed the client a frame masked by the server, a reserved bit set or a forged length, and check that it refuses. A client tested against a real server would only cover the nominal path.

Also checked along the way: the SHA-1 vectors from FIPS 180-1, the base64 vectors from RFC 4648, and the normative handshake example from RFC 6455 section 1.3.

## A frame does not care about your poll timeout

`mcpb_provider_poll` takes a timeout, and on a slow link a single frame arrives across several of them. The receive path is therefore **resumable**: the frame in progress (header, length, bytes received so far) lives in `mcpb_ws_t`, a timeout leaves it where it is, and the next call continues from there. Before 0.2.1 a timeout in the middle of a frame forgot the bytes already consumed, and the next call parsed a "header" out of the middle of the JSON: `{"`, refused as `rsv bits set, header 7B 22`. It was seen on an ESP32 over a weak Wi-Fi link with power save on, every few minutes under load, and never on a LAN, where a message is never split across 200 ms. The bench now pauses the fake link inside the header, inside the extended length, inside the payload and inside a ping, and checks that the message still comes out whole.

## Known limits

Client role only. No extensions (a server-imposed `permessage-deflate` fails the handshake rather than being ignored). No binary frames on receive, the broker only sends text. No HTTP redirect following: a 3xx is a refusal, because following one would dial a different host from the one that was logged. On the multiplexed endpoint, a slot name that needs a `\u` escape beyond ASCII is not matched.

## Origin

Written in the CyanMycelium repository (`libmcpb/`, last commit there `c76102c`, 2026-08-31) and moved to mcp-broker on 2026-09-12, where it now lives under `c/libmcpb`. The 0.2.0 changes (the `_all` opt-in, the refusal fields on events, the broker's obligations) were made here.

## Licence

Apache-2.0, same as mcp-broker.
