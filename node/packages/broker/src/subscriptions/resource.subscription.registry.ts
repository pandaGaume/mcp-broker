/**
 * Per-slot bookkeeping for `resources/subscribe`.
 *
 * A slot is one MCP server shared by every client attached to it, so the
 * provider behind it must not see one subscription per browser tab: it sees
 * one per URI. This registry owns that reference count. The first subscriber
 * of a URI triggers the upstream `resources/subscribe`, the last one to leave
 * triggers the upstream `resources/unsubscribe`, and everybody in between is
 * answered locally.
 *
 * Every operation on one `(slot, uri)` pair runs through a queue, so two
 * clients subscribing at the same instant cannot both send upstream, and an
 * unsubscribe cannot overtake the subscribe it undoes. A second subscriber that
 * arrives while the first upstream round trip is in flight waits for it: on
 * success it is added locally, with no second upstream call; on failure it
 * asks the provider itself, since the first refusal may have been transient.
 *
 * The registry does no I/O. The tunnel supplies the upstream calls through
 * {@link IResourceSubscriptionUpstream} and decides what a subscriber is: `S`
 * is whatever it needs to deliver a notification later.
 */

/** Identifies one consumer across transports, e.g. `ws:7`, `http:<session>`, `stdio`. */
export type ClientKey = string;

/** An upstream answer, reduced to what the registry needs. */
export type SubscriptionOutcome = { readonly ok: true } | { readonly ok: false; readonly error: { readonly code: number; readonly message: string } };

/** What the tunnel provides so the registry can talk to a provider. */
export interface IResourceSubscriptionUpstream {
    /** Sends one request to the provider behind `slot` and resolves with its answer, never rejects. */
    request(slot: string, method: "resources/subscribe" | "resources/unsubscribe", uri: string): Promise<SubscriptionOutcome>;
    /** `true` when a provider currently serves `slot`. */
    isConnected(slot: string): boolean;
}

/**
 * Bounds on what clients can make the broker hold. Without them one client, or
 * many sessions a client never closes, could grow the registry without limit
 * and pin upstream subscriptions forever.
 */
export interface IResourceSubscriptionLimits {
    /** Distinct URIs one client may be subscribed to at once. */
    readonly maxSubscriptionsPerClient: number;
    /** Client/URI pairs one slot may hold at once. */
    readonly maxSubscriptionsPerSlot: number;
    /** Longest URI accepted, in UTF-16 code units. */
    readonly maxResourceUriLength: number;
}

export const DEFAULT_RESOURCE_SUBSCRIPTION_LIMITS: IResourceSubscriptionLimits = Object.freeze({
    maxSubscriptionsPerClient: 64,
    maxSubscriptionsPerSlot: 1024,
    maxResourceUriLength: 2048,
});

/**
 * Where a URI stands with the provider.
 *
 * - `inactive`: not subscribed upstream. Either nothing was ever sent, or the
 *   provider disconnected and the subscription waits for {@link ResourceSubscriptionRegistry.replay}.
 * - `subscribing` / `unsubscribing`: an upstream round trip is in flight.
 * - `active`: the provider confirmed the subscription.
 */
export type SubscriptionState = "inactive" | "subscribing" | "active" | "unsubscribing";

/** Error code for a subscription refused by a broker limit. JSON-RPC reserves -32000..-32099 for servers. */
export const SUBSCRIPTION_LIMIT_ERROR_CODE = -32000;

interface IUriEntry<S> {
    state: SubscriptionState;
    /** Confirmed subscribers: they receive `notifications/resources/updated`. */
    readonly subscribers: Map<ClientKey, S>;
    /** Tail of this URI's operation queue. */
    tail: Promise<void>;
}

/** One URI whose upstream subscription was re-sent after a provider reconnected. */
export interface IReplayResult<S> {
    readonly uri: string;
    readonly outcome: SubscriptionOutcome;
    /** Who was subscribed at the time; they are dropped when the outcome is a failure. */
    readonly subscribers: ReadonlyArray<{ readonly client: ClientKey; readonly sink: S }>;
}

const OK: SubscriptionOutcome = Object.freeze({ ok: true });

export class ResourceSubscriptionRegistry<S> {
    private readonly _upstream: IResourceSubscriptionUpstream;
    private readonly _limits: IResourceSubscriptionLimits;

    /** slot → uri → entry. */
    private readonly _slots = new Map<string, Map<string, IUriEntry<S>>>();

    /**
     * client → slot → URIs, counting subscriptions still being confirmed.
     * Counting those is what makes the per-client limit hold under concurrent
     * requests: a reservation is taken before the upstream call, not after.
     */
    private readonly _clients = new Map<ClientKey, Map<string, Set<string>>>();

    /** slot → number of client/URI pairs, reserved ones included. */
    private readonly _slotCounts = new Map<string, number>();

    constructor(upstream: IResourceSubscriptionUpstream, limits: Partial<IResourceSubscriptionLimits> = {}) {
        this._upstream = upstream;
        this._limits = { ...DEFAULT_RESOURCE_SUBSCRIPTION_LIMITS, ...limits };
    }

    get limits(): IResourceSubscriptionLimits {
        return this._limits;
    }

    /**
     * Subscribes `client` to `uri` on `slot`. Idempotent: subscribing twice
     * keeps one entry and answers success.
     */
    subscribe(slot: string, client: ClientKey, sink: S, uri: string): Promise<SubscriptionOutcome> {
        if (uri.length === 0) return Promise.resolve(failure(-32602, "Missing required parameter: uri"));
        if (uri.length > this._limits.maxResourceUriLength) {
            return Promise.resolve(
                failure(-32602, `Resource URI is ${uri.length} characters long; this broker accepts at most ${this._limits.maxResourceUriLength} (maxResourceUriLength).`)
            );
        }

        const alreadyHeld = this._clients.get(client)?.get(slot)?.has(uri) ?? false;
        if (!alreadyHeld) {
            if (this._clientTotal(client) >= this._limits.maxSubscriptionsPerClient) {
                return Promise.resolve(
                    failure(
                        SUBSCRIPTION_LIMIT_ERROR_CODE,
                        `Subscription limit reached: this client already holds ${this._limits.maxSubscriptionsPerClient} resource subscriptions (maxSubscriptionsPerClient). Unsubscribe from one first.`
                    )
                );
            }
            if ((this._slotCounts.get(slot) ?? 0) >= this._limits.maxSubscriptionsPerSlot) {
                return Promise.resolve(
                    failure(
                        SUBSCRIPTION_LIMIT_ERROR_CODE,
                        `Subscription limit reached on slot "${slot}": it already holds ${this._limits.maxSubscriptionsPerSlot} client subscriptions (maxSubscriptionsPerSlot).`
                    )
                );
            }
            this._reserve(slot, client, uri);
        }

        const entry = this._entry(slot, uri, true)!;
        return this._enqueue(entry, async () => {
            // The client may have left while this waited in the queue.
            if (!this._isReserved(slot, client, uri)) return OK;

            if (entry.state === "active") {
                entry.subscribers.set(client, sink);
                return OK;
            }

            entry.state = "subscribing";
            const outcome = await this._upstream.request(slot, "resources/subscribe", uri);
            if (outcome.ok) {
                entry.state = "active";
                // Re-checked after the await, for the same reason as above.
                if (this._isReserved(slot, client, uri)) entry.subscribers.set(client, sink);
                return OK;
            }

            entry.state = "inactive";
            this._release(slot, client, uri);
            this._dropIfUnused(slot, uri, entry);
            return outcome;
        });
    }

    /**
     * Unsubscribes `client` from `uri`. Always succeeds, including for a URI
     * the client never subscribed to: the client asked not to be subscribed,
     * and it is not. The provider is told only when the last subscriber leaves,
     * and only when it is connected; its answer does not change ours.
     */
    unsubscribe(slot: string, client: ClientKey, uri: string): Promise<SubscriptionOutcome> {
        if (!this._isReserved(slot, client, uri)) return Promise.resolve(OK);
        this._release(slot, client, uri);

        const entry = this._entry(slot, uri, false);
        if (!entry) return Promise.resolve(OK);

        return this._enqueue(entry, async () => {
            entry.subscribers.delete(client);
            if (entry.subscribers.size > 0 || this._hasReservation(slot, uri)) return OK;

            if (entry.state === "active" && this._upstream.isConnected(slot)) {
                entry.state = "unsubscribing";
                await this._upstream.request(slot, "resources/unsubscribe", uri);
            }
            entry.state = "inactive";
            this._dropIfUnused(slot, uri, entry);
            return OK;
        });
    }

    /** Confirmed subscribers of `uri` on `slot`, the only ones a notification may reach. */
    subscribers(slot: string, uri: string): ReadonlyArray<{ readonly client: ClientKey; readonly sink: S }> {
        const entry = this._slots.get(slot)?.get(uri);
        if (!entry) return [];
        return [...entry.subscribers].map(([client, sink]) => ({ client, sink }));
    }

    /** Where `uri` stands with the provider behind `slot`. */
    stateOf(slot: string, uri: string): SubscriptionState {
        return this._slots.get(slot)?.get(uri)?.state ?? "inactive";
    }

    /** Number of client/URI pairs on `slot`, subscriptions being confirmed included. */
    countFor(slot: string): number {
        return this._slotCounts.get(slot) ?? 0;
    }

    /** `true` when `slot` has at least one URI someone is subscribed to. */
    hasSubscriptions(slot: string): boolean {
        for (const entry of this._slots.get(slot)?.values() ?? []) {
            if (entry.subscribers.size > 0) return true;
        }
        return false;
    }

    /**
     * Drops every subscription `client` holds, on every slot. Safe to call
     * repeatedly and for a client that holds nothing.
     */
    async removeClient(client: ClientKey): Promise<void> {
        const perSlot = this._clients.get(client);
        if (!perSlot) return;
        const pending: Promise<SubscriptionOutcome>[] = [];
        for (const [slot, uris] of [...perSlot]) {
            for (const uri of [...uris]) pending.push(this.unsubscribe(slot, client, uri));
        }
        await Promise.all(pending);
    }

    /**
     * Records that the provider behind `slot` went away: whatever it had
     * subscribed is gone with it. Subscribers are kept, so {@link replay} can
     * restore them when a provider comes back.
     */
    providerDisconnected(slot: string): void {
        for (const entry of this._slots.get(slot)?.values() ?? []) entry.state = "inactive";
    }

    /**
     * Re-sends one upstream `resources/subscribe` per URI that still has
     * subscribers, after a provider (re)attached to `slot`. A URI the new
     * provider refuses is dropped along with its subscribers, since nothing
     * will ever notify them; the result lists them so the caller can tell them.
     */
    async replay(slot: string): Promise<IReplayResult<S>[]> {
        const entries = [...(this._slots.get(slot) ?? [])].filter(([, entry]) => entry.subscribers.size > 0);
        return Promise.all(
            entries.map(([uri, entry]) =>
                this._enqueue(entry, async (): Promise<IReplayResult<S>> => {
                    const subscribers = [...entry.subscribers].map(([client, sink]) => ({ client, sink }));
                    if (entry.state === "active" || entry.subscribers.size === 0) return { uri, outcome: OK, subscribers };
                    entry.state = "subscribing";
                    const outcome = await this._upstream.request(slot, "resources/subscribe", uri);
                    if (outcome.ok) {
                        entry.state = "active";
                    } else {
                        entry.state = "inactive";
                        for (const { client } of subscribers) {
                            entry.subscribers.delete(client);
                            this._release(slot, client, uri);
                        }
                        this._dropIfUnused(slot, uri, entry);
                    }
                    return { uri, outcome, subscribers };
                })
            )
        );
    }

    /** Forgets everything without calling upstream. Used when the broker stops. */
    clear(): void {
        this._slots.clear();
        this._clients.clear();
        this._slotCounts.clear();
    }

    // -------------------------------------------------------------------------
    // Internals
    // -------------------------------------------------------------------------

    private _enqueue<T>(entry: IUriEntry<S>, op: () => Promise<T>): Promise<T> {
        const run = entry.tail.then(op);
        entry.tail = run.then(
            () => undefined,
            () => undefined
        );
        return run;
    }

    private _entry(slot: string, uri: string, create: boolean): IUriEntry<S> | undefined {
        let uris = this._slots.get(slot);
        if (!uris) {
            if (!create) return undefined;
            uris = new Map();
            this._slots.set(slot, uris);
        }
        let entry = uris.get(uri);
        if (!entry && create) {
            entry = { state: "inactive", subscribers: new Map(), tail: Promise.resolve() };
            uris.set(uri, entry);
        }
        return entry;
    }

    /** Removes an entry nobody holds or waits for, once its queue is idle. */
    private _dropIfUnused(slot: string, uri: string, entry: IUriEntry<S>): void {
        if (entry.subscribers.size > 0 || this._hasReservation(slot, uri) || entry.state !== "inactive") return;
        const uris = this._slots.get(slot);
        if (uris?.get(uri) !== entry) return;
        uris.delete(uri);
        if (uris.size === 0) this._slots.delete(slot);
    }

    private _reserve(slot: string, client: ClientKey, uri: string): void {
        let perSlot = this._clients.get(client);
        if (!perSlot) {
            perSlot = new Map();
            this._clients.set(client, perSlot);
        }
        let uris = perSlot.get(slot);
        if (!uris) {
            uris = new Set();
            perSlot.set(slot, uris);
        }
        uris.add(uri);
        this._slotCounts.set(slot, (this._slotCounts.get(slot) ?? 0) + 1);
    }

    private _release(slot: string, client: ClientKey, uri: string): void {
        const perSlot = this._clients.get(client);
        const uris = perSlot?.get(slot);
        if (!uris?.delete(uri)) return;
        if (uris.size === 0) perSlot!.delete(slot);
        if (perSlot!.size === 0) this._clients.delete(client);
        const count = (this._slotCounts.get(slot) ?? 1) - 1;
        if (count > 0) this._slotCounts.set(slot, count);
        else this._slotCounts.delete(slot);
    }

    private _isReserved(slot: string, client: ClientKey, uri: string): boolean {
        return this._clients.get(client)?.get(slot)?.has(uri) ?? false;
    }

    /** `true` when some client reserved `uri` on `slot`, confirmed or not. */
    private _hasReservation(slot: string, uri: string): boolean {
        for (const perSlot of this._clients.values()) {
            if (perSlot.get(slot)?.has(uri)) return true;
        }
        return false;
    }

    private _clientTotal(client: ClientKey): number {
        let n = 0;
        for (const uris of this._clients.get(client)?.values() ?? []) n += uris.size;
        return n;
    }
}

function failure(code: number, message: string): SubscriptionOutcome {
    return { ok: false, error: { code, message } };
}
