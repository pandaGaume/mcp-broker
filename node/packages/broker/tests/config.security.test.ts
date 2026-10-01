import { beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BrokerConfigError, loadSecurityConfig, type ILoadedBrokerConfig } from "../src/config";

/**
 * The security file holds what decides who may do what (auth, provider
 * identities, protected slots), apart from the topology in config.json. It
 * fails closed exactly like the config file, and never holds a secret in clear.
 */
describe("loadSecurityConfig", () => {
    let dir: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "mcp-broker-security-"));
    });

    function loaded(config: Record<string, unknown> = {}): ILoadedBrokerConfig {
        return { config, baseDir: dir, sourcePath: join(dir, "config.json") };
    }

    function write(name: string, content: unknown): string {
        const file = join(dir, name);
        writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
        return file;
    }

    const valid = {
        auth: { enabled: true, roles: {} },
        providers: [{ id: "mcp-scada", secretEnv: "SCADA_SECRET", subjects: ["service:mcp-scada"], allowedResources: ["/production/**"] }],
        authorization: { protectedSlots: { "bench-motor01": { declaredBy: "mcp-scada", publishedBy: "modbus-bench" } } },
    };

    it("returns null when nothing names a security file", () => {
        expect(loadSecurityConfig(loaded(), {})).toBeNull();
    });

    it("loads a valid file, resolves the secrets it names, and fingerprints it", () => {
        write("security.json", valid);
        const result = loadSecurityConfig(loaded({ securityFile: "security.json" }), { SCADA_SECRET: "s3cret" })!;
        expect(result.credentials).toEqual([{ id: "mcp-scada", secret: "s3cret", subjects: ["service:mcp-scada"], allowedResources: ["/production/**"] }]);
        expect(result.security.authorization?.protectedSlots).toEqual(valid.authorization.protectedSlots);
        expect(result.version).toMatch(/^[0-9a-f]{12}$/);
    });

    it("T21: changes version when the file changes", () => {
        write("security.json", valid);
        const first = loadSecurityConfig(loaded({ securityFile: "security.json" }), { SCADA_SECRET: "x" })!.version;
        write("security.json", { ...valid, auth: { enabled: true, roles: { r: { capabilities: ["scada.observe"] } } } });
        const second = loadSecurityConfig(loaded({ securityFile: "security.json" }), { SCADA_SECRET: "x" })!.version;
        expect(second).not.toBe(first);
    });

    it("T19: refuses a designated file that is missing or malformed", () => {
        expect(() => loadSecurityConfig(loaded({ securityFile: "nope.json" }), {})).toThrow(/does not exist/);
        expect(() => loadSecurityConfig(loaded(), { MCP_BROKER_SECURITY_FILE: join(dir, "nope.json") })).toThrow(/MCP_BROKER_SECURITY_FILE does not exist/);
        write("bad.json", '{ "auth": { "enabled": true, } }');
        expect(() => loadSecurityConfig(loaded({ securityFile: "bad.json" }), {})).toThrow(BrokerConfigError);
        write("array.json", "[]");
        expect(() => loadSecurityConfig(loaded({ securityFile: "array.json" }), {})).toThrow(/JSON object/);
    });

    it("T20: refuses auth in both files, and security keys in config.json", () => {
        write("security.json", valid);
        expect(() => loadSecurityConfig(loaded({ securityFile: "security.json", auth: { enabled: true } }), { SCADA_SECRET: "x" })).toThrow(/also carries "auth"/);
        expect(() => loadSecurityConfig(loaded({ authorization: { protectedSlots: {} } }), {})).toThrow(/belong in the security file/);
        expect(() => loadSecurityConfig(loaded({ providers: [] }), {})).toThrow(/belong in the security file/);
    });

    it("never accepts a secret written in clear, and refuses a secret variable that is unset", () => {
        write("clear.json", { auth: { providerSecret: "plain" }, providers: [{ id: "a", secret: "plain", secretEnv: "A" }] });
        let message = "";
        try {
            loadSecurityConfig(loaded({ securityFile: "clear.json" }), { A: "x" });
        } catch (error) {
            message = (error as Error).message;
        }
        expect(message).toContain("auth.providerSecret");
        expect(message).toContain('"secret" would put a secret in clear');

        write("unset.json", { providers: [{ id: "a", secretEnv: "NOT_SET" }] });
        expect(() => loadSecurityConfig(loaded({ securityFile: "unset.json" }), {})).toThrow(/NOT_SET is not set/);
    });
});
