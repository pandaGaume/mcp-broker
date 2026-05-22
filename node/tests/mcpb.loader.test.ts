import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { deflateRawSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { loadMcpbBundle } from "../src/mcpb.loader.js";
import { unzipMcpb } from "../src/mcpb.unzip.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(here, "fixtures", "sample-bundle");

// ── Minimal ZIP packer (symmetric to src/mcpb.unzip.ts) ─────────────────────

function crc32(buf: Buffer): number {
    let crc = 0xffffffff;
    for (let i = 0; i < buf.length; i++) {
        crc ^= buf[i];
        for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    return (crc ^ 0xffffffff) >>> 0;
}

interface ZipEntry {
    name: string;
    data: Buffer;
    method?: 0 | 8;
}

/** Builds a ZIP archive in memory. Supports stored (0) and deflate (8). */
function packZip(entries: ZipEntry[]): Buffer {
    const locals: Buffer[] = [];
    const centrals: Buffer[] = [];
    let offset = 0;

    for (const entry of entries) {
        const method = entry.method ?? 0;
        const nameBuf = Buffer.from(entry.name, "utf8");
        const stored = method === 8 ? deflateRawSync(entry.data) : entry.data;
        const crc = crc32(entry.data);

        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(method, 8);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(stored.length, 18);
        local.writeUInt32LE(entry.data.length, 22);
        local.writeUInt16LE(nameBuf.length, 26);
        const localEntry = Buffer.concat([local, nameBuf, stored]);
        locals.push(localEntry);

        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(method, 10);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(stored.length, 20);
        central.writeUInt32LE(entry.data.length, 24);
        central.writeUInt16LE(nameBuf.length, 28);
        central.writeUInt32LE(offset, 42);
        centrals.push(Buffer.concat([central, nameBuf]));

        offset += localEntry.length;
    }

    const localPart = Buffer.concat(locals);
    const centralPart = Buffer.concat(centrals);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(centralPart.length, 12);
    eocd.writeUInt32LE(localPart.length, 16);
    return Buffer.concat([localPart, centralPart, eocd]);
}

// ── Shared fixtures ─────────────────────────────────────────────────────────

let baseDir: string;
let bundlePath: string;
let publicKeyPath: string;
let wrongKeyPath: string;

beforeAll(() => {
    baseDir = mkdtempSync(join(tmpdir(), "mcpb-loader-test-"));

    // Pack the fixture source dir into a .mcpb (a ZIP).
    const mcpbBytes = packZip([
        { name: "manifest.json", data: readFileSync(join(fixtureDir, "manifest.json")) },
        { name: "server.js", data: readFileSync(join(fixtureDir, "server.js")) },
    ]);
    bundlePath = join(baseDir, "sample.mcpb");
    writeFileSync(bundlePath, mcpbBytes);

    // Sign it with an Ed25519 key; write the trusted public key + a foreign one.
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    publicKeyPath = join(baseDir, "trusted.pub.pem");
    writeFileSync(publicKeyPath, publicKey.export({ type: "spki", format: "pem" }));
    writeFileSync(join(baseDir, "sample.mcpb.sig"), sign(null, mcpbBytes, privateKey));

    const { publicKey: foreignKey } = generateKeyPairSync("ed25519");
    wrongKeyPath = join(baseDir, "foreign.pub.pem");
    writeFileSync(wrongKeyPath, foreignKey.export({ type: "spki", format: "pem" }));
});

afterAll(() => {
    rmSync(baseDir, { recursive: true, force: true });
});

// ── loadMcpbBundle ──────────────────────────────────────────────────────────

describe("loadMcpbBundle", () => {
    it("loads a correctly signed bundle and expands manifest placeholders", async () => {
        const result = await loadMcpbBundle({ name: "sample", path: "sample.mcpb", publicKey: "trusted.pub.pem", userConfig: { greeting: "hello" } }, baseDir);
        expect(result).not.toBeNull();
        const outputDir = resolve(baseDir, ".cache", "mcpb", "sample");
        expect(result!.name).toBe("sample");
        expect(result!.command).toBe("node");
        expect(result!.args).toEqual([`${outputDir}/server.js`, "hello"]);
        expect(result!.env).toEqual({ SAMPLE_BUNDLE_DIR: outputDir });
        // The bundle was actually unpacked next to the cache dir.
        expect(existsSync(join(outputDir, "server.js"))).toBe(true);
    });

    it("defaults aggregate to true and honours an explicit false", async () => {
        const onByDefault = await loadMcpbBundle({ name: "sample", path: "sample.mcpb", publicKey: "trusted.pub.pem", userConfig: { greeting: "hi" } }, baseDir);
        expect(onByDefault!.aggregate).toBe(true);

        const optedOut = await loadMcpbBundle({ name: "sample", path: "sample.mcpb", publicKey: "trusted.pub.pem", userConfig: { greeting: "hi" }, aggregate: false }, baseDir);
        expect(optedOut!.aggregate).toBe(false);
    });

    it("refuses a bundle whose signature does not match the public key", async () => {
        const result = await loadMcpbBundle({ name: "sample", path: "sample.mcpb", publicKey: "foreign.pub.pem", userConfig: { greeting: "hi" } }, baseDir);
        expect(result).toBeNull();
    });

    it("refuses a bundle with a tampered signature", async () => {
        const tampered = readFileSync(join(baseDir, "sample.mcpb.sig"));
        tampered[0] ^= 0xff;
        writeFileSync(join(baseDir, "tampered.sig"), tampered);
        const result = await loadMcpbBundle(
            { name: "sample", path: "sample.mcpb", publicKey: "trusted.pub.pem", signature: "tampered.sig", userConfig: { greeting: "hi" } },
            baseDir
        );
        expect(result).toBeNull();
    });

    it("refuses a bundle whose signature file is missing", async () => {
        const result = await loadMcpbBundle(
            { name: "sample", path: "sample.mcpb", publicKey: "trusted.pub.pem", signature: "does-not-exist.sig", userConfig: { greeting: "hi" } },
            baseDir
        );
        expect(result).toBeNull();
    });

    it("refuses a bundle when a referenced user_config value is not supplied", async () => {
        const result = await loadMcpbBundle({ name: "sample", path: "sample.mcpb", publicKey: "trusted.pub.pem" }, baseDir);
        expect(result).toBeNull();
    });
});

// ── unzipMcpb ───────────────────────────────────────────────────────────────

describe("unzipMcpb", () => {
    it("extracts stored and deflated entries", () => {
        const dest = mkdtempSync(join(tmpdir(), "mcpb-unzip-test-"));
        try {
            const archive = join(dest, "a.zip");
            writeFileSync(
                archive,
                packZip([
                    { name: "stored.txt", data: Buffer.from("stored content"), method: 0 },
                    { name: "nested/deflated.txt", data: Buffer.from("deflated content".repeat(50)), method: 8 },
                ])
            );
            const out = join(dest, "out");
            unzipMcpb(archive, out);
            expect(readFileSync(join(out, "stored.txt"), "utf8")).toBe("stored content");
            expect(readFileSync(join(out, "nested", "deflated.txt"), "utf8")).toBe("deflated content".repeat(50));
        } finally {
            rmSync(dest, { recursive: true, force: true });
        }
    });

    it("rejects a zip-slip entry that escapes the destination", () => {
        const dest = mkdtempSync(join(tmpdir(), "mcpb-slip-test-"));
        try {
            const archive = join(dest, "evil.zip");
            writeFileSync(archive, packZip([{ name: "../escaped.txt", data: Buffer.from("pwned") }]));
            expect(() => unzipMcpb(archive, join(dest, "out"))).toThrow(/zip-slip/);
        } finally {
            rmSync(dest, { recursive: true, force: true });
        }
    });
});
