/**
 * The broker's reserved slot names, in one dependency-free module.
 *
 * They live here rather than next to the code that registers them because
 * three unrelated layers need them: `broker.server.ts` registers `_broker`,
 * `AggregateServer` owns `_all`, and the diagnostics engine has to tell a
 * reserved slot from a user slot without importing either. Importing the
 * registrars would close a module cycle; importing this does not.
 */

/**
 * Reserved provider slot name under which the broker exposes itself as an MCP
 * server. Clients reach it via `<host>/_broker/mcp` (or any other client
 * transport).
 *
 * Prefixed with `_` to make it unambiguously a system slot, and to reduce the
 * chance of collision with user-supplied provider names.
 */
export const BROKER_PROVIDER_NAME = "_broker";

/**
 * Reserved provider slot name under which the broker exposes the aggregate of
 * every opted-in provider. Mirrors `AggregateServer.SLOT`.
 */
export const BROKER_AGGREGATE_NAME = "_all";

/** Every slot name the broker reserves for itself. */
export const BROKER_RESERVED_SLOTS: readonly string[] = [BROKER_PROVIDER_NAME, BROKER_AGGREGATE_NAME];

/**
 * `true` when `name` is one of the broker's own slots rather than a slot a
 * provider may claim. A provider connecting to a reserved name is refused.
 */
export function isReservedBrokerSlot(name: string): boolean {
    return name === BROKER_PROVIDER_NAME || name === BROKER_AGGREGATE_NAME;
}
