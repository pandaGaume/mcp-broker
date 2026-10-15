# Deployment plugins

The broker loads trusted Node ESM plugins without depending on any slot implementation. Installing a new plugin changes the deployment manifest and configuration, not the broker package. No packages are downloaded at broker startup.

## Configuration

```json
{
    "pluginsDirectory": "/opt/mcp-broker-plugins",
    "plugins": [
        {
            "id": "plant-api",
            "module": "@cyanmycelium/mcp-open-api/plugin",
            "provider": "plant-provider",
            "aggregate": false,
            "required": true,
            "config": {
                "manifests": ["manifests/plant.json"],
                "trustedKeys": ["keys/operator.pub.pem"],
                "allowedTargets": ["https://plant.example"],
                "secrets": { "plant": { "env": "PLANT_API_TOKEN" } }
            }
        }
    ]
}
```

`provider` names an identity in the security file's `providers` table. Its `secretEnv` must be populated under the existing security-file contract, but its secret is never passed to the plugin. Resource restrictions, subjects and protected slots continue to be enforced by the broker. Grant client capabilities through the existing security policy.

`module` is a local file path relative to the broker config, an absolute file path, or an installed package export. Bare packages resolve from `pluginsDirectory`, overridden by `MCP_BROKER_PLUGINS_DIR`; without either they resolve from the config directory. Package exports should supply a `default` resolution condition as well as `import`. HTTP URLs, automatic discovery and runtime installation are unsupported.

Plugins start sequentially after the tunnel starts. `required` defaults to true: a failure cleans the partial plugin, stops earlier plugins in reverse order and stops the CLI's tunnel. An explicitly optional plugin may fail without stopping the broker, with a diagnostic in the startup log. Cleanup failures are fatal even for optional plugins. Shutdown runs plugin disposals before tunnel shutdown and attempts all disposals if one fails. A plugin's `start` and disposals must settle; this in-process lifecycle does not forcibly terminate unresponsive plugin code.

The broker may briefly listen before required plugins finish starting. Readiness must verify expected slots, not just the TCP port.

## Plugin contract, API version 1

Types are exported from `@cyanmycelium/mcp-broker`; use type-only imports so an adapter does not add a runtime dependency on the broker.

```ts
import type { IBrokerPlugin } from "@cyanmycelium/mcp-broker";

export default {
    apiVersion: 1,
    async start(context, config) {
        // Validate config. Register each resource disposal as soon as acquired.
        // context.onCleanup(() => resource.close());
        // Install the MCP server's handler before registering its transport.
        // const authority = context.registerSlot(name, brokerEnd);
        return { async stop() { /* stop application work */ } };
    },
} satisfies IBrokerPlugin;
```

The context supplies `baseDir` (broker config directory), `log(message)`, `onCleanup(dispose)` and `registerSlot(name, transport)`. A plugin can create multiple slots. `registerSlot` returns the loopback authority handle with declaration, authorization, result and budget methods. The loader supplies the configured provider principal and aggregation choice, refuses reserved slot names, tracks transports and closes them even after partial startup failures. Reusing a live slot fails instead of replacing its owner. Publish capability declarations before reporting startup success.

Keep domain code in the plugin: the broker knows no OpenAPI manifest format, signing rules or API credentials. Configuration is passed unchanged to the plugin. Plugins execute with the broker process's privileges and can read its environment; use only operator-trusted code. The context is an API boundary, not a sandbox. Use external provider processes where process isolation is required.

## Docker

Build from the repository's `node/` directory with `docker build -f packages/broker/Dockerfile -t broker-with-plugins .`. The build uses the workspace lockfile and compiles the provider codec before the broker. The existing Dockerfile builds an optional deployment plugin layer from `plugins/`. Its checked-in manifest and lockfile are empty, so the default image remains independent of all plugins. To compose a deployment, install the desired pinned plugins into this directory and retain its lockfile, then build using the existing broker Dockerfile. For example, when the plugin version has been published:

```sh
cd node/packages/broker/plugins
npm install --save-exact @cyanmycelium/mcp-open-api@<published-version>
cd ../../..
docker build -f packages/broker/Dockerfile -t broker-with-plugins .
```

For unpublished code, `npm pack` the adapter package and copy its tarball into `plugins/`, then install that tarball into this deployment manifest. The Docker stage uses `npm ci --omit=dev` and copies the complete deployment directory to `/opt/mcp-broker-plugins`. Mount the broker config/security files, signed manifests and public keys read-only, inject secrets at runtime, and configure the modules to load. Private signing keys stay outside the image. A mounted deployment directory with its own `node_modules` is also supported; its dependencies must match the container's platform.

The Dockerfile uses Node 22 in all stages and runs the final process as an unprivileged user. Its TCP healthcheck only proves broker availability. Verify each required plugin's slot with `provider_status`, an MCP initialization, `tools/list`, an authorized read and an expected denial. If serving a designer page, mount only its public assets with `www.mounts`; plugin configuration, manifests containing sensitive metadata and keys must stay outside public mounts.
