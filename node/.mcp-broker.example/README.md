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
