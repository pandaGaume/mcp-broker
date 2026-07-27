/**
 * Copies non-TypeScript assets from `src/` to `dist/`.
 *
 * A bundler emits no `.json`, and it also **flattens the module tree**: code
 * that lived in `src/broker/` ends up in a bundle at the root of `dist/`. Any
 * asset resolved at runtime from `fileURLToPath(import.meta.url)` must therefore
 * be copied next to the bundle, not to a path mirroring the source layout.
 *
 * That is why each entry below is an explicit `from → to` pair rather than a
 * single relative path: the two sides genuinely differ, and assuming otherwise
 * builds a `dist` that passes every test — they run against `src` — and fails
 * the moment the published artifact is executed.
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
    // Broker grammars, read at runtime by broker.grammars.ts relative to its own
    // module. Bundled, that module sits at the root of `dist`.
    { from: "broker/grammars", to: "grammars" },
];

for (const { from, to } of assets) {
    const src = join(root, "src", from);
    const dst = join(root, "dist", to);
    if (!existsSync(src)) {
        console.warn(`[copy-assets] skipping missing source: ${src}`);
        continue;
    }
    cpSync(src, dst, { recursive: true });
    console.log(`[copy-assets] copied ${from} -> dist/${to}`);
}
