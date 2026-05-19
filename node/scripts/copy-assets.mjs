/**
 * Copies non-TypeScript assets from `src/` to `dist/`.
 *
 * tsc does not copy non-`.ts` files (e.g. `.json`, `.proto`, `.txt`) to the
 * output directory. This script walks the known asset directories and mirrors
 * them under `dist/`, preserving their relative layout so runtime
 * `fileURLToPath(import.meta.url)`-based resolution keeps working.
 *
 * Usage (called from npm scripts):
 *   node scripts/copy-assets.mjs
 */

import { cpSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const assets = [
    // Broker grammar resources (loaded at runtime by broker.grammars.ts)
    "broker/grammars",
];

for (const rel of assets) {
    const src = join(root, "src", rel);
    const dst = join(root, "dist", rel);
    if (!existsSync(src)) {
        console.warn(`[copy-assets] skipping missing source: ${src}`);
        continue;
    }
    cpSync(src, dst, { recursive: true });
    console.log(`[copy-assets] copied ${rel}`);
}
