/**
 * Internal plumbing shared by the two tunnel transports.
 *
 * Three concerns live here, all of them about the same thing: a tunnel that
 * misbehaves must say so instead of going quiet.
 *
 * - {@link PendingFrames}, the bounded outbound queue that covers the window
 *   between `connect()` and `open` (and, for the multiplexed socket, the whole
 *   reconnect back-off). Without it every frame written in that window is
 *   discarded with no error and no log, and the peer simply never answers.
 * - {@link ThrottledNotice}, so a mis-wired tunnel reports itself once in full
 *   rather than once per frame forever.
 * - The URL guards, which catch the single most common wiring mistake: a
 *   transport pointed at the endpoint the *other* transport speaks to.
 *
 * Nothing here is exported from the package root: it is internal to the
 * transports, which are the only things that can produce these situations.
 */

// ---------------------------------------------------------------------------
// Outbound frame queue
// ---------------------------------------------------------------------------

/**
 * How many outbound frames a transport holds while its socket is not open.
 *
 * Sized for a handshake, not for a backlog: an MCP server writes a handful of
 * frames before its transport reports open (an `initialize` result, a couple of
 * `list_changed` notifications), and anything beyond that is a symptom rather
 * than traffic worth keeping. A cap also matters because the multiplexed socket
 * queues across a reconnect back-off of up to 30 seconds, during which an
 * unbounded queue would grow without limit.
 */
export const PENDING_FRAME_LIMIT = 64;

/**
 * A bounded FIFO of frames waiting for a socket to open.
 *
 * Overflow drops the *oldest* frame, because the newest one is the one still
 * worth answering, and says so on the console: a dropped request never gets a
 * response, so the caller would otherwise wait forever on a frame nothing sent.
 */
export class PendingFrames {
    private readonly _label: string;
    private readonly _limit: number;
    private _frames: string[] = [];

    /**
     * @param label Identifies the owner in log lines, e.g. `DirectTransport ws://host/provider/x`.
     * @param limit Maximum queued frames, defaults to {@link PENDING_FRAME_LIMIT}.
     */
    constructor(label: string, limit: number = PENDING_FRAME_LIMIT) {
        this._label = label;
        this._limit = Math.max(1, limit);
    }

    /** Number of frames currently waiting. */
    get size(): number {
        return this._frames.length;
    }

    /** Queues one frame, evicting the oldest with a warning when full. */
    push(frame: string): void {
        if (this._frames.length >= this._limit) {
            const dropped = this._frames.shift();
            console.warn(
                `[mcp-provider] ${this._label}: outbound queue full at ${this._limit} frames, dropping the oldest (${describeFrame(dropped)}). ` +
                    `The socket is still connecting or reconnecting. Nothing resends a dropped frame, so a request lost here never gets a response.`
            );
        }
        this._frames.push(frame);
    }

    /** Hands back everything queued and empties the queue. */
    drain(): string[] {
        const frames = this._frames;
        this._frames = [];
        return frames;
    }

    /** Empties the queue, returning how many frames were discarded. */
    clear(): number {
        const discarded = this._frames.length;
        this._frames = [];
        return discarded;
    }
}

/**
 * Best-effort one-line description of a frame, for a log line about losing it.
 *
 * Reads through a tunnel envelope when there is one, so a multiplexed frame
 * reports the JSON-RPC method the caller recognizes rather than the wrapper.
 * Never throws: it is only ever called from an error path.
 */
export function describeFrame(frame: string | undefined): string {
    if (frame === undefined) return "an empty frame";

    let parsed: unknown;
    try {
        parsed = JSON.parse(frame);
    } catch {
        return `${frame.length} bytes that are not JSON`;
    }

    let message = parsed;
    if (typeof message === "object" && message !== null && "payload" in message) {
        message = (message as { payload: unknown }).payload;
    }
    if (typeof message !== "object" || message === null) return `${frame.length} bytes`;

    const { method, id } = message as { method?: unknown; id?: unknown };
    const methodPart = typeof method === "string" ? `method "${method}"` : "no method";
    const idPart = id === undefined ? "no id" : `id ${JSON.stringify(id)}`;
    return `${methodPart}, ${idPart}`;
}

/** How much of an offending frame a diagnostic quotes back. */
const QUOTED_FRAME_LIMIT = 200;

/**
 * Quotes a frame for a log line, shortened so one oversized message cannot fill
 * a console. The reader needs enough to recognize the shape, not the payload.
 */
export function truncate(raw: string, limit: number = QUOTED_FRAME_LIMIT): string {
    return raw.length <= limit ? raw : `${raw.slice(0, limit)}... (${raw.length} bytes total)`;
}

// ---------------------------------------------------------------------------
// Console throttling
// ---------------------------------------------------------------------------

/**
 * One in how many repeats of the same diagnostic reaches the console.
 *
 * A mis-wired tunnel does not fail once, it fails on every frame. Logging each
 * occurrence would bury the first, most useful message under thousands of
 * copies of itself, which is how a browser console becomes unreadable.
 */
export const NOTICE_SAMPLE_RATE = 50;

/**
 * Counts occurrences of one diagnostic on one socket and decides which of them
 * are logged: the first always, then one in every {@link NOTICE_SAMPLE_RATE}.
 *
 * Only console output is sampled. Callbacks such as `onError` still fire on
 * every occurrence, so nothing an application observes changes.
 */
export class ThrottledNotice {
    private readonly _sampleRate: number;
    private _count = 0;

    constructor(sampleRate: number = NOTICE_SAMPLE_RATE) {
        this._sampleRate = Math.max(1, sampleRate);
    }

    /** Occurrences reported so far, logged or suppressed. */
    get count(): number {
        return this._count;
    }

    /** Records one occurrence and answers whether it should be logged. */
    hit(): boolean {
        this._count++;
        return this._count === 1 || this._count % this._sampleRate === 0;
    }

    /**
     * Suffix naming how many occurrences the current line stands for.
     *
     * Empty on the first occurrence, so the message a reader is meant to act on
     * arrives unadorned.
     */
    suffix(): string {
        return this._count <= 1 ? "" : ` [occurrence ${this._count} on this socket, logging one in ${this._sampleRate}]`;
    }
}

// ---------------------------------------------------------------------------
// URL guards
// ---------------------------------------------------------------------------

/** The broker's default slot-scoped provider path, `/provider/<name>`. */
export const DEFAULT_PROVIDER_PATH = "/provider";

/** The broker's default shared multiplex path, on which envelopes are spoken. */
export const DEFAULT_MULTIPLEX_PATH = "/providers";

/**
 * Appended to both guards. The broker's paths are configurable
 * (`withProviderPath` / `withProvidersPath`), so the heuristic can legitimately
 * be wrong, and a warning that cannot be dismissed is a warning people learn to
 * ignore.
 */
const RECONFIGURED_HINT = "If you have reconfigured the broker's paths.provider / paths.providers, ignore this warning.";

/** Parses a WebSocket URL, or `undefined` when it is not a URL at all. */
function parseWsUrl(wsUrl: string): URL | undefined {
    try {
        // `ws:` and `wss:` are special schemes for the URL parser, so host and
        // pathname come out exactly as they would for `http:`.
        return new URL(wsUrl);
    } catch {
        return undefined;
    }
}

/**
 * The same URL with its path replaced, so a suggestion can be pasted as-is.
 *
 * Assembled by hand rather than through the `pathname` setter, which percent-
 * encodes: a suggested path carrying a `<name>` placeholder would come back as
 * `%3Cname%3E` and read as a typo.
 */
function withPath(url: URL, path: string): string {
    return `${url.protocol}//${url.host}${path}${url.search}`;
}

/**
 * Warns when a {@link DirectTransport} is aimed at the shared multiplex base.
 *
 * This is one half of the mismatch that costs an integrator a day: the broker
 * decides framing by which endpoint the socket landed on, so a plain JSON-RPC
 * frame arriving on `/providers` is not an envelope, is dropped, and nothing is
 * logged on either side.
 *
 * Warns, never throws: a false positive must not break a deployment that has
 * reconfigured its paths.
 */
export function warnIfMultiplexPath(wsUrl: string): void {
    const url = parseWsUrl(wsUrl);
    if (!url) return;

    const path = url.pathname;
    if (path !== DEFAULT_MULTIPLEX_PATH && !path.startsWith(`${DEFAULT_MULTIPLEX_PATH}/`)) return;

    console.warn(
        `[mcp-provider] DirectTransport is connecting to "${wsUrl}", whose path "${path}" is the broker's shared multiplex endpoint. ` +
            `That endpoint carries multiplex envelopes { provider, payload }, while DirectTransport writes plain JSON-RPC frames, so the broker will not route what this transport sends. ` +
            `Either point DirectTransport at the slot-scoped path "${withPath(url, `${DEFAULT_PROVIDER_PATH}/<name>`)}", or publish through MultiplexTransport.create("<name>", "${wsUrl}"). ` +
            RECONFIGURED_HINT
    );
}

/**
 * Warns when a {@link MultiplexTransport} is aimed at a slot-scoped path.
 *
 * The mirror of {@link warnIfMultiplexPath}: envelopes sent to
 * `/provider/<name>` are taken for opaque provider messages and rebroadcast to
 * clients as notifications, so the publisher waits for answers that never come.
 */
export function warnIfSlotScopedPath(wsUrl: string): void {
    const url = parseWsUrl(wsUrl);
    if (!url) return;

    const path = url.pathname;
    if (path !== DEFAULT_PROVIDER_PATH && !path.startsWith(`${DEFAULT_PROVIDER_PATH}/`)) return;

    console.warn(
        `[mcp-provider] MultiplexTransport is connecting to "${wsUrl}", whose path "${path}" is a slot-scoped provider endpoint. ` +
            `That endpoint carries plain JSON-RPC frames, while MultiplexTransport writes multiplex envelopes { provider, payload }, which the broker never unwraps, so nothing sent here is answered. ` +
            `Either publish through new DirectTransport("${wsUrl}"), or point MultiplexTransport at the shared multiplex base "${withPath(url, DEFAULT_MULTIPLEX_PATH)}". ` +
            RECONFIGURED_HINT
    );
}
