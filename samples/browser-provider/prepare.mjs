/**
 * Puts the two modules the page imports where the browser can fetch them.
 *
 * Run automatically by run.mjs. Safe to run on its own; it only ever writes
 * inside `public/vendor/`, which is git-ignored and regenerated every time.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { vendorProviderBundle } from "../lib/vendor.mjs";
import { dirOf } from "../lib/broker-bin.mjs";

const here = dirOf(import.meta.url);
const vendorDir = path.join(here, "public", "vendor");

// 1. The provider SDK: @cyanmycelium/mcp-broker-provider's ESM build, mapped to
//    its bare specifier by the import map in index.html.
const bundle = vendorProviderBundle(vendorDir);

// 2. The sample's own MCP client over Streamable HTTP. It is written to run
//    unchanged in Node and in a browser (it uses nothing but `fetch`), so the
//    one file in samples/lib is the single copy and cannot drift from the
//    version the Node client uses.
fs.copyFileSync(path.join(here, "..", "lib", "mcp-http-client.mjs"), path.join(vendorDir, "mcp-http-client.js"));

export { bundle };

// Only when invoked directly (`node prepare.mjs`), not when run.mjs imports it.
// Compared on the basename because a Windows `process.argv[1]` is a drive path
// and `import.meta.url` is a file:// URL, so the two never match literally.
if (path.basename(process.argv[1] ?? "") === "prepare.mjs") {
    console.log(`[sample] vendored ${bundle.bytes} bytes from ${bundle.source}`);
    console.log(`[sample] vendored samples/lib/mcp-http-client.mjs`);
    console.log(`[sample] into ${vendorDir}`);
}
