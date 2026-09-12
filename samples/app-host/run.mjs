/**
 * Starts the broker as this application's host.
 *
 * Unlike ../browser-provider/run.mjs, which sets every knob as an environment
 * variable, this one sets exactly ONE (`MCP_BROKER_CONFIG`) and lets the config
 * file carry the rest. That is the shape a real deployment takes, and it is why
 * this sample keeps its settings in `.mcp-broker/config.json`.
 *
 *   node run.mjs               start and open /app/ in a browser
 *   node run.mjs --no-open     start without launching a browser
 *
 * Then, from a second terminal, drive the open page from an MCP client:
 *
 *   node client.mjs
 */
import * as path from "node:path";
import { startBroker, dirOf } from "../lib/broker-bin.mjs";
import { vendorProviderBundle } from "../lib/vendor.mjs";

const here = dirOf(import.meta.url);
const configPath = path.join(here, ".mcp-broker", "config.json");

const argv = process.argv.slice(2);
const bundle = vendorProviderBundle(path.join(here, "public", "app", "vendor"));

const env = {
    // The only variable this sample needs. Everything else, including the two
    // static mounts and the sub-path to open, lives in the config file.
    //
    // PATHS INSIDE A CONFIG FILE RESOLVE AGAINST THE CONFIG FILE'S OWN
    // DIRECTORY, not against the working directory. That is what lets
    // `.mcp-broker/` be a self-contained folder you can copy: "../public/site"
    // in the file means `<this dir>/public/site` wherever the broker is started
    // from. Env-var paths (MCP_BROKER_WWW_DIR and friends) are the opposite:
    // they resolve against the current working directory.
    MCP_BROKER_CONFIG: configPath,
};

// `www.open` in the config is the string "/app/", which the broker resolves to
// a same-origin URL and refuses to launch unless a mount actually serves that
// path. Setting the variable to "0" here overrides the file and opens nothing;
// an empty string would NOT, because the file only fills a variable that is
// unset or empty.
if (argv.includes("--no-open")) env.MCP_BROKER_OPEN = "0";

console.log();
console.log("app-host sample");
console.log("=".repeat(72));
console.log(`Config           ${configPath}`);
console.log(`Provider SDK     copied to public/app/vendor/index.js (${bundle.bytes} bytes)`);
console.log();
console.log("Two mounts, one process, one origin:");
console.log("  /       -> public/site   the landing page");
console.log("  /app    -> public/app    the application, which publishes itself as a provider");
console.log();
console.log("The equivalent without a config file, for comparison:");
console.log(`  MCP_BROKER_PROTOCOL=http MCP_BROKER_PORT=3400 \\`);
console.log(`  MCP_BROKER_WWW_DIR=public/site \\`);
console.log(`  MCP_BROKER_ALLOWED_ORIGINS=http://localhost:3400 \\`);
console.log(`  npx @cyanmycelium/mcp-broker`);
console.log(`  ...but MCP_BROKER_WWW_DIR only mounts ONE directory at "/", so the second`);
console.log(`  mount needs the config file's www.mounts array. There is no env var for it.`);
console.log();
console.log("What to do:");
console.log("  1. The browser opens at http://localhost:3400/app/ (not at /, note the sub-path).");
console.log("  2. The page publishes itself immediately. There is no Connect button.");
console.log("  3. Drive it from an MCP client:  node app-host/client.mjs");
console.log("     The number on the page changes while you watch.");
console.log("=".repeat(72));
console.log();

startBroker(env, { cwd: here });
