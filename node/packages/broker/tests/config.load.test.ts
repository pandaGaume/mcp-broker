import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BrokerConfigError, loadBrokerConfig } from "../src/config";

/**
 * `loadBrokerConfig` fails closed. A config file that was designated or found
 * and cannot be used must stop the broker: the empty config it used to fall
 * back to is a broker with no authentication and no authorization.
 */
describe("loadBrokerConfig", () => {
    const originalCwd = process.cwd();
    const originalEnv = process.env["MCP_BROKER_CONFIG"];
    let dir: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "mcp-broker-config-"));
        process.chdir(dir);
        delete process.env["MCP_BROKER_CONFIG"];
    });

    afterEach(() => {
        process.chdir(originalCwd);
        if (originalEnv === undefined) delete process.env["MCP_BROKER_CONFIG"];
        else process.env["MCP_BROKER_CONFIG"] = originalEnv;
    });

    function writeDiscovered(content: string): string {
        mkdirSync(join(dir, ".mcp-broker"));
        const file = join(dir, ".mcp-broker", "config.json");
        writeFileSync(file, content);
        return file;
    }

    it("returns the empty config when discovery finds no file", () => {
        const loaded = loadBrokerConfig();
        expect(loaded).toEqual({ config: {}, baseDir: process.cwd(), sourcePath: null });
    });

    it("loads a valid discovered file", () => {
        const file = writeDiscovered('{ "port": 4000 }');
        const loaded = loadBrokerConfig();
        expect(loaded.config).toEqual({ port: 4000 });
        expect(loaded.sourcePath).toBe(file);
    });

    it("refuses a discovered file that is not valid JSON", () => {
        const file = writeDiscovered('{ "auth": { "enabled": true, } }');
        expect(() => loadBrokerConfig()).toThrow(BrokerConfigError);
        try {
            loadBrokerConfig();
        } catch (error) {
            expect((error as BrokerConfigError).sourcePath).toBe(file);
            expect((error as Error).message).toContain("refuses to start");
        }
    });

    it("refuses a file whose top-level value is not an object", () => {
        for (const content of ["[]", "null", "42", '"config"']) {
            writeFileSync(join(dir, "c.json"), content);
            expect(() => loadBrokerConfig(join(dir, "c.json")), content).toThrow(/must be a JSON object/);
        }
    });

    it("refuses an explicit path that does not exist", () => {
        expect(() => loadBrokerConfig(join(dir, "missing.json"))).toThrow(/the path given to loadBrokerConfig\(\) does not exist/);
    });

    it("refuses an MCP_BROKER_CONFIG that points nowhere", () => {
        process.env["MCP_BROKER_CONFIG"] = join(dir, "missing.json");
        expect(() => loadBrokerConfig()).toThrow(/MCP_BROKER_CONFIG does not exist/);
    });
});
