<!-- Generated from node/packages/broker/src/broker/broker.guides.ts by node/scripts/build-site.mjs --guides. Do not edit. -->

> **Deploy the broker.** Embed as a library or run as a process: startup ordering, topologies, configuration, static files, TLS, shutdown. This is the page a running broker serves as `broker://guide/deploy` and through `broker_guide({ topic: "deploy" })`; the live copy also carries that deployment's effective configuration (host, port, scheme, paths), so prefer it when you can reach a broker.

Execution limits: put limits in the security file, separate from auth roles. Rules may bound calls/rate/concurrency and declared operation budgets; all matching rules intersect. Use withLimits in the library. storeFile enables a single-owner local durable ledger. broker_diagnose reports its faults and refusals.
A timeout does not release unresolved native concurrency. Inspect authority.limits.activeCalls, verify work stopped, then use the embedding-only resolveLimitCall(slot, requestId). Preserve the ledger across restart. After a crash, remove a stale .lock only after verifying its owner is gone. Multi-broker storage is unsupported.
# Deploying the broker

## 1. Two ways to run it

**As a process.** `npx @cyanmycelium/mcp-broker`, configured by
`.mcp-broker/config.json` and `MCP_BROKER_*` environment variables. Choose this
when the broker is infrastructure: a host entry, a container, a service.

**As a library.** Build a tunnel and start it inside your own process. Choose
this when your application already owns the port, or when it hosts MCP servers
itself and you want them served without a WebSocket round trip.

```ts
import { WsTunnelBuilder } from "@cyanmycelium/mcp-broker";

const tunnel = new WsTunnelBuilder()
    .withPort(3000)
    .withHost("127.0.0.1")
    .withAllowedOrigins(["http://localhost:5173"])
    .withStaticMount("/", "/abs/path/to/www")
    .build();

await tunnel.start();
// ... later
await tunnel.stop();
```

An MCP server living in the same process skips the network entirely:

```ts
import { LoopbackTransport } from "@cyanmycelium/mcp-core";

const [serverEnd, clientEnd] = LoopbackTransport.createPair();
const server = new McpServerBuilder().withTransport(serverEnd).register(/* ... */).build();
await server.start();
tunnel.registerLoopbackProvider("in-process", clientEnd);
```

A loopback slot outranks a WebSocket provider of the same name: the WebSocket
one is refused with `Provider "<n>" is reserved by the broker`.

## 2. What `start()` does, in order

1. Creates the HTTP(S) server and attaches the WebSocket server.
2. Binds the port.
3. Starts the provider heartbeat and the request-timeout sweep, both on
   `unref`'d timers so they never hold a process open.
4. Registers the `_all` aggregate slot.
5. Wires and connects every configured upstream (`stdioUpstreams`, `mcpServers`,
   `mcpbBundles`). Upstreams marked `aggregate` join `_all` when they open.
6. Attaches the stdio bridge, if configured, and resumes stdin.
7. Starts the embedded `_broker` server and adds it to `_all`.

Step 4 before step 6 is what makes `_all` a safe stdio bridge target: the slot
exists before the host's first byte arrives. Nothing in this sequence waits for
a WebSocket provider, because none can exist yet.

`start()` **rejects** on a listen failure, and the rejection names the port, the
one-broker-per-port rule and the URL to attach to the broker already holding it.
Await it and catch it: `void tunnel.start()` turns that into an unhandled
rejection. The original errno is preserved as `err.cause`.

## 3. Topologies

**Browser app plus broker.** The broker serves the page from a static mount and
the page publishes a provider over WebSocket. Needs `allowedOrigins` for the
page's own origin if the page is also an MCP client, and needs provider auth
OFF, because a browser cannot present the provider secret.

**Stdio host plus broker plus browser provider.** The host launches the broker
pinned to `_all`; the human opens the page later; `_all` pushes
`list_changed` and the tools appear. This is the topology `broker://guide/host-config`
is written for.

**Broker in front of remote MCP servers.** `mcpServers[]` entries: the broker
dials out over Streamable HTTP, SSE or WebSocket and republishes each as a slot.
Aggregated into `_all` by default.

**Deployment plugins.** `plugins[]` loads explicitly configured local ESM modules
after the broker starts, using provider identities from the security file.
Required plugin failures roll startup back; plugins stop before the tunnel.
Plugin packages are supplied by the deployment, never downloaded at startup.
They run as trusted code in the broker process. See docs/plugins.md.

**Broker running signed bundles.** `mcpbBundles[]` entries: each `.mcpb` is a ZIP
with a manifest, signature-verified against a trusted public key before being
unpacked and spawned as a stdio upstream. A bundle that fails verification is
skipped and never spawned. Aggregated into `_all` by default.

## 4. Configuration

The CLI reads `.mcp-broker/config.json` (or `MCP_BROKER_CONFIG`). Environment
variables win over the file. Relative paths in the file resolve against the
file's directory; relative paths in env vars resolve against the working
directory.

```json
{
    "port": 3000,
    "host": "127.0.0.1",
    "allowedOrigins": ["http://localhost:3000"],
    "stdioProvider": "_all",
    "www": { "mounts": [{ "urlPrefix": "/", "dir": "./www" }] },
    "stdioUpstreams": [
        { "name": "fs", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/data"], "aggregate": true }
    ],
    "mcpServers": [{ "name": "geo", "url": "https://geo.example.com/mcp" }],
    "resourceSubscriptions": { "maxSubscriptionsPerClient": 64, "maxSubscriptionsPerSlot": 1024, "maxResourceUriLength": 2048 }
}
```

Note the asymmetry, it is real and it bites: a `stdioUpstreams` entry is NOT
aggregated unless you write `"aggregate": true`, while `mcpServers` and
`mcpbBundles` entries ARE aggregated unless you write `"aggregate": false`.

All six `paths.*` keys are read by the CLI, as `env ?? config ?? default`. One
key is still library-only: `brokerName` is a valid config key and `WsTunnel`
honors it, but `WsTunnelBuilder` has no `withBrokerName()`, so the CLI cannot
forward it and setting it in the file changes nothing. `enableBrokerProvider`
and `enableAggregateProvider` are `IWsTunnelOptions` fields only, not config
keys at all. Confirm the effective values with `broker_info` rather than
assuming the file won.

### The security file

Who may do what lives apart from the topology: `"securityFile": "security.json"`
in `config.json` (or `MCP_BROKER_SECURITY_FILE`) names a file holding `auth`,
`providers` and `authorization.protectedSlots`. It fails closed: a named file
that is missing or invalid stops the broker, and so do `auth` in both files or
`providers` / `authorization` left in `config.json`. Secrets are never written
in it: each provider names the environment variable that holds its secret.

```json
{
    "auth": { "enabled": true, "roles": {}, "assignments": [] },
    "providers": [
        { "id": "mcp-scada", "secretEnv": "SCADA_PROVIDER_SECRET", "subjects": ["service:mcp-scada"], "allowedResources": ["/production/site1/**"] },
        { "id": "modbus-bench", "secretEnv": "MODBUS_PROVIDER_SECRET", "allowedResources": ["/production/site1/bench/**"] }
    ],
    "authorization": { "protectedSlots": { "bench-motor01": { "declaredBy": "mcp-scada", "publishedBy": "modbus-bench" } } }
}
```

Its SHA-256 prefix starts every `policyVersion`, which `broker_info` shows and
every `broker/authorize` decision carries.

## 5. Static files

Mounts are matched longest-prefix-first and JSON-RPC routes always win over
them, so a slot named like a directory shadows that directory. Directory
requests serve `index.html`. Paths escaping the mount are refused with 403.
`MCP_BROKER_WWW_DIR` is a shortcut for a mount at `/`, `MCP_BROKER_BUNDLE_DIR`
for one at `/bundle`; a directory that does not exist is skipped with a warning
rather than failing startup.

## 6. TLS

Setting both a certificate and a key switches the whole server to HTTPS and WSS
at once. There is no mixed mode: providers then connect with `wss://` and
clients with `https://`, and browser origins in `allowedOrigins` must be spelled
with `https://`. The files are read synchronously when the tunnel is built, so a
wrong path throws before the port is bound.

## 7. Optional LAN discovery

`mdns` in the config file, or `withMdns()` when embedding, explicitly enables
IPv4 DNS-SD on named interfaces. It is off by default. The private service
type is `_mcp-broker._tcp.local.`; TXT carries `txtvers=1`, `scheme`, the
effective introspection `path`, and optional configured proxy `origin`.
Client auth and HTTPS are required unless `allowInsecureDev` explicitly
permits a development announcement. No credentials or slot inventory are
announced. `mcp-network-discovery` can query this type when its operator
profile allows it. Discovery is untrusted: approve the destination and
validate TLS identity before sending any token. See the repository HOWTO.md
for proxy configuration and the complete trust boundary.

## 8. Shutdown

`stop()` first withdraws any mDNS announcement, then tears down the embedded broker
server first, then the aggregate, then the stdio bridge, then every session,
client socket, provider socket and upstream, then the heartbeat and
request-timeout timers, then the listener. It resolves when the HTTP server is
fully closed, and a second `stop()` is silent rather than an error. Call it
before your process exits so providers see a clean close rather than a dropped
connection.
