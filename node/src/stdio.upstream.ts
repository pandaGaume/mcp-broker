import { spawn, ChildProcess } from "node:child_process";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface StdioUpstreamConfig {
    /** Logical name of this provider (matched against incoming WebSocket provider names). */
    name: string;
    /** Executable to spawn (e.g. `"node"`, `"python"`, an absolute path). */
    command: string;
    /** Arguments passed to the command. */
    args?: string[];
    /** Extra environment variables merged with `process.env`. */
    env?: NodeJS.ProcessEnv;
}

// ---------------------------------------------------------------------------
// StdioUpstream
// ---------------------------------------------------------------------------

/**
 * Manages a stdio-based MCP server process.
 * JSON-RPC messages are exchanged over the child process stdin/stdout using
 * newline-delimited framing (matching the MCP SDK stdio transport).
 *
 * One instance per configured provider. The broker uses this to bridge
 * WebSocket/SSE/HTTP clients to local MCP server processes.
 */
export class StdioUpstream {
    readonly name: string;

    private readonly _config: StdioUpstreamConfig;
    private _proc: ChildProcess | null = null;
    private _buffer = "";
    private _open = false;
    private _stopped = false;

    /** Called when a complete JSON-RPC line arrives from the process stdout. */
    onMessage: ((data: string) => void) | null = null;

    /** Called when the process has started and stdin is writable. */
    onOpen: (() => void) | null = null;

    /** Called when the process exits (cleanly or otherwise). */
    onClose: (() => void) | null = null;

    /** Called on spawn or runtime errors. */
    onError: ((error: Error) => void) | null = null;

    constructor(config: StdioUpstreamConfig) {
        this.name = config.name;
        this._config = config;
    }

    get isOpen(): boolean {
        return this._open;
    }

    /** Spawns the child process and wires up stdio listeners. */
    connect(): void {
        this._stopped = false;
        const { command, args = [], env } = this._config;

        this._proc = spawn(command, args, {
            env: { ...process.env, ...env },
            stdio: ["pipe", "pipe", "inherit"],
        });

        this._proc.on("error", (err: Error) => {
            this._open = false;
            this.onError?.(new Error(`StdioUpstream "${this.name}": process error — ${err.message}`));
        });

        this._proc.on("spawn", () => {
            this._open = true;
            this.onOpen?.();
        });

        this._proc.stdout!.on("data", (chunk: Buffer) => {
            this._buffer += chunk.toString("utf8");
            let nl: number;
            while ((nl = this._buffer.indexOf("\n")) !== -1) {
                const line = this._buffer.slice(0, nl).trim();
                this._buffer = this._buffer.slice(nl + 1);
                if (line) this.onMessage?.(line);
            }
        });

        this._proc.on("close", (code) => {
            this._open = false;
            this._proc = null;
            this.onClose?.();
            if (!this._stopped) {
                this.onError?.(new Error(`StdioUpstream "${this.name}": process exited with code ${code ?? "null"}`));
            }
        });
    }

    /** Sends a JSON-RPC message to the process stdin (appends newline). */
    send(data: string): void {
        if (!this._open || !this._proc?.stdin?.writable) return;
        this._proc.stdin.write(data + "\n", "utf8");
    }

    /** Kills the child process and prevents further reconnection attempts. */
    close(): void {
        this._stopped = true;
        this._open = false;
        this._proc?.stdin?.end();
        this._proc?.kill();
        this._proc = null;
    }
}
