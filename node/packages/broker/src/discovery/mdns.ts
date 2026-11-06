import { randomBytes } from "crypto";
import { networkInterfaces } from "os";
import { isIPv4 } from "net";
import type { CiaoService, Responder } from "@homebridge/ciao";

/** Private CyanMycelium convention, not an IANA-registered MCP service type. */
export const BROKER_MDNS_TYPE = "_mcp-broker._tcp.local";

export interface IBrokerMdnsOptions {
    /** Explicit opt-in. Absent or false opens no multicast socket. */
    enabled?: boolean;
    /** Exact OS interface names. Required when enabled; never all interfaces implicitly. */
    interfaces?: readonly string[];
    /** Optional operator-chosen label. Defaults to an opaque per-start instance name. */
    name?: string;
    /** Optional single DNS hostname label, without .local. Defaults to the opaque instance name. */
    hostname?: string;
    /** External HTTP(S) origin and optional mount prefix, for a reverse proxy. No credentials or query. */
    publicBaseUrl?: string;
    /** Explicit permission to announce an HTTP or unauthenticated development listener. */
    allowInsecureDev?: boolean;
}

export interface IMdnsListener {
    host: string;
    port: number;
    tls: boolean;
    authenticated: boolean;
    brokerProviderEnabled: boolean;
    mcpPath: string;
}

/** Validate configuration even when disabled, so misspellings cannot silently enable a broad announcement. */
export function parseMdnsOptions(value: unknown): IBrokerMdnsOptions | undefined {
    if (value === undefined) return undefined;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("mdns must be an object");
    const raw = value as Record<string, unknown>;
    const keys = ["enabled", "interfaces", "name", "hostname", "publicBaseUrl", "allowInsecureDev"];
    if (Object.keys(raw).some((key) => !keys.includes(key))) throw new Error("mdns contains an unknown option");
    for (const key of ["enabled", "allowInsecureDev"]) if (raw[key] !== undefined && typeof raw[key] !== "boolean") throw new Error(`mdns.${key} must be boolean`);
    if (
        raw.interfaces !== undefined &&
        (!Array.isArray(raw.interfaces) ||
            raw.interfaces.length < 1 ||
            raw.interfaces.length > 8 ||
            !raw.interfaces.every((nic) => typeof nic === "string" && nic.length > 0 && nic.length <= 256))
    ) {
        throw new Error("mdns.interfaces must list 1 to 8 exact interface names");
    }
    if (raw.enabled === true && raw.interfaces === undefined) throw new Error("mdns.interfaces is required when mdns.enabled is true");
    for (const key of ["name", "hostname"])
        if (raw[key] !== undefined && (typeof raw[key] !== "string" || !/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,46}[a-zA-Z0-9])?$/.test(raw[key] as string))) {
            throw new Error(`mdns.${key} must be a DNS label of at most 48 ASCII characters`);
        }
    if (raw.publicBaseUrl !== undefined) {
        if (typeof raw.publicBaseUrl !== "string") throw new Error("mdns.publicBaseUrl must be an HTTP(S) URL");
        let url: URL;
        try {
            url = new URL(raw.publicBaseUrl);
        } catch {
            throw new Error("mdns.publicBaseUrl must be an HTTP(S) URL");
        }
        if (
            !["http:", "https:"].includes(url.protocol) ||
            url.username ||
            url.password ||
            url.search ||
            url.hash ||
            url.hostname === "0.0.0.0" ||
            url.hostname === "[::]" ||
            url.hostname === "localhost" ||
            url.hostname === "[::1]" ||
            url.hostname.startsWith("127.") ||
            url.href.length > 200
        ) {
            throw new Error("mdns.publicBaseUrl must be a reachable HTTP(S) URL without credentials, query or fragment (maximum 200 characters)");
        }
        if (!/^\/(?:[A-Za-z0-9._~-]+\/)*[A-Za-z0-9._~-]*$/.test(url.pathname)) throw new Error("mdns.publicBaseUrl has an unsupported mount prefix");
    }
    return { ...raw, ...(raw.interfaces ? { interfaces: [...new Set(raw.interfaces as string[])] } : {}) } as IBrokerMdnsOptions;
}

export function mdnsAdvertisement(options: IBrokerMdnsOptions, listener: IMdnsListener) {
    if (!listener.brokerProviderEnabled) throw new Error("mDNS requires the _broker introspection provider");
    const interfaces = networkInterfaces();
    const addresses: string[] = [];
    for (const name of options.interfaces ?? []) {
        const ipv4 = interfaces[name]?.filter((info) => info.family === "IPv4" && !info.internal && isIPv4(info.address));
        if (!ipv4?.length) throw new Error(`mdns interface "${name}" has no non-loopback IPv4 address`);
        addresses.push(...ipv4.map((info) => info.address));
    }
    if (!addresses.length) throw new Error("mdns requires explicitly selected IPv4 interfaces");
    if (!options.publicBaseUrl && !["0.0.0.0", "::", ...addresses].includes(listener.host))
        throw new Error("mDNS interfaces are not reachable through the broker bind host; configure a reachable listener or publicBaseUrl proxy");
    // An address-bound listener must not be advertised on another interface.
    if (!options.publicBaseUrl && isIPv4(listener.host) && listener.host !== "0.0.0.0" && addresses.some((ip) => ip !== listener.host))
        throw new Error("mDNS selected addresses exceed the broker bind address");
    const external = options.publicBaseUrl ? new URL(options.publicBaseUrl) : undefined;
    const scheme = external?.protocol.replace(":", "") ?? (listener.tls ? "https" : "http");
    if ((!listener.authenticated || scheme !== "https") && !options.allowInsecureDev)
        throw new Error("mDNS requires client authentication and HTTPS, or explicit mdns.allowInsecureDev for a development network");
    // HTTP routing uses /<slot>/<suffix>. clientPath is not an HTTP prefix.
    const suffix = listener.mcpPath.replace(/^\//, "");
    if (!/^[A-Za-z0-9_~-][A-Za-z0-9._~-]*$/.test(suffix)) throw new Error("mDNS requires a single routable MCP endpoint suffix");
    const entry = `/_broker/${suffix}`;
    const path = `${external?.pathname.replace(/\/$/, "") ?? ""}${entry}`;
    if (!/^\/(?:[A-Za-z0-9._~-]+\/)*[A-Za-z0-9._~-]+$/.test(path) || Buffer.byteLength(`path=${path}`) > 255)
        throw new Error("mDNS introspection path must be an absolute ASCII path of at most 250 bytes");
    const name = options.name ?? `mcp-${randomBytes(6).toString("hex")}`;
    const txt = { txtvers: "1", scheme, path, ...(external ? { origin: external.origin } : {}) };
    const port = external ? Number(external.port || (scheme === "https" ? 443 : 80)) : listener.port;
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("mDNS requires a bound TCP port");
    return { name, hostname: options.hostname ?? name, type: "mcp-broker", port, txt, restrictedAddresses: addresses, disabledIpv6: true };
}

/** Ciao handles DNS-SD probing, collisions, legacy unicast replies and goodbye records. */
export class BrokerMdnsAdvertiser {
    private _responder?: Responder;
    private _service?: CiaoService;

    async start(options: IBrokerMdnsOptions, listener: IMdnsListener): Promise<void> {
        const advertisement = mdnsAdvertisement(options, listener);
        const { getResponder } = await import("@homebridge/ciao");
        this._responder = getResponder({ interface: [...options.interfaces!], disableIpv6: true, advertiseIpv6: false });
        try {
            this._service = this._responder.createService(advertisement);
            await this._service.advertise();
        } catch (error) {
            await this.stop();
            throw error;
        }
    }

    async stop(): Promise<void> {
        const service = this._service,
            responder = this._responder;
        this._service = undefined;
        this._responder = undefined;
        try {
            await service?.destroy();
        } finally {
            await responder?.shutdown();
        }
    }
}
