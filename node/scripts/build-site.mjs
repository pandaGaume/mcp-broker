// Builds the public website's source tree, so that an agent that cannot reach
// GitHub still finds every document it needs, as Markdown, at a stable URL.
//
//   node node/scripts/build-site.mjs --guides          write docs/guide/*.md from broker.guides.ts
//   node node/scripts/build-site.mjs --check           guides up to date, every relative link resolves
//   node node/scripts/build-site.mjs --stage <dir>     stage the Jekyll source tree into <dir>
//
// The staged tree is docs/ plus a mirror of the repository's other documents at
// their repository paths (AGENTS.md, the broker docs, c/, python/, samples/),
// then llms.txt, llms-full.txt, sitemap.xml and robots.txt. Relative links are
// rewritten for the site's layout, where docs/ is the root: a link to a mirrored
// document stays relative, a link to anything else (sources, folders) becomes a
// GitHub URL. Run with Node 22.18 or later: the guides are imported straight
// from their TypeScript source.

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const SITE = (process.env.SITE_URL ?? "https://pandagaume.github.io/mcp-broker/").replace(/\/?$/, "/");
const GITHUB = "https://github.com/pandaGaume/mcp-broker";

const abs = (p) => join(root, p);
const read = (p) => readFileSync(abs(p), "utf8");
const isDir = (p) => existsSync(abs(p)) && statSync(abs(p)).isDirectory();

// ── What is published ───────────────────────────────────────────────────────

/** Repository documents mirrored on the site at their repository path. */
const MIRRORED = [
    "AGENTS.md",
    "README.md",
    "HOWTO.md",
    "CHANGELOG.md",
    "node/packages/broker/README.md",
    "node/packages/provider/README.md",
    "c/README.md",
    "c/libmcpb/README.md",
    "c/espressif/README.md",
    "c/unreal/README.md",
    "python/README.md",
    "samples/README.md",
    "samples/index.json",
    ...listFiles("node/packages/broker/docs", ".md"),
    ...readdirSync(abs("samples"))
        .map((d) => `samples/${d}/README.md`)
        .filter((p) => existsSync(abs(p))),
];

function listFiles(dir, ext) {
    const out = [];
    for (const entry of readdirSync(abs(dir), { withFileTypes: true })) {
        const p = `${dir}/${entry.name}`;
        if (entry.isDirectory()) out.push(...listFiles(p, ext));
        else if (entry.name.endsWith(ext)) out.push(p);
    }
    return out.sort();
}

const DOCS_MD = listFiles("docs", ".md");
const PUBLISHED_MD = [...DOCS_MD, ...MIRRORED];

/** Where a repository path lives on the site: docs/ is the root, the rest keeps its path. */
const sitePath = (repoPath) => (repoPath.startsWith("docs/") ? repoPath.slice(5) : repoPath);
const isPublished = (repoPath) => repoPath.startsWith("docs/") || MIRRORED.includes(repoPath);

// ── Guides ──────────────────────────────────────────────────────────────────

async function loadGuides() {
    const module = await import(pathToFileURL(abs("node/packages/broker/src/broker/broker.guides.ts")).href);
    return module.BROKER_GUIDES;
}

function renderGuide(guide) {
    return [
        `<!-- Generated from node/packages/broker/src/broker/broker.guides.ts by node/scripts/build-site.mjs --guides. Do not edit. -->`,
        "",
        `> **${guide.title}.** ${guide.summary} This is the page a running broker serves as \`${guide.uri}\` and through \`broker_guide({ topic: "${guide.topic}" })\`; the live copy also carries that deployment's effective configuration (host, port, scheme, paths), so prefer it when you can reach a broker.`,
        "",
        guide.content.trimEnd(),
        "",
    ].join("\n");
}

async function guideFiles() {
    const guides = await loadGuides();
    return guides.map((g) => ({ path: `docs/guide/${g.topic}.md`, content: renderGuide(g), guide: g }));
}

// ── Link rewriting ──────────────────────────────────────────────────────────

const LINK = /(\]\()([^)\s]+)((?:\s+"[^"]*")?\))|(\bsrc=")([^"]+)(")|(^\[[^\]]+\]:\s*)(\S+)()/gm;

const FENCE = /(^```[\s\S]*?^```[^\n]*$)/m;

/**
 * Resolves every relative link of a published file outside fenced code blocks,
 * calls `onLink(repoTarget, trailingSlash, fragment)` and replaces the link
 * target with its result, or leaves it when the result is undefined.
 */
function mapLinks(repoPath, text, onLink) {
    return text
        .split(FENCE)
        .map((segment) => (segment.startsWith("```") ? segment : mapSegment(repoPath, segment, onLink)))
        .join("");
}

function mapSegment(repoPath, text, onLink) {
    return text.replace(LINK, (all, h1, t1, e1, h2, t2, e2, h3, t3, e3) => {
        const head = h1 ?? h2 ?? h3;
        const target = t1 ?? t2 ?? t3;
        const tail = e1 ?? e2 ?? e3 ?? "";
        if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("#") || target.startsWith("/")) return all;
        const [pathPart, fragment] = splitFragment(target);
        const repoTarget = posix.normalize(posix.join(posix.dirname(repoPath), decodeURI(pathPart)));
        const replaced = onLink(repoTarget.replace(/\/$/, ""), pathPart.endsWith("/"), fragment);
        return replaced === undefined ? all : `${head}${replaced}${tail}`;
    });
}

function splitFragment(target) {
    const i = target.indexOf("#");
    return i < 0 ? [target, ""] : [target.slice(0, i), target.slice(i)];
}

function rewriteForSite(repoPath, text) {
    const from = posix.dirname(sitePath(repoPath));
    return mapLinks(repoPath, text, (target, _trailingSlash, fragment) => {
        if (target.startsWith("..")) return undefined;
        if (isPublished(target) || (target.startsWith("docs/") && existsSync(abs(target)))) {
            return posix.relative(from, sitePath(target)) + fragment;
        }
        if (!existsSync(abs(target))) return undefined;
        // A folder whose README is published: link the README, which the site has.
        if (isDir(target) && isPublished(`${target}/README.md`)) {
            return posix.relative(from, sitePath(`${target}/README.md`)) + fragment;
        }
        return `${GITHUB}/${isDir(target) ? "tree" : "blob"}/main/${target}${fragment}`;
    });
}

function brokenLinks(repoPath, text, generated) {
    const broken = [];
    mapLinks(repoPath, text, (target) => {
        if (!existsSync(abs(target)) && !generated.has(target)) broken.push(target);
        return undefined;
    });
    return broken;
}

// ── llms.txt ────────────────────────────────────────────────────────────────

const url = (repoPath) => SITE + sitePath(repoPath);

function positioning(key) {
    const match = new RegExp(`<!-- positioning:${key} -->\\s*([\\s\\S]*?)\\s*<!-- /positioning:${key} -->`).exec(read("docs/positioning.md"));
    return match[1].replace(/\s+/g, " ").trim();
}

function llmsTxt(guides) {
    const entry = (repoPath, note) => `- [${sitePath(repoPath)}](${url(repoPath)}): ${note}`;
    return [
        "# mcp-broker",
        "",
        `> ${positioning("long")}`,
        "",
        "Every link below is Markdown. Start with the architecture page, then read only what the task needs. A running broker serves the same integration guide over MCP on its `_broker` slot (`broker_guide`, `broker_diagnose`), completed with its effective configuration; when it disagrees with these pages, it wins. Packages: `@cyanmycelium/mcp-broker` (the broker, CLI and library) and `@cyanmycelium/mcp-broker-provider` (publish an MCP server into a slot) on npm. Source: " + GITHUB + ".",
        "",
        "## Start here",
        "",
        entry("docs/agents/architecture.md", "the map: every layer, its key rule, its specification and its source"),
        entry("AGENTS.md", "for a coding agent embedding the broker: topology table, transport/path pairing rule, copy-pasteable configurations, reserved slots, symptom-to-fix table"),
        entry("docs/positioning.md", "what mcp-broker is, in one sentence and three proofs"),
        "",
        "## Integration guide",
        "",
        ...guides.map((g) => entry(`docs/guide/${g.topic}.md`, g.summary)),
        "",
        "## Specifications",
        "",
        entry("docs/architecture.md", "roles, provider and client transports, per-slot state, the reserved `_broker` and `_all` slots"),
        entry("docs/protocol.md", "wire protocol: provider framings, envelopes, the aggregate opt-in, resource subscriptions, error envelopes"),
        entry("docs/endpoints.md", "every HTTP and WebSocket endpoint and what it requires"),
        entry("docs/authorization.md", "OAuth 2.1 resource server, provider authentication, scopes, `_all` filtering"),
        entry("docs/hierarchical-authorization.md", "roles, ISA-95 aligned resource paths, inherited permissions, explicit deny, provider namespaces"),
        entry("docs/telemetry.md", "trace propagation, the `broker/telemetry` notification, OTLP export, PDU data security"),
        entry("node/packages/broker/docs/config.md", "every configuration key, default and environment variable"),
        entry("node/packages/broker/docs/execution-limits.md", "concurrency, rate and budget limits"),
        entry("node/packages/broker/docs/plugins.md", "deployment plugins, API version 1"),
        entry("node/packages/broker/docs/testing.md", "`startTestBroker()`: a real broker for tests, with callers and provider identities"),
        entry("docs/packages.md", "the npm packages and what belongs in each"),
        entry("node/packages/broker/README.md", "the broker package: CLI, environment variables, programmatic API"),
        entry("node/packages/provider/README.md", "the provider package: DirectTransport, MultiplexTransport"),
        "",
        "## Device side",
        "",
        entry("c/README.md", "the C99 side: why it stops at the transport"),
        entry("c/libmcpb/README.md", "libmcpb, the allocation-free tunnel client"),
        entry("c/espressif/README.md", "ESP-IDF component `mcpb_esp` for the ESP32"),
        entry("c/unreal/README.md", "Unreal Engine 5 plugin `McpBroker`, many slots on one socket"),
        entry("python/README.md", "Python tools, resources and prompts over libmcpb"),
        "",
        "## Samples",
        "",
        entry("samples/index.json", "machine-readable index: when to use each sample, the exact command, what success looks like"),
        entry("samples/README.md", "the runnable Node integrations"),
        "",
        "## Optional",
        "",
        entry("CHANGELOG.md", "every release"),
        entry("HOWTO.md", "in French: from open development to production, policy tests with `auth.dev`, mDNS discovery"),
        entry("docs/mhs-positioning.md", "mcp-broker and the Model Hardware Standard"),
        ...listFiles("docs/design", ".md").map((p) => entry(p, "design note, in French, not the reference")),
        "",
    ].join("\n");
}

const FULL = ["docs/agents/architecture.md", "AGENTS.md", "docs/guide/*", "docs/endpoints.md", "docs/protocol.md"];

function llmsFullTxt(files) {
    const order = FULL.flatMap((p) => (p.endsWith("/*") ? [...files.keys()].filter((k) => k.startsWith(p.slice(0, -1))).sort() : [p]));
    const parts = [`# mcp-broker, full text\n\nThe pages an agent needs most, concatenated. Index: ${SITE}llms.txt\n`];
    for (const p of order) parts.push(`\n\n---\n\n<!-- Source: ${url(p)} -->\n\n${files.get(p).trim()}\n`);
    return parts.join("");
}

// ── Modes ───────────────────────────────────────────────────────────────────

const [mode, arg] = process.argv.slice(2);

if (mode === "--guides") {
    mkdirSync(abs("docs/guide"), { recursive: true });
    for (const f of await guideFiles()) writeFileSync(abs(f.path), f.content);
    console.log("[build-site] wrote docs/guide/*.md");
} else if (mode === "--check") {
    const problems = [];
    const guides = await guideFiles();
    for (const f of guides) {
        if (!existsSync(abs(f.path)) || read(f.path) !== f.content) problems.push(`${f.path} is stale: run \`node node/scripts/build-site.mjs --guides\``);
    }
    const generated = new Set(["docs/llms.txt", "docs/llms-full.txt", ...guides.map((g) => g.path)]);
    for (const p of PUBLISHED_MD.filter((p) => p.endsWith(".md"))) {
        for (const target of brokenLinks(p, read(p), generated)) problems.push(`${p}: broken link to ${target}`);
    }
    for (const p of problems) console.error(`[build-site] ${p}`);
    if (problems.length > 0) process.exit(1);
    console.log(`[build-site] ${guides.length} guides current, ${PUBLISHED_MD.length} published documents, no broken relative link`);
} else if (mode === "--stage" && arg) {
    const out = arg;
    rmSync(out, { recursive: true, force: true });
    cpSync(abs("docs"), out, { recursive: true });

    const files = new Map();
    for (const f of await guideFiles()) files.set(f.path, f.content);
    for (const p of PUBLISHED_MD) if (!files.has(p)) files.set(p, read(p));

    for (const [p, content] of files) {
        const target = join(out, sitePath(p));
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, p.endsWith(".md") ? rewriteForSite(p, content) : content);
    }

    const guides = await loadGuides();
    writeFileSync(join(out, "llms.txt"), llmsTxt(guides));
    writeFileSync(join(out, "llms-full.txt"), llmsFullTxt(new Map([...files].map(([p, c]) => [p, p.endsWith(".md") ? rewriteForSite(p, c) : c]))));
    writeFileSync(join(out, "robots.txt"), `User-agent: *\nAllow: /\n\nSitemap: ${SITE}sitemap.xml\n`);

    const pages = [
        ...readdirSync(abs("docs")).filter((f) => f.endsWith(".html")),
        ...[...files.keys()].map(sitePath),
        "llms.txt",
        "llms-full.txt",
    ];
    const urls = [...new Set(pages)].sort().map((p) => `  <url><loc>${SITE}${p === "index.html" ? "" : encodeURI(p)}</loc></url>`);
    writeFileSync(
        join(out, "sitemap.xml"),
        `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`,
    );
    console.log(`[build-site] staged ${files.size} documents, llms.txt, llms-full.txt, sitemap.xml (${urls.length} URLs), robots.txt into ${out}`);
} else {
    console.error("usage: node node/scripts/build-site.mjs --guides | --check | --stage <dir>");
    process.exit(2);
}
