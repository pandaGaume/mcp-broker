# OAuth Policy Lab

A self-contained browser demonstration of the broker's OAuth 2.1 resource
server and hierarchical authorization features.

## Run

From the `node/` directory:

```sh
npm run demo:oauth
```

The command builds the broker, starts the local authorization server on
`http://127.0.0.1:4100`, starts the broker and three stdio MCP providers on
`http://127.0.0.1:3001`, then opens:

```text
http://127.0.0.1:3001/demos/oauth-lab/
```

Set `OAUTH_LAB_NO_OPEN=1` to keep the command from opening a browser.

While the demo is running, its automated end-to-end check can be launched
from another terminal:

```sh
npm run demo:oauth:smoke
```

This example is for local development only. Its authorization server presents
four passwordless demo identities and generates an in-memory signing key on
every start.

## What it demonstrates

- OAuth 2.0 Protected Resource Metadata discovery
- Authorization Code with PKCE S256
- authorization server metadata discovery
- signed JWT access tokens and JWKS validation
- issuer, expiration, OAuth scope, and RFC 8707 audience validation
- tab-scoped token caching with silent per-resource token acquisition
- claim mapping to users, groups, and client identities
- role inheritance and resource-scoped assignments
- explicit deny precedence
- per-slot scope requirements for `_broker`
- capability mapping for MCP tool calls
- live allow and deny audit events

## Demo identities

| Identity | Group | Effective access |
| --- | --- | --- |
| Geordi La Forge, Chief Engineer | `starfleet-engineering` | Read, diagnose, and reset in Area A. Reset is explicitly denied on the critical furnace. |
| Worf, Chief Security Officer | `starfleet-security` | Read and start machines in Area A. |
| Seven of Nine, Astrometrics Specialist | `astrometrics` | Read-only access across the Paris site. |
| Jean-Luc Picard, Captain | `starfleet-command` | Full resource access and the `broker:admin` OAuth scope. |

Each token is audience-bound to the selected MCP resource. Picard's policy
grants access everywhere, but a token issued for `_broker` cannot be reused for
`motor-7`, `critical-furnace`, or `site-energy`. The browser caches one token
per resource for the lifetime of the tab. After the first interactive identity
selection, the local authorization server reuses its opaque identity session to
add tokens silently without presenting the identity page again.

The private signing key, authorization codes, identity sessions, and audit
events are held only in server memory. Access tokens are held in the browser's
tab-scoped session storage. Stop the demo with `Ctrl+C`.
