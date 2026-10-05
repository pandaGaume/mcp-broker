# Testing against a real broker: `@cyanmycelium/mcp-broker/testing`

One call starts a real broker for your test, with **callers that need no
authorization server**. Everything below the token is the production code
path: subject mapping, the policy engine, caller references, protected slots,
provider identities. Only the token check is replaced: **a caller's token is its
name**, and the kit turns that name into the claims you declared.

Use it for automated tests of a provider (mcp-scada, say) or of a client. For
manual sessions with real signed tokens, use the OAuth lab instead
(`npm run demo:oauth`).

> **Test only.** The broker binds `127.0.0.1` on a free port and accepts
> tokens anybody can guess. The CLI never reaches this module.

## 30 seconds

```ts
import { startTestBroker } from "@cyanmycelium/mcp-broker/testing";
import { DirectTransport } from "@cyanmycelium/mcp-broker-provider";

const broker = await startTestBroker({
    callers: { operator: { groups: ["operators-line1"] } },
    providers: { "mcp-scada": { subjects: ["service:mcp-scada"], allowedResources: ["/production/site1/**"] } },
});

// Your provider, authenticated as "mcp-scada":
const transport = new DirectTransport(broker.providerUrl("scada"), { secret: broker.providerSecret("mcp-scada") });

// A client, as "operator":
await fetch(broker.mcpUrl("scada"), { method: "POST", headers: { ...broker.bearer("operator"), "content-type": "application/json", accept: "application/json, text/event-stream" }, body });

await broker.stop();
```

With no `policy`, every declared caller may do everything everywhere: enough
for a happy path. Add a `policy` to test a refusal.

## Options

```ts
startTestBroker({
    callers?,         // who calls: name -> identity. The name is the token.
    providers?,       // provider identities: id -> { subjects?, allowedResources? }
    policy?,          // roles, assignments, denies, slotResources
    protectedSlots?,  // slot -> { declaredBy, publishedBy }
    telemetry?,       // true: capture provider spans in memory
    configure?,       // (builder) => void, last word on WsTunnelBuilder
})
```

### `callers`

Each field of a caller becomes a claim, mapped to a subject exactly as a real
token would be:

| field     | claim       | subject             |
|-----------|-------------|---------------------|
| `user`    | `sub`       | `user:<user>`       |
| `groups`  | `groups`    | `group:<each>`      |
| `service` | `service`   | `service:<service>` |
| `client`  | `client_id` | `client:<client>`   |
| `scopes`  | `scope`     | (OAuth scopes, only checked if you configure required scopes) |

`user` defaults to the caller's name, so `callers: { visitor: {} }` is
`user:visitor`. Send it as `Authorization: Bearer visitor`, or spread
`broker.bearer("visitor")` into your headers. An undeclared token is refused
with 401, like a bad real one.

**A provider calling another slot** (mcp-scada reading Modbus) is a caller
too: give it a caller entry whose subject matches the provider's `subjects`:

```ts
callers: { scada: { service: "mcp-scada" } },
providers: { "mcp-scada": { subjects: ["service:mcp-scada"], allowedResources: ["/production/site1/**"] } },
```

### `providers`

Provider identities, as the security file's `providers` table would declare
them. The kit makes up each secret; pass `broker.providerSecret(id)` to the
transport's `secret` option. A browser cannot send it.

The provider transports use the global `WebSocket`, which Node has from 22 on.
On Node 20, put `ws` in its place once, at the top of the test file (it
accepts the same handshake headers):

```ts
import { WebSocket } from "ws";
if (typeof globalThis.WebSocket === "undefined") globalThis.WebSocket = WebSocket as unknown as typeof globalThis.WebSocket;
```

A provider that declares an authorization domain must have explicit
`allowedResources`, without `"**"`.

### `policy`

The security file's policy keys: `roles`, `assignments`, `denies`,
`slotResources`, `toolCapabilities`. `subjectMapping` is fixed by the kit (see
`callers`). Remember that a caller needs `mcp.tools.call` (or whatever the
operation classifies as) on the **slot's** resource just to reach the
provider, on top of the domain capabilities `broker/authorize` checks:

```ts
policy: {
    slotResources: { scada: "/production/site1/scada" },
    roles: {
        caller: { capabilities: ["mcp.tools.call"] },
        operator: { inherits: ["caller"], capabilities: ["scada.observe", "scada.control"] },
    },
    assignments: [{ id: "operators", subject: "group:operators-line1", role: "operator", resource: "/production/site1/**" }],
    denies: [{ id: "no-line2", subject: "group:operators-line1", capabilities: ["scada.control"], resource: "/production/site1/line2/**" }],
},
```

### `protectedSlots`

```ts
protectedSlots: { "bench-motor01": { declaredBy: "mcp-scada", publishedBy: "modbus-bench" } },
```

Both ids must be in `providers`. Closed from startup, as in production.

## What you get back

| member | value |
|---|---|
| `url` / `wsUrl` | `http://127.0.0.1:<port>` / `ws://127.0.0.1:<port>` |
| `mcpUrl(slot)` | Streamable HTTP endpoint of a slot |
| `providerUrl(slot)` | dedicated provider socket (`DirectTransport`) |
| `providersUrl` | shared provider socket (`MultiplexTransport`) |
| `bearer(caller)` | `{ authorization: "Bearer <caller>" }`; throws for an undeclared caller |
| `providerSecret(id)` | the secret of a provider identity; throws for an undeclared id |
| `spans` | immutable snapshot of spans exported in memory when `telemetry: true` |
| `tunnel` | the `WsTunnel`, for `getAuthorityInfo()`, `getProviderInfo()`, `registerLoopbackProvider()` |
| `stop()` | call it in your teardown |

## A complete test

[`tests/testing.kit.test.ts`](../tests/testing.kit.test.ts) runs the whole
loop in about forty lines: a provider authenticated with its secret declares
the `scada` domain; an operator and a visitor call the same tool over
Streamable HTTP; the provider asks `broker/authorize` about each caller and
gets `allow` for one and `deny` for the other. Copy it as a starting point.

On the provider side, the caller reference is read with
`callerReferenceOf(params._meta)` from `@cyanmycelium/mcp-broker-provider`
(with mcp-core 1.4.0, an adapter gets the same object as `request?.meta`).

For end-to-end trace tests, pass `telemetry: true`, emit with
`transport.broker.span(span)`, then assert on `broker.spans`. No collector or
network exporter is involved.

## When something does not work

| symptom | look at |
|---|---|
| the client gets `-32001 Forbidden` before the provider sees anything | the caller lacks `mcp.tools.call` on the slot's resource (`slotResources`) |
| every decision is `no-matching-grant` | no assignment matches the caller's subjects for that capability and path |
| `undeclared-capability` / `undeclared-resource` | the check is outside what the provider declared |
| the declaration is refused | `error.data.errors` lists every reason; the broker log too |
| the provider socket closes with 1008 | it publishes a protected slot it is not `publishedBy` for |
| `broker.tunnel.getAuthorityInfo()` | declarations, protected slots, live caller references |
# Testing engineering patterns (1.7.0)

`startTestBroker({ policy: { resourceLimits: [{ id: "maintenance", pattern: "/nord/valves/{id}", where: { id: "V-0\\d{2}" }, limits: { maxValue: 80 } }], roles, assignments } })` installs the same operator rules as the security file. The provider's `transport.broker.declare()` accepts concrete resources and `{ resourcePattern, where?, limits? }` entries. Assert `effect: "allow-with-constraints"` and the returned obligations; `allowed` is false for constrained grants. Budgets use the same constraints and empty intersections refuse reservations.

`broker.tunnel.getAuthorityInfo()` exposes patterns, rules and recent limit problems. Read `broker://authority` on `_broker` or call `broker_info` to verify the MCP surface. Run `npm run bench:limits --workspace @cyanmycelium/mcp-broker` from `node/` for 1,000 indexed patterns and 1,000 overlapping patterns. The second case exposes the cost of checking every applicable rule.
