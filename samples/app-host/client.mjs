/**
 * Drives the open application from an MCP client.
 *
 * Run it while `node app-host/run.mjs` is up and the page at /app/ is open:
 * the number on the page changes while you watch, which is the point of hosting
 * an application behind the broker. The tool is not a description of the app's
 * state, it IS the app's state.
 *
 *   node client.mjs             through the slot itself
 *   node client.mjs --all       through the _all aggregate, as an MCP host sees it
 *   node client.mjs --diagnose  ask the broker to describe its own health
 */
import { connectMcp, toolText, waitForBroker } from "../lib/mcp-http-client.mjs";

const argv = process.argv.slice(2);
const base = "http://127.0.0.1:3400";
const SLOT = "counter-app";
const target = argv.includes("--all") ? "_all" : SLOT;

async function main() {
    await waitForBroker(base);

    if (argv.includes("--diagnose")) {
        // The broker documents and diagnoses itself. `broker_diagnose` returns
        // live per-slot state plus proven problems, each with a symptom, the
        // evidence behind it and a fix. `broker_guide` returns the integration
        // guide as Markdown. Both live on the reserved `_broker` slot, so they
        // work before any provider exists.
        const introspection = await connectMcp(base, "_broker");
        console.log(toolText(await introspection.callTool("broker_diagnose", {})));
        await introspection.close();
        return;
    }

    const client = await connectMcp(base, target);
    console.log(`connected to ${client.endpoint}, server "${client.serverInfo?.name}"`);

    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    console.log(`tools/list -> ${names.join(", ")}`);

    // Through `_all` every tool is prefixed with its slot name. Resolve the real
    // name from the catalog rather than rebuilding it: the broker caps long
    // names, hashes the overflow, and appends "-2" to break ties.
    const read = names.find((n) => n === "read_counter" || n.endsWith("-read_counter"));
    const increment = names.find((n) => n === "increment" || n.endsWith("-increment"));

    if (!read || !increment) {
        console.error(
            `\nThe counter-app tools are not on slot "${target}".\n` +
                (target === "_all"
                    ? "  The page is running but did not join the aggregate, or no page is open. Open http://localhost:3400/app/\n"
                    : "  No page is holding the slot. Open http://localhost:3400/app/ and leave the tab open.\n")
        );
        process.exitCode = 1;
        await client.close();
        return;
    }

    console.log(`\nbefore: ${toolText(await client.callTool(read))}`);
    for (let i = 0; i < 5; i++) {
        const value = toolText(await client.callTool(increment, { by: 3 }));
        console.log(`  increment(by: 3) -> ${value}   (watch the page)`);
        await new Promise((r) => setTimeout(r, 600));
    }
    console.log(`after:  ${toolText(await client.callTool(read))}`);

    await client.close();
}

main().catch((err) => {
    console.error(`\nFAILED: ${err.message}`);
    if (/did not answer|ECONNREFUSED/i.test(err.message)) {
        console.error("  Nothing is listening on http://127.0.0.1:3400. Start the sample: node app-host/run.mjs");
    }
    if (/not connected/i.test(err.message)) {
        console.error("  The broker is up but no page holds the slot. Open http://localhost:3400/app/ and leave it open.");
    }
    process.exit(1);
});
