import { randomUUID, createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, isAbsolute } from "node:path";
import { ResourcePath, ResourcePathPattern } from "../authorization/resource.path";

export interface ILimitWindow {
    readonly max: number;
    readonly windowMs: number;
}
export interface ILimitRule {
    readonly id: string;
    /** Selectors intersect. An omitted selector matches everyone. Counters are shared by default. */
    readonly match?: { readonly subject?: string; readonly provider?: string; readonly capability?: string; readonly resource?: string };
    readonly groupBy?: readonly ("subject" | "provider" | "capability" | "resource")[];
    readonly calls?: ILimitWindow;
    readonly rate?: ILimitWindow;
    readonly concurrency?: number;
    readonly budget?: ILimitWindow & { readonly unit: string };
    readonly requireReservation?: boolean;
    /**
     * What a request deadline does to the concurrency slot this rule holds.
     * `"hold"` (default) keeps it until the provider answers or an operator
     * releases it: a timeout does not prove the native work stopped, which is
     * what matters for a write. `"release"` frees it at the deadline, which is
     * right for reads, where a late answer changes nothing in the plant.
     */
    readonly onTimeout?: "hold" | "release";
}
export interface ILimitsConfig {
    readonly rules: readonly ILimitRule[];
    /** Absolute local path; one broker process owns it. No shared/network filesystem. */
    readonly storeFile?: string;
    readonly retentionMs?: number;
    readonly maxRecords?: number;
    /**
     * What a `<storeFile>.lock` left by a crash does at startup.
     * `"pid-check"` (default): the lock records the process id and host; when
     * that host is this one and the process is gone, the lock is stale, so the
     * broker takes it over and says so. Any doubt (another host, a live or
     * unreadable process) refuses, as `"refuse"` always does. A supervisor
     * restarting a crashed broker therefore restarts a working one.
     */
    readonly staleLock?: "pid-check" | "refuse";
    /**
     * What a store written under different rules does at startup.
     * `"migrate"` (default): counters of rules that still exist are kept,
     * counters of removed rules are dropped, unresolved concurrency is kept,
     * and the change is logged. `"refuse"` stops instead.
     */
    readonly onRulesChange?: "migrate" | "refuse";
}
export interface ILimitContext {
    readonly subjects: readonly string[];
    readonly provider: string;
    readonly capability: string;
    readonly resource: string;
    readonly requestId: string;
    readonly providerId?: string;
    readonly correlationId?: string;
}
export interface ILimitFailure {
    readonly reason: string;
    readonly ruleId?: string;
    readonly retryAfterMs?: number;
}
export type LimitOutcome<T> = { readonly allowed: true; readonly value: T } | { readonly allowed: false; readonly error: ILimitFailure };
export interface IBudgetGrant {
    readonly reservationId: string;
    readonly expiresAt: number;
    readonly quantity: number;
    readonly decisionId: string;
    readonly replayed: boolean;
}
interface Debit {
    key: string;
    quantity: number;
    windowMs: number;
    /** Absent in stores written before 1.6.1. */
    ruleId?: string;
    /** Which limit the debit counts against. `rate` debits are kept in memory only. Absent before 1.6.1: treated as durable. */
    kind?: "calls" | "rate" | "budget";
}
interface Entry {
    id: string;
    kind: "call" | "reservation";
    at: number;
    context: ILimitContext;
    debits: Debit[];
    activeKeys: string[];
    /** The rule behind each active key, same order. Absent before 1.6.1: those slots are held. */
    activeRules?: string[];
    finished: boolean;
    fingerprint?: string;
    idempotencyKey?: string;
    expiresAt?: number;
    decisionId?: string;
    quantity?: number;
    used?: number;
    result?: string;
}
interface State {
    version: 1;
    policyHash: string;
    entries: Entry[];
}
export interface ILimitsInfo {
    readonly durable: boolean;
    readonly storageFault: string | null;
    readonly rules: number;
    readonly records: number;
    readonly activeCallCount: number;
    readonly activeCalls: readonly { requestId: string; provider: string; ageMs: number }[];
    readonly expiredReservations: number;
    readonly recentEvents: readonly ILimitAuditEvent[];
}
export interface ILimitAuditEvent {
    readonly timestamp: string;
    readonly action: "admit" | "reserve" | "settle" | "complete" | "timeout" | "release";
    readonly allowed: boolean;
    readonly requestId?: string;
    readonly correlationId?: string;
    readonly decisionId?: string;
    readonly reservationId?: string;
    readonly error?: ILimitFailure;
    /** For `release`: who released it, as the operator's subjects. */
    readonly by?: readonly string[];
    /** For `timeout`: the rules whose slot the deadline freed. */
    readonly releasedRules?: readonly string[];
}

function object(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}
function keys(v: Record<string, unknown>, allowed: string[], label: string): void {
    for (const k of Object.keys(v)) if (!allowed.includes(k)) throw new Error(`${label}: unknown key "${k}"`);
}
function positive(v: unknown, label: string): void {
    if (!Number.isSafeInteger(v) || (v as number) <= 0) throw new Error(`${label} must be a positive safe integer`);
}
function window(v: unknown, label: string, budget = false): void {
    if (!object(v)) throw new Error(`${label} must be an object`);
    keys(v, budget ? ["max", "windowMs", "unit"] : ["max", "windowMs"], label);
    positive(v.max, label + ".max");
    positive(v.windowMs, label + ".windowMs");
    if ((v.windowMs as number) > 86400000) throw new Error(label + ".windowMs exceeds one day");
    if (budget && (typeof v.unit !== "string" || !/^[a-z][a-z0-9._-]{0,63}$/.test(v.unit))) throw new Error(label + ".unit invalid");
}
export function validateLimitsConfig(value: unknown): asserts value is ILimitsConfig {
    if (!object(value)) throw new Error("limits must be an object");
    keys(value, ["rules", "storeFile", "retentionMs", "maxRecords", "staleLock", "onRulesChange"], "limits");
    if (value.staleLock !== undefined && value.staleLock !== "pid-check" && value.staleLock !== "refuse") throw new Error('limits.staleLock must be "pid-check" or "refuse"');
    if (value.onRulesChange !== undefined && value.onRulesChange !== "migrate" && value.onRulesChange !== "refuse")
        throw new Error('limits.onRulesChange must be "migrate" or "refuse"');
    if (!Array.isArray(value.rules) || value.rules.length > 256) throw new Error("limits.rules must be an array of at most 256 rules");
    if (value.storeFile !== undefined && (typeof value.storeFile !== "string" || !value.storeFile.length)) throw new Error("limits.storeFile must be a non-empty path");
    if (value.retentionMs !== undefined) positive(value.retentionMs, "limits.retentionMs");
    if (value.maxRecords !== undefined) positive(value.maxRecords, "limits.maxRecords");
    const ids = new Set<string>();
    for (const r of value.rules) {
        if (!object(r)) throw new Error("limit rule must be an object");
        keys(r, ["id", "match", "groupBy", "calls", "rate", "concurrency", "budget", "requireReservation", "onTimeout"], "limit rule");
        if (r.onTimeout !== undefined && r.onTimeout !== "hold" && r.onTimeout !== "release") throw new Error('limit rule onTimeout must be "hold" or "release"');
        if (r.onTimeout !== undefined && r.concurrency === undefined) throw new Error("limit rule onTimeout only applies to a concurrency limit");
        if (typeof r.id !== "string" || !/^[a-zA-Z0-9._-]{1,128}$/.test(r.id) || ids.has(r.id)) throw new Error("limit rule id invalid or duplicated");
        ids.add(r.id);
        if (r.match !== undefined) {
            if (!object(r.match)) throw new Error("limit match must be an object");
            keys(r.match, ["subject", "provider", "capability", "resource"], "limit match");
            for (const v of Object.values(r.match)) if (typeof v !== "string" || !v.length || v.length > 2048) throw new Error("limit selector invalid");
            if (r.match.resource) ResourcePathPattern.parse(r.match.resource as string);
        }
        if (
            r.groupBy !== undefined &&
            (!Array.isArray(r.groupBy) ||
                r.groupBy.length > 4 ||
                new Set(r.groupBy).size !== r.groupBy.length ||
                !r.groupBy.every((k) => ["subject", "provider", "capability", "resource"].includes(k as string)))
        )
            throw new Error("limit groupBy invalid");
        if (r.calls !== undefined) window(r.calls, "calls");
        if (r.rate !== undefined) window(r.rate, "rate");
        if (r.concurrency !== undefined) positive(r.concurrency, "concurrency");
        if (r.budget !== undefined) window(r.budget, "budget", true);
        if (r.requireReservation !== undefined && typeof r.requireReservation !== "boolean") throw new Error("requireReservation must be boolean");
        if (r.requireReservation && !r.budget) throw new Error("requireReservation needs a budget");
        if (!r.calls && !r.rate && !r.concurrency && !r.budget) throw new Error("limit rule needs a limit");
    }
}
/** `true` while process `pid` exists on this host. `EPERM` means it exists but belongs to someone else. */
function processAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM";
    }
}

/** Entries that must survive a restart: reservations, `calls` quotas, and calls still holding a concurrency slot. */
function durable(e: Entry): boolean {
    return e.kind === "reservation" || (!e.finished && e.activeKeys.length > 0) || e.debits.some((d) => d.kind !== "rate");
}

function hash(value: unknown): string {
    return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** Synchronous transactions serialize all admissions, including concurrent sockets in this process. */
export class LimitController {
    private readonly config: ILimitsConfig;
    private state: State;
    private lock: number | undefined;
    private fault: string | undefined;
    private closed = false;
    private readonly events: ILimitAuditEvent[] = [];
    constructor(
        config: ILimitsConfig,
        private readonly clock: () => number = Date.now
    ) {
        validateLimitsConfig(config);
        this.config = JSON.parse(JSON.stringify(config)) as ILimitsConfig;
        this.state = { version: 1, policyHash: hash(config.rules), entries: [] };
        const file = config.storeFile;
        if (file) {
            if (!isAbsolute(file)) throw new Error("limits.storeFile must be absolute in the library API");
            this.lock = this.acquireLock(file + ".lock");
            try {
                writeFileSync(this.lock, JSON.stringify({ pid: process.pid, host: hostname(), startedAt: new Date().toISOString() }));
                fsyncSync(this.lock);
                if (existsSync(file)) {
                    const loaded = JSON.parse(readFileSync(file, "utf8")) as State & { checksum?: string };
                    if (loaded.checksum !== hash(loaded.entries)) throw new Error("limit store checksum mismatch");
                    const s: State = loaded;
                    if (s.version !== 1 || !Array.isArray(s.entries)) throw new Error("limit store invalid");
                    if (s.policyHash !== this.state.policyHash && (config.onRulesChange ?? "migrate") === "refuse")
                        throw new Error('limit store was written under other rules and limits.onRulesChange is "refuse"; migrate it explicitly');
                    for (const e of s.entries) {
                        if (
                            !e ||
                            !["call", "reservation"].includes(e.kind) ||
                            typeof e.id !== "string" ||
                            !Number.isSafeInteger(e.at) ||
                            !object(e.context) ||
                            !Array.isArray(e.debits) ||
                            !Array.isArray(e.activeKeys) ||
                            typeof e.finished !== "boolean" ||
                            !e.debits.every(
                                (d) => typeof d.key === "string" && Number.isSafeInteger(d.quantity) && d.quantity >= 0 && Number.isSafeInteger(d.windowMs) && d.windowMs > 0
                            )
                        )
                            throw new Error("corrupt limit store entry");
                    }
                    this.state = s.policyHash === this.state.policyHash ? s : this.migrate(s);
                }
                this.persist(this.state);
            } catch (e) {
                this.close();
                throw e;
            }
        }
    }
    /**
     * Takes `<storeFile>.lock`. With `staleLock: "pid-check"`, a lock whose
     * process is gone from this very host is stale and taken over; anything
     * uncertain refuses, so two brokers never share a ledger.
     */
    private acquireLock(path: string): number {
        try {
            return openSync(path, "wx", 0o600);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST" || (this.config.staleLock ?? "pid-check") !== "pid-check") throw error;
            let owner: { pid?: unknown; host?: unknown } = {};
            try {
                owner = JSON.parse(readFileSync(path, "utf8")) as typeof owner;
            } catch {
                throw new Error(`limit store lock ${path} exists and cannot be read; verify no other broker owns the store, then remove the lock`);
            }
            if (typeof owner.pid !== "number" || owner.host !== hostname()) {
                throw new Error(`limit store lock ${path} belongs to ${String(owner.host ?? "an unknown host")}; verify that broker is gone, then remove the lock`);
            }
            if (processAlive(owner.pid)) throw new Error(`limit store lock ${path} is held by live process ${owner.pid}; another broker owns this store`);
            console.warn(
                `[broker] limits: taking over the stale lock ${path}: process ${owner.pid} on this host is gone (it crashed or was killed). The ledger is kept as it was.`
            );
            unlinkSync(path);
            return openSync(path, "wx", 0o600);
        }
    }

    /**
     * Carries a store written under other rules over to the current ones:
     * counters of rules that still exist are kept (a changed maximum applies
     * to them from now on), counters of removed rules are dropped, and
     * unresolved concurrency is kept unless its rule was removed.
     */
    private migrate(s: State): State {
        const ids = new Set(this.config.rules.map((r) => r.id));
        let dropped = 0;
        const entries = s.entries.map((e) => {
            const debits = e.debits.filter((d) => {
                const keep = d.ruleId === undefined || ids.has(d.ruleId);
                if (!keep) dropped++;
                return keep;
            });
            if (!e.activeRules) return { ...e, debits };
            const keep = e.activeRules.map((id) => ids.has(id));
            const activeKeys = e.activeKeys.filter((_, i) => keep[i]);
            const activeRules = e.activeRules.filter((_, i) => keep[i]);
            return { ...e, debits, activeKeys, activeRules, finished: e.finished || (e.kind === "call" && activeKeys.length === 0) };
        });
        console.warn(
            `[broker] limits: the store was written under other rules; migrated it to the current ${this.config.rules.length} rule(s), ` +
                `dropping ${dropped} counter(s) of removed rules. Set limits.onRulesChange to "refuse" to stop instead.`
        );
        return { version: 1, policyHash: this.state.policyHash, entries };
    }

    private persist(next: State): void {
        const file = this.config.storeFile;
        if (!file) return;
        const temporary = file + ".tmp";
        const fd = openSync(temporary, "w", 0o600);
        try {
            // Only what must survive a restart: reservations (budgets, idempotency),
            // `calls` quotas (a crash must not reset them) and unresolved
            // concurrency. `rate` counters pace starts over short windows; losing
            // them costs one window, and keeping them would put a synchronous disk
            // write on every admitted call of a high-frequency reader.
            const entries = next.entries.filter(durable);
            writeFileSync(fd, JSON.stringify({ ...next, entries, checksum: hash(entries) }));
            fsyncSync(fd);
        } finally {
            closeSync(fd);
        }
        renameSync(temporary, file);
        if (process.platform !== "win32") {
            const directory = openSync(dirname(file), "r");
            try {
                fsyncSync(directory);
            } finally {
                closeSync(directory);
            }
        }
    }
    private commit(entries: Entry[], persist = true): boolean {
        if (this.closed || this.fault) return false;
        const next: State = { ...this.state, entries };
        try {
            if (persist) this.persist(next);
            this.state = next;
            return true;
        } catch {
            this.fault = "storage-unavailable";
            return false;
        }
    }
    private retained(now: number): Entry[] {
        const retention = this.config.retentionMs ?? 86400000;
        return this.state.entries.filter((e) => (e.kind === "call" && !e.finished) || e.at + Math.max(retention, ...e.debits.map((d) => d.windowMs)) > now);
    }
    private matches(c: ILimitContext): ILimitRule[] {
        return this.config.rules.filter((r) => {
            const m = r.match;
            return (
                (!m?.subject || c.subjects.includes(m.subject)) &&
                (!m?.provider || m.provider === c.provider) &&
                (!m?.capability || m.capability === c.capability) &&
                (!m?.resource || ResourcePathPattern.parse(m.resource).matches(ResourcePath.parse(c.resource)))
            );
        });
    }
    private key(r: ILimitRule, c: ILimitContext, kind: string): string {
        // Claims such as group memberships can change without creating a new user.
        const identity =
            [...c.subjects].sort().find((s) => s.startsWith("user:")) ??
            [...c.subjects].sort().find((s) => s.startsWith("service:")) ??
            [...c.subjects].sort().find((s) => s.startsWith("client:")) ??
            "anonymous";
        return hash([r.id, kind, ...(r.groupBy ?? []).map((k) => (k === "subject" ? identity : c[k]))]);
    }
    private failure(action: ILimitAuditEvent["action"], error: ILimitFailure, c?: ILimitContext): LimitOutcome<never> {
        this.audit({ timestamp: new Date(this.clock()).toISOString(), action, allowed: false, requestId: c?.requestId, correlationId: c?.correlationId, error });
        return { allowed: false, error };
    }
    private audit(e: ILimitAuditEvent): void {
        this.events.push(e);
        if (this.events.length > 200) this.events.shift();
        console.error("[broker] limits " + JSON.stringify(e));
    }
    private check(key: string, w: ILimitWindow, quantity: number, now: number, ruleId: string): ILimitFailure | undefined {
        const items = this.state.entries.flatMap((e) => e.debits.filter((d) => d.key === key && e.at + d.windowMs > now).map((d) => ({ at: e.at, ...d })));
        const total = items.reduce((sum, d) => sum + d.quantity, 0);
        if (quantity <= w.max - total) return undefined;
        let remaining = total;
        for (const d of items.sort((a, b) => a.at + a.windowMs - (b.at + b.windowMs))) {
            remaining -= d.quantity;
            if (quantity <= w.max - remaining) return { reason: "limit-exceeded", ruleId, retryAfterMs: Math.max(1, d.at + d.windowMs - now) };
        }
        return { reason: "quantity-exceeds-limit", ruleId };
    }
    admit(c: ILimitContext, units: readonly string[]): LimitOutcome<string | undefined> {
        if (this.closed || this.fault) return this.failure("admit", { reason: "storage-unavailable" }, c);
        c = { ...c, resource: ResourcePath.parse(c.resource).value };
        const rules = this.matches(c);
        if (!rules.length) return { allowed: true, value: undefined };
        const now = this.clock(),
            debits: Debit[] = [],
            activeKeys: string[] = [],
            activeRules: string[] = [];
        for (const r of rules) {
            if (r.requireReservation && (!c.providerId || !units.includes(r.budget!.unit))) return this.failure("admit", { reason: "reservation-unsupported", ruleId: r.id }, c);
            for (const kind of ["calls", "rate"] as const) {
                const w = r[kind];
                if (!w) continue;
                const key = this.key(r, c, kind),
                    error = this.check(key, w, 1, now, r.id);
                if (error) return this.failure("admit", error, c);
                debits.push({ key, quantity: 1, windowMs: w.windowMs, ruleId: r.id, kind });
            }
            if (r.concurrency) {
                const key = this.key(r, c, "concurrency");
                if (this.state.entries.filter((e) => !e.finished && e.activeKeys.includes(key)).length >= r.concurrency)
                    return this.failure("admit", { reason: "concurrency-exceeded", ruleId: r.id }, c);
                activeKeys.push(key);
                activeRules.push(r.id);
            }
        }
        const entries = this.retained(now);
        if (entries.length >= (this.config.maxRecords ?? 10000)) return this.failure("admit", { reason: "ledger-full" }, c);
        const id = randomUUID();
        entries.push({ id, kind: "call", at: now, context: c, debits, activeKeys, activeRules, finished: activeKeys.length === 0 });
        // A call that only moves `rate` counters changes nothing that must survive a restart.
        if (!this.commit(entries, durable(entries[entries.length - 1]))) return this.failure("admit", { reason: "storage-unavailable" }, c);
        this.audit({ timestamp: new Date(now).toISOString(), action: "admit", allowed: true, requestId: c.requestId, correlationId: c.correlationId });
        return { allowed: true, value: id };
    }
    complete(provider: string, requestId: string): void {
        const found = this.state.entries.find((e) => e.kind === "call" && e.context.provider === provider && e.context.requestId === requestId && !e.finished);
        if (!found) return;
        if (this.commit(this.state.entries.map((e) => (e === found ? { ...e, finished: true } : e))))
            this.audit({ timestamp: new Date(this.clock()).toISOString(), action: "complete", allowed: true, requestId });
    }
    /**
     * The request deadline passed. Frees the concurrency slots of the rules
     * that say `onTimeout: "release"`; the others stay held until the provider
     * answers or an operator releases them.
     */
    timedOut(provider: string, requestId: string): void {
        const found = this.state.entries.find((e) => e.kind === "call" && e.context.provider === provider && e.context.requestId === requestId && !e.finished);
        if (!found || !found.activeRules) return;
        const releasing = new Set(this.config.rules.filter((r) => r.onTimeout === "release").map((r) => r.id));
        const keep = found.activeRules.map((id) => !releasing.has(id));
        if (keep.every(Boolean)) return;
        const activeKeys = found.activeKeys.filter((_, i) => keep[i]);
        const activeRules = found.activeRules.filter((_, i) => keep[i]);
        const released = found.activeRules.filter((_, i) => !keep[i]);
        const next = { ...found, activeKeys, activeRules, finished: activeKeys.length === 0 };
        if (this.commit(this.state.entries.map((e) => (e === found ? next : e))))
            this.audit({
                timestamp: new Date(this.clock()).toISOString(),
                action: "timeout",
                allowed: true,
                requestId,
                correlationId: found.context.correlationId,
                releasedRules: released,
            });
    }

    /**
     * An operator releases every slot a call still holds, after checking the
     * native work stopped. Returns `false` when no such unresolved call exists.
     */
    release(provider: string, requestId: string, by: readonly string[]): boolean {
        const found = this.state.entries.find((e) => e.kind === "call" && e.context.provider === provider && e.context.requestId === requestId && !e.finished);
        if (!found) return false;
        if (!this.commit(this.state.entries.map((e) => (e === found ? { ...e, activeKeys: [], activeRules: [], finished: true } : e)))) return false;
        this.audit({ timestamp: new Date(this.clock()).toISOString(), action: "release", allowed: true, requestId, correlationId: found.context.correlationId, by });
        return true;
    }

    reserve(c: ILimitContext, unit: string, quantity: number, idempotencyKey: string, decisionId: string): LimitOutcome<IBudgetGrant> {
        if (this.closed || this.fault) return this.failure("reserve", { reason: "storage-unavailable" }, c);
        if (!Number.isSafeInteger(quantity) || quantity <= 0 || !/^[A-Za-z0-9._:-]{1,128}$/.test(idempotencyKey))
            return this.failure("reserve", { reason: "invalid-reservation" }, c);
        c = { ...c, resource: ResourcePath.parse(c.resource).value };
        // Scope includes the request. An expired caller reference cannot open new work.
        const fingerprint = hash([c.providerId, c.provider, c.requestId, c.subjects, c.capability, c.resource, unit, quantity]);
        const previous = this.state.entries.find(
            (e) =>
                e.kind === "reservation" &&
                e.context.providerId === c.providerId &&
                e.context.provider === c.provider &&
                e.context.requestId === c.requestId &&
                e.idempotencyKey === idempotencyKey
        );
        if (previous) {
            if (previous.fingerprint !== fingerprint) return this.failure("reserve", { reason: "idempotency-conflict" }, c);
            if (previous.finished || previous.expiresAt! <= this.clock()) return this.failure("reserve", { reason: "reservation-expired-or-settled" }, c);
            return {
                allowed: true,
                value: { reservationId: previous.id, expiresAt: previous.expiresAt!, quantity: previous.quantity!, decisionId: previous.decisionId!, replayed: true },
            };
        }
        const rules = this.matches(c).filter((r) => r.budget?.unit === unit);
        if (!rules.length) return this.failure("reserve", { reason: "no-budget-policy" }, c);
        const now = this.clock(),
            debits: Debit[] = [];
        for (const r of rules) {
            const w = r.budget!,
                key = this.key(r, c, "budget"),
                error = this.check(key, w, quantity, now, r.id);
            if (error) return this.failure("reserve", error, c);
            debits.push({ key, quantity, windowMs: w.windowMs, ruleId: r.id, kind: "budget" });
        }
        const entries = this.retained(now);
        if (entries.length >= (this.config.maxRecords ?? 10000)) return this.failure("reserve", { reason: "ledger-full" }, c);
        const id = randomUUID(),
            expiresAt = now + Math.min(60000, ...debits.map((d) => d.windowMs));
        entries.push({ id, kind: "reservation", at: now, context: c, debits, activeKeys: [], finished: false, quantity, expiresAt, idempotencyKey, fingerprint, decisionId });
        if (!this.commit(entries)) return this.failure("reserve", { reason: "storage-unavailable" }, c);
        this.audit({
            timestamp: new Date(now).toISOString(),
            action: "reserve",
            allowed: true,
            requestId: c.requestId,
            correlationId: c.correlationId,
            decisionId,
            reservationId: id,
        });
        return { allowed: true, value: { reservationId: id, expiresAt, quantity, decisionId, replayed: false } };
    }
    settle(providerId: string, slot: string, id: string, used: number, result: string): LimitOutcome<{ settled: true }> {
        if (this.closed || this.fault) return this.failure("settle", { reason: "storage-unavailable" });
        const e = this.state.entries.find((r) => r.kind === "reservation" && r.id === id && r.context.providerId === providerId && r.context.provider === slot);
        if (!e) return this.failure("settle", { reason: "unknown-reservation" });
        if (!["success", "failure", "refused"].includes(result) || !Number.isSafeInteger(used) || used < 0 || used > e.quantity!)
            return this.failure("settle", { reason: "invalid-usage" }, e.context);
        if (e.finished)
            return e.used === used && e.result === result ? { allowed: true, value: { settled: true } } : this.failure("settle", { reason: "settlement-conflict" }, e.context);
        // Deliberately do not refund unused units. A reservation is a debit.
        // This makes expiry, late settlement and lost replies conservative.
        if (!this.commit(this.state.entries.map((r) => (r === e ? { ...r, finished: true, used, result } : r))))
            return this.failure("settle", { reason: "storage-unavailable" }, e.context);
        this.audit({
            timestamp: new Date(this.clock()).toISOString(),
            action: "settle",
            allowed: true,
            requestId: e.context.requestId,
            correlationId: e.context.correlationId,
            decisionId: e.decisionId,
            reservationId: id,
        });
        return { allowed: true, value: { settled: true } };
    }
    info(): ILimitsInfo {
        const now = this.clock();
        return {
            durable: !!this.config.storeFile,
            storageFault: this.fault ?? null,
            rules: this.config.rules.length,
            activeCallCount: this.state.entries.filter((e) => e.kind === "call" && !e.finished).length,
            activeCalls: this.state.entries
                .filter((e) => e.kind === "call" && !e.finished)
                .slice(0, 20)
                .map((e) => ({ requestId: e.context.requestId, provider: e.context.provider, ageMs: now - e.at })),
            expiredReservations: this.state.entries.filter((e) => e.kind === "reservation" && !e.finished && e.expiresAt! <= now).length,
            records: this.state.entries.length,
            recentEvents: [...this.events],
        };
    }
    close(): void {
        this.closed = true;
        if (this.lock !== undefined) {
            closeSync(this.lock);
            this.lock = undefined;
            unlinkSync(this.config.storeFile! + ".lock");
        }
    }
}
