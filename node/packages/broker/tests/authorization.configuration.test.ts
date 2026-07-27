import { describe, expect, it } from "vitest";
import { ConfiguredCapabilityClassifier, DefaultSlotResourceResolver, ResourcePath, compileAuthorizationPolicy, providerMayPublish, type IRoleDefinition } from "../src/index.js";

describe("slot resource resolution and capability classification", () => {
    it("separates technical slots from resources and reserves broker paths", () => {
        const resolver = new DefaultSlotResourceResolver({
            "spoony-00452": "/enterprise/site/area/line/cell/motor-7",
        });
        expect(resolver.resolve("spoony-00452")?.value).toBe("/enterprise/site/area/line/cell/motor-7");
        expect(resolver.resolve("plain-slot")?.value).toBe("/plain-slot");
        expect(resolver.resolve("_broker")?.value).toBe("/_system/broker");
        expect(resolver.resolve("..")).toBeUndefined();
        expect(resolver.resolve("_system")).toBeUndefined();
        expect(resolver.resolve("/_system/private")).toBeUndefined();
        expect(() => new DefaultSlotResourceResolver({ device: "/_system/broker" })).toThrow(/reserved/);
        expect(() => new DefaultSlotResourceResolver({ device: "/_system" })).toThrow(/reserved/);
    });

    it("uses provider-specific, global, then default tool capabilities", () => {
        const classifier = new ConfiguredCapabilityClassifier(
            { diagnose: "mcp.tools.diagnose", start: "mcp.tools.operate" },
            {
                "/enterprise/site/**": {
                    start: "mcp.tools.site-operate",
                },
            }
        );
        const site = ResourcePath.parse("/enterprise/site/asset");
        const other = ResourcePath.parse("/enterprise/other/asset");
        expect(classifier.classify({ method: "tools/call", params: { name: "start" } }, site)?.capability).toBe("mcp.tools.site-operate");
        expect(classifier.classify({ method: "tools/call", params: { name: "start" } }, other)?.capability).toBe("mcp.tools.operate");
        expect(classifier.classify({ method: "tools/call", params: { name: "unknown" } }, site)?.capability).toBe("mcp.tools.call");
        expect(classifier.classify({ method: "resources/list" }, site)?.capability).toBe("mcp.resources.read");
    });

    it("validates every policy and path input at compilation", () => {
        expect(() =>
            compileAuthorizationPolicy({
                roles: { viewer: { capabilities: ["mcp.tools.list"] } },
                assignments: [{ subject: "", role: "viewer", resource: "/enterprise/**" }],
            })
        ).toThrow(/subject/);
        expect(() =>
            compileAuthorizationPolicy({
                roles: { viewer: { capabilities: ["mcp.tools.list"] } },
                assignments: [{ subject: "user:alice", role: "viewer", resource: "/enterprise/**/asset" }],
            })
        ).toThrow();
        expect(() =>
            compileAuthorizationPolicy({
                roles: { viewer: { capabilities: ["mcp.tools.list"] } },
                slotResources: { device: "/enterprise/../secret" },
            })
        ).toThrow();
        expect(() =>
            compileAuthorizationPolicy({
                roles: {
                    invalid: {
                        capabilities: ["mcp.tools.list"],
                        resource: "/enterprise/**",
                    } as unknown as IRoleDefinition,
                },
            })
        ).toThrow(/roles contain capabilities/);
    });

    it("fails provider namespace checks safely when any allowed pattern is malformed", () => {
        const resource = ResourcePath.parse("/enterprise/site/asset");
        expect(
            providerMayPublish(
                {
                    id: "device:1",
                    allowedResources: ["/enterprise/**", "not-absolute"],
                },
                resource
            )
        ).toBe(false);
    });
});
