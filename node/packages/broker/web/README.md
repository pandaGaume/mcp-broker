# `node/packages/broker/web/`: broker instance UI

Static web UI served by the broker. No build step: plain ES modules and CSS,
served as-is over the broker's static mount.

The folder is listed in the package's `files`, so it also ships to npm and is
available at `node_modules/@cyanmycelium/mcp-broker/web`.

## Layout

```
web/
├── index.html                  ← launcher: shown when the broker starts
├── broker-self-mcp.html        ← explainer: the _broker slot, _all aggregate, .mcpb bundles
├── css/
│   └── styles.css              ← common stylesheet (shared by all pages)
├── js/
│   └── lib/
│       └── broker-tunnel.js     ← common reusable lib (shared by demos)
├── assets/
│   └── logo.png
└── demos/
    ├── DemoPlaceholder.html      ← stand-in for demos not bundled yet
    ├── provider-tunnel/         ← one self-contained folder per demo
    │   ├── index.html
    │   ├── css/
    │   │   └── app.css
    │   └── js/
    │       ├── app.js
    │       └── toolbox-server.js
    ├── broker-explorer/         ← MCP client connecting to a broker slot
    │   ├── index.html
    │   ├── css/
    │   │   └── app.css
    │   └── js/
    │       ├── app.js
    │       └── mcp-ws-client.js
    └── oauth-lab/               <- OAuth 2.1 and policy demonstration
        ├── index.html
        ├── config.json
        ├── css/app.css
        ├── js/app.js
        └── server/
```

## Conventions

- **`index.html`** is the launcher. The broker opens it on start (`www.open`).
  It links the bundled demos and the broker's own endpoints.
- **`broker-self-mcp.html`** is a root-level explainer page (not a demo): the
  `_broker` introspection slot, the `_all` aggregate, and loading signed
  `.mcpb` bundles. Linked from the launcher's "Broker self-MCP" card.
- **`css/` and `js/` at the root hold only common, shared assets.**
  `css/styles.css` is the sitewide stylesheet; `js/lib/broker-tunnel.js` is
  the reusable, zero-dependency broker connection module.
- **Each demo lives in its own folder under `demos/`** with its own
  `index.html`, `css/`, and `js/`. A demo may import shared code from the root
  `js/` (e.g. `../../../js/lib/broker-tunnel.js`).
- **`demos/DemoPlaceholder.html`** is the stand-in linked from the launcher
  for demos that are not packaged yet. It reads `?slot=<name>` to label itself.

## Bundled demos

- **`demos/provider-tunnel/`**, hosts an MCP server (official
  `@modelcontextprotocol/sdk`) and tunnels it to the broker over a WebSocket.
  Proves the broker is implementation-agnostic: a server built with the
  reference SDK tunnels through unchanged. The only broker-specific code is
  `js/lib/broker-tunnel.js`.
- **`demos/broker-explorer/`**: the client side: connects a browser MCP
  client to a broker slot (`_broker`, `_all`, or any provider), lists its
  tools and calls them live. The MCP-over-WebSocket client is isolated in
  `js/mcp-ws-client.js`. Paired with the `broker-self-mcp.html` explainer.
- **`demos/oauth-lab/`** is a complete local OAuth 2.1 environment with
  Authorization Code and PKCE, JWT and JWKS validation, audience-bound access
  tokens, hierarchical roles, explicit denies, protected MCP calls, and a live
  authorization audit. Run it with `npm run demo:oauth` from `node/`.

## Serving it

Point a `www` mount at this folder from a broker config:

```json
{
    "allowedOrigins": ["http://localhost:3000"],
    "www": {
        "open": true,
        "mounts": [{ "urlPrefix": "/", "dir": "../web" }]
    }
}
```

Mount `dir` values are resolved against the **config file's** directory. With
the config at `node/packages/broker/.mcp-broker/config.json`, `../web` resolves
to `node/packages/broker/web`, this folder.

`allowedOrigins` is not decoration. `broker-explorer` and `oauth-lab` are MCP
clients, and a page reaching `/<slot>/mcp`, `/<slot>/sse` or `/<slot>/messages`
is origin-checked even when the broker itself served that page. Omit the key and
those demos get `403 invalid_origin`. `provider-tunnel` uses only WebSockets,
which are not origin-checked, so it works either way.

Or with environment variables. From a checkout, in `node/packages/broker`:

```sh
MCP_BROKER_WWW_DIR=web MCP_BROKER_ALLOWED_ORIGINS=http://localhost:3000 npm start
```

The workspace root (`node/`) has **no** `start` script; run this from the broker
package, or use `node dist/bin.js` after `npm run build`.

From an installed package, with no checkout at all:

```sh
MCP_BROKER_WWW_DIR=node_modules/@cyanmycelium/mcp-broker/web \
MCP_BROKER_ALLOWED_ORIGINS=http://localhost:3000 \
MCP_BROKER_OPEN=1 \
npx @cyanmycelium/mcp-broker
```

`MCP_BROKER_WWW_DIR` is resolved against the working directory, not against a
config file.
