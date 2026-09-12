# Educational guide to `config.json`

This document explains the [`config.json`](config.json) file property by
property. It is intended for developers who are not yet familiar with OAuth,
JWTs, or permission models.

## Before you begin

The real configuration file uses strict JSON. JSON does not support comments.
Do not add lines beginning with `//` to `config.json`.

Comments and partial examples in this guide are for explanation only. They
must not be copied directly into the JSON file.

Basic reading rules:

- `{` opens an object, which is a collection of properties.
- `}` closes an object.
- `[` opens a list.
- `]` closes a list.
- `,` separates properties or list items.
- Spaces used to align values do not change behavior.
- Relative file paths are resolved from the `.mcp-broker/` directory.

Each section below is named after the key it explains, not after a line number,
so the guide stays correct when the example file grows.

One thing to know before anything else: **the template ships with
`auth.enabled: false`**. A fresh copy starts and answers every client, which is
what you want while you are finding your way. The whole `auth` block is present
as the reference for the day you turn it on. Read
[`docs/authorization.md`](../../../../docs/authorization.md) before you do.

## The mental model

The file answers six questions:

1. Where does the broker listen?
2. How are network connections encrypted?
3. Which browser pages, if any, may call it?
4. How does the broker identify clients and providers?
5. What may each client do, and on which resources?
6. Which local or packaged MCP servers should be loaded?

The `auth` block is the most security-sensitive part. Read it this way:

```text
JWT subjects       Roles and capabilities       Resource paths
    who?                    what?                    where?
      \                       |                       /
       \                      |                      /
                   allow or deny decision
```

## OAuth and authorization vocabulary

| Term | Plain-language explanation |
|---|---|
| OAuth 2.1 | Protocol that lets a client present a token to the broker. The broker does not issue this token |
| Authorization Server | External server that authenticates the user and issues the token |
| JWT | Common token format. It contains properties called claims |
| Claim | Property inside a JWT, such as `sub`, `groups`, or `client_id` |
| JWKS | Public endpoint containing the keys used to verify JWT signatures |
| OAuth scope | Coarse permission carried by the JWT and checked before detailed policy evaluation |
| Subject | Identity derived from the JWT, such as `user:alice` or `group:energy-team` |
| Capability | Stable functional action, such as `mcp.tools.diagnose` |
| Role | Reusable collection of capabilities |
| Resource | Stable location in the hierarchy, such as `/enterprise/site/area/asset` |
| Assignment | Grant of a role to a subject on a resource |
| Deny | Explicit prohibition that always overrides an allow |
| Slot | Technical name used to reach an MCP provider |
| Provider | MCP server that publishes tools, resources, or prompts through a slot |

## Authorization decision order

For each protected request, the broker follows these steps:

1. It reads the bearer token from the HTTP `Authorization` header.
2. It verifies the JWT signature, issuer, audience, and expiration.
3. It checks `requiredScopes` or the slot-specific `perSlotScopes` rule.
4. It converts JWT claims into subjects.
5. It converts the MCP operation into a capability.
6. It converts the slot name into a resource path.
7. It finds roles assigned to the subjects on that path.
8. It applies matching `denies`.
9. A matching deny always rejects the request.
10. Without a deny, at least one matching role must grant the capability.
11. Without an explicit matching grant, the request is rejected.

This separation is important:

- OAuth scopes provide the first coarse security gate.
- Roles describe what is allowed.
- Resources describe where it is allowed.
- Subjects describe who receives the permission.

## General settings

```json
{
    "port": 3001,
    "host": "0.0.0.0",
    "locale": "fr",
    "brokerName": "broker-eu-west"
}
```

### `port`

TCP port on which the broker listens.

- `3001` means clients may use an address such as
  `https://server-name:3001`.
- The `MCP_BROKER_PORT` environment variable can override this value.

### `host`

Network interface on which the broker accepts connections.

- `0.0.0.0` means every network interface on the machine.
- For local development only, prefer `127.0.0.1`.
- Never expose `0.0.0.0` to an untrusted network without TLS and
  authentication.

### `locale`

Language used for descriptions exposed by the internal `_broker` provider.

- `fr` selects French.
- This value does not change capability names or resource paths.

### `brokerName`

Logical name displayed by the broker introspection tools.

- It helps distinguish multiple broker instances.
- It has no effect on authorization.
- **Library-only today.** The tunnel honors it, but the command-line broker has
  no way to forward it yet, so setting it here changes nothing. Set it through
  the programmatic API (`IWsTunnelOptions.brokerName`) if you need it now.

## Browser origins

```json
"allowedOrigins": ["https://app.factory.local", "https://mcp.factory.local"]
```

The list of web-page origins allowed to call this broker over HTTP. It is
checked on `/<slot>/mcp`, `/<slot>/sse` and `/<slot>/messages`.

Three rules worth memorizing, because each one surprises somebody:

1. **Absent means closed.** With no `allowedOrigins`, every request carrying an
   `Origin` header is refused with `403`. That is deliberate: without the check,
   any page the user happens to have open could drive your broker.
2. **A request with no `Origin` header always passes.** Claude Desktop, the MCP
   Inspector and every server-side SDK send none, which is why the broker
   appears to work perfectly until the first browser tries.
3. **Being served by this broker exempts nothing.** A page loaded from the `www`
   mount is still a browser origin and must be listed.

Origins are compared verbatim, so the scheme and the port are part of the value:
`https://app.factory.local` does not match `http://app.factory.local` or
`https://app.factory.local:8443`, and a trailing slash never matches. This
template sets `tls.cert`/`tls.key`, so the broker speaks HTTPS and the entries
use `https://`. Drop the TLS block and they must become `http://...:3001`.

A regular expression is accepted instead of a list when the origins are not
known in advance:

```json
"allowedOrigins": { "pattern": "^https://[a-z0-9-]+\\.factory\\.local$" }
```

`MCP_BROKER_ALLOWED_ORIGINS` overrides the file with a comma-separated list. It
cannot carry the pattern form, since a regular expression does not survive
comma-splitting.

## HTTP and WebSocket paths

```json
"paths": {
    "provider":  "/provider",
    "providers": "/providers",
    "client":    "/",
    "mcp":       "/mcp",
    "sse":       "/sse",
    "messages":  "/messages"
}
```

All six keys are honored, and each is also settable through an environment
variable, which wins: `MCP_BROKER_PROVIDER_PATH`, `MCP_BROKER_PROVIDERS_PATH`,
`MCP_BROKER_CLIENT_PATH`, `MCP_BROKER_MCP_PATH`, `MCP_BROKER_SSE_PATH`,
`MCP_BROKER_MESSAGES_PATH`.

Change one and you move the endpoint for everybody: the provider SDK, the
clients, and the URLs printed in the startup banner. Leave them alone unless you
have a reason.

### `paths.provider`

WebSocket prefix used by a provider connecting to the broker.

Example:

```text
wss://mcp.factory.local/provider/spoony-00452
```

The provider requests the `spoony-00452` slot. The socket carries plain
JSON-RPC frames, one provider per socket. In
`@cyanmycelium/mcp-broker-provider` this is `DirectTransport`.

### `paths.providers`

Exact WebSocket path (no slot appended) used by a provider that carries several
slots over a single socket, wrapping each frame in an envelope that names the
slot. In `@cyanmycelium/mcp-broker-provider` this is `MultiplexTransport`.

```text
wss://mcp.factory.local/providers
```

`paths.provider` and `paths.providers` are one letter apart and are **not
interchangeable**: they differ by framing, not just by URL. Pointing a
`MultiplexTransport` at `/provider/<name>`, or a `DirectTransport` at
`/providers`, is the single most common integration failure. The broker now
names the mismatch and refuses the socket rather than hanging, but the pairing
is worth getting right the first time:

| Endpoint            | Framing            | Transport            |
|---------------------|--------------------|----------------------|
| `/provider/<name>`  | plain JSON-RPC     | `DirectTransport`    |
| `/providers`        | envelopes          | `MultiplexTransport` |

`/providers/<name>` is neither, and is taken as a *client* connection on a slot
literally named `providers/<name>`.

### `paths.client`

Prefix used by raw MCP WebSocket clients. The value `/` preserves the
historical URL form:

```text
wss://mcp.factory.local/spoony-00452
```

### `paths.mcp`

Suffix used by the MCP Streamable HTTP transport.

For the `spoony-00452` slot, the URL becomes:

```text
https://mcp.factory.local/spoony-00452/mcp
```

This is the transport to reach for. The two below it are the legacy pair.

### `paths.sse`

Suffix of the legacy SSE stream, opened with `GET`. The broker answers it with
an `endpoint` event carrying the URL to post to.

```text
https://mcp.factory.local/spoony-00452/sse
```

### `paths.messages`

Suffix the legacy SSE client `POST`s its JSON-RPC requests to, paired with the
stream above.

```text
https://mcp.factory.local/spoony-00452/messages
```

Both legacy endpoints are subject to the same `allowedOrigins` check as
`/<slot>/mcp`.

## Provider liveness

```json
"providerHeartbeatIntervalMs": 30000,
"providerRequestTimeoutMs": 60000,
"providerTakeover": "liveness"
```

Three optional keys. The defaults shown are the built-in ones, so you can delete
the block entirely; they are spelled out here because when a provider misbehaves
these are what you tune.

### `providerHeartbeatIntervalMs`

How often the broker pings each connected provider socket. A provider that
misses a full interval is disconnected and its slot freed. `0` disables the
heartbeat. Also `MCP_BROKER_PROVIDER_HEARTBEAT_MS`.

Without it, a socket whose peer vanished without closing (a killed browser tab,
a slept laptop, a dropped VPN) stays open as far as the operating system is
concerned for around two hours, during which the broker reports the slot as
connected and refuses every reconnection attempt.

Be honest about what it proves: a pong is answered by the peer's network stack,
not by the page's JavaScript. It detects a dead process, machine or network
path, not a provider that is connected and simply not answering. For that, see
the next key.

### `providerRequestTimeoutMs`

How long the broker waits for a provider to answer one request before failing it
with a JSON-RPC error naming the slot. `0` disables the deadline. Also
`MCP_BROKER_PROVIDER_REQUEST_TIMEOUT_MS`.

Raise it if you host genuinely long-running tools. Lower it if you would rather
see an error than a client that waits forever, which is the alternative: a
browser tab throttled in the background is a connected provider that answers
nothing.

### `providerTakeover`

What happens when a provider connects to a slot another socket already holds.

- `"reject"`: the incumbent always keeps the slot.
- `"liveness"` (default): the incumbent keeps it only while it answers the
  heartbeat.
- `"always"`: the newcomer wins, but only when provider authentication is
  configured and it authenticated as the same principal as the incumbent.
  Without provider authentication the broker falls back to `"liveness"` and says
  so, because unconditional takeover would let anyone who can reach the URL
  evict the real provider.

Also `MCP_BROKER_PROVIDER_TAKEOVER`.

## TLS

```json
"tls": {
    "cert": "certs/cert.pem",
    "key": "certs/key.pem"
}
```

TLS encrypts network traffic and enables HTTPS/WSS.

### `tls.cert`

Path to the public certificate in PEM format.

In this example, the broker looks for:

```text
.mcp-broker/certs/cert.pem
```

### `tls.key`

Path to the private key associated with the certificate.

This key is secret. It must never be committed to the Git repository.

The broker must be able to read both files. A mismatched certificate and key
pair prevents HTTPS startup.

## Static web files

```json
"www": {
    "open": false,
    "mounts": [
        { "urlPrefix": "/", "dir": "www" }
    ]
}
```

### `www.open`

Controls whether the broker automatically opens a web browser at startup.

- `false` (or absent) is suitable for servers, containers, and headless
  environments.
- `true` opens the broker root, `https://localhost:3001/`.
- A string opens a specific page: `"/app/index.html"`, or an absolute URL on
  this broker's own origin.

A URL on any other origin is refused with a message on stderr, and so is any
other string: a value that reaches the platform's "open this" command unchecked
can launch a local file or a registered application, and nothing about starting
a broker requires visiting another host. Open it yourself instead.

The browser opens only when a `www.mounts` entry actually covers the resolved
path. If none does, the broker says which prefixes are mounted rather than
launching a browser onto a `404`.

`MCP_BROKER_OPEN` carries the same values (`"1"` for the root).

### `www.mounts`

List of static directories served by the broker.

### `urlPrefix`

URL prefix associated with the directory. Here, `/` represents the web root.

### `dir`

Local directory containing the web files. Here, `www` resolves to:

```text
.mcp-broker/www/
```

This block does not automatically secure a web application. MCP routes are
protected by `auth`, but a static web application must also be designed not to
expose secrets.

## Enabling OAuth

```json
"auth": {
    "enabled": false,
    "publicBaseUrl": "https://mcp.factory.local",
    "authorizationServers": [
        "https://identity.factory.local"
    ],
    "jwks": "https://identity.factory.local/.well-known/jwks.json",
    "requiredScopes": ["mcp:call"],
    "perSlotScopes": {
        "_broker": ["broker:admin"]
    }
}
```

### `auth.enabled`

Enables OAuth authentication for MCP clients. **This template ships it off.**

- `false` (the shipped value) preserves the historical unauthenticated mode:
  every client reaches every slot. Use it on a trusted network, and while you
  are getting the rest working.
- `true` requires a valid bearer token on every client request. The rest of this
  block then has to describe a real authorization server: with `enabled: true`
  and the placeholder `identity.factory.local` values still in place, the broker
  answers every client with a `401` whose challenge points at a host that does
  not resolve, which is a confusing way to spend an afternoon.
- A detailed policy is useful only when clients have an authenticated
  identity.

Everything below this point (`roles`, `assignments`, `denies`, `slotResources`,
`toolCapabilities`) is inert while `enabled` is `false`. It is kept in the
template as a worked example, not because it is doing anything.

### `auth.publicBaseUrl`

Public address through which clients reach the broker.

This value must match the address visible to clients, which may differ from the
internal process address.

It is also used to calculate the expected JWT audience. For the
`spoony-00452` slot, the expected audience is:

```text
https://mcp.factory.local/spoony-00452/mcp
```

A common mistake is to use `http://localhost:3001` while clients actually use a
public HTTPS reverse proxy.

### `auth.authorizationServers`

List of external authorization servers advertised to clients.

In this example, `https://identity.factory.local`:

- authenticates users or applications;
- issues access tokens;
- remains external to the broker.

The broker does not become an identity provider.

### `auth.jwks`

URL of the authorization server's JWKS document.

The broker downloads public keys from this endpoint to verify JWT signatures.
A public key can verify a token, but it cannot issue one.

Do not put a private key or OAuth client secret here.

### `auth.requiredScopes`

OAuth scopes required by default before a client can reach a slot.

```json
["mcp:call"]
```

means the JWT must contain the `mcp:call` scope.

This scope is not sufficient by itself when hierarchical policies are enabled.
It only opens the first gate. Roles, resources, and denies are evaluated next.

### `auth.perSlotScopes`

Replaces `requiredScopes` for specific slots.

```json
"_broker": ["broker:admin"]
```

means the internal `_broker` slot requires `broker:admin` instead of
`mcp:call`.

This rule protects network access to `_broker`. Hierarchical policy then checks
the `broker.providers.read` capability on the reserved
`/_system/broker` resource.

The example file intentionally contains no assignment for
`/_system/broker`. By default, nobody can use `_broker` tools, even with the
`broker:admin` scope.

To grant this access, add an assignment such as:

```json
{
    "id": "broker-administrators",
    "subject": "group:broker-administrators",
    "role": "administrator",
    "resource": "/_system/broker"
}
```

The JWT must then contain both the `broker:admin` scope and the
`broker-administrators` group.

## Converting JWT claims into subjects

```json
"subjectMapping": {
    "userClaim": "sub",
    "groupClaims": ["groups"],
    "clientClaim": "client_id"
}
```

The broker trusts only claims from an already validated JWT.

### `userClaim`

Name of the claim containing the user identifier.

With:

```json
{ "sub": "alice" }
```

the broker produces:

```text
user:alice
```

### `groupClaims`

Claims containing the user's groups.

With:

```json
{ "groups": ["maintenance-area-a", "employees"] }
```

the broker produces:

```text
group:maintenance-area-a
group:employees
```

The claim may be a single string or a list of strings. An invalid type causes
authorization to fail safely.

### `clientClaim`

Claim containing the client application identifier.

With:

```json
{ "client_id": "local-ai-assistant" }
```

the broker produces:

```text
client:local-ai-assistant
```

A single call may therefore have multiple identities at the same time, such as
one user, two groups, and one client application.

## Roles and capabilities

A role answers only the question "what may be done?" It never contains a
resource path.

### `viewer` role

```json
"viewer": {
    "capabilities": [
        "mcp.resources.read",
        "mcp.tools.list",
        "mcp.prompts.read"
    ]
}
```

This role allows:

- `mcp.resources.read`: list and read MCP resources;
- `mcp.tools.list`: view the tool catalog;
- `mcp.prompts.read`: list and read prompts.

It does not allow tool calls.

### `maintenance` role

```json
"maintenance": {
    "inherits": ["viewer"],
    "capabilities": [
        "mcp.tools.call",
        "mcp.tools.diagnose",
        "mcp.tools.configure-analysis"
    ]
}
```

`inherits: ["viewer"]` means that `maintenance` also receives every capability
from `viewer`.

Its additional capabilities are:

- `mcp.tools.call`: call a tool without a more specific mapping;
- `mcp.tools.diagnose`: run a diagnostic;
- `mcp.tools.configure-analysis`: modify an analysis configuration.

### `operator` role

```json
"operator": {
    "inherits": ["viewer"],
    "capabilities": ["mcp.tools.operate"]
}
```

This role can view resources, tools, and prompts through `viewer`, then perform
operations classified as `mcp.tools.operate`.

### `administrator` role

```json
"administrator": {
    "capabilities": ["*"]
}
```

`*` means every capability, but only on resources covered by an assignment.

Declaring a role does not grant it to anyone. The example file contains no
assignment for `administrator`, so nobody becomes an administrator from this
block alone.

## Assignments

An assignment expresses this sentence:

```text
This subject receives this role on this resource.
```

### `maintenance-area-a` assignment

```json
{
    "id": "maintenance-area-a",
    "subject": "group:maintenance-area-a",
    "role": "maintenance",
    "resource": "/enterprise-a/site-paris/area-a/**"
}
```

#### `id`

Unique identifier used in validation and audit logs.

#### `subject`

Subject receiving the role. Here, it applies to every JWT containing the
`maintenance-area-a` group.

#### `role`

Exact name of a role declared in the `roles` block.

#### `resource`

Industrial subtree on which the role is valid.

The `/**` suffix means:

- the `/enterprise-a/site-paris/area-a` resource itself;
- every descendant, regardless of depth.

A provider added later under this area is automatically covered by the
assignment.

### `energy-team` assignment

```json
{
    "id": "energy-team",
    "subject": "group:energy-team",
    "role": "viewer",
    "resource": "/enterprise-a/site-paris/**"
}
```

The `energy-team` group can view resources, tools, and prompts across the Paris
site, but it cannot call tools.

### Wildcard meanings

| Form | Meaning |
|---|---|
| `/enterprise/site/asset` | This exact path only |
| `/enterprise/site/*` | One direct level below the site |
| `/enterprise/site/**` | The site and every descendant |

Regular expressions are not supported.

## Explicit deny

```json
"denies": [
    {
        "id": "protect-critical-furnace",
        "subject": "group:maintenance-area-a",
        "capabilities": [
            "mcp.tools.configure-analysis",
            "mcp.tools.operate"
        ],
        "resource": "/enterprise-a/site-paris/area-a/line-2/cell-4/critical-furnace"
    }
]
```

This rule prevents the maintenance group from:

- modifying analysis configuration;
- running an operational action;
- only on the specified critical furnace.

The group keeps its other permissions everywhere else in `area-a`.

A matching deny always overrides an allow assignment, regardless of rule order
in the file.

Use `"capabilities": ["*"]` to deny every capability on a specific resource.

## Technical names and stable resources

```json
"slotResources": {
    "spoony-00452": "/enterprise-a/site-paris/area-a/line-3/cell-2/motor-7",
    "site-energy": "/enterprise-a/site-paris"
}
```

The key on the left is the technical slot name. The value on the right is its
stable identity in the hierarchy.

### `spoony-00452`

A client uses the technical slot:

```text
/spoony-00452/mcp
```

but the policy engine evaluates:

```text
/enterprise-a/site-paris/area-a/line-3/cell-2/motor-7
```

The provider may reconnect or change IP address without changing this
identity.

### `site-energy`

This slot represents the Paris site itself. A resource does not need to be a
leaf such as a motor.

An undeclared slot normally becomes `/<slot-name>`. In an industrial
environment, explicit mappings are preferable because they preserve stable
identities.

## Global tool classification

```json
"toolCapabilities": {
    "get_electrical_state": "mcp.resources.read",
    "diagnose_motor": "mcp.tools.diagnose",
    "reset_baseline": "mcp.tools.configure-analysis",
    "start_motor": "mcp.tools.operate"
}
```

The broker never guesses permission from a tool name. This block explicitly
maps each tool to a capability.

| Tool | Required capability |
|---|---|
| `get_electrical_state` | Resource read |
| `diagnose_motor` | Diagnostic |
| `reset_baseline` | Analysis configuration change |
| `start_motor` | Equipment operation |

If a tool is absent from every mapping, the broker uses the generic
`mcp.tools.call` capability.

This fallback explains why the `maintenance` role also contains
`mcp.tools.call`.

## Resource-specific tool classification

```json
"providerToolCapabilities": {
    "/enterprise-a/site-paris/area-a/**": {
        "start_motor": "mcp.tools.operate"
    }
}
```

This block can change a tool's classification for one resource or subtree.

Resolution order:

1. resource-specific mapping in `providerToolCapabilities`;
2. global mapping in `toolCapabilities`;
3. generic `mcp.tools.call` capability.

In this example, the specific `start_motor` value is the same as the global
value. This duplication is intentionally educational. In a real deployment,
this block is useful when the same tool name has a different risk level for a
particular provider or area.

## Audit logging

```json
"audit": {
    "logAllowed": false
}
```

Denied decisions are always logged.

`logAllowed: false` means successful decisions are not logged. This is the
recommended setting because it avoids excessive log volume.

Temporarily set it to `true` when learning the policy or diagnosing a problem.
Audit records contain the decision and matching policy identifiers, but never
the bearer token or provider secret.

## Shared provider secret

```json
"providerSecret": "change-me"
```

**Deliberately absent from the shipped template.** Add the key inside `auth` to
turn provider authentication on.

This secret authenticates MCP servers connecting to `/provider/<slot>` or
`/providers`. Every provider must then present it as `X-Provider-Token` or
`Authorization: Bearer`, and one that does not is refused at the WebSocket
handshake.

It is independent from client bearer tokens, and in particular it is **not**
governed by `auth.enabled`: set it and provider authentication is on, even with
OAuth off. That is why the template does not ship it. Left in place with the
placeholder value, it would refuse every provider on a broker the reader
believes is running wide open.

One consequence to plan around: the browser `WebSocket` constructor cannot set
request headers, so a provider hosted in a web page cannot present the secret at
all. With `providerSecret` set, browser-hosted providers are locked out; they
need provider authentication off, or an authenticating reverse proxy in front.

The `change-me` value is only a placeholder. In production:

- generate a long, random value;
- preferably provide it through `MCP_BROKER_PROVIDER_SECRET`;
- never commit it to Git;
- never share it with MCP clients.

The shared secret preserves historical compatibility and allows every resource
path. To restrict each device to its own subtree, use a custom
`IProviderAuthenticator` that returns `IProviderPrincipal.allowedResources`.

## Local MCP server started by the broker

```json
"stdioUpstreams": [
    {
        "name":      "fs",
        "command":   "npx",
        "args":      ["-y", "@modelcontextprotocol/server-filesystem", "/data"],
        "aggregate": true
    }
]
```

### `name`

Slot name exposed by the broker. A client uses:

```text
/fs/mcp
```

### `command`

Program started by the broker. Here, it is `npx`.

### `args`

Arguments passed to the program:

- `-y` automatically accepts the installation requested by `npx`;
- `@modelcontextprotocol/server-filesystem` is the package to run;
- `/data` is the directory exposed to the server.

Filesystem access is sensitive. Restrict `/data` to the smallest required
directory.

### `aggregate`

`true` makes this provider part of the reserved `_all` slot, in addition to its
own `/fs/mcp`. Without it the stdio upstream is reachable through its own slot
only.

Note the asymmetry: `stdioUpstreams` entries do **not** join `_all` by default,
while `mcpServers` and `mcpbBundles` entries do. Set it explicitly either way
and you never have to remember which is which.

## Bridging an MCP host over stdio

Not in `config.json`, but the reason most people set `aggregate` in the first
place. A second file in this folder, `config.stdio-bridge.json`, adds one key:

```json
"stdioProvider": "_all"
```

With it, the broker also behaves as a stdio MCP server: it reads JSON-RPC from
its standard input and writes answers to its standard output, bridging a host
such as Claude Desktop to one slot. Point the host's config at that file:

```json
{
    "command": "npx",
    "args": ["-y", "@cyanmycelium/mcp-broker"],
    "env": { "MCP_BROKER_CONFIG": "/abs/path/to/.mcp-broker/config.stdio-bridge.json" }
}
```

Two things to get right.

- **Pin it to `_all`, not to a real slot.** `_all` exists from startup and
  answers the handshake itself, so the host connects even though no provider has
  arrived yet, and it announces new tools as providers join. Pinned to a real
  slot, the host starts before the provider does, gets "not connected" for its
  very first message, and gives up. For a provider hosted in a browser page that
  is guaranteed: the page cannot possibly be open before the host launches.
  `_broker` also always answers, but it only ever offers the five introspection
  tools. The broker warns at startup when `stdioProvider` names a slot it does
  not host.
- **Keep it in its own file.** With `stdioProvider` set, standard output belongs
  to the JSON-RPC stream and every log line moves to standard error, so a broker
  started that way in a terminal looks like it is doing nothing.

`MCP_BROKER_STDIO_PROVIDER` sets the same thing from the environment.

## Signed local MCP bundle

```json
"mcpbBundles": [
    {
        "name": "weather",
        "path": "bundles/weather.mcpb",
        "publicKey": "bundles/mcpb-signing.pub.pem",
        "signature": "bundles/weather.mcpb.sig",
        "userConfig": { "apiKey": "your-key-here" },
        "aggregate": true
    }
]
```

### `name`

Exposed slot name, here `weather`.

### `path`

Path to the `.mcpb` bundle.

### `publicKey`

Public key used to verify that the bundle was signed by a trusted source.

### `signature`

Detached signature file corresponding to the bundle.

The broker refuses to start the bundle if the signature is missing or invalid.

### `userConfig`

Values injected into the configuration declared by the bundle.

`apiKey` is an example secret. Never store a real API key in a public or shared
version of this file.

### `aggregate`

`true` adds the `weather` provider to the `_all` aggregate slot.

Even inside `_all`, visibility and calls remain filtered by authorization
policy.

## Complete decision example

Assume a validated JWT contains:

```json
{
    "sub": "alice",
    "groups": ["maintenance-area-a"],
    "client_id": "local-ai-assistant",
    "scope": "mcp:call"
}
```

Alice calls:

```text
tool: diagnose_motor
slot: spoony-00452
```

The broker calculates:

1. The `mcp:call` scope passes the OAuth gate.
2. The `groups` claim produces `group:maintenance-area-a`.
3. `diagnose_motor` produces the `mcp.tools.diagnose` capability.
4. `spoony-00452` produces the
   `/enterprise-a/site-paris/area-a/line-3/cell-2/motor-7` resource.
5. The `maintenance-area-a` assignment matches the subject and resource.
6. The `maintenance` role contains `mcp.tools.diagnose`.
7. No deny matches this motor.
8. The final decision is allow.

If Alice attempts `start_motor` on the critical furnace:

1. `start_motor` produces `mcp.tools.operate`.
2. The `protect-critical-furnace` deny matches the resource.
3. The deny has priority.
4. The final decision is deny.

## Pre-deployment checklist

- Set `auth.enabled` to `true`. The template ships it off so that a fresh copy
  runs; leaving it off in production means every client reaches every slot.
- Replace every `.local` domain with the real address.
- Confirm that `publicBaseUrl` exactly matches the broker's public address.
- Confirm that JWTs use this resource as their audience.
- Verify the JWKS URL and expected issuer.
- If you add `providerSecret`, never keep `change-me`.
- Never publish the private TLS key.
- Never publish API keys from `userConfig`.
- Use `127.0.0.1` instead of `0.0.0.0` when network access is unnecessary.
- Test every role with a representative account.
- Test denies against critical assets.
- Confirm that `_all` does not reveal unauthorized providers.
- List in `allowedOrigins` exactly the browser origins that need access, with
  the right scheme and port, and no others. Remember that a page served by this
  broker still counts as a browser origin.
- Return `audit.logAllowed` to `false` after troubleshooting.
- Restart the broker after each policy change because policies are loaded only
  once at startup.

## Further reading

- [Complete configuration reference](../docs/config.md)
- [Broker OAuth guide](../../../../docs/authorization.md)
- [Hierarchical authorization](../../../../docs/hierarchical-authorization.md)
- [Endpoints and transports](../../../../docs/endpoints.md)

Or ask the broker itself: the reserved `_broker` slot exposes a `broker_guide`
tool (integration walkthroughs, written from the source) and a `broker_diagnose`
tool (live state plus the problems it can prove, each with a fix).
