import { describe, expect, it } from "vitest";
import {
    ConfiguredCapabilityClassifier,
    DefaultSlotResourceResolver,
    RequiredCapabilityResolver,
    UNCLASSIFIED_METHOD_CAPABILITY,
    ResourcePath,
    compileAuthorizationPolicy,
    providerMayPublish,
    type IRoleDefinition,
} from "../src/index";

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
        const classifier = new RequiredCapabilityResolver(
            { diagnose: "mcp.tools.diagnose", start: "mcp.tools.operate" },
            {
                "/enterprise/site/**": {
                    start: "mcp.tools.site-operate",
                },
            }
        );
        const site = ResourcePath.parse("/enterprise/site/asset");
        const other = ResourcePath.parse("/enterprise/other/asset");
        expect(classifier.resolve({ method: "tools/call", params: { name: "start" } }, site)?.capability).toBe("mcp.tools.site-operate");
        expect(classifier.resolve({ method: "tools/call", params: { name: "start" } }, other)?.capability).toBe("mcp.tools.operate");
        expect(classifier.resolve({ method: "tools/call", params: { name: "unknown" } }, site)?.capability).toBe("mcp.tools.call");
        expect(classifier.resolve({ method: "resources/list" }, site)?.capability).toBe("mcp.resources.read");
    });

    it("classifies the MCP Skills extension methods as resource reads", () => {
        const resolver = new RequiredCapabilityResolver();
        const slot = ResourcePath.parse("/enterprise/site/asset");
        const broker = ResourcePath.parse("/_system/broker");
        for (const method of ["skills/list", "skills/get", "resources/directory/read"]) {
            expect(resolver.resolve({ method, id: 1 }, slot, "device")?.capability).toBe("mcp.resources.read");
            expect(resolver.resolve({ method, id: 1 }, broker, "_broker")?.capability).toBe("broker.providers.read");
        }
    });

    it("refuses unknown requests by default and leaves the free methods free", () => {
        const resolver = new RequiredCapabilityResolver();
        const slot = ResourcePath.parse("/enterprise/site/asset");
        // An unknown request needs a capability nothing grants by default.
        expect(resolver.resolve({ method: "tasks/get", id: 7 }, slot, "device")?.capability).toBe(UNCLASSIFIED_METHOD_CAPABILITY);
        expect(resolver.resolve({ method: "acme/custom", id: "a" }, slot, "device")?.capability).toBe(UNCLASSIFIED_METHOD_CAPABILITY);
        expect(resolver.resolve({ method: "acme/custom", id: 1 }, ResourcePath.parse("/_system/broker"), "_broker")?.capability).toBe(UNCLASSIFIED_METHOD_CAPABILITY);
        // What every session needs stays free, revoked grant or not.
        for (const method of ["initialize", "server/discover", "ping", "resources/unsubscribe"]) {
            expect(resolver.resolve({ method, id: 1 }, slot, "device")).toBeUndefined();
        }
        // Responses and unknown notifications carry nothing to authorize.
        expect(resolver.resolve({ id: 1 }, slot, "device")).toBeUndefined();
        expect(resolver.resolve({ method: "notifications/progress" }, slot, "device")).toBeUndefined();
        expect(resolver.resolve({ method: "acme/notify", id: null }, slot, "device")).toBeUndefined();
        // Known notifications stay checked: they carry provider data out.
        expect(resolver.resolve({ method: "notifications/resources/updated" }, slot, "device")?.capability).toBe("mcp.resources.read");
        expect(resolver.resolve({ method: "logging/setLevel", id: 1 }, slot, "device")?.capability).toBe("mcp.logging.configure");
    });

    it("lets the operator classify unknown methods, never the built-in ones", () => {
        const slot = ResourcePath.parse("/enterprise/site/asset");
        const resolver = new RequiredCapabilityResolver({}, {}, { "acme/custom": "acme.custom.use" });
        expect(resolver.resolve({ method: "acme/custom", id: 1 }, slot, "device")?.capability).toBe("acme.custom.use");
        expect(() => new RequiredCapabilityResolver({}, {}, { "tools/list": "acme.open" })).toThrow(/cannot be reclassified/);
        expect(() => new RequiredCapabilityResolver({}, {}, { ping: "acme.ping" })).toThrow(/cannot be reclassified/);
        expect(() => new RequiredCapabilityResolver({}, {}, { "acme/x": "bad capability" })).toThrow(/malformed/);
    });

    it("keeps the 1.13 classifier name working", () => {
        const classifier = new ConfiguredCapabilityClassifier();
        const slot = ResourcePath.parse("/enterprise/site/asset");
        expect(classifier.classify({ method: "tools/list", id: 1 }, slot)?.capability).toBe("mcp.tools.list");
        expect(classifier.classify({ method: "acme/custom", id: 1 }, slot)?.capability).toBe(UNCLASSIFIED_METHOD_CAPABILITY);
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
