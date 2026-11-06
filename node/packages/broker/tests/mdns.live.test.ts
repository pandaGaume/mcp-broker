import { createSocket } from "dgram";
import { networkInterfaces } from "os";
import { randomInt } from "crypto";
import packet from "dns-packet";
import { describe, expect, it } from "vitest";
import { WsTunnelBuilder } from "../src/ws/ws.tunnel.builder";
import { BROKER_MDNS_TYPE } from "../src/discovery/mdns";
import { McpClient } from "@cyanmycelium/mcp-core";
import { StreamableHttpTransport } from "@cyanmycelium/mcp-core/node";

// Explicit interface opt-in only. Ordinary CI must not announce an open broker on its LAN.
const nic = process.env.MCP_BROKER_TEST_MDNS_INTERFACE;
describe.skipIf(!nic)("real LAN mDNS interoperability", () => {
    it("answers the legacy unicast PTR query used by mcp-network-discovery with PTR/SRV/TXT/A", async () => {
        const address = networkInterfaces()[nic!]?.find((entry) => entry.family === "IPv4" && !entry.internal)?.address;
        expect(address).toBeTruthy();
        const broker = new WsTunnelBuilder()
            .withHost(address!)
            .withPort(0)
            .withClientPath("/not-an-http-prefix")
            .withMcpPath("/rpc")
            .withMdns({ enabled: true, interfaces: [nic!], allowInsecureDev: true })
            .build();
        const socket = createSocket("udp4");
        const id = randomInt(1, 65536);
        let client: McpClient | undefined;
        try {
            await broker.start();
            const answer = await new Promise<packet.DecodedPacket>((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error("No complete mDNS reply on the selected LAN interface")), 5000);
                socket.on("error", (error) => {
                    clearTimeout(timer);
                    reject(error);
                });
                socket.on("message", (buffer, sender) => {
                    if (sender.address !== address) return;
                    let reply: packet.DecodedPacket;
                    try {
                        reply = packet.decode(buffer);
                    } catch {
                        return;
                    }
                    if (reply.id !== id || reply.type !== "response") return;
                    const records = [...(reply.answers ?? []), ...(reply.additionals ?? [])];
                    if (!["PTR", "SRV", "TXT", "A"].every((type) => records.some((record) => record.type === type))) return;
                    clearTimeout(timer);
                    resolve(reply);
                });
                socket.bind(0, address, () => {
                    socket.setMulticastInterface(address!);
                    socket.send(packet.encode({ type: "query", id, questions: [{ name: BROKER_MDNS_TYPE, type: "PTR", class: "IN" }] }), 5353, "224.0.0.251", (error) => {
                        if (error) {
                            clearTimeout(timer);
                            reject(error);
                        }
                    });
                });
            });
            const records = [...(answer.answers ?? []), ...(answer.additionals ?? [])];
            const srv = records.find((r): r is packet.SrvAnswer => r.type === "SRV")!;
            const txt = records.find((r): r is packet.TxtAnswer => r.type === "TXT")!;
            const fields = (Array.isArray(txt.data) ? txt.data : [txt.data]).map((value) => value.toString());
            expect(srv.data.port).toBeGreaterThan(0);
            expect(fields.sort()).toEqual(["path=/_broker/rpc", "scheme=http", "txtvers=1"]);
            expect(records.some((r) => r.type === "A" && r.data === address)).toBe(true);
            client = new McpClient({ name: "mdns-live-check", version: "1" }, new StreamableHttpTransport(`http://${address}:${srv.data.port}/_broker/rpc`));
            await client.connect();
            expect((await client.callTool("broker_info", {})).isError).not.toBe(true);
        } finally {
            client?.disconnect();
            socket.close();
            await broker.stop();
        }
    }, 20_000);
});
