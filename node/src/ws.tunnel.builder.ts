import * as fs from "fs";
import { WsTunnel, type WsTunnelOptions, type StaticMount } from "./ws.tunnel.js";
import type { StdioUpstreamConfig } from "./stdio.upstream.js";
import type { RemoteUpstreamConfig } from "./remote.upstream.js";

/**
 * Fluent builder that constructs a configured {@link WsTunnel}.
 *
 * @example
 * ```typescript
 * const tunnel = new WsTunnelBuilder()
 *     .withPort(3000)
 *     .withHost("localhost")
 *     .withStaticMount("/", "/abs/path/to/www")
 *     .build();
 *
 * await tunnel.start();
 * console.log("Broker listening on ws://localhost:3000");
 * console.log("  Provider connects to: ws://localhost:3000/provider/<name>");
 * console.log("  Clients  connect to:  ws://localhost:3000/<name>");
 * ```
 */
export class WsTunnelBuilder {
    private _port = 3000;
    private _host: string | undefined;
    private _providerPath = "/provider";
    private _providersPath = "/providers";
    private _clientPath = "/";
    private _ssePath = "/sse";
    private _messagesPath = "/messages";
    private _mcpPath = "/mcp";
    private _samplesIndexPath = "/__samples_index__";
    private _staticMounts: StaticMount[] = [];
    private _stdioUpstreams: StdioUpstreamConfig[] = [];
    private _remoteUpstreams: RemoteUpstreamConfig[] = [];
    private _stdioClient: { providerName: string } | undefined = undefined;
    private _tls: { cert: string; key: string } | undefined = undefined;
    private _brokerLocalGrammarsDir: string | undefined = undefined;

    /** Sets the TCP port the broker listens on. */
    withPort(port: number): this {
        this._port = port;
        return this;
    }

    /**
     * Sets the host/interface to bind to.
     * @default "0.0.0.0" (all interfaces)
     */
    withHost(host: string): this {
        this._host = host;
        return this;
    }

    /**
     * Sets the URL path the MCP provider connects to.
     * @default "/provider"
     */
    withProviderPath(path: string): this {
        this._providerPath = path;
        return this;
    }

    /**
     * Sets the URL path for multiplexed provider connections.
     * Multiple providers share a single WebSocket using the envelope protocol.
     * @default "/providers"
     */
    withProvidersPath(path: string): this {
        this._providersPath = path;
        return this;
    }

    /**
     * Sets the URL path MCP clients connect to.
     * @default "/"
     */
    withClientPath(path: string): this {
        this._clientPath = path;
        return this;
    }

    /**
     * Sets the URL path for the SSE stream (legacy Claude transport, GET).
     * @default "/sse"
     */
    withSsePath(path: string): this {
        this._ssePath = path;
        return this;
    }

    /**
     * Sets the URL path for JSON-RPC POST requests (legacy Claude transport).
     * @default "/messages"
     */
    withMessagesPath(path: string): this {
        this._messagesPath = path;
        return this;
    }

    /**
     * Sets the URL path for the Streamable HTTP transport (MCP 2025-03-26).
     * MCP Inspector and other 2025+ clients POST JSON-RPC here.
     * @default "/mcp"
     */
    withMcpPath(path: string): this {
        this._mcpPath = path;
        return this;
    }

    /**
     * Sets the URL path that returns a `{ files: string[] }` listing of the
     * `samples/` subdirectory under the root static mount.
     * @default "/__samples_index__"
     */
    withSamplesIndexPath(path: string): this {
        this._samplesIndexPath = path;
        return this;
    }

    /**
     * Adds a static-file mount served over plain HTTP.
     * Can be called multiple times; longest-prefix match wins at runtime.
     *
     * @param urlPrefix  URL prefix that triggers this mount (e.g. `"/"` or `"/bundle"`).
     * @param dir        Absolute path to the directory to serve.
     */
    withStaticMount(urlPrefix: string, dir: string): this {
        this._staticMounts.push({ urlPrefix, dir });
        return this;
    }

    /**
     * Registers a stdio upstream provider. The broker spawns the configured
     * command and bridges its stdin/stdout as an MCP transport. Clients reach
     * it using `config.name` directly (e.g. `/<name>/mcp`).
     *
     * Can be called multiple times to register multiple providers.
     */
    withStdioUpstream(config: StdioUpstreamConfig): this {
        this._stdioUpstreams.push(config);
        return this;
    }

    /**
     * Registers a remote MCP server reached by URL. The broker connects out to
     * it and exposes it as a provider slot named `config.name`, bridging the
     * Streamable HTTP / SSE / WebSocket transport for the slot's clients.
     *
     * Can be called multiple times to register multiple servers.
     */
    withRemoteUpstream(config: RemoteUpstreamConfig): this {
        this._remoteUpstreams.push(config);
        return this;
    }

    /**
     * Enables the stdio client transport. The broker will read JSON-RPC from
     * `process.stdin` and write responses to `process.stdout`, bridging Claude
     * Desktop (or any stdio MCP client) to the named provider.
     *
     * All console output is automatically redirected to stderr in this mode so
     * stdout stays clean for the JSON-RPC stream.
     *
     * @param providerName  The provider the stdio client maps to.
     */
    withStdioClient(providerName: string): this {
        this._stdioClient = { providerName };
        return this;
    }

    /**
     * Enables HTTPS/WSS mode by supplying PEM-encoded certificate and key strings directly.
     * Call this when you already have the PEM content in memory.
     */
    withTls(cert: string, key: string): this {
        this._tls = { cert, key };
        return this;
    }

    /**
     * Enables HTTPS/WSS mode by reading the certificate and key from the given file paths.
     * Files are read synchronously at call time.
     *
     * @param certPath  Path to the PEM certificate file (e.g. `fullchain.pem`).
     * @param keyPath   Path to the PEM private-key file (e.g. `privkey.pem`).
     */
    withTlsFiles(certPath: string, keyPath: string): this {
        return this.withTls(fs.readFileSync(certPath, "utf8"), fs.readFileSync(keyPath, "utf8"));
    }

    /**
     * Sets the path to a user-supplied grammars directory whose
     * `<userAgent>/<locale>.json` files are merged on top of the packaged
     * grammars used by the embedded broker server (the reserved `_broker`
     * provider slot). Typically pointed at `.mcp-broker/grammars/`.
     */
    withBrokerLocalGrammarsDir(dir: string): this {
        this._brokerLocalGrammarsDir = dir;
        return this;
    }

    /** Constructs and returns a configured {@link WsTunnel}. */
    build(): WsTunnel {
        const options: WsTunnelOptions = {
            port: this._port,
            host: this._host,
            providerPath: this._providerPath,
            providersPath: this._providersPath,
            clientPath: this._clientPath,
            ssePath: this._ssePath,
            messagesPath: this._messagesPath,
            mcpPath: this._mcpPath,
            samplesIndexPath: this._samplesIndexPath,
            staticMounts: this._staticMounts.length > 0 ? [...this._staticMounts] : undefined,
            stdioUpstreams: this._stdioUpstreams.length > 0 ? [...this._stdioUpstreams] : undefined,
            remoteUpstreams: this._remoteUpstreams.length > 0 ? [...this._remoteUpstreams] : undefined,
            stdioClient: this._stdioClient,
            tls: this._tls,
            brokerLocalGrammarsDir: this._brokerLocalGrammarsDir,
        };
        return new WsTunnel(options);
    }
}
