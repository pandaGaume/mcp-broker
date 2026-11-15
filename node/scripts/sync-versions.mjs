// Keeps the public surfaces of the repository saying the same thing as the
// sources they describe.
//
//   node scripts/sync-versions.mjs --write   rewrite the version mentions
//   node scripts/sync-versions.mjs --check   report every mismatch, exit 1 if any
//
// Versions are written: the broker version comes from its package.json, the
// libmcpb version from mcpb.h, and every place that repeats them is rewritten.
// Descriptions are only checked: docs/positioning.md holds the canonical text,
// and a surface that says something else is a mistake for a human to fix.
//
// The MCP registry entry (node/packages/broker/server.json) is one of the
// surfaces: its versions are written, its description, name and package are
// checked against docs/positioning.md and the broker's package.json.
//
// Run by the broker's `version` lifecycle script and by bump-broker-minor.mjs,
// so a release commit carries the new version everywhere, and by ci-docs.yml.

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const mode = process.argv[2];
if (mode !== "--write" && mode !== "--check") {
    console.error("usage: node scripts/sync-versions.mjs --write | --check");
    process.exit(2);
}

const path = (p) => join(root, p);
const read = (p) => readFileSync(path(p), "utf8");

const SHORT_MAX = 100;

// ── Sources of truth ────────────────────────────────────────────────────────

const brokerVersion = JSON.parse(read("node/packages/broker/package.json")).version;
const brokerMinor = brokerVersion.split(".").slice(0, 2).join(".");

const mcpbHeader = /#define MCPB_VERSION_STRING "([^"]+)"/.exec(read("c/libmcpb/include/mcpb/mcpb.h"));
if (mcpbHeader === null) throw new Error("MCPB_VERSION_STRING not found in c/libmcpb/include/mcpb/mcpb.h");
const libmcpbVersion = mcpbHeader[1];

function positioning(key) {
    const match = new RegExp(`<!-- positioning:${key} -->\\s*([\\s\\S]*?)\\s*<!-- /positioning:${key} -->`).exec(
        read("docs/positioning.md"),
    );
    if (match === null) throw new Error(`positioning:${key} block not found in docs/positioning.md`);
    return match[1].replace(/\s+/g, " ").trim();
}
const SHORT = positioning("short");
const LONG = positioning("long");

// ── Version rewrites ────────────────────────────────────────────────────────

/** Each rule: a file, a pattern whose group 2 is the version, and the value it must hold. */
const versionRules = [
    {
        file: "node/packages/broker/mcpb/manifest.json",
        what: "bundle version",
        pattern: /^(    "version": ")([^"]*)(")/m,
        value: brokerVersion,
    },
    {
        file: "node/packages/broker/server.json",
        what: "MCP registry server version",
        pattern: /^(    "version": ")([^"]*)(")/m,
        value: brokerVersion,
    },
    {
        file: "node/packages/broker/server.json",
        what: "MCP registry npm package version",
        pattern: /^(            "version": ")([^"]*)(")/m,
        value: brokerVersion,
    },
    {
        file: "README.md",
        what: "libmcpb version in the implementation status table",
        pattern: /(\| \[c\/libmcpb\/\]\(c\/libmcpb\/\) \| )([0-9][^,|]*)(,)/,
        value: libmcpbVersion,
    },
    {
        file: "docs/index.html",
        what: "JSON-LD softwareVersion",
        pattern: /("softwareVersion": ")([^"]*)(")/,
        value: brokerVersion,
    },
];
for (const file of readdirSync(path("docs")).filter((f) => f.endsWith(".html"))) {
    versionRules.push(
        {
            file: `docs/${file}`,
            what: 'data-version="broker"',
            pattern: /(<span[^>]*\bdata-version="broker"[^>]*>)([^<]*)(<\/span>)/g,
            value: `v${brokerVersion}`,
        },
        {
            file: `docs/${file}`,
            what: 'data-version="broker-minor"',
            pattern: /(<span[^>]*\bdata-version="broker-minor"[^>]*>)([^<]*)(<\/span>)/g,
            value: `v${brokerMinor}`,
        },
    );
}

const problems = [];
const pending = new Map();

for (const rule of versionRules) {
    const before = pending.get(rule.file) ?? read(rule.file);
    const required = !rule.pattern.global;
    let found = false;
    const after = before.replace(rule.pattern, (_all, head, current, tail) => {
        found = true;
        if (current !== rule.value) problems.push(`${rule.file}: ${rule.what} is "${current}", expected "${rule.value}"`);
        return `${head}${rule.value}${tail}`;
    });
    if (required && !found) problems.push(`${rule.file}: ${rule.what} not found`);
    pending.set(rule.file, after);
}

// ── Description checks ──────────────────────────────────────────────────────

if (SHORT.length > SHORT_MAX) problems.push(`docs/positioning.md: short text is ${SHORT.length} characters, at most ${SHORT_MAX}`);

function expectEqual(file, what, actual, expected) {
    if (actual === undefined) problems.push(`${file}: ${what} not found`);
    else if (actual.replace(/\s+/g, " ").trim() !== expected) problems.push(`${file}: ${what} differs from docs/positioning.md`);
}

expectEqual(
    "node/packages/broker/package.json",
    "description (long text)",
    JSON.parse(read("node/packages/broker/package.json")).description,
    LONG,
);
expectEqual(
    "node/packages/broker/mcpb/manifest.json",
    "description (short text)",
    JSON.parse(read("node/packages/broker/mcpb/manifest.json")).description,
    SHORT,
);

const brokerPackage = JSON.parse(read("node/packages/broker/package.json"));
const serverJson = JSON.parse(read("node/packages/broker/server.json"));
expectEqual("node/packages/broker/server.json", "description (short text)", serverJson.description, SHORT);
if (serverJson.name !== brokerPackage.mcpName) {
    problems.push(`node/packages/broker/server.json: name "${serverJson.name}" differs from mcpName "${brokerPackage.mcpName}" in package.json; the MCP registry refuses the publish`);
}
if (serverJson.packages?.[0]?.identifier !== brokerPackage.name) {
    problems.push(`node/packages/broker/server.json: packages[0].identifier is not "${brokerPackage.name}"`);
}

const readmeLead = /^# mcp-broker\s*\n\s*\n([^\n]+)/m.exec(read("README.md"))?.[1];
if (readmeLead === undefined) problems.push("README.md: no paragraph after the title");
else if (!readmeLead.startsWith(LONG)) problems.push("README.md: first sentence differs from the long text in docs/positioning.md");

const index = read("docs/index.html");
expectEqual("docs/index.html", '<meta name="description">', /<meta name="description" content="([^"]*)"/.exec(index)?.[1], LONG);
expectEqual("docs/index.html", "JSON-LD description", /"@type": "SoftwareSourceCode",[\s\S]*?"description": "([^"]*)"/.exec(index)?.[1], LONG);
expectEqual("docs/index.html", ".hero-sub", /<p class="hero-sub">([\s\S]*?)<\/p>/.exec(index)?.[1], LONG);

// ── Outcome ─────────────────────────────────────────────────────────────────

if (mode === "--write") {
    for (const [file, content] of pending) {
        if (content !== read(file)) {
            writeFileSync(path(file), content);
            console.log(`[sync-versions] updated ${file}`);
        }
    }
    const remaining = problems.filter((p) => !p.includes("expected \""));
    for (const p of remaining) console.error(`[sync-versions] ${p}`);
    process.exit(remaining.length === 0 ? 0 : 1);
}

for (const p of problems) console.error(`[sync-versions] ${p}`);
if (problems.length > 0) {
    console.error(`[sync-versions] ${problems.length} problem(s). Versions: run \`node node/scripts/sync-versions.mjs --write\`. Descriptions: edit the surface or docs/positioning.md.`);
    process.exit(1);
}
console.log(`[sync-versions] consistent: broker ${brokerVersion}, libmcpb ${libmcpbVersion}`);
