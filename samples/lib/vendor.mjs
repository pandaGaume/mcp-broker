/**
 * Copies the `@cyanmycelium/mcp-broker-provider` ESM build into a directory the
 * broker serves, so a browser page can `import` it with no bundler and no CDN.
 *
 * WHY THIS EXISTS, and why it is not a workaround:
 *
 * `@cyanmycelium/mcp-broker-provider` ships one self-contained ES module with
 * **zero import statements** (its only dependency, `@cyanmycelium/mcp-core`, is
 * type-only and therefore erased at build time). A browser can load that file
 * directly. What a browser cannot do is resolve the bare specifier
 * `"@cyanmycelium/mcp-broker-provider"` to a file inside `node_modules`.
 *
 * In a real application your bundler (Vite, webpack, esbuild, Rollup) does that
 * resolution for you and there is nothing to copy. These samples deliberately
 * have no build step, so they do the same job with two plain web features:
 * a copied file plus an `<script type="importmap">` entry. The page source
 * still reads exactly like the code you would write with a bundler:
 *
 *     import { DirectTransport } from "@cyanmycelium/mcp-broker-provider";
 *
 * The alternative, `import ... from "https://esm.sh/@cyanmycelium/..."`, is not
 * used: it would pull the last *published* version from the network rather than
 * the code in this repo, so a sample could pass against a package you are not
 * running.
 */
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";

const require = createRequire(import.meta.url);

/** Files copied out of the package's `dist/`. The map keeps stack traces readable. */
const FILES = ["index.js", "index.js.map"];

/**
 * Copies the provider package's ESM build into `<targetDir>`.
 *
 * @param {string} targetDir Directory to write into; created if missing.
 * @returns {{ file: string, bytes: number, source: string }} What was written.
 */
export function vendorProviderBundle(targetDir) {
    let entry;
    try {
        entry = require.resolve("@cyanmycelium/mcp-broker-provider");
    } catch (err) {
        throw new Error(
            `Cannot find @cyanmycelium/mcp-broker-provider. Run "npm install" in the samples/ directory first. ` + `Underlying error: ${err.message}`
        );
    }

    const distDir = path.dirname(entry);
    if (!fs.existsSync(entry)) {
        throw new Error(
            `${entry} does not exist. The provider package is linked but not built. ` +
                `Run "npm run build --workspace @cyanmycelium/mcp-broker-provider" from node/, then try again.`
        );
    }

    fs.mkdirSync(targetDir, { recursive: true });
    for (const name of FILES) {
        const from = path.join(distDir, name);
        if (fs.existsSync(from)) fs.copyFileSync(from, path.join(targetDir, name));
    }

    const written = path.join(targetDir, "index.js");
    return { file: written, bytes: fs.statSync(written).size, source: entry };
}
