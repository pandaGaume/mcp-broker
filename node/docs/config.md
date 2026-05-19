# Broker configuration

`mcp-broker` reads its configuration from three sources, applied in this order
(highest priority first):

1. **Environment variables** — `MCP_BROKER_*`
2. **JSON config file** — discovered automatically (see below)
3. **Built-in defaults**

Env vars always win over file values. The file is the static baseline you ship
with the broker; env vars are the deploy-specific overrides. Arrays (`www.mounts`,
`stdioUpstreams`) are file-only — no env-var equivalent.

---

## The `.mcp-broker/` convention

All broker-local files live in a hidden `.mcp-broker/` folder next to where
you launch the broker. The folder is **self-contained**: paths inside
`config.json` are resolved against it, not against the cwd.

```
your-project/
└── .mcp-broker/
    ├── config.json       ← broker configuration
    ├── certs/            ← TLS material (optional)
    │   ├── cert.pem
    │   └── key.pem
    ├── grammars/         ← local grammar overrides (optional)
    │   └── <userAgent>/
    │       └── <locale>.json
    └── www/              ← static dev harness (optional)
        └── index.html
```

A starter template ships with the package at
[`.mcp-broker.example/`](../.mcp-broker.example/). Copy it as `.mcp-broker/`
and adapt:

```sh
cp -r node_modules/@cyanmycelium/mcp-broker/.mcp-broker.example .mcp-broker
```

### Config file discovery

The broker looks in this order:

1. `MCP_BROKER_CONFIG` env var (explicit path).
2. `./.mcp-broker/config.json` relative to `process.cwd()`.
3. `./mcp-broker.config.json` relative to `process.cwd()` — **legacy**,
   logs a deprecation warning to stderr. Move it to `.mcp-broker/config.json`
   to silence.

When none of these exist, the broker runs with env-vars-or-defaults only —
no error, no warning.

### Path resolution

| Source | Relative to |
|---|---|
| Paths inside `config.json` (`tls.cert`, `www.mounts[*].dir`, ...) | The config file's directory (`.mcp-broker/`) |
| Paths from env vars (`MCP_BROKER_TLS_CERT`, `MCP_BROKER_WWW_DIR`) | `process.cwd()` |

This split is deliberate: the config file is a self-contained bundle, env
vars are deploy-time overrides injected by the surrounding environment.

### Grammar overrides

When `.mcp-broker/grammars/` exists, every `<userAgent>/<locale>.json` file
in it is **merged on top of** the packaged grammar with the same key. Local
entries win on conflicts; missing entries fall through to the packaged
values.

Concrete example:

```
.mcp-broker/grammars/claude/fr.json
```

```json
{
    "tools": {
        "broker_info": {
            "description": "Custom description for Claude in French — overrides the packaged one."
        }
    }
}
```

For everything else in the `claude:fr` grammar (other tools, resources,
templates), the packaged values apply. You only override what you want to
customize.

---

## Complete example

```json
{
    "port": 3001,
    "host": "0.0.0.0",
    "protocol": "https",
    "locale": "fr",
    "brokerName": "broker-eu-west",
    "stdioProvider": null,

    "paths": {
        "provider":  "/provider",
        "providers": "/providers",
        "client":    "/",
        "mcp":       "/mcp",
        "sse":       "/sse",
        "messages":  "/messages"
    },

    "tls": {
        "cert": "certs/cert.pem",
        "key":  "certs/key.pem"
    },

    "www": {
        "open":   false,
        "mounts": [
            { "urlPrefix": "/",       "dir": "www" },
            { "urlPrefix": "/extras", "dir": "../shared/extras" }
        ]
    },

    "stdioUpstreams": [
        {
            "name":    "fs",
            "command": "npx",
            "args":    ["-y", "@modelcontextprotocol/server-filesystem", "/data"]
        },
        {
            "name":    "git",
            "command": "uvx",
            "args":    ["mcp-server-git", "--repository", "/data/repo"],
            "env":     { "GIT_AUTHOR_NAME": "broker" }
        }
    ]
}
```

`certs/cert.pem` → resolves to `.mcp-broker/certs/cert.pem`.
`www` (in `mounts`) → resolves to `.mcp-broker/www/`.
`../shared/extras` → resolves to `<your-project>/shared/extras/`.

---

## Schema reference

### Top-level scalars

| Field | Type | Default | Env var | Notes |
|---|---|---|---|---|
| `port` | `number` | `3000` | `MCP_BROKER_PORT` | TCP port |
| `host` | `string` | `0.0.0.0` | `MCP_BROKER_HOST` | Bind interface |
| `protocol` | `"http" \| "https"` | auto | `MCP_BROKER_PROTOCOL` | `auto` enables TLS when `tls.cert` + `tls.key` are set |
| `locale` | `string` | `en` | `MCP_BROKER_LOCALE` | BCP-47 tag (`fr`, `fr-CA`, `zh-CN`, ...) |
| `brokerName` | `string` | package name | (none) | Logical name in `broker_info` output |
| `stdioProvider` | `string` | (unset) | `MCP_BROKER_STDIO_PROVIDER` | Bridge stdin/stdout to this provider |

### `paths` (URL routing)

| Field | Default | Env var |
|---|---|---|
| `paths.provider` | `/provider` | `MCP_BROKER_PROVIDER_PATH` |
| `paths.providers` | `/providers` | (none) |
| `paths.client` | `/` | `MCP_BROKER_CLIENT_PATH` |
| `paths.mcp` | `/mcp` | `MCP_BROKER_MCP_PATH` |
| `paths.sse` | `/sse` | (none) |
| `paths.messages` | `/messages` | (none) |

### `tls`

Both fields are paths on disk, resolved against `.mcp-broker/`.

| Field | Env var |
|---|---|
| `tls.cert` | `MCP_BROKER_TLS_CERT` |
| `tls.key`  | `MCP_BROKER_TLS_KEY` |

Set both to enable HTTPS/WSS. Use `protocol: "http"` to keep plain HTTP even
when both are present, or `protocol: "https"` to force TLS.

### `www` (static-file serving)

| Field | Type | Env var | Notes |
|---|---|---|---|
| `www.open` | `boolean` | `MCP_BROKER_OPEN=1` | Auto-launch browser at the root URL on startup (requires a mount at `/`) |
| `www.mounts` | `Array<{urlPrefix, dir}>` | (file-only) | URL-prefix → directory mappings. Longest-prefix match wins |

JSON-RPC routes always take precedence over static routes. Mounts whose
target directory does not exist on disk are skipped with a warning.

#### Env-var shortcuts (additive)

Env vars cannot express arrays, so two flat shortcuts cover the common cases.
They are **additive** with `www.mounts` — both contribute mount entries.

| Env var | Equivalent JSON |
|---|---|
| `MCP_BROKER_WWW_DIR=./public` | `www.mounts: [{ "urlPrefix": "/", "dir": "./public" }]` |
| `MCP_BROKER_BUNDLE_DIR=./bundle` | `www.mounts: [{ "urlPrefix": "/bundle", "dir": "./bundle" }]` |

### `stdioUpstreams`

File-only. Each entry spawns a child process at broker start.

| Field | Type | Required | Notes |
|---|---|---|---|
| `name` | `string` | yes | Unique provider slot name |
| `command` | `string` | yes | Executable (looked up in `PATH`) |
| `args` | `string[]` | no | Arguments passed to the command |
| `env` | `Record<string, string>` | no | Extra env vars merged with the parent process env |

---

## Common patterns

### Persistent custom port + locale

```json
{
    "port": 3001,
    "locale": "fr"
}
```

The most frequent use case — no env vars needed across shell sessions.

### Local TLS

```sh
npm run gen-cert    # writes .mcp-broker/certs/{cert,key}.pem after the migration
```

In `.mcp-broker/config.json`:

```json
{
    "tls": {
        "cert": "certs/cert.pem",
        "key":  "certs/key.pem"
    }
}
```

Self-contained — moving `.mcp-broker/` to another machine carries the certs.

### Bridge a local stdio MCP server

```json
{
    "stdioUpstreams": [
        {
            "name": "fs",
            "command": "npx",
            "args":   ["-y", "@modelcontextprotocol/server-filesystem", "/data"]
        }
    ]
}
```

`http://localhost:3000/fs/mcp` proxies to that child process.

### Customize tool descriptions for your org

Drop a JSON file at `.mcp-broker/grammars/claude/en.json`:

```json
{
    "tools": {
        "broker_info": {
            "description": "Your org-specific description for Claude in English."
        }
    }
}
```

The packaged grammar provides the baseline; only your overrides take effect
on the conflicting keys. No need to fork the package.

### Dev harness with auto-open

```json
{
    "www": {
        "open": true,
        "mounts": [
            { "urlPrefix": "/", "dir": "www" }
        ]
    }
}
```

Put your `index.html` etc. in `.mcp-broker/www/`. The broker opens
`http://localhost:3000/` in the default browser on startup. Skipped silently
in headless / container environments.

### Deploy-specific override

Ship the config file with sensible defaults, override per environment via
env vars:

```sh
MCP_BROKER_PORT=4000 mcp-broker     # staging
```

The env var wins; the rest of the file applies as-is.

---

## Programmatic loading

Embedders that build the broker themselves can re-use the loader:

```ts
import { loadBrokerConfig, WsTunnelBuilder } from "@cyanmycelium/mcp-broker";
import * as path from "node:path";

const { config, baseDir } = loadBrokerConfig();

const tunnel = new WsTunnelBuilder()
    .withPort(config.port ?? 3000)
    .withHost(config.host ?? "0.0.0.0")
    .withBrokerLocalGrammarsDir(path.join(baseDir, "grammars"))
    .build();
```

`loadBrokerConfig` never throws; an absent or invalid file returns
`{ config: {}, baseDir: process.cwd(), sourcePath: null }`.

The `BrokerConfig` and `LoadedBrokerConfig` interfaces are exported for
static typing of custom loaders.

---

## Caveats

- **Secrets**: by default the repo's `.gitignore` excludes `.mcp-broker/`
  entirely. Adjust if you want to commit a non-sensitive `config.json` but
  keep certs/grammars overrides local.
- **Relative paths**: config-file paths are resolved against the config
  file's directory; env-var paths against `process.cwd()`.
- **JSON, not JSON5**: no comments. Use a `_comment` field or split into
  multiple keys if you need annotations.
- **Hot reload**: the config is read once at broker startup. Restart to pick
  up changes.
