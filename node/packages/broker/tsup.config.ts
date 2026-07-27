import { defineConfig } from "tsup";

export default defineConfig({
    entry: {
        "index": "src/index.ts",
        // The CLI. Its shebang is the first line of the entry, which esbuild
        // preserves, so `npx @cyanmycelium/mcp-broker` keeps working.
        "bin": "src/bin.ts",
    },
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
