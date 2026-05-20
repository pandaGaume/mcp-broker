# `node/web/` — broker instance UI

Static web UI served by the broker. No build step: plain ES modules and CSS,
served as-is over the broker's static mount.

## Layout

```
web/
├── index.html                  ← launcher: shown when the broker starts
├── css/
│   └── styles.css              ← common stylesheet (shared by all pages)
├── js/
│   └── lib/
│       └── broker-tunnel.js     ← common reusable lib (shared by demos)
├── assets/
│   └── logo.png
└── demos/
    ├── DemoPlaceholder.html      ← stand-in for demos not bundled yet
    └── provider-tunnel/         ← one self-contained folder per demo
        ├── index.html
        ├── css/
        │   └── app.css
        └── js/
            ├── app.js
            └── toolbox-server.js
```

## Conventions

- **`index.html`** is the launcher. The broker opens it on start (`www.open`).
  It links the bundled demos and the broker's own endpoints.
- **`css/` and `js/` at the root hold only common, shared assets.**
  `css/styles.css` is the sitewide stylesheet; `js/lib/broker-tunnel.js` is
  the reusable, zero-dependency broker connection module.
- **Each demo lives in its own folder under `demos/`** with its own
  `index.html`, `css/`, and `js/`. A demo may import shared code from the root
  `js/` (e.g. `../../../js/lib/broker-tunnel.js`).
- **`demos/DemoPlaceholder.html`** is the stand-in linked from the launcher
  for demos that are not packaged yet. It reads `?slot=<name>` to label itself.

## Bundled demos

- **`demos/provider-tunnel/`** — hosts an MCP server (official
  `@modelcontextprotocol/sdk`) and tunnels it to the broker over a WebSocket.
  Proves the broker is implementation-agnostic: a server built with the
  reference SDK tunnels through unchanged. The only broker-specific code is
  `js/lib/broker-tunnel.js`.

## Serving it

Point a `www` mount at this folder from a broker config:

```json
{
    "www": {
        "open": true,
        "mounts": [{ "urlPrefix": "/", "dir": "../web" }]
    }
}
```

(`../web` is resolved against the config file's directory, e.g. `.mcp-broker/`.)

Or with an environment variable, from the `node/` directory:

```sh
MCP_BROKER_WWW_DIR=web npm start
```
