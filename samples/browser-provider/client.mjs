/**
 * The client half, headless.
 *
 * Calls a tool on the slot the browser page publishes, from Node, over
 * Streamable HTTP. Run it while the page is connected:
 *
 *   npm run browser-provider          (terminal 1, then press Publish in the page)
 *   npm run browser-provider:client   (terminal 2)
 *
 * Options:
 *   --slot <name>   slot to call (default "browser-demo")
 *   --all           go through the `_all` aggregate instead of the slot itself,
 *                   which only works if the page ticked "Join the _all aggregate"
 *   --port <n>      broker port (default 3000)
 *
 * Note what this proves and what it does not: a Node client sends no `Origin`
 * header, so `allowedOrigins` never applies to it. If this script succeeds and
 * the in-page button returns 403, the origin list is the problem, not the slot.
 */
import { connectMcp, toolText, waitForBroker } from "../lib/mcp-http-client.mjs";

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const port = arg("--port", process.env.MCP_BROKER_PORT ?? "3000");
const base = `http://localhost:${port}`;
const viaAggregate = argv.includes("--all");
const slot = arg("--slot", "browser-demo");
const target = viaAggregate ? "_all" : slot;

// Through `_all`, every tool is prefixed with its slot name and a dash, so the
// page's `echo` is reachable as `browser-demo-echo`. NEVER rebuild that name by
// string concatenation in production code: the broker caps long names, hashes
// what does not fit, and appends "-2" to break ties. Read it out of tools/list.
const wantedTool = "echo";

async function main() {
    await waitForBroker(base);

    // Ask the broker what it is holding before talking to a slot. `_broker` is
    // always present, needs no provider, and its providers_list is the fastest
    // way to tell "the page is not connected" from "the tool call failed".
    const introspection = await connectMcp(base, "_broker");
    const listed = await introspection.callTool("providers_list", {});
    console.log(`[client] broker sees:\n${toolText(listed)}\n`);
    await introspection.close();

    const client = await connectMcp(base, target);
    console.log(`[client] session ${client.sessionId} on ${client.endpoint}`);
    console.log(`[client] server: ${client.serverInfo?.name ?? "(unnamed)"}`);

    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    console.log(`[client] tools/list -> ${names.join(", ") || "(empty)"}`);

    // Resolve the real name rather than assuming it.
    const chosen = names.includes(wantedTool) ? wantedTool : names.find((n) => n.endsWith(`-${wantedTool}`));

    if (!chosen) {
        console.error(
            `\n[client] No "${wantedTool}" tool on slot "${target}".\n` +
                (viaAggregate
                    ? `  The page is not in the aggregate. Tick "Join the _all aggregate" in the page before pressing Publish:\n` +
                      `  membership is decided by the registration frame sent when the socket opens, so toggling it\n` +
                      `  afterwards does nothing until you Release and Publish again.\n`
                    : `  Nothing is published on "${target}". Open ${base}/ and press Publish, then run this again.\n`)
        );
        process.exitCode = 1;
        await client.close();
        return;
    }

    const result = await client.callTool(chosen, { text: `called from Node at ${new Date().toISOString()}` });
    console.log(`[client] tools/call ${chosen} -> ${toolText(result)}`);
    console.log(`\n[client] round trip complete: Node -> broker -> browser page -> broker -> Node.`);

    await client.close();
}

main().catch((err) => {
    console.error(`\n[client] FAILED: ${err.message}`);
    if (/not connected/i.test(err.message)) {
        console.error(
            `  The slot exists but no provider holds it. Open ${base}/ and press Publish.\n` +
                `  If the page says it is published and you still see this, the page and this script disagree about\n` +
                `  the slot name: pass --slot <name>.`
        );
    }
    if (/ECONNREFUSED|did not answer/i.test(err.message)) {
        console.error(`  Nothing is listening on ${base}. Start the sample first: npm run browser-provider`);
    }
    process.exit(1);
});
