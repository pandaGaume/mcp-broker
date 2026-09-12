# app-host

**The broker as your application's HTTP host: it serves the app, and the app publishes itself to the broker. One process, one origin, no ordering dependency.**

## Use this when

You are shipping a web application whose live state should be reachable by an MCP client: a scene editor, a dashboard, a design tool, a simulation. The usual browser-provider deployment has two things to start in the right order (a broker, then a static or dev server for the page) and a broker URL to configure in the page. This topology removes both problems: the broker is the static server, so the page cannot exist before the broker, and the broker's address is `location.host` and therefore cannot be wrong.

Compare with `../browser-provider/`, which teaches the provider API. This one is about deployment shape.

## Run it

```bash
cd samples
npm install
node app-host/run.mjs                 # opens http://localhost:3400/app/
node app-host/run.mjs --no-open
```

Then, in a second terminal, drive the open page from an MCP client:

```bash
node app-host/client.mjs              # through the slot
node app-host/client.mjs --all        # through the _all aggregate, as an MCP host sees it
node app-host/client.mjs --diagnose   # ask the broker to report its own health
```

## What you should see when it works

The banner shows **two** mounts and the browser opens on the **sub-path**, not on `/`:

```
📁  Static mounts         http://localhost:3400/  http://localhost:3400/app/
🌍  Browser origins       http://localhost:3400, http://127.0.0.1:3400
🚀  Opening browser: http://localhost:3400/app/
```

The page publishes itself on load, with no Connect button:

```
Published on "counter-app". An MCP client can drive this page now.
```

And the client drives it, with the number on the page changing while you watch:

```
connected to http://127.0.0.1:3400/counter-app/mcp, server "counter-app"
tools/list -> read_counter, increment
before: 0
  increment(by: 3) -> 3   (watch the page)
  ...
after:  15
```

Through `--all`, the same tools carry the slot prefix, which is what an MCP host pointed at `_all` sees:

```
tools/list -> _broker-broker_info, …, counter-app-read_counter, counter-app-increment
```

The point of the counter is that the tool is not a *description* of the application's state, it **is** the application's state. Clicking the button and calling `increment` mutate the same variable.

## Two mounts, and why the config file rather than env vars

```json
"www": {
    "mounts": [
        { "urlPrefix": "/", "dir": "../public/site" },
        { "urlPrefix": "/app", "dir": "../public/app" }
    ],
    "open": "/app/"
}
```

`MCP_BROKER_WWW_DIR` mounts exactly one directory at `/`, and `MCP_BROKER_BUNDLE_DIR` mounts exactly one at `/bundle`. There is **no environment variable for an arbitrary set of mounts**; `www.mounts` is the only way. That is why this sample sets a single variable, `MCP_BROKER_CONFIG`, and keeps everything else in the file.

**Paths inside a config file resolve against the config file's own directory**, not against the working directory. `"../public/site"` in `.mcp-broker/config.json` means `<sample>/public/site` no matter where you start the broker from, which is what makes `.mcp-broker/` a folder you can copy. Env-var paths are the opposite: they resolve against the current working directory. Mixing the two rules up is the usual cause of a mount silently not appearing, and the broker does say so:

```
[mcp-broker] www.mounts entry "/app" → <abs path> skipped (directory not found).
```

At runtime the longest matching prefix wins, so `/app/index.html` is served from the `/app` mount even though `/` also matches.

## `www.open` and the sub-path

`www.open` accepts:

| Value | Meaning |
|---|---|
| `false`, absent, `""`, `"0"`, `"false"` | open nothing |
| `true`, `"1"`, `"true"` | open the root |
| `"/app/"` | open that path on this broker |
| `"http://localhost:3400/app/"` | same, written in full; must be **this broker's own origin** |

A foreign origin is refused with a message naming both origins, because a config file (or an env var inherited from a parent process) that can launch a browser at an arbitrary site is a phishing primitive with no upside. A protocol-relative `//host/x`, a non-http scheme and a bare word are refused too.

**Keep the trailing slash.** `"/app/"` and `"/app"` both resolve and both load the page, but from `/app` the browser resolves `app.js` against `/`, so the page loads and the script 404s. It is a two-character bug with a confusing symptom.

The broker refuses to open a path no mount serves, rather than launching a browser at a 404:

```
[mcp-broker] Not opening http://localhost:3400/nope: no static mount serves "/nope", so it would 404.
Mounted prefixes: "/", "/app".
```

## Still true here: the origin check applies

Being served by the broker does not exempt the page. The config lists both loopback spellings:

```json
"allowedOrigins": ["http://localhost:3400", "http://127.0.0.1:3400"]
```

Drop that and the page still loads and still publishes over WebSocket (upgrades are not origin-checked), but any `fetch` from the page to `/<slot>/mcp` comes back `403 {"error":"invalid_origin"}`. This sample does not fetch from the page, so it would appear to work: the failure would only show up the day you add an in-page client. See `../browser-provider/` for that failure demonstrated.

## Going to production with this shape

- **TLS.** Add `tls.cert` / `tls.key` (resolved against the config directory) and drop `"protocol": "http"`. The page follows `location.protocol` for `ws:` versus `wss:` already. Update `allowedOrigins` to the `https://` origin: the comparison is verbatim.
- **A real build.** Point a mount at your bundler's output directory and delete the import map from the page; your bundler resolves `@cyanmycelium/mcp-broker-provider` from `node_modules`. Nothing else changes.
- **Behind a reverse proxy.** The proxy must forward the WebSocket upgrade on `/provider/*` and `/providers`, and must not buffer `text/event-stream`. Set `auth.publicBaseUrl` to the public origin when authorization is on.
- **Do not put `stdioProvider` in this config.** It redirects stdout to the JSON-RPC stream, so a broker you start in a terminal looks dead. The stdio bridge belongs in a separate config file; see `../host-config/`.

## Failure modes

**The browser opens on `/` instead of `/app/`.** `www.open` was `true` rather than `"/app/"`, or `MCP_BROKER_OPEN=1` is set in the environment and wins over the file.

**`Not opening …: no static mount serves "…"`.** The path in `www.open` is outside every mounted prefix. The message lists the prefixes that exist.

**The page loads but `app.js` 404s.** The URL has no trailing slash, so the relative script path resolved one level too high.

**A mount is silently absent from the banner.** The directory does not exist; the broker warns with the absolute path it tried. Check the config-relative versus cwd-relative rule above.

**`Cannot find @cyanmycelium/mcp-broker-provider` at startup.** `npm install` was not run in `samples/`, or the provider package has no `dist/`.

**`EADDRINUSE` on 3400.** Change `port` in `.mcp-broker/config.json`, and remember to change `allowedOrigins` to match, since the port is part of an origin.

## Files

| File | What it is |
|---|---|
| `run.mjs` | Vendors the SDK, then starts the broker with one env var. |
| `client.mjs` | Drives the open page over Streamable HTTP; `--all` and `--diagnose` variants. |
| `.mcp-broker/config.json` | **The sample.** Two mounts, the sub-path open, the origin list, the liveness defaults written out. |
| `public/site/index.html` | Mounted at `/`. |
| `public/app/index.html`, `public/app/app.js` | Mounted at `/app`. The application, which is also the provider. |
