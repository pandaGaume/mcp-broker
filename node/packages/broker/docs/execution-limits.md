# Execution limits and operation budgets

This optional broker feature adds execution admission alongside authorization. Put `limits` at the top level of the security file, or use `WsTunnelBuilder.withLimits(config)`. Roles still decide permissions. A limit never grants a permission, and `broker/authorize` never consumes a quota.

## Operator configuration

Merge this block into the security file, alongside the existing auth and providers configuration:

```json
{
  "limits": {
    "storeFile": "./broker-limits.json",
    "maxRecords": 10000,
    "retentionMs": 600000,
    "rules": [
      {
        "id": "global-call-rate",
        "rate": { "max": 30, "windowMs": 1000 },
        "concurrency": 8
      },
      {
        "id": "calls-per-user",
        "groupBy": ["subject"],
        "calls": { "max": 120, "windowMs": 60000 }
      },
      {
        "id": "lan-operations",
        "match": { "provider": "network-discovery" },
        "budget": { "unit": "network-operation", "max": 300, "windowMs": 60000 },
        "requireReservation": true
      }
    ]
  }
}
```

These numbers are an example, not a certified OT operating profile. The provider must retain its own interface, subnet, port, rate and concurrency restrictions.

All matching rules apply atomically. If one refuses, none of the rules is debited. Selectors `subject`, `provider` and `capability` are exact matches; `resource` uses the existing hierarchical resource patterns. Omitted selectors match everyone. Counters are shared by every matching caller by default. Optional `groupBy` partitions a rule by subject, provider, capability or resource. Subject grouping uses the stable user identity, then service or client identity, then a shared anonymous bucket. It does not partition by mutable group memberships.

`rate` and `calls` both use sliding windows, not calendar boundaries or token-bucket bursts. A rate permits up to `max` starts in any `windowMs`; it does not space those starts evenly. Window lengths are bounded to one day. A provider's scheduler enforces physical pacing.

Resource selectors on call admission refer to the slot's configured resource. Resource selectors on operation reservation refer to the authorized native resource path. Map tools to capabilities using the existing operator-owned `auth.toolCapabilities` or `providerToolCapabilities` if limits need to distinguish them. The broker does not interpret tool arguments to infer cost, targets or identity.

Admission covers `tools/call` on HTTP, WebSocket, legacy SSE, stdio and internal clients. `_all` is admitted only when it dispatches to the actual provider. Non-tool MCP methods do not consume call quotas. Global rules also apply to _broker tools. During saturation, operators can inspect getAuthorityInfo().limits directly through the embedding API; scope rules to workload providers when MCP diagnostic access must retain capacity. When limits are enabled, tool notifications are dropped and batches containing tools are refused because they cannot be tracked safely by the existing tunnel.

A refused admission returns JSON-RPC `-32029` with `error.data.reason`, `ruleId` when applicable, and `retryAfterMs` when time alone can resolve the refusal. It never reaches the provider. Other protocol/authorization failures retain their existing error codes.

## Provider contract

Declare `budgetUnits: ["network-operation"]` alongside the existing authorization declaration. This advertises support; it grants no budget. A rule with `requireReservation: true` refuses admission when the authenticated provider has not declared its required unit. Ordinary providers need no SDK changes for call quotas alone.

Before native work, call:

```ts
const grant = await transport.broker.reserveBudget({
    principal: { type: "caller-ref", ref: callerReferenceOf(request.meta)!.ref },
    capability: "network.active",
    resource: "network-discovery",
    resourcePath: "/site/network",
    unit: "network-operation",
    quantity: 1,
    idempotencyKey: crypto.randomUUID()
});
```

The broker checks the live caller reference, its slot and provider identity, declared capability, resource namespace and current role policy, then reserves all matching budgets in one transaction. No caller identity from tool arguments is trusted. Reservations currently require a caller reference; autonomous provider-principal reservations are not enabled.

The result contains `reservationId`, `decisionId`, `quantity`, `expiresAt` and `replayed`. Validity lasts at most 60 seconds and no longer than the shortest matching budget window. Expiry limits when native work may start. It is not a cancellation mechanism. Synchronize provider and broker clocks when checking `expiresAt`.

After completion:

```ts
await transport.broker.settleBudget({
    reservationId: grant.reservationId,
    used: 1,
    result: "success"
});
```

Settlement accepts only the original authenticated provider on the original slot. It remains possible after the client reply, timeout or provider reconnect. Repeating an identical settlement succeeds; a conflicting result or usage is refused.

The SDK `withBudget(query, work)` helper reserves, refuses expired or replayed grants, executes the callback once, and settles. A low-level reservation retry with the same request and idempotency key returns the original live grant without another debit. Changing the quantity, unit, capability or resource with that key is refused. Never execute native work again merely because a reservation response was replayed. The broker cannot give exactly-once native execution across a provider crash.

Reservations debit the full quantity immediately. **This version does not refund unused units**, including a report with `used: 0`. Expiry, disconnect, lost replies and failed settlement do not refund anything. Window expiry is the ordinary way capacity becomes available again. Settlement records actual usage for audit. Reservation authorization is audited, but its outcome is tracked by the reservation ledger, not by resultsRequired / broker/audit/result. A settled or expired key cannot open a second operation while its record is retained.

Engineering constraints from an authorization declaration are not automatically interpreted by the budget API. An `allow-with-constraints` decision is conservatively refused for reservation. Generic constraint enforcement can be added separately.

The broker enforces its ledger and admission. A provider is still responsible for reserving before every native operation, respecting grant expiry, and enforcing local physical limits. Merely advertising a unit cannot make arbitrary provider code obey it.

## Storage, recovery and diagnostics

Without `storeFile`, state survives socket reconnects but not broker restart. With it, the broker flushes an atomic local snapshot before confirming admission, reservation or settlement. The implementation serializes writes in one process and bounds the ledger by `maxRecords` (default 10000). Full ledgers and storage failures refuse new controlled work. Snapshot writes are synchronous; size this initial implementation for moderate traffic and measure latency before a high-throughput deployment.

Paths in the security file are relative to that file. The library API requires an absolute path. The parent directory must exist. The store belongs on a local filesystem with atomic replacement semantics, not a network share. POSIX also flushes the parent directory; Node on Windows cannot provide the same directory-flush guarantee against sudden power loss. Graceful restart and process-crash recovery preserve a completed snapshot; hardware/power-loss guarantees depend on the filesystem.

A `<storeFile>.lock` file prevents a second broker from owning the same store. A normal stop removes it. After a crash, startup deliberately refuses a leftover lock: verify the previous process is gone, preserve the ledger, then remove only its lock. Never delete the ledger to clear a lock. Policy changes affecting the ledger require explicit migration; a different rules fingerprint refuses startup. Multi-broker/shared-store operation is not implemented.

Client timeout, client disconnect and provider disconnect do not prove native execution stopped, so they do not release concurrency. A matching late provider response releases it. After a crash or a permanently lost response, the operator can inspect `getAuthorityInfo().limits`, independently confirm work stopped, then invoke the embedding-only `tunnel.resolveLimitCall(slot, requestId)`. This is deliberately absent from MCP and provider RPC. It does not refund any quota. CLI-only deployments currently need an operator recovery integration for these orphaned concurrency records.

`broker_diagnose` exposes storage faults, expired unsettled reservations, recent limit refusals and active calls. Logs carry request, correlation, decision and reservation identifiers, without tool arguments or credentials. The recent-event diagnostic buffer is bounded and in-memory; configure the existing process log collector for durable denial history. The ledger persists debits, reservations, usage and unresolved concurrency.

Retained records protect idempotency and accounting. Retention defaults to one day and never evicts unresolved call concurrency. Finished records are kept for at least their debit windows. Expired unsettled reservations age out only after both retention and debit windows have passed.

## Validation

Tests cover atomic intersection, shared and partitioned quotas, expiry boundaries, exclusive storage ownership, restart, write failure, lost responses, identity isolation, SSE/HTTP/WS, multiplexed provider reservations, aggregate accounting, and provider reconnects. The network-discovery integration test uses a real broker with two callers and a simulated native backend.
