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

## The mental model

The file answers five questions:

1. Where does the broker listen?
2. How are network connections encrypted?
3. How does the broker identify clients and providers?
4. What may each client do, and on which resources?
5. Which local or packaged MCP servers should be loaded?

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

## Lines 1 to 5: general settings

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

## Lines 7 to 11: HTTP and WebSocket paths

```json
"paths": {
    "provider": "/provider",
    "client": "/",
    "mcp": "/mcp"
}
```

### `paths.provider`

WebSocket prefix used by a provider connecting to the broker.

Example:

```text
wss://mcp.factory.local/provider/spoony-00452
```

The provider requests the `spoony-00452` slot.

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

The `providers`, `sse`, and `messages` paths are not overridden in this
example, so the broker uses their default values.

## Lines 13 to 16: TLS

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

## Lines 18 to 23: static web files

```json
"www": {
    "open": false,
    "mounts": [
        { "urlPrefix": "/", "dir": "www" }
    ]
}
```

### `www.open`

Controls whether the broker automatically opens a web browser.

- `false` is suitable for servers, containers, and headless environments.
- `true` is convenient during local development.

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

## Lines 25 to 35: enabling OAuth

```json
"auth": {
    "enabled": true,
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

Enables OAuth authentication for MCP clients.

- `true` requires a valid bearer token.
- `false` preserves the historical unauthenticated mode.
- A detailed policy is useful only when clients have an authenticated
  identity.

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

## Lines 36 to 40: converting JWT claims into subjects

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

## Lines 41 to 64: roles and capabilities

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

## Lines 65 to 78: assignments

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

## Lines 79 to 89: explicit deny

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

## Lines 90 to 93: technical names and stable resources

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

## Lines 94 to 99: global tool classification

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

## Lines 100 to 104: resource-specific tool classification

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

## Lines 105 to 107: audit logging

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

## Line 108: shared provider secret

```json
"providerSecret": "change-me"
```

This secret authenticates MCP servers connecting to `/provider/<slot>` or
`/providers`.

It is independent from client bearer tokens.

The `change-me` value is only a placeholder. In production:

- generate a long, random value;
- preferably provide it through `MCP_BROKER_PROVIDER_SECRET`;
- never commit it to Git;
- never share it with MCP clients.

The shared secret preserves historical compatibility and allows every resource
path. To restrict each device to its own subtree, use a custom
`IProviderAuthenticator` that returns `IProviderPrincipal.allowedResources`.

## Lines 111 to 117: local MCP server started by the broker

```json
"stdioUpstreams": [
    {
        "name": "fs",
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-filesystem", "/data"]
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

Add `"aggregate": true` if this provider should also appear in `_all`.
Without this property, the stdio upstream remains available through its direct
slot only.

## Lines 119 to 128: signed local MCP bundle

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

- Replace every `.local` domain with the real address.
- Confirm that `publicBaseUrl` exactly matches the broker's public address.
- Confirm that JWTs use this resource as their audience.
- Verify the JWKS URL and expected issuer.
- Never keep `change-me`.
- Never publish the private TLS key.
- Never publish API keys from `userConfig`.
- Use `127.0.0.1` instead of `0.0.0.0` when network access is unnecessary.
- Test every role with a representative account.
- Test denies against critical assets.
- Confirm that `_all` does not reveal unauthorized providers.
- Return `audit.logAllowed` to `false` after troubleshooting.
- Restart the broker after each policy change because policies are loaded only
  once at startup.

## Further reading

- [Complete configuration reference](../docs/config.md)
- [Broker OAuth guide](../../docs/authorization.md)
- [Hierarchical authorization](../../docs/hierarchical-authorization.md)
