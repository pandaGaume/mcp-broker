# `.mcp-broker.example/`

This is a template. Copy it as `.mcp-broker/` next to where you run the
broker, then adapt to your needs:

```sh
cp -r .mcp-broker.example .mcp-broker
```

## Layout

```
.mcp-broker/
├── config.json          ← broker configuration (port, locale, TLS, mounts, ...)
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

A ready-made instance UI lives at [`node/web/`](../web/) — point a `www`
mount at it (`"dir": "../web"`) to serve it. See [`node/web/README.md`](../web/README.md).

## Path resolution

Paths inside `config.json` are resolved against the **directory of the
config file** (i.e. `.mcp-broker/`). So `"certs/cert.pem"` in the config
points at `.mcp-broker/certs/cert.pem`. The folder is self-contained.

Env vars (`MCP_BROKER_TLS_CERT`, `MCP_BROKER_WWW_DIR`, ...) are still
resolved against `process.cwd()` — they are the deploy-time override
mechanism and not tied to the config file's location.

## `.mcpb` bundles

`mcpbBundles` entries load local `.mcpb` bundles as stdio provider slots.
Each bundle is verified against a **detached signature** before it is
unpacked and run — the broker never spawns an unverified bundle.

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
