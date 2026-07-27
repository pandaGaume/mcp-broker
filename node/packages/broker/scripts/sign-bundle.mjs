/**
 * Signs `.mcpb` bundles for the broker's bundle loader — built-ins only.
 *
 * The broker verifies a **detached signature** of a `.mcpb` file against a
 * trusted public key (see `src/mcpb.loader.ts`). This script produces that
 * signature using `node:crypto` only — no dependency on OpenSSL or the
 * `@anthropic-ai/mcpb` CLI.
 *
 * Usage (from the `node/` directory):
 *
 *   node scripts/sign-bundle.mjs keygen [outDir]
 *       Generates an Ed25519 key pair:
 *         <outDir>/mcpb-signing.key.pem  — private key (keep secret)
 *         <outDir>/mcpb-signing.pub.pem  — public key  (point `publicKey` at this)
 *       outDir defaults to the current directory.
 *
 *   node scripts/sign-bundle.mjs sign <bundle.mcpb> <privateKey.pem> [signaturePath]
 *       Writes the detached signature. signaturePath defaults to
 *       `<bundle.mcpb>.sig` — the path the broker looks for by default.
 */
import { generateKeyPairSync, createPrivateKey, sign } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const [command, ...rest] = process.argv.slice(2);

function fail(message) {
    console.error(`[sign-bundle] ${message}`);
    process.exit(1);
}

if (command === "keygen") {
    const outDir = resolve(process.cwd(), rest[0] ?? ".");
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const keyPath = resolve(outDir, "mcpb-signing.key.pem");
    const pubPath = resolve(outDir, "mcpb-signing.pub.pem");
    writeFileSync(keyPath, privateKey.export({ type: "pkcs8", format: "pem" }), "utf8");
    writeFileSync(pubPath, publicKey.export({ type: "spki", format: "pem" }), "utf8");
    console.log(`[sign-bundle] private key  →  ${keyPath}`);
    console.log(`[sign-bundle] public key   →  ${pubPath}`);
    console.log(`[sign-bundle] keep the private key secret; configure "publicKey" with the public one.`);
} else if (command === "sign") {
    const [bundleArg, keyArg, sigArg] = rest;
    if (!bundleArg || !keyArg) {
        fail("usage: sign-bundle.mjs sign <bundle.mcpb> <privateKey.pem> [signaturePath]");
    }
    const bundlePath = resolve(process.cwd(), bundleArg);
    const keyPath = resolve(process.cwd(), keyArg);
    const sigPath = sigArg ? resolve(process.cwd(), sigArg) : `${bundlePath}.sig`;

    const data = readFileSync(bundlePath);
    const privateKey = createPrivateKey(readFileSync(keyPath, "utf8"));
    // Ed25519/Ed448 sign without a separate hash algorithm; RSA/EC need one.
    const keyType = privateKey.asymmetricKeyType;
    const algorithm = keyType === "ed25519" || keyType === "ed448" ? null : "sha256";
    const signature = sign(algorithm, data, privateKey);
    writeFileSync(sigPath, signature);
    console.log(`[sign-bundle] signature (${keyType}) → ${sigPath}`);
} else {
    fail('unknown command — use "keygen" or "sign". See the file header for usage.');
}
