import { describe, expect, it } from "vitest";
import { AggregateCatalog, withoutAppUi } from "../src/broker/aggregate/aggregate.catalog";

/**
 * MCP Apps through `_all`: `_all` serves no resources, so a `ui://` link would
 * be dead there. Tools keep their UI on their own slot; in `_all` they lose
 * `_meta.ui`, and app-only tools are left out.
 */
describe("MCP Apps tools in _all", () => {
    it("strips _meta.ui, keeps other _meta, and drops app-only tools", () => {
        const catalog = new AggregateCatalog();
        catalog.setProvider("plc", {
            tools: [
                { name: "read_valve", inputSchema: {}, _meta: { ui: { resourceUri: "ui://plc/valve" }, keep: 1 } },
                { name: "faceplate_only", inputSchema: {}, _meta: { ui: { resourceUri: "ui://plc/x", visibility: ["model", "app"] } } },
                { name: "nudge", inputSchema: {}, _meta: { ui: { visibility: ["app"] } } },
                { name: "plain", inputSchema: {} },
            ],
            prompts: [],
        });
        const tools = catalog.tools;
        expect(tools.map((tool) => tool.name)).toEqual(["plc-read_valve", "plc-faceplate_only", "plc-plain"]);
        expect(tools[0]["_meta"]).toEqual({ keep: 1 });
        expect("_meta" in tools[1]).toBe(false);
        expect(catalog.resolveTool("plc-nudge")).toBeUndefined();
    });

    it("leaves a tool without UI untouched", () => {
        const tool = { name: "t", _meta: { other: true } };
        expect(withoutAppUi(tool)).toBe(tool);
    });
});
