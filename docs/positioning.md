# Positioning

The one description of mcp-broker that every public surface repeats verbatim. Change it here first; `node/scripts/sync-versions.mjs --check` fails when a surface listed below says something else.

## Short

At most 100 characters. Used where space is counted: the GitHub repository description, the `.mcpb` manifest `description`, the MCP registry entry.

<!-- positioning:short -->
One host and one port for many MCP servers: browsers, devices, simulators and stdio tools.
<!-- /positioning:short -->

## Long

One sentence. Used as the npm `description`, the first sentence of the root README, and the website's meta description and hero line.

<!-- positioning:long -->
Puts many MCP servers behind one host and one port: browsers, ESP32 boards, Unreal Engine simulations and stdio tools publish into named slots, and any standard MCP client reaches each one, or all of them aggregated, over Streamable HTTP, SSE, WebSocket or stdio.
<!-- /positioning:long -->

## Three proofs

Say these, in this order, wherever there is room for more than one sentence.

1. **Any MCP server in, any MCP client out.** Providers arrive over a dedicated or multiplexed WebSocket, as stdio children, as remote servers the broker dials, or as signed `.mcpb` bundles. Clients use Streamable HTTP, SSE, WebSocket or stdio. The `_all` slot aggregates every provider that opted in.
2. **The same slot, from the simulator to the field.** A C99 client (`libmcpb`, 7.4 KB of flash on an ESP32) and an Unreal Engine 5 plugin publish the same slot names and tool schemas, so an agent's calls do not change when a real device replaces a simulated one.
3. **A decision point, not only a relay.** OAuth 2.1 resource server, per-provider identities, authorization declared by the provider and decided by the broker, engineering limits, audited decisions and results, W3C trace propagation.

And one property that serves all three: the broker documents and diagnoses itself over MCP, on the reserved `_broker` slot (`broker_guide`, `broker_diagnose`).

## Where each text lives

| Surface | Text | Checked |
|---|---|---|
| `node/packages/broker/package.json` `description` | long | yes |
| `node/packages/broker/mcpb/manifest.json` `description` | short | yes |
| `node/packages/broker/server.json` `description` (MCP registry) | short | yes |
| `README.md`, first sentence after the title | long | yes |
| `docs/index.html` `<meta name="description">`, `.hero-sub` and JSON-LD `description` | long | yes |
| GitHub repository description | short | no, set by hand in the repository settings |
