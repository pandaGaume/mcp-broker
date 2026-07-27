import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import open from "open";
import { startAuthorizationServer } from "./auth-server.mjs";

const serverDir = dirname(fileURLToPath(import.meta.url));
const nodeRoot = resolve(serverDir, "../../../..");
const configPath = resolve(serverDir, "../config.json");
const brokerEntry = join(nodeRoot, "dist", "bin.js");
const demoUrl = "http://127.0.0.1:3001/demos/oauth-lab/";
const auditEvents = [];
let shuttingDown = false;

function forwardLines(stream, destination, onLine) {
    let buffered = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
        buffered += chunk;
        let newline = buffered.indexOf("\n");
        while (newline >= 0) {
            const line = buffered.slice(0, newline);
            buffered = buffered.slice(newline + 1);
            destination.write(`${line}\n`);
            onLine?.(line);
            newline = buffered.indexOf("\n");
        }
    });
    stream.on("end", () => {
        if (buffered) {
            destination.write(buffered);
            onLine?.(buffered);
        }
    });
}

function collectAudit(line) {
    const marker = "[broker] authorization ";
    const index = line.indexOf(marker);
    if (index < 0) return;
    try {
        auditEvents.push(JSON.parse(line.slice(index + marker.length)));
        if (auditEvents.length > 200) auditEvents.splice(0, auditEvents.length - 200);
    } catch {
        // Ignore unrelated or partial log lines.
    }
}

async function waitFor(url, attempts = 80) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
        try {
            const response = await fetch(url);
            if (response.ok) return;
        } catch {
            // The child process is still starting.
        }
        await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
    throw new Error(`Timed out waiting for ${url}`);
}

const authorizationServer = await startAuthorizationServer({ auditEvents });
process.stdout.write(`[oauth-lab] authorization server: ${authorizationServer.issuer}\n`);

const broker = spawn(process.execPath, [brokerEntry], {
    cwd: nodeRoot,
    env: {
        ...process.env,
        MCP_BROKER_CONFIG: configPath,
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
});

forwardLines(broker.stdout, process.stdout);
forwardLines(broker.stderr, process.stderr, collectAudit);

async function shutdown(exitCode = 0) {
    if (shuttingDown) return;
    shuttingDown = true;
    if (broker.exitCode === null) broker.kill("SIGTERM");
    await authorizationServer.close().catch(() => undefined);
    process.exitCode = exitCode;
}

broker.on("exit", (code) => {
    if (!shuttingDown) {
        process.stderr.write(`[oauth-lab] broker exited with code ${code ?? "unknown"}\n`);
        void shutdown(code ?? 1);
    }
});

process.on("SIGINT", () => void shutdown(0));
process.on("SIGTERM", () => void shutdown(0));

try {
    await waitFor(demoUrl);
    process.stdout.write(`\n[oauth-lab] ready: ${demoUrl}\n`);
    process.stdout.write("[oauth-lab] press Ctrl+C to stop the demo\n\n");
    if (process.env["OAUTH_LAB_NO_OPEN"] !== "1" && !process.argv.includes("--no-open")) {
        await open(demoUrl);
    }
} catch (error) {
    process.stderr.write(`[oauth-lab] ${error instanceof Error ? error.message : String(error)}\n`);
    await shutdown(1);
}
