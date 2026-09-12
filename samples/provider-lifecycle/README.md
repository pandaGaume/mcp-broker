# provider-lifecycle

**The whole life of a provider socket, driven on purpose in one terminal: connect, register, serve, get refused with 1008, release, survive a broker restart, reconnect, release again.**

## Use this when

- A slot is stuck and you want to know which of the two sides is holding it.
- You saw close code **1008** and want to reproduce it deliberately rather than by reloading a tab thirty times.
- You are choosing between `DirectTransport` and `MultiplexTransport` and want to see the difference under a restart.
- You are deciding what to set for `providerHeartbeatIntervalMs` / `providerTakeover`.

## Run it

```bash
cd samples
npm install
node provider-lifecycle/run.mjs                  # ~30 seconds, port 3300
node provider-lifecycle/run.mjs --port 4000
node provider-lifecycle/run.mjs --heartbeat 2000 # tighter liveness sweep
```

The broker's own output is interleaved with the narration. That is the point: the broker's lines are the diagnostic you will actually have in production.

## The six steps, and what each proves

### 1. Connect and register

```
[broker] ws connect path="/provider/lifecycle-demo" role=dedicated-provider slot="lifecycle-demo"
   [page-A] onOpen: the slot "lifecycle-demo" is claimed
```

**`role=` is the single most useful line the broker prints.** It says which of the three roles it filed your socket under: `dedicated-provider`, `multiplex-provider`, or `client`. If a URL you meant as a provider is logged as `role=client`, the URL is wrong and nothing will ever answer on that slot. That is the `/providers/<name>` trap.

### 2. Serve a call

```
client: tools/call whoami -> page-A is holding "lifecycle-demo"
```

### 3. A second provider claims the slot while the first still holds it

**This is the reload loop.** A tab reloads; the old page's socket is still OPEN when the new page asks for the slot.

```
[broker] WARNING: WebSocket provider "lifecycle-demo" rejected. Provider "lifecycle-demo" is already
  connected. The incumbent answered the last heartbeat, so it is treated as alive. If the previous
  instance really is gone, wait up to 5000ms for the heartbeat to notice a dead socket and reconnect,
  close the old socket cleanly from the provider side, or publish on a different slot name. Call
  provider_status on the _broker slot to see which socket holds it.
   [page-B] onOpen: the slot "lifecycle-demo" is claimed
   [page-B] onError: DirectTransport: the socket to ws://…/provider/lifecycle-demo closed with code
     1008: "Slot already held by a live provider; call provider_status on _broker. Slot:
     "lifecycle-demo"". Code 1008 is a policy refusal from the broker, not a network drop …
   [page-B] onClose: socket gone
```

Three things to take from that:

1. **The newcomer is refused; the incumbent is untouched.** The page you are looking at is the one that breaks, while the page that is already gone keeps the slot. That inversion is why this is confusing in the field.
2. **`onOpen` fires BEFORE `onError`.** The WebSocket handshake succeeds and the refusal arrives afterwards as a close frame. Never treat `onOpen` as proof that you own the slot; it only means the socket came up.
3. **The fix is on the provider side and it is three lines.**
   ```js
   window.addEventListener("pagehide", () => transport.close());
   ```

### 4. Explicit release, then the newcomer gets in

`transport.close()` frees the slot immediately, with no timeout involved. The next claim succeeds.

### 5. Deliberate broker restart

The broker is `SIGKILL`ed and restarted on the same port. Both providers see the drop:

```
   [page-B (retry)] onError: … closed with code 1006 (no reason given). DirectTransport does not
     reconnect, call connect() again to retry.
   [multiplex-C] onClose: socket gone
```

`1006` is an abnormal close: no close frame, no reason. That is what a crash looks like from a provider's point of view, and it is deliberately different from the `1008` in step 3, which is a policy refusal carrying the broker's own words.

Then the asymmetry that matters:

| | Reconnects after the broker comes back? |
|---|---|
| `DirectTransport` | **No. Never.** `onClose` fires and that is the end. Call `connect()` again from your own retry policy. |
| `MultiplexTransport` | Yes, on its own, with exponential backoff (1 s base, doubling, capped at 30 s, jittered), re-announcing every slot on the shared socket. |

That asymmetry is deliberate, documented on both classes, and easy to miss because the two classes look alike.

### 6. Clean release and shutdown

```
providers_list: … {"name":"lifecycle-demo","transport":"none","connected":false,…}
```

A slot with `connected: false` is a slot that exists with no provider behind it. The broker keeps it, because a client may be waiting on it and a provider may come back to it.

## Known Node-only limitation, and it is visible in this sample

**`MultiplexTransport`'s automatic reconnect stops after the first retry that lands while the broker is still down, when running under Node.** The sample says so when it happens and recovers by hand.

The cause is not in this project. Node's built-in `WebSocket` (undici) fires `error` for a connection that never opened and then **never fires `close`**; `readyState` stays at `0` (CONNECTING) forever. Browsers fire `error` and then `close` with code `1006`, which is what the reconnect chain is built on. Check it yourself:

```js
const ws = new WebSocket("ws://127.0.0.1:59999/nope");
ws.onerror = () => console.log("error");   // fires in Node and in a browser
ws.onclose = () => console.log("close");   // NEVER fires in Node; fires in a browser
```

So in a page, the reconnect loop keeps running as designed. In Node it needs one of:

- `transport.close()` then `transport.connect()`, which re-registers the slot. This is what the sample does.
- or a `ws`-based polyfill installed before importing the package:
  ```js
  import WS from "ws";
  globalThis.WebSocket = WS;                // fires close on a failed connect
  const { MultiplexTransport } = await import("@cyanmycelium/mcp-broker-provider");
  ```

## The broker-side safety nets

These bound the damage from a provider that goes away without releasing. **They do not replace the `pagehide` listener**, because a socket that is genuinely still open answers heartbeats perfectly well, and the reload race is exactly that case.

| Setting | Default | What it does |
|---|---|---|
| `MCP_BROKER_PROVIDER_HEARTBEAT_MS` | `30000` | Pings every provider socket. A socket that did not answer the previous ping is terminated, so a slot held by a dead peer frees itself after roughly one interval. `0` disables. A pong is answered by the network stack, so it proves the *process* is alive, not that the page's JS thread is serving. |
| `MCP_BROKER_PROVIDER_REQUEST_TIMEOUT_MS` | `60000` | Deadline for one provider answer. That is the setting for "the socket is up but the provider stopped responding". Raise it if you have genuinely long-running tools; the error names the option. `0` disables. |
| `MCP_BROKER_PROVIDER_TAKEOVER` | `liveness` | `reject` never evicts an incumbent. `liveness` evicts one the heartbeat has proven dead. `always` evicts unconditionally, and is honoured **only when provider authentication is configured**, because without it an unconditional takeover is a slot-hijacking primitive; the broker logs the downgrade and falls back to `liveness`. |

The equivalent config-file keys are `providerHeartbeatIntervalMs`, `providerRequestTimeoutMs` and `providerTakeover`, and the builder methods are `withProviderHeartbeat()`, `withProviderRequestTimeout()` and `withProviderTakeover()`.

## Failure modes

**Close code 1008 on connect.** A policy refusal. Three causes: the slot is held by a live provider (this sample, step 3), the slot is reserved (`_all` or `_broker` cannot be claimed), or provider authentication rejected the socket. The reason string in `onError` distinguishes them, and `provider_status` on `_broker` names the holder.

**Close code 1006 on connect or during a session.** Abnormal close, no reason. Network, process death, or a proxy dropping an idle WebSocket. If it happens on a fixed interval, look for an idle timeout in front of the broker and lower `MCP_BROKER_PROVIDER_HEARTBEAT_MS` below it.

**`transport.close()` reports an error with code 1005.** Cosmetic, and expected today: `DirectTransport` reports every close code other than `1000`, and a local `close()` with no explicit code produces `1005` ("no status received"). Nothing is wrong.

**The slot never frees after the page is gone.** Wait one heartbeat interval. If it still does not free, the socket is genuinely open (a suspended tab whose network stack still answers pings). `providerTakeover: "always"` plus provider authentication is the deliberate answer to that; a shorter heartbeat is not, since the socket is answering.

**The scenario dies at step 1 with `EADDRINUSE`.** Another broker holds port 3300. Pass `--port 4000`.

## Files

| File | What it is |
|---|---|
| `run.mjs` | The scenario. Both providers are built inline so every callback is visible. |
| `broker-control.mjs` | Starts and `SIGKILL`s a broker process. A hard kill on purpose: `SIGINT` closes sockets politely with `1000`, which is the nice case and not the one worth rehearsing. |
