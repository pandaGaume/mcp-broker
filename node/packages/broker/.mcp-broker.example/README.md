# `.mcp-broker.example/`

This is a template. Copy it as `.mcp-broker/` next to where you run the
broker, then adapt to your needs:

```sh
cp -r .mcp-broker.example .mcp-broker
```

**Read this before you copy.** `config.json` is a *production reference*: it
shows every key the broker understands, filled in with values from an imagined
factory deployment. Two consequences.

1. **Authorization ships off** (`auth.enabled: false`), so a fresh copy starts
   and answers. The whole `auth` block is still there as the reference for when
   you turn it on: flip `enabled` to `true`, then replace
   `identity.factory.local` with your own authorization server and
   `providerSecret: "change-me"` with a real secret. See
   [`docs/authorization.md`](../../../../docs/authorization.md).
2. **Other values point at hosts and files that do not exist here**: the TLS
   material under `certs/`, the `www/` directory, the `/data` filesystem
   upstream, the `.mcpb` bundle under `bundles/`. Delete the sections you do not
   use. A missing directory is skipped with a warning; a missing TLS file stops
   startup, with a message naming the two files and the three ways out.

So a straight `cp -r` does not run yet. Do one of these first:

```sh
# either: run without TLS, which ignores the tls block entirely
MCP_BROKER_PROTOCOL=http npx @cyanmycelium/mcp-broker

# or: put a self-signed pair where the config says
mkdir -p .mcp-broker/certs
openssl req -x509 -newkey rsa:2048 -nodes -days 365 -subj "/CN=localhost" \
  -keyout .mcp-broker/certs/key.pem -out .mcp-broker/certs/cert.pem
```

(Working inside this repository, `npm run gen-cert -w @cyanmycelium/mcp-broker`
does the same thing without openssl. That script is not usable from an installed
package: it needs a development dependency the published package does not
carry.)

If you take the second route, remember the `allowedOrigins` entries below become
`http://`, since the scheme is part of the comparison.

Property-by-property educational guides:

- [English](CONFIGURATION-EN.md)
- [Français](CONFIGURATION-FR.md)

## Bridging an MCP host over stdio

`config.stdio-bridge.json` is the second, minimal file in this folder: it turns
the broker into a stdio MCP server for a host such as Claude Desktop, bridged to
the reserved `_all` slot.

```json
{
    "command": "npx",
    "args": ["-y", "@cyanmycelium/mcp-broker"],
    "env": { "MCP_BROKER_CONFIG": "/abs/path/to/.mcp-broker/config.stdio-bridge.json" }
}
```

Pin the bridge to `_all`, not to a real slot. `_all` exists from startup and
answers the handshake itself, so the host connects even though no provider has
arrived yet, and it pushes `notifications/tools/list_changed` as providers join,
so a browser page opened later shows up live. Pinned to a real slot, the host
starts before the provider does and fails the handshake every time. Providers
join `_all` by opting in: `aggregate: true` on an upstream, or
`{ aggregate: true }` on `DirectTransport` / `MultiplexTransport.create`.

Keep that file separate from `config.json`: with `stdioProvider` set, stdout
carries JSON-RPC and every log line moves to stderr, so a broker started that
way in a terminal looks like it is doing nothing.

## Layout

```
.mcp-broker/
├── config.json          ← broker configuration (port, locale, TLS, mounts, ...)
├── config.stdio-bridge.json  ← minimal config for an MCP host over stdio (optional)
├── certs/               ← TLS material (optional, gitignore this)
│   ├── cert.pem
│   └── key.pem
├── bundles/             ← signed .mcpb bundles + trusted public key (optional)
│   ├── <bundle>.mcpb
│   ├── <bundle>.mcpb.sig
│   └── mcpb-signing.pub.pem
├── grammars/            ← local grammar overrides (optional)
│   └── <userAgent>/
│       └── <locale>.json
└── www/                 ← static files served at "/" (optional)
    └── index.html
```

A ready-made instance UI lives at
[`node/packages/broker/web/`](../web/), point a `www` mount at it
(`"dir": "../web"`) to serve it. See [its README](../web/README.md).

The page is served by the broker but is still a *browser* origin, so it has to
be listed in `allowedOrigins` before it may call `/<slot>/mcp`, `/<slot>/sse` or
`/<slot>/messages`. Being served by the same broker exempts nothing. With
`port: 3001` and no TLS, that is `"http://localhost:3001"`; the template ships
`https://` entries because it also sets `tls.cert`/`tls.key`, which makes the
broker speak HTTPS.

## Path resolution

Paths inside `config.json` are resolved against the **directory of the
config file** (i.e. `.mcp-broker/`). So `"certs/cert.pem"` in the config
points at `.mcp-broker/certs/cert.pem`. The folder is self-contained.

Env vars (`MCP_BROKER_TLS_CERT`, `MCP_BROKER_WWW_DIR`, ...) are still
resolved against `process.cwd()`: they are the deploy-time override
mechanism and not tied to the config file's location.

## `.mcpb` bundles

`mcpbBundles` entries load local `.mcpb` bundles as stdio provider slots.
Each bundle is verified against a **detached signature** before it is
unpacked and run: the broker never spawns an unverified bundle.

1. Generate a signing key pair (once):
   `node ../scripts/sign-bundle.mjs keygen bundles`
2. Sign each bundle:
   `node ../scripts/sign-bundle.mjs sign bundles/<bundle>.mcpb bundles/mcpb-signing.key.pem`
3. Reference the bundle, its `.sig` and the **public** key in `config.json`.

Keep the private key (`mcpb-signing.key.pem`) out of the config folder and
out of version control. `userConfig` supplies values for the manifest's
`${user_config.*}` placeholders.

## Grammar overrides

Drop a JSON at `grammars/<userAgent>/<locale>.json` to override individual
tool/resource/template descriptions for that combination. Entries you don't
override fall back to the packaged defaults shipped with the broker. See
[`docs/config.md`](../docs/config.md) for the schema.

## Suggested `.gitignore`

```
.mcp-broker/certs/
.mcp-broker/config.json   # if it contains environment-specific values
```

Or, to gitignore the whole folder:

```
.mcp-broker/
```
