/**
 * The broker's self-diagnosis: live state plus the problems the broker can
 * *prove* about its own wiring, each carrying the fix.
 *
 * The point is to do the correlation an integrator would otherwise have to do
 * by hand. `provider_status` already exposes the raw counters, and the field
 * evidence is that `pendingCount` is what finally located a transport/path
 * mismatch. That inference is mechanical, so the broker should make it instead
 * of making a caller notice a number.
 *
 * Two rules govern what lands in {@link IBrokerDiagnosisProblem}:
 *
 * 1. **Evidence or nothing.** A problem is reported only when the state
 *    actually observed implies it. A check whose input is not reachable on this
 *    host is reported as skipped (see {@link IBrokerDiagnosisSkippedCheck}),
 *    never guessed at.
 * 2. **Every problem ends in an action.** `fix` must be executable by a reader
 *    that has read nothing else, so it names paths, slots and settings in full
 *    rather than pointing at a document.
 *
 * The engine is a pure function of {@link IBrokerContext}, so it is testable
 * without a socket and reusable by anything holding a context.
 */

import type { IBrokerContext, IBrokerProviderInfo } from "./broker.context";
import { BROKER_AGGREGATE_NAME, BROKER_PROVIDER_NAME, isReservedBrokerSlot } from "./broker.slots";

// ---------------------------------------------------------------------------
// Result shapes
// ---------------------------------------------------------------------------

/**
 * How much a problem matters.
 *
 * - `error`: something is broken right now and a caller is being hurt by it.
 * - `warning`: a configuration that will break under a foreseeable condition.
 * - `info`: worth knowing, nothing is wrong.
 */
export type BrokerDiagnosisSeverity = "error" | "warning" | "info";

/** Stable identifier of a diagnostic rule. Safe to branch on programmatically. */
export type BrokerDiagnosisRuleId =
    | "broker-not-started"
    | "transport-path-mismatch"
    | "provider-not-responding"
    | "upstream-not-responding"
    | "sessions-without-clients"
    | "no-providers"
    | "slot-never-connected"
    | "aggregate-disabled"
    | "aggregate-empty"
    | "aggregate-missing-live-slots"
    | "stdio-bridge-target-unreachable"
    | "self-served-page-blocked";

/** One detected problem: what is wrong, what proves it, and what to do. */
export interface IBrokerDiagnosisProblem {
    /** Stable rule id. */
    id: BrokerDiagnosisRuleId;

    severity: BrokerDiagnosisSeverity;

    /** Slot the problem is about, when it is about one. */
    slot?: string;

    /** What a caller of this broker actually observes. */
    symptom: string;

    /** The state that proves the symptom, verbatim from the live snapshot. */
    evidence: Record<string, unknown>;

    /** A concrete action, executable without reading anything else. */
    fix: string;
}

/** A rule that could not run, and why. Never a silent omission. */
export interface IBrokerDiagnosisSkippedCheck {
    id: BrokerDiagnosisRuleId;
    reason: string;
}

/** One slot as the diagnosis sees it: the live counters plus its role. */
export interface IBrokerDiagnosisSlot extends IBrokerProviderInfo {
    /** `true` for `_broker` and `_all`, which no provider may claim. */
    reserved: boolean;

    /** `true` when this slot currently contributes to `_all`. `undefined` when unknown. */
    aggregated?: boolean;
}

/** The whole answer of `broker_diagnose`. */
export interface IBrokerDiagnosis {
    /** Identity and listening configuration, enough to build a URL. */
    broker: {
        name: string;
        version: string;
        startedAt: string | null;
        uptimeSeconds: number;
        listening: string;
        tls: boolean;
        paths: IBrokerContext["paths"];
        endpoints: {
            provider: string;
            providers: string;
            client: string;
            streamableHttp: string;
        };
    };

    /** Slots in scope: every slot, or just the one the caller asked about. */
    slots: IBrokerDiagnosisSlot[];

    /** Counts, so a caller does not have to reduce the array itself. */
    summary: {
        slots: number;
        connected: number;
        providerSlots: number;
        connectedProviderSlots: number;
        pendingRequests: number;
        clients: number;
        sessions: number;
    };

    /** Membership of `_all`, when the host can report it. */
    aggregate?: { enabled: boolean; providers: readonly string[] };

    /** Detected problems, most severe first. Empty means nothing was provable. */
    problems: IBrokerDiagnosisProblem[];

    /** Rules that could not run here. */
    checksSkipped: IBrokerDiagnosisSkippedCheck[];

    /**
     * Statements that are true and worth acting on but are not faults, e.g. a
     * configuration that only breaks a topology this broker cannot see.
     */
    notes: string[];

    /** Where to read the rule behind a problem. */
    seeAlso: string[];
}

// ---------------------------------------------------------------------------
// Reusable prose
// ---------------------------------------------------------------------------

/**
 * The transport/path pairing rule, as a single fix string.
 *
 * Repeated in full inside the `fix` of every rule that can be caused by it,
 * rather than referenced: a caller acting on one problem entry must not have
 * to go read a second one.
 */
const PAIRING_FIX =
    "A provider's transport and its URL path are a matched pair. " +
    'DirectTransport speaks plain JSON-RPC and belongs on the slot-scoped path "<providerPath>/<slot>". ' +
    'MultiplexTransport speaks { provider, payload } envelopes and belongs on the shared path "<providersPath>" with no name appended. ' +
    'Note that "<providersPath>/<slot>" is neither: the router accepts it as an MCP CLIENT on a slot of that name, so nothing ever answers it. ' +
    "Move the provider to the path that matches its transport, or swap the transport to match the path it is on.";

const SEE_PUBLISH = "broker://guide/publish-provider";
const SEE_TROUBLESHOOTING = "broker://guide/troubleshooting";
const SEE_HOST_CONFIG = "broker://guide/host-config";
const SEE_CONNECT = "broker://guide/connect-client";

const SEVERITY_ORDER: Record<BrokerDiagnosisSeverity, number> = { error: 0, warning: 1, info: 2 };

/**
 * Number of long-lived sessions on one slot above which the count is worth
 * mentioning.
 *
 * One or two sessions is the normal steady state of a slot serving Streamable
 * HTTP or SSE clients, so reporting those would drown the real signal. The
 * leak this catches is monotonic accumulation, and three concurrent sessions
 * on a single slot is already unusual for a hand-driven integration.
 */
const SESSION_ACCUMULATION_THRESHOLD = 3;

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

/**
 * Runs every rule that has the evidence to run, against a live broker context.
 *
 * @param context Read-only view of the broker.
 * @param slot    Narrows the report to one slot. Problems that are not about a
 *                slot (no providers at all, a blocked self-served page) are
 *                dropped in that mode, because they are not answers to the
 *                question that was asked.
 * @returns The full diagnosis. `undefined` only when `slot` names a slot the
 *          broker has never heard of, which the caller should report as an
 *          error naming `providers_list`.
 */
export function diagnoseBroker(context: IBrokerContext, slot?: string): IBrokerDiagnosis | undefined {
    if (slot !== undefined && !context.getProviderInfo(slot)) return undefined;

    const all = context.getProvidersInfo();
    const aggregate = context.getAggregateInfo?.();
    const security = context.getSecurityInfo?.();
    const bridgeTarget = context.getStdioBridgeTarget?.();

    const aggregateMembers = aggregate ? new Set(aggregate.providers) : null;
    const slots: IBrokerDiagnosisSlot[] = all.map((info) => ({
        ...info,
        reserved: isReservedBrokerSlot(info.name),
        ...(aggregateMembers ? { aggregated: aggregateMembers.has(info.name) } : {}),
    }));

    const problems: IBrokerDiagnosisProblem[] = [];
    const checksSkipped: IBrokerDiagnosisSkippedCheck[] = [];
    const paths = context.paths;
    const scheme = context.tls ? "https" : "http";
    const wsScheme = context.tls ? "wss" : "ws";
    const authority = `${context.host && context.host !== "0.0.0.0" ? context.host : "localhost"}:${context.port}`;
    const pairingFix = PAIRING_FIX.replace(/<providerPath>/g, paths.provider).replace(/<providersPath>/g, paths.providers);

    // -- Rule: the broker never finished starting --------------------------
    if (!context.startedAt) {
        problems.push({
            id: "broker-not-started",
            severity: "error",
            symptom: "The broker reports no start time, so it is not listening and nothing can reach it.",
            evidence: { startedAt: null, uptimeSeconds: context.uptimeSeconds },
            fix: "Call start() on the tunnel (or launch the CLI) and wait for it to resolve before connecting anything. If start() already ran, it rejected: a listen failure on the configured port is the usual cause, so check that nothing else holds it.",
        });
    }

    // -- Per-slot rules ----------------------------------------------------
    const scoped = slot === undefined ? slots : slots.filter((s) => s.name === slot);

    for (const s of scoped) {
        // A slot with requests in flight and a live WebSocket provider is the
        // signature of the mismatch: the slot-scoped path registers from the
        // URL before any frame exists, so an envelope-speaking provider is
        // reported connected while it discards every plain frame the broker
        // writes. `pendingCount` is the only externally visible trace.
        if (s.connected && s.transport === "ws" && s.pendingCount > 0) {
            problems.push({
                id: "transport-path-mismatch",
                severity: "error",
                slot: s.name,
                symptom: `Slot "${s.name}" has ${s.pendingCount} request(s) in flight and a WebSocket provider that reports itself connected, yet nothing is coming back. Clients on this slot hang on initialize with no error.`,
                evidence: { transport: s.transport, connected: s.connected, pendingCount: s.pendingCount, clientCount: s.clientCount, sessionCount: s.sessionCount },
                fix:
                    `Most likely a MultiplexTransport connected to "${paths.provider}/${s.name}". ` +
                    pairingFix +
                    ` If the provider really is a DirectTransport on "${paths.provider}/${s.name}", then it received the request and did not answer: check that it is not a backgrounded browser tab, and that its MCP message handler was installed before the socket opened.`,
            });
        } else if (s.connected && s.transport === "ws-multiplex" && s.pendingCount > 0) {
            problems.push({
                id: "provider-not-responding",
                severity: "warning",
                slot: s.name,
                symptom: `Slot "${s.name}" has ${s.pendingCount} request(s) in flight on a multiplexed provider socket and no reply yet.`,
                evidence: { transport: s.transport, pendingCount: s.pendingCount, clientCount: s.clientCount, sessionCount: s.sessionCount },
                fix:
                    "The framing is right (a multiplex socket only registers a slot from a valid envelope), so the provider received the request and has not answered. " +
                    "Check that the provider's page or process is not throttled, and that it replies with the SAME id it received, wrapped in an envelope for this slot. " +
                    "Each entry is released by a matching response, by the provider disconnecting, by the caller closing, or by providerRequestTimeoutMs expiring (default 60000ms), " +
                    "which fails the caller with a named error rather than leaving it to hang. If this count is not falling and no timeout error ever arrives, providerRequestTimeoutMs is set to 0.",
            });
        } else if (s.connected && s.transport === "stdio" && s.pendingCount > 0) {
            // Deliberately NOT extended to `loopback`. The diagnosis is itself
            // an in-flight request on whichever loopback slot is serving it
            // (`_broker` directly, plus `_all` when it is reached through the
            // aggregate), so a loopback rule would fire on every single call
            // and be wrong every time.
            problems.push({
                id: "upstream-not-responding",
                severity: "warning",
                slot: s.name,
                symptom: `Slot "${s.name}" is served by a configured upstream (a child process or a remote URL) with ${s.pendingCount} request(s) outstanding and no reply yet.`,
                evidence: { transport: s.transport, pendingCount: s.pendingCount },
                fix:
                    "A brief spike is normal. A count that only grows means the upstream is not answering: for a child process check its stderr, for a remote URL check that the server is up and returning JSON-RPC rather than an HTML error page with status 200. " +
                    "providerRequestTimeoutMs (default 60000ms) applies to configured upstreams too, so the caller gets a named error rather than hanging; if none ever arrives, that setting is 0.",
            });
        }

        // Long-lived sessions are torn down by their own transport, and a
        // Streamable HTTP session that is never DELETEd outlives the client
        // that opened it. The broker genuinely cannot tell a live session from
        // an abandoned one, and a healthy HTTP client is `clientCount: 0,
        // sessionCount: 1` (clientCount counts raw WebSocket clients only), so
        // this is reported as information above a threshold rather than
        // asserted as a fault. Below the threshold the number carries no
        // signal at all and reporting it would be noise.
        if (s.sessionCount >= SESSION_ACCUMULATION_THRESHOLD) {
            problems.push({
                id: "sessions-without-clients",
                severity: "info",
                slot: s.name,
                symptom:
                    `Slot "${s.name}" holds ${s.sessionCount} long-lived session(s) (${s.clientCount} raw WebSocket client(s) besides). ` +
                    "Sessions on this broker never expire, and it cannot tell a live one from one whose client walked away.",
                evidence: { clientCount: s.clientCount, sessionCount: s.sessionCount },
                fix:
                    `A Streamable HTTP or SSE client that closes without sending DELETE ${scheme}://${authority}/${s.name}${paths.mcp} leaves its session alive, and every notification the provider broadcasts is queued into it, without bound. ` +
                    "Send that DELETE when a client is done. If this count only ever grows across a session, that is the leak, and a broker restart is the only way to reclaim it today.",
            });
        }

        // A slot exists as soon as anything mentions it, so an empty one is a
        // client waiting for a provider that never arrived. Reserved slots are
        // excluded: no provider may claim them, so the fix would be wrong.
        if (!s.reserved && !s.connected && s.transport === "none") {
            problems.push({
                id: "slot-never-connected",
                severity: s.clientCount + s.sessionCount > 0 ? "error" : "info",
                slot: s.name,
                symptom: `Slot "${s.name}" exists but no provider is serving it. Requests to it are answered with -32000 "Provider \\"${s.name}\\" not connected".`,
                evidence: { transport: s.transport, connected: s.connected, clientCount: s.clientCount, sessionCount: s.sessionCount },
                fix:
                    `Slots are created lazily by whoever mentions them first, so this name may simply be a typo on the client side. ` +
                    `If a provider is meant to serve it, connect it to ${wsScheme}://${authority}${paths.provider}/${s.name} with a DirectTransport, ` +
                    `or to ${wsScheme}://${authority}${paths.providers} with a MultiplexTransport created for the name "${s.name}". ` +
                    (s.clientCount + s.sessionCount > 0
                        ? `${s.clientCount + s.sessionCount} caller(s) are attached and getting nothing.`
                        : "No caller is attached, so nothing is being hurt yet."),
            });
        }
    }

    // -- Broker-wide rules -------------------------------------------------
    const providerSlots = slots.filter((s) => !s.reserved);
    const connectedProviderSlots = providerSlots.filter((s) => s.connected);

    if (slot === undefined && connectedProviderSlots.length === 0) {
        problems.push({
            id: "no-providers",
            severity: "warning",
            symptom: "No provider is connected. Only the reserved slots answer, so every other slot returns -32000 not-connected.",
            evidence: { knownSlots: slots.map((s) => s.name), providerSlots: providerSlots.length },
            fix:
                `Connect an MCP server to ${wsScheme}://${authority}${paths.provider}/<slot> with a DirectTransport (plain JSON-RPC frames), ` +
                `or to ${wsScheme}://${authority}${paths.providers} with a MultiplexTransport (envelope frames, slot named per envelope). ` +
                `Do not use ${wsScheme}://${authority}${paths.providers}/<slot>: that is neither endpoint and is accepted as a client. ` +
                `Configured upstreams are another route: add a stdioUpstreams, mcpServers or mcpbBundles entry to the config file.`,
        });
    }

    // -- Aggregate rules ---------------------------------------------------
    if (!aggregate) {
        checksSkipped.push({
            id: "aggregate-empty",
            reason: "This broker context does not implement getAggregateInfo(), so `_all` membership cannot be read. Call tools/list on the _all slot to see it directly.",
        });
    } else if (!aggregate.enabled) {
        problems.push({
            id: "aggregate-disabled",
            severity: "info",
            slot: BROKER_AGGREGATE_NAME,
            symptom: `The reserved "${BROKER_AGGREGATE_NAME}" aggregate slot is disabled on this broker.`,
            evidence: { enabled: false },
            fix: `Nothing will union the providers, and a stdio MCP host has no always-available target except "${BROKER_PROVIDER_NAME}". Leave enableAggregateProvider unset (or set it to true) when building the tunnel if you want "${BROKER_AGGREGATE_NAME}" back.`,
        });
    } else if (slot === undefined) {
        const aggregatedProviders = aggregate.providers.filter((name) => !isReservedBrokerSlot(name));
        const liveOutside = connectedProviderSlots.filter((s) => !aggregate.providers.includes(s.name));

        if (aggregatedProviders.length === 0) {
            problems.push({
                id: "aggregate-empty",
                severity: connectedProviderSlots.length > 0 ? "warning" : "info",
                slot: BROKER_AGGREGATE_NAME,
                symptom: `"${BROKER_AGGREGATE_NAME}" contains no provider beyond the broker's own introspection tools, so a client on it sees only the _broker-* tools.`,
                evidence: { aggregateProviders: aggregate.providers, connectedProviderSlots: connectedProviderSlots.map((s) => s.name) },
                fix: aggregateOptInFix(),
            });
        } else if (liveOutside.length > 0) {
            problems.push({
                id: "aggregate-missing-live-slots",
                severity: "info",
                slot: BROKER_AGGREGATE_NAME,
                symptom: `${liveOutside.length} connected slot(s) are not in "${BROKER_AGGREGATE_NAME}": ${liveOutside.map((s) => s.name).join(", ")}. Clients on the aggregate cannot see their tools.`,
                evidence: { missing: liveOutside.map((s) => ({ name: s.name, transport: s.transport })), aggregateProviders: aggregate.providers },
                fix: aggregateOptInFix(),
            });
        }
    }

    // -- stdio bridge target ------------------------------------------------
    if (bridgeTarget === undefined) {
        checksSkipped.push({
            id: "stdio-bridge-target-unreachable",
            reason: "This broker context does not implement getStdioBridgeTarget(), so the stdio bridge's target cannot be read. Check MCP_BROKER_STDIO_PROVIDER by hand.",
        });
    } else if (bridgeTarget !== null && !isReservedBrokerSlot(bridgeTarget)) {
        const target = slots.find((s) => s.name === bridgeTarget);
        problems.push({
            id: "stdio-bridge-target-unreachable",
            severity: target?.connected ? "warning" : "error",
            slot: bridgeTarget,
            symptom:
                `The stdio bridge is pinned to "${bridgeTarget}", which is not a reserved slot. ` +
                (target?.connected
                    ? "It happens to be connected right now, but it will not be at the next host start."
                    : `It is not connected, so the MCP host's very first initialize is answered with -32000 not-connected and the host will treat this server as dead with no retry.`),
            evidence: { stdioBridgeTarget: bridgeTarget, targetConnected: target?.connected ?? false, targetTransport: target?.transport ?? "none" },
            fix:
                `Set MCP_BROKER_STDIO_PROVIDER (or stdioProvider in the config file) to "${BROKER_AGGREGATE_NAME}". ` +
                `An MCP host starts its servers before any provider can exist, so pinning a real slot fails every time. "${BROKER_AGGREGATE_NAME}" is registered before stdin is resumed, answers initialize itself, ` +
                `already aggregates "${BROKER_PROVIDER_NAME}", and pushes notifications/tools/list_changed when a provider joins, so a provider that appears mid-session shows up live. ` +
                `Use "${BROKER_PROVIDER_NAME}" instead if you only want the broker's introspection tools.`,
        });
    }

    // -- Origin check on a self-served page ---------------------------------
    if (!security) {
        checksSkipped.push({
            id: "self-served-page-blocked",
            reason: "This broker context does not implement getSecurityInfo(), so the origin allow-list and the static mounts cannot be read. Check allowedOrigins by hand if a browser page is involved.",
        });
    } else if (slot === undefined && security.staticMountPrefixes.length > 0 && !security.allowedOriginsConfigured) {
        problems.push({
            id: "self-served-page-blocked",
            severity: "warning",
            symptom: `This broker serves static files (${security.staticMountPrefixes.join(", ")}) while no browser origin is allowed on the client endpoint, so a page it serves gets HTTP 403 invalid_origin the moment it calls /<slot>${paths.mcp}.`,
            evidence: { staticMountPrefixes: security.staticMountPrefixes, allowedOriginsConfigured: false },
            fix:
                `Serving a page does not exempt its origin. Add the page's exact origin to allowedOrigins, or set MCP_BROKER_ALLOWED_ORIGINS=${scheme}://${authority}. ` +
                `Match scheme, host and port exactly as the browser sends them (${context.tls ? "this broker runs TLS, so the origin is https://" : "this broker is plain HTTP, so the origin is http://"}). ` +
                "Leave it unset if only non-browser clients (which send no Origin header) reach this broker.",
        });
    }

    // -- Notes: true, actionable, but not a fault ---------------------------
    const notes: string[] = [];
    if (security?.providerAuthEnabled) {
        // Not a problem on its own: it is only fatal for browser-hosted
        // providers, and the broker cannot tell from here whether any provider
        // is a browser. Stated so a reader wiring one is not surprised.
        notes.push(
            "Provider authentication is enabled. A browser-hosted provider can never satisfy it: the WebSocket constructor cannot set the X-Provider-Token or Authorization header, and neither shipped transport accepts a credential. " +
                "Such a provider is refused at the handshake with HTTP 401, which reaches the page as a bare error event with no status. Run without a provider secret, or authenticate in a reverse proxy."
        );
    }
    if (security?.clientAuthEnabled && bridgeTarget === BROKER_AGGREGATE_NAME) {
        notes.push(
            `OAuth is enabled and the stdio bridge is pinned to "${BROKER_AGGREGATE_NAME}". The bridge forwards frames with no principal attached, so once per-provider scopes or a policy denying an anonymous subject are configured, ` +
                "the host's tool list silently empties: tools/list still answers 200 with an empty array. Grant the anonymous subject, or reach the broker over Streamable HTTP with a token instead of the bridge."
        );
    }

    problems.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);

    return {
        broker: {
            name: context.name,
            version: context.version,
            startedAt: context.startedAt?.toISOString() ?? null,
            uptimeSeconds: context.uptimeSeconds,
            listening: `${scheme}://${authority}`,
            tls: context.tls,
            paths,
            endpoints: {
                provider: `${wsScheme}://${authority}${paths.provider}/<slot>`,
                providers: `${wsScheme}://${authority}${paths.providers}`,
                client: `${wsScheme}://${authority}/<slot>`,
                streamableHttp: `${scheme}://${authority}/<slot>${paths.mcp}`,
            },
        },
        slots: scoped,
        summary: {
            slots: slots.length,
            connected: slots.filter((s) => s.connected).length,
            providerSlots: providerSlots.length,
            connectedProviderSlots: connectedProviderSlots.length,
            pendingRequests: slots.reduce((n, s) => n + s.pendingCount, 0),
            clients: slots.reduce((n, s) => n + s.clientCount, 0),
            sessions: slots.reduce((n, s) => n + s.sessionCount, 0),
        },
        ...(aggregate ? { aggregate: { enabled: aggregate.enabled, providers: aggregate.providers } } : {}),
        problems,
        checksSkipped,
        notes,
        seeAlso: [SEE_PUBLISH, SEE_CONNECT, SEE_HOST_CONFIG, SEE_TROUBLESHOOTING],
    };
}

/**
 * The aggregate opt-in, spelled out per provider kind. Shared by the two
 * aggregate rules so both give the same complete answer.
 */
function aggregateOptInFix(): string {
    return (
        `Membership in "${BROKER_AGGREGATE_NAME}" is opt-in, per provider, and the opt-in differs per kind. ` +
        "A WebSocket provider asks for it at registration: from the SDK, pass { aggregate: true } to the DirectTransport constructor or to MultiplexTransport.create; " +
        'driving the socket by hand on the slot-scoped path, send {"type":"register","aggregate":true} as the very FIRST frame, before any MCP traffic. ' +
        "Install your MCP message handler before either, because the broker sends initialize the moment it accepts the opt-in, and a provider that misses that handshake is dropped from the aggregate silently. " +
        'A stdioUpstreams config entry needs "aggregate": true written explicitly, while mcpServers and mcpbBundles entries are aggregated unless you write "aggregate": false. ' +
        `Never assume an opt-in took: a refused or unrecognized one produces no error. Verify with tools/list on the "${BROKER_AGGREGATE_NAME}" slot, where aggregated tools are named <slot>-<original>.`
    );
}
