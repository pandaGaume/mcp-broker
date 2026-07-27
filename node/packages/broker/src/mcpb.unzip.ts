/**
 * Minimal ZIP extractor for `.mcpb` bundles, built on `node:zlib` only.
 *
 * A `.mcpb` bundle is an ordinary ZIP archive. The broker deliberately avoids
 * the `@anthropic-ai/mcpb` package so it stays compatible with the format
 * without being coupled to Anthropic's tooling — hence this small reader.
 *
 * Supports the two compression methods used in practice: stored (0) and
 * deflate (8). ZIP64 archives are rejected with a clear error (`.mcpb` bundles
 * are small and never need it). Any trailing bytes after the End Of Central
 * Directory record — e.g. a native PKCS#7 signature block — are ignored, since
 * extraction is driven entirely by the central directory.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { inflateRawSync } from "node:zlib";

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const LOCAL_HEADER_SIGNATURE = 0x04034b50;

/** Locates the End Of Central Directory record by scanning backwards. */
function findEocd(buf: Buffer): number {
    // The EOCD is 22 bytes plus a comment of up to 65535 bytes.
    const minPos = Math.max(0, buf.length - 22 - 0xffff);
    for (let pos = buf.length - 22; pos >= minPos; pos--) {
        if (buf.readUInt32LE(pos) === EOCD_SIGNATURE) return pos;
    }
    throw new Error("not a ZIP archive (no End Of Central Directory record found)");
}

/**
 * Extracts every entry of the `.mcpb` archive at `mcpbPath` into `destDir`.
 * `destDir` is created if missing. Entries whose resolved path would escape
 * `destDir` (zip-slip) are rejected.
 */
export function unzipMcpb(mcpbPath: string, destDir: string): void {
    const buf = readFileSync(mcpbPath);
    const eocd = findEocd(buf);

    const totalEntries = buf.readUInt16LE(eocd + 10);
    const centralDirOffset = buf.readUInt32LE(eocd + 16);
    if (centralDirOffset === 0xffffffff || totalEntries === 0xffff) {
        throw new Error("ZIP64 archives are not supported");
    }

    const absDest = resolve(destDir);
    mkdirSync(absDest, { recursive: true });

    let pos = centralDirOffset;
    for (let i = 0; i < totalEntries; i++) {
        if (buf.readUInt32LE(pos) !== CENTRAL_HEADER_SIGNATURE) {
            throw new Error(`corrupt ZIP: bad central directory header at offset ${pos}`);
        }
        const method = buf.readUInt16LE(pos + 10);
        const compressedSize = buf.readUInt32LE(pos + 20);
        const uncompressedSize = buf.readUInt32LE(pos + 24);
        const nameLen = buf.readUInt16LE(pos + 28);
        const extraLen = buf.readUInt16LE(pos + 30);
        const commentLen = buf.readUInt16LE(pos + 32);
        const localHeaderOffset = buf.readUInt32LE(pos + 42);
        const name = buf.toString("utf8", pos + 46, pos + 46 + nameLen);
        pos += 46 + nameLen + extraLen + commentLen;

        if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
            throw new Error("ZIP64 archives are not supported");
        }

        // Resolve the destination path and reject zip-slip escapes.
        const target = resolve(absDest, name);
        const rel = relative(absDest, target);
        if (rel.startsWith("..") || isAbsolute(rel)) {
            throw new Error(`unsafe ZIP entry path (zip-slip): ${name}`);
        }

        // Directory entry.
        if (name.endsWith("/")) {
            mkdirSync(target, { recursive: true });
            continue;
        }

        // Parse the local header to locate the entry's data.
        if (buf.readUInt32LE(localHeaderOffset) !== LOCAL_HEADER_SIGNATURE) {
            throw new Error(`corrupt ZIP: bad local header for "${name}"`);
        }
        const localNameLen = buf.readUInt16LE(localHeaderOffset + 26);
        const localExtraLen = buf.readUInt16LE(localHeaderOffset + 28);
        const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
        const compressed = buf.subarray(dataStart, dataStart + compressedSize);

        let data: Buffer;
        if (method === 0) {
            data = compressed;
        } else if (method === 8) {
            data = inflateRawSync(compressed);
        } else {
            throw new Error(`unsupported ZIP compression method ${method} for "${name}"`);
        }

        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, data);
    }
}
