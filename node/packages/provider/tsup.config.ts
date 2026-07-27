import { defineConfig } from "tsup";

export default defineConfig({
    entry: {
        "index": "src/index.ts",
        // Published as its own subpath so the broker imports the wire contract
        // without pulling in the transports.
        "protocol/index": "src/protocol/index.ts",
    },
    format: ["esm"],
    dts: true,
    sourcemap: true,
    clean: true,
    target: "node20",
    outDir: "dist",
    splitting: false,
    treeshake: true,
});
