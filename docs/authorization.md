# Authorization

The broker can act as an **OAuth 2.1 resource server**, aligned with the
[MCP Authorization specification](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization)
(2025-06-18). This lets you expose it publicly: every HTTP/WebSocket client
request must then carry a valid bearer token, providers must authenticate to
occupy a slot, and the `_all` aggregate is filtered per caller.

> **Authorization is opt-in.** With no `auth` configuration the broker performs
> **no** authentication and behaves exactly as before, appropriate only behind a
> trusted network boundary (loopback, private LAN, sidecar). The MCP spec itself
> classifies authorization as OPTIONAL.

Two independent concerns:

| Concern | Who | Mechanism |
|---|---|---|
| **Client authorization** | MCP clients calling a slot | OAuth 2.1 bearer token (resource server) |
| **Provider authentication** | Engines connecting to serve a slot | Shared secret (or a custom authenticator) |

Out of scope (by the spec): the **stdio** transport (credentials come from the
environment) and in-process **loopback** clients (the broker's own components).

OAuth scopes remain available as coarse gates. For industrial namespace
authorization based on who, what, and where, see
[Hierarchical authorization](hierarchical-authorization.md).

---

## Model

The broker is **only** a resource server. It never issues tokens: an external
authorization server (AS) does that, and the broker just advertises it and
validates the tokens presented to it.

Each slot exposed over HTTP is a **distinct protected resource**. Its canonical
resource identifier (RFC 8707) is the slot's `/mcp` endpoint:

```
<publicBaseUrl>/<slot>/mcp
```

That identifier is what the client must request a token for (the `resource`
parameter) and what the broker checks the token's `aud` claim against. A token
minted for one slot cannot be replayed against another, or against a different
service.

The broker never forwards a client's token to an upstream provider: **no token
passthrough**. Upstream/remote providers keep their own credentials.

---

## Client authorization flow

Standard RFC 9728 / OAuth 2.1 discovery:

```
Client                         Broker (resource server)          Authorization Server
  |   request without token         |                                    |
  |-------------------------------->|                                    |
  |   401 + WWW-Authenticate        |                                    |
  |<--------------------------------|                                    |
  |   GET .well-known/…             |                                    |
  |-------------------------------->|                                    |
  |   Protected Resource Metadata   |                                    |
  |<--------------------------------|                                    |
  |                    discover AS metadata, run OAuth 2.1 (PKCE)         |
  |--------------------------------------------------------------------->|
  |                    access token (aud = <base>/<slot>/mcp)            |
  |<---------------------------------------------------------------------|
  |   request WITH bearer token     |                                    |
  |-------------------------------->|                                    |
  |   MCP response                  |                                    |
  |<--------------------------------|                                    |
```

### Protected Resource Metadata

Served unauthenticated (it is public discovery data) at:

```
GET <publicBaseUrl>/.well-known/oauth-protected-resource/<slot>/mcp
```

```json
{
  "resource": "https://mcp.example.com/weather/mcp",
  "authorization_servers": ["https://auth.example.com"],
  "scopes_supported": ["mcp:call"],
  "bearer_methods_supported": ["header"]
}
```

### The challenge

On a missing or invalid token the broker replies `401` with an RFC 9728 §5.1
header pointing at that slot's metadata:

```
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/weather/mcp", error="invalid_token", error_description="Missing bearer token"
```

On a valid token that lacks the required scope, `403`:

```
HTTP/1.1 403 Forbidden
WWW-Authenticate: Bearer resource_metadata="…", error="insufficient_scope", scope="mcp:call"
```

The token is only ever read from the `Authorization: Bearer` header, never from
the query string (OAuth 2.1 §5). The same rules apply to the raw WebSocket
client transport (`/<slot>`), where the challenge is returned during the upgrade
handshake.

### Token validation

The default validator verifies JWT access tokens **statelessly**: it checks the
signature against the AS's JWKS, the issuer, the audience (`aud` must equal the
slot's canonical resource), and expiry. No per-request round-trip to the AS, no
shared secret. A pluggable `ITokenValidator` seam lets a deployment swap in
opaque-token introspection (RFC 7662) or any custom logic without touching the
enforcement code.

---

## Scopes

Three layers, all optional:

| Setting | Effect |
|---|---|
| `requiredScopes` | Baseline scope(s) any caller must hold to reach any slot. Empty ⇒ any valid token passes. |
| `perSlotScopes[slot]` | Override for one slot. E.g. require an admin scope on `_broker`. |
| `providerScopes[provider]` | Deprecated. Narrows the `_all` aggregate by scope and combines restrictively with hierarchical policies. |

### `_all` per-client filtering

`_all` is the content-confidentiality enforcement point. When `providerScopes`
is set, a client's view of the aggregate is narrowed to the providers it is
authorized for:

- `tools/list` and `prompts/list` only return entries from visible providers.
- `tools/call` / `prompts/get` to a provider the caller may not see return the
  **same** "unknown" error as a missing name, so a forbidden provider's
  existence never leaks.

A provider not listed in `providerScopes` stays visible to every authenticated
caller (opt-in per provider).

> **Note:** `_broker`'s `providers_list` tool is token-gated (and can require an
> admin scope via `perSlotScopes`), but it is not filtered per provider. Use
> `_all` when you need per-caller content confidentiality.

---

## Hierarchical policies

When `roles`, `assignments`, or `denies` are configured, the broker also
evaluates each MCP operation against a compiled hierarchical policy:

```text
JWT subjects + functional capability + resource path -> allow or deny
```

Roles define what a caller may do. Assignments bind roles to subjects and
resource subtrees. Explicit denies override every allow. Technical slot names
can be mapped to stable paths. Industrial examples use a domain-neutral,
ISA-95 / IEC 62264-aligned profile such as:

```text
/enterprise/site/area/line/cell/asset
```

Here, `line` and `cell` are compact identifiers for the ISA-95 Production Line
and Work Cell concepts. The final asset is a project-specific extension. The
broker does not claim or enforce full ISA-95 compliance, and UMD-style
namespaces remain mappable to the same resource paths.

The policy engine applies to direct slot transports and to every provider
exposed through `_all`. Unauthorized aggregate calls use the same error as an
unknown provider or tool. Provider identities may also be restricted to
specific resource subtrees.

The complete model, configuration, validation rules, examples, provider
principals, and `providerScopes` migration procedure are documented in
[Hierarchical authorization](hierarchical-authorization.md).

---

## Provider authentication

A separate concern from client authorization: a provider is the backend that
connects **into** the broker to serve a slot, not an OAuth client acting for a
resource owner. Authenticating it is what stops a stranger from occupying a free
slot (`ws://host/provider/<slot>`) and impersonating the real engine.

When enabled, every provider connecting to `/provider/<slot>` (slot-level) or
the multiplexed `/providers` socket (socket-level) must present a shared secret,
via either header, checked in constant time:

```
X-Provider-Token: <secret>
# or
Authorization: Bearer <secret>
```

A failed handshake is rejected with `401` before the connection is accepted.
The default is a single shared secret; swap in a custom `IProviderAuthenticator`
for per-slot secrets, mTLS, or a signed handshake.

A custom authenticator can return a structured `IProviderPrincipal` with
`allowedResources`. The broker then rejects a dedicated registration outside
that namespace before the slot becomes visible. A multiplexed connection checks
each announced slot independently. The shared-secret implementation remains
unrestricted for backward compatibility.

---

## Endpoints summary

| Endpoint | Auth when enabled |
|---|---|
| `POST/GET /<slot>/mcp`, `/<slot>/sse`, `/<slot>/messages` | Client bearer token for `<slot>` |
| `WS /<slot>` | Client bearer token for `<slot>` (checked at upgrade) |
| `GET /.well-known/oauth-protected-resource/<slot>/mcp` | None (public discovery) |
| `WS /provider/<slot>`, `WS /providers` | Provider shared secret (if provider auth enabled) |
| `OPTIONS` (CORS preflight) | None (returns `204`) |

`_broker` is a regular slot: once client auth is on, `/_broker/mcp` requires a
token like any other, and `perSlotScopes["_broker"]` can gate it behind an admin
scope.

### Two layers, two shapes of refusal

Authentication and per-frame policy fail at different moments, and say so
differently:

| Refusal | When | What the client sees |
|---|---|---|
| Token absent, invalid, or missing a required scope | Before the request reaches the transport | HTTP `401` / `403` with `WWW-Authenticate` |
| Hierarchical policy denies the operation the frame carries | Once the session is established and the frame is read | HTTP `200` with JSON-RPC `{ "error": { "code": -32001, "message": "Forbidden" } }` |

The second is not an HTTP failure: the transport did its job, the operation was
refused. This is the shape the raw WebSocket transport has always returned, and
on `/<slot>/mcp` it is now the same, because the session owns the exchange by
the time the frame is inspected. A client must therefore check the JSON-RPC
body, not the status code alone.

---

## Configuration

See the Node implementation's [config reference](../node/docs/config.md#auth-oauth-21-authorization)
for the concrete `auth` block, environment variables, and the builder API
(`withJwtAuth`, `withProviderSecret`, `withAuthorizationPolicy`,
`withPolicyEngine`, `withSlotResourceResolver`).
