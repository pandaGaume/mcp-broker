/**
 * Smoke test for the samples that need no human and no browser.
 *
 *   cd samples && npm run verify
 *
 * Runs each one on a free port, checks its output for the sentence that only
 * appears on success, and reports pass or fail per sample. Exit code 0 means
 * every headless sample still works against the code currently in this repo.
 *
 * What it does NOT cover, and why:
 *   browser-provider  needs a page to press Publish in. Its headless half,
 *                     browser-provider/client.mjs, is meaningless without one.
 *   app-host          same: the counter lives in an open tab.
 *   provider-lifecycle runs, but takes ~30s and deliberately kills and restarts
 *                     a broker, which is more disruption than a smoke test wants.
 *                     Pass --full to include it.
 */
import { spawn } from "node:child_process";
import * as path from "node:path";
import { dirOf } from "./broker-bin.mjs";

const here = dirOf(import.meta.url);
const samplesDir = path.join(here, "..");
const full = process.argv.includes("--full");

/** Each entry: what to run, and the line that only appears when it worked. */
const CASES = [
    {
        id: "embedded",
        args: ["embedded/server.mjs", "--once", "--port", "3591"],
        expect: "stopped cleanly",
        timeoutMs: 30_000,
    },
    {
        id: "host-config",
        args: ["host-config/check.mjs", "--port", "3592"],
        expect: "BOTH ENTRIES WORK AGAINST ONE PROCESS.",
        timeoutMs: 45_000,
    },
    ...(full
        ? [
              {
                  id: "provider-lifecycle",
                  args: ["provider-lifecycle/run.mjs", "--port", "3593"],
                  expect: "SCENARIO COMPLETE",
                  timeoutMs: 90_000,
              },
          ]
        : []),
];

/** Runs one case and resolves with { ok, output }. */
function runCase(entry) {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, entry.args, { cwd: samplesDir, stdio: ["ignore", "pipe", "pipe"] });
        let output = "";
        child.stdout.on("data", (c) => (output += c));
        child.stderr.on("data", (c) => (output += c));

        const timer = setTimeout(() => {
            child.kill("SIGKILL");
            resolve({ ok: false, output: output + `\n[verify] timed out after ${entry.timeoutMs}ms` });
        }, entry.timeoutMs);

        child.on("exit", (code) => {
            clearTimeout(timer);
            resolve({ ok: code === 0 && output.includes(entry.expect), output, code });
        });
        child.on("error", (err) => {
            clearTimeout(timer);
            resolve({ ok: false, output: `${output}\n[verify] could not spawn: ${err.message}` });
        });
    });
}

let failed = 0;
for (const entry of CASES) {
    process.stdout.write(`${entry.id.padEnd(20)} ... `);
    const { ok, output, code } = await runCase(entry);
    if (ok) {
        console.log("ok");
    } else {
        failed += 1;
        console.log(`FAILED (exit ${code ?? "killed"}, expected to find ${JSON.stringify(entry.expect)})`);
        console.log(
            output
                .split("\n")
                .slice(-25)
                .map((l) => `    ${l}`)
                .join("\n")
        );
    }
}

if (!full) console.log(`\n(provider-lifecycle skipped; pass --full to include it. browser-provider and app-host need an open page.)`);
console.log(failed === 0 ? "\nAll headless samples pass." : `\n${failed} sample(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
