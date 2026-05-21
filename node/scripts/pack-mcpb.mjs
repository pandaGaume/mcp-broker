/**
 * Packs the broker into an installable MCP Bundle (`.mcpb`).
 *
 * Assembles a self-contained staging directory and hands it to the official
 * `@anthropic-ai/mcpb` CLI:
 *
 *   mcpb/build/
 *   ├── manifest.json     ← mcpb/manifest.json, version synced from package.json
 *   ├── icon.png          ← mcpb/icon.png
 *   ├── .mcpbignore       ← mcpb/.mcpbignore
 *   ├── package.json      ← generated: prod dependencies only, type=module
 *   ├── node_modules/     ← npm install --omit=dev (the host does not install)
 *   └── dist/             ← compiled broker
 *
 * Requires `dist/` to exist — run `npm run build` first (the `pack:mcpb`
 * npm script chains it).
 *
 * Usage (from node/):
 *   node scripts/pack-mcpb.mjs
 */
import { cpSync, existsSync, mkdirSync, rmSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const mcpbDir = join(root, "mcpb");
const stage = join(mcpbDir, "build");

function run(command, args, cwd) {
    const result = spawnSync(command, args, { cwd, stdio: "inherit", shell: true });
    if (result.status !== 0) {
        throw new Error(`\`${command} ${args.join(" ")}\` failed with exit code ${result.status}`);
    }
}

// ── Read package metadata — single source of truth for version + deps ───────
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const { version, dependencies } = pkg;

// ── Preconditions ───────────────────────────────────────────────────────────
if (!existsSync(join(root, "dist", "bin.js"))) {
    console.error("[pack-mcpb] dist/bin.js not found — run `npm run build` first.");
    process.exit(1);
}

console.log(`[pack-mcpb] packing mcp-broker v${version}`);

// ── Fresh staging directory ─────────────────────────────────────────────────
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

// ── Compiled broker ─────────────────────────────────────────────────────────
cpSync(join(root, "dist"), join(stage, "dist"), { recursive: true });
console.log("[pack-mcpb] copied dist/");

// ── Production package.json — drives the bundled npm install ────────────────
// type=module is required so Node treats the compiled .js as ESM.
writeFileSync(
    join(stage, "package.json"),
    JSON.stringify({ name: pkg.name, version, private: true, type: "module", dependencies }, null, 4) + "\n",
);

// ── Bundle production dependencies (the host does not run npm install) ──────
console.log("[pack-mcpb] installing production dependencies …");
run("npm", ["install", "--omit=dev", "--no-audit", "--no-fund", "--no-package-lock"], stage);

// ── Manifest, version synced from package.json ──────────────────────────────
const manifest = JSON.parse(readFileSync(join(mcpbDir, "manifest.json"), "utf8"));
manifest.version = version;
writeFileSync(join(stage, "manifest.json"), JSON.stringify(manifest, null, 4) + "\n");

// ── Static assets ───────────────────────────────────────────────────────────
cpSync(join(mcpbDir, "icon.png"), join(stage, "icon.png"));
cpSync(join(mcpbDir, ".mcpbignore"), join(stage, ".mcpbignore"));

// ── Pack ────────────────────────────────────────────────────────────────────
const output = join(mcpbDir, `mcp-broker-${version}.mcpb`);
console.log("[pack-mcpb] running mcpb pack …");
run("npx", ["--yes", "@anthropic-ai/mcpb@2", "pack", stage, output]);

const sizeMb = (statSync(output).size / 1024 / 1024).toFixed(2);
console.log(`[pack-mcpb] done — ${output} (${sizeMb} MB)`);
