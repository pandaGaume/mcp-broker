import { beforeEach, describe, expect, it, vi } from "vitest";
import { WsTunnelBuilder } from "../src/ws/ws.tunnel.builder";
import { BROKER_MDNS_TYPE, mdnsAdvertisement, parseMdnsOptions, type IMdnsListener } from "../src/discovery/mdns";

const mocks = vi.hoisted(() => ({
    advertise: vi.fn(async () => {}),
    destroy: vi.fn(async () => {}),
    shutdown: vi.fn(async () => {}),
    createService: vi.fn(),
    getResponder: vi.fn(),
}));
vi.mock("@homebridge/ciao", () => ({ getResponder: mocks.getResponder }));
vi.mock("os", async (original) => ({
    ...(await original<typeof import("os")>()),
    networkInterfaces: () => ({
        lan0: [{ address: "192.0.2.10", family: "IPv4", internal: false }],
        lan1: [{ address: "198.51.100.10", family: "IPv4", internal: false }],
        lo: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
    }),
}));

const listener: IMdnsListener = { host: "0.0.0.0", port: 3456, tls: true, authenticated: true, brokerProviderEnabled: true, mcpPath: "/mcp" };
beforeEach(() => {
    vi.clearAllMocks();
    mocks.advertise.mockResolvedValue();
    mocks.createService.mockReturnValue({ advertise: mocks.advertise, destroy: mocks.destroy });
    mocks.getResponder.mockReturnValue({ createService: mocks.createService, shutdown: mocks.shutdown });
});

describe("opt-in mDNS configuration and endpoint convention", () => {
    it("validates opt-in, exact interface configuration and bounded labels", () => {
        expect(parseMdnsOptions(undefined)).toBeUndefined();
        expect(parseMdnsOptions({ enabled: false })).toEqual({ enabled: false });
        for (const config of [
            true,
            { enabled: "true" },
            { enabled: true },
            { enabled: true, interfaces: [] },
            { enabled: true, interfaces: [1] },
            { enabled: false, token: "secret" },
            { name: "bad.name" },
            { hostname: "x".repeat(49) },
            { publicBaseUrl: "https://user:secret@site.example" },
            { publicBaseUrl: "https://site.example?token=secret" },
        ]) {
            expect(() => parseMdnsOptions(config)).toThrow();
        }
    });
    it("publishes only the introspection path and protocol metadata", () => {
        const ad = mdnsAdvertisement({ enabled: true, interfaces: ["lan0"] }, listener);
        expect(BROKER_MDNS_TYPE).toBe("_mcp-broker._tcp.local");
        expect(ad).toMatchObject({
            type: "mcp-broker",
            port: 3456,
            restrictedAddresses: ["192.0.2.10"],
            disabledIpv6: true,
            txt: { txtvers: "1", scheme: "https", path: "/_broker/mcp" },
        });
        expect(ad.name).toMatch(/^mcp-[a-f0-9]{12}$/);
        expect(ad.hostname).toBe(ad.name);
        expect(Object.keys(ad.txt)).toEqual(["txtvers", "scheme", "path"]);
    });
    it("uses effective endpoint paths and an explicitly configured proxy origin", () => {
        const ad = mdnsAdvertisement(
            { interfaces: ["lan0"], publicBaseUrl: "https://broker.example:8443/gateway/clients/" },
            { ...listener, host: "127.0.0.1", tls: false, mcpPath: "/rpc" }
        );
        expect(ad.port).toBe(8443);
        expect(ad.txt).toEqual({ txtvers: "1", scheme: "https", path: "/gateway/clients/_broker/rpc", origin: "https://broker.example:8443" });
    });
    it("refuses open listeners, unreachable interfaces and malformed endpoints", () => {
        for (const patch of [
            { tls: false },
            { authenticated: false },
            { host: "127.0.0.1" },
            { brokerProviderEnabled: false },
            { mcpPath: "/unsafe?secret=" },
            { mcpPath: "/nested/rpc" },
        ]) {
            expect(() => mdnsAdvertisement({ interfaces: ["lan0"] }, { ...listener, ...patch })).toThrow();
        }
        for (const interfaces of [["missing"], ["lo"], []]) expect(() => mdnsAdvertisement({ interfaces }, listener)).toThrow();
        expect(() => mdnsAdvertisement({ interfaces: ["lan0", "lan1"] }, { ...listener, host: "192.0.2.10" })).toThrow();
        expect(() => mdnsAdvertisement({ interfaces: ["lan0"], allowInsecureDev: true }, { ...listener, tls: false, authenticated: false })).not.toThrow();
    });
});

describe("broker mDNS lifecycle", () => {
    it("opens no mDNS socket by default or when disabled", async () => {
        for (const mdns of [undefined, { enabled: false }]) {
            const tunnel = new WsTunnelBuilder().withHost("127.0.0.1").withPort(0);
            if (mdns) tunnel.withMdns(mdns);
            const broker = tunnel.build();
            try {
                await broker.start();
                expect(mocks.getResponder).not.toHaveBeenCalled();
            } finally {
                await broker.stop();
            }
        }
    });
    it("advertises after the listener is bound and withdraws before shutdown", async () => {
        const broker = new WsTunnelBuilder()
            .withHost("0.0.0.0")
            .withPort(0)
            .withMdns({ enabled: true, interfaces: ["lan0"], allowInsecureDev: true })
            .build();
        await broker.start();
        expect(mocks.getResponder).toHaveBeenCalledWith({ interface: ["lan0"], disableIpv6: true, advertiseIpv6: false });
        expect(mocks.createService.mock.calls[0]![0].port).toBeGreaterThan(0);
        expect(mocks.advertise).toHaveBeenCalledOnce();
        await broker.stop();
        await broker.stop();
        expect(mocks.destroy).toHaveBeenCalledOnce();
        expect(mocks.shutdown).toHaveBeenCalledOnce();
    });
    it("cleans up HTTP and discovery when advertising fails", async () => {
        mocks.advertise.mockRejectedValueOnce(new Error("advertisement failed"));
        const broker = new WsTunnelBuilder()
            .withPort(0)
            .withMdns({ enabled: true, interfaces: ["lan0"], allowInsecureDev: true })
            .build();
        await expect(broker.start()).rejects.toThrow("advertisement failed");
        expect(mocks.shutdown).toHaveBeenCalledOnce();
        expect(broker.isListening).toBe(false);
    });
});
