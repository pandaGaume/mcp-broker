import { defineConfig } from "tsup";

export default defineConfig({
    entry: {
        "index": "src/index.ts",
        // The CLI. Its shebang is the first line of the entry, which esbuild
        // preserves, so `npx @cyanmycelium/mcp-broker` keeps working.
        "bin": "src/bin.ts",
    },
    // The broker uses exactly one thing from the provider package: the tunnel
    // envelope codec, a handful of pure functions over the wire format that
    // import nothing themselves. Bundling it in rather than depending on it at
    // runtime keeps the single shared definition (both ends still compile from
    // the same source) while dropping the package from the broker's dependency
    // tree. That matters because the provider declares a peer range on
    // mcp-core: a published provider lagging a core release would otherwise
    // block installing the broker at all, over a module that never touches
    // mcp-core. Two copies of a stateless codec cost nothing, what has to agree
    // is the format on the wire, not the identity of the functions.
    noExternal: ["@cyanmycelium/mcp-broker-provider"],
    format: ["esm"],
    dts: true,
    sourcemap: true,
    clean: true,
    target: "node20",
    outDir: "dist",
    // The CLI is a superset of the library, so let them share a chunk rather
    // than ship the whole broker twice. They live in one package and are always
    // installed together, so there is nothing to gain from standalone files.
    splitting: true,
    treeshake: true,
});
