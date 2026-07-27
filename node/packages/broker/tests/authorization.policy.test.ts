import { describe, expect, it } from "vitest";
import { ConfigPolicyEngine, ResourcePath, type IAuthorizationSubject } from "../src/index.js";

const alice: IAuthorizationSubject = { ids: ["user:alice", "group:maintenance"] };
const resource = ResourcePath.parse("/enterprise/site/area/line/cell/asset");

function authorize(engine: ConfigPolicyEngine, capability: string, subject = alice, target = resource) {
    return engine.authorize({ subject, capability, resource: target });
}

describe("ConfigPolicyEngine roles and assignments", () => {
    it("expands direct, inherited, multiple-inheritance, and wildcard capabilities", () => {
        const engine = new ConfigPolicyEngine(
            {
                viewer: { capabilities: ["mcp.resources.read"] },
                toolLister: { capabilities: ["mcp.tools.list"] },
                maintenance: {
                    inherits: ["viewer", "toolLister"],
                    capabilities: ["mcp.tools.diagnose", "mcp.tools.diagnose"],
                },
                administrator: { capabilities: ["*"] },
            },
            [
                { id: "group-maint", subject: "group:maintenance", role: "maintenance", resource: "/enterprise/site/**" },
                { id: "alice-admin", subject: "user:alice", role: "administrator", resource: "/enterprise/admin/**" },
            ],
            []
        );

        expect(authorize(engine, "mcp.resources.read")).toMatchObject({ allowed: true, reason: "role-grant" });
        expect(authorize(engine, "mcp.tools.list").allowed).toBe(true);
        expect(authorize(engine, "mcp.tools.diagnose").allowed).toBe(true);
        expect(authorize(engine, "mcp.tools.operate").allowed).toBe(false);
        expect(authorize(engine, "anything.valid", { ids: ["user:alice"] }, ResourcePath.parse("/enterprise/admin/asset")).allowed).toBe(true);
    });

    it("supports user, group, and multiple caller identities", () => {
        const engine = new ConfigPolicyEngine(
            { viewer: { capabilities: ["mcp.resources.read"] } },
            [
                { subject: "user:bob", role: "viewer", resource: "/enterprise/site-a/**" },
                { subject: "group:energy", role: "viewer", resource: "/enterprise/site-b/**" },
            ],
            []
        );
        expect(authorize(engine, "mcp.resources.read", { ids: ["user:nobody", "group:energy"] }, ResourcePath.parse("/enterprise/site-b/asset")).allowed).toBe(true);
        expect(authorize(engine, "mcp.resources.read", { ids: ["user:bob"] }, ResourcePath.parse("/enterprise/site-b/asset")).allowed).toBe(false);
    });

    it("fails startup on unknown roles and inheritance cycles", () => {
        expect(() => new ConfigPolicyEngine({ broken: { inherits: ["missing"], capabilities: [] } }, [], [])).toThrow(/not defined/);
        expect(
            () =>
                new ConfigPolicyEngine(
                    {
                        a: { inherits: ["b"], capabilities: [] },
                        b: { inherits: ["a"], capabilities: [] },
                    },
                    [],
                    []
                )
        ).toThrow(/cycle/);
        expect(() => new ConfigPolicyEngine({}, [{ subject: "user:alice", role: "missing", resource: "/enterprise/**" }], [])).toThrow(/not defined/);
    });
});

describe("ConfigPolicyEngine explicit denies", () => {
    function engine(denyResource: string, capabilities: readonly string[] = ["mcp.tools.operate"]): ConfigPolicyEngine {
        return new ConfigPolicyEngine(
            { operator: { capabilities: ["mcp.tools.operate", "mcp.tools.diagnose"] } },
            [{ id: "allow", subject: "group:maintenance", role: "operator", resource: "/enterprise/**" }],
            [{ id: "deny", subject: "group:maintenance", capabilities, resource: denyResource }]
        );
    }

    it("lets exact deny override a parent allow", () => {
        expect(authorize(engine(resource.value), "mcp.tools.operate")).toEqual({
            allowed: false,
            reason: "explicit-deny",
            matchedPolicies: ["deny"],
        });
    });

    it("lets a parent deny override a child allow", () => {
        expect(authorize(engine("/enterprise/site/**"), "mcp.tools.operate").allowed).toBe(false);
    });

    it("lets a child deny override a parent allow without affecting siblings", () => {
        const policy = engine("/enterprise/site/area/line/cell/asset");
        expect(authorize(policy, "mcp.tools.operate").allowed).toBe(false);
        expect(authorize(policy, "mcp.tools.operate", alice, ResourcePath.parse("/enterprise/site/area/line/cell/sibling")).allowed).toBe(true);
    });

    it("supports wildcard deny and leaves unrelated capabilities allowed", () => {
        expect(authorize(engine("/enterprise/site/**", ["*"]), "mcp.tools.diagnose").allowed).toBe(false);
        expect(authorize(engine(resource.value), "mcp.tools.diagnose").allowed).toBe(true);
    });

    it("denies when no assignment matches", () => {
        expect(authorize(engine("/unrelated/**"), "mcp.unknown").reason).toBe("no-matching-grant");
    });

    it("fails startup on duplicate ids and malformed capabilities", () => {
        expect(
            () =>
                new ConfigPolicyEngine(
                    { viewer: { capabilities: ["mcp.tools.list"] } },
                    [{ id: "same", subject: "user:alice", role: "viewer", resource: "/a" }],
                    [{ id: "same", subject: "user:alice", capabilities: ["mcp.tools.list"], resource: "/a" }]
                )
        ).toThrow(/duplicate/);
        expect(() => new ConfigPolicyEngine({ viewer: { capabilities: ["not valid"] } }, [], [])).toThrow(/malformed/);
    });
});
