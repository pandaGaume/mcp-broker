/**
 * Starts the broker configured for this sample, in one process, and prints what
 * to do next.
 *
 * Everything here is `MCP_BROKER_*` environment variables. There is no magic and
 * no wrapper: the same four variables on a command line give the same result.
 * The equivalent shell one-liner is printed at startup so you can copy it.
 *
 *   node run.mjs                 start and open a browser
 *   node run.mjs --no-open       start without launching a browser
 *   node run.mjs --port 4000     use another port
 */
import * as path from "node:path";
import { startBroker, dirOf } from "../lib/broker-bin.mjs";
import { bundle } from "./prepare.mjs";

const here = dirOf(import.meta.url);
const publicDir = path.join(here, "public");

const argv = process.argv.slice(2);
const portIndex = argv.indexOf("--port");
const port = portIndex >= 0 ? argv[portIndex + 1] : (process.env.MCP_BROKER_PORT ?? "3000");
const open = !argv.includes("--no-open");

const origin = `http://localhost:${port}`;

const env = {
    MCP_BROKER_PORT: String(port),

    // Force plain HTTP. Without this the broker turns TLS on as soon as a cert
    // and key are configured, and a sample that half-works over https is worse
    // than one that is explicit.
    MCP_BROKER_PROTOCOL: "http",

    // Mount the page directory at "/". THE PATH IS RESOLVED AGAINST THE CURRENT
    // WORKING DIRECTORY, so an absolute path is passed here and the sample works
    // from anywhere. In a deployment installed from npm the equivalent value is
    // the package's own web directory, e.g.
    //   MCP_BROKER_WWW_DIR=node_modules/@cyanmycelium/mcp-broker/web
    // or, more usefully, your own build output:
    //   MCP_BROKER_WWW_DIR=./dist
    MCP_BROKER_WWW_DIR: publicDir,

    // THIS IS THE LINE PEOPLE LEAVE OUT.
    //
    // Serving a page from the broker does NOT exempt that page from the browser
    // origin check on `/<slot>/mcp`, `/<slot>/sse` and `/<slot>/messages`. The
    // check compares the request's `Origin` header against this list verbatim.
    // Leave the list unset and NO browser origin passes, so the page loads, the
    // WebSocket provider connects (WebSocket upgrades are not origin-checked),
    // and only the client half fails, with 403 invalid_origin. That asymmetry is
    // what makes it confusing to diagnose from the page alone.
    //
    // Verbatim means verbatim: scheme, host and port all have to match. Both
    // spellings of loopback are listed because a browser sends whichever one is
    // in the address bar, and http://localhost:3000 is a different origin from
    // http://127.0.0.1:3000.
    MCP_BROKER_ALLOWED_ORIGINS: `http://localhost:${port},http://127.0.0.1:${port}`,
};

if (open) env.MCP_BROKER_OPEN = "1";

console.log();
console.log("browser-provider sample");
console.log("=".repeat(72));
console.log(`Page directory   ${publicDir}`);
console.log(`Provider SDK     ${bundle.source}`);
console.log(`                 copied to public/vendor/index.js (${bundle.bytes} bytes)`);
console.log();
console.log("The same thing without this script:");
console.log(`  MCP_BROKER_PROTOCOL=http \\`);
console.log(`  MCP_BROKER_PORT=${port} \\`);
console.log(`  MCP_BROKER_WWW_DIR="${publicDir}" \\`);
console.log(`  MCP_BROKER_ALLOWED_ORIGINS="${origin},http://127.0.0.1:${port}" \\`);
console.log(`  npx @cyanmycelium/mcp-broker`);
console.log();
console.log("What to do once the banner appears:");
console.log(`  1. Open ${origin}/  (a browser opens by itself unless you passed --no-open)`);
console.log(`  2. Press "Publish". The broker logs a ws connect line for /provider/browser-demo.`);
console.log(`  3. Press the initialize + tools/list + tools/call button. The log ends with`);
console.log(`     'round trip complete'.`);
console.log(`  4. From another terminal, prove it without a browser:`);
console.log(`       npm run browser-provider:client`);
console.log("=".repeat(72));
console.log();

startBroker(env, { cwd: here });
