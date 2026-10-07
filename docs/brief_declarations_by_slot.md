# Brief: one identity, several declarations, one per slot

Status: proposal, 2026-10-06. Requested by mcp-open-api, after benchmarking its engine.

## In one sentence

Today, a provider identity holds **one** declaration, and therefore **one** domain. We propose that it hold **one declaration per slot** it publishes, each with its own domain, so that a single host can serve several governed slots without them overwriting each other.

## The model, unchanged

A governed resource is a **qualified name**: a domain and a path. `scada:/site/nord/**` and `vannes:/site/nord/**` are two distinct resources, even if their paths overlap. What mcp-scada protects belongs to it and concerns no other domain.

- **A domain has one owner**, just as a URN namespace has one authority. The broker already enforces this (`domain "<d>" is already declared by provider "<id>"; a domain has one owner`), and this brief does not touch it.
- **Rights are qualified** by the capability prefix: a `scada.*` assignment on `/site/**` grants nothing on the resources of `vannes`.
- **An unqualified path**, written in the policy (`slotResources`, the `resource` of an assignment), is common to all domains: `/site/**` covers the resources of each one.
- Two different domains can therefore declare overlapping namespaces; the broker does not check this, and it is right not to.

## The problem

`BrokerAuthority` keeps declarations in `_declarations: Map<principalId, IProviderDeclaration>` (`authority/broker.authority.ts`), and `broker/authorize` looks up the declaration by the requesting identity (`declarationOf(principal.id)`), without taking into account the slot the request comes from, even though `origin.slot` is known. An identity that declares again **replaces** its previous declaration, whatever the slot.

A host that publishes several governed slots under a single identity therefore sees them overwrite each other, silently:

1. mcp-open-api serves `vannes` (domain `vannes`) and declares;
2. it serves `pompes` (domain `pompes`) and declares: this declaration **replaces** the one for `vannes`;
3. `vannes` is still published, but every `authorize` for its tools answers `undeclared-capability`. No error, anywhere.

The current workaround, one identity per slot, forces the operator to write one `providers` entry per served slot, and to keep it up to date with each publication. For a host whose role is precisely to publish slots on demand (mcp-open-api, mcp-designer), this is not sustainable.

## The proposal

- Declarations are indexed by the pair **(identity, slot)**.
- `broker/authorize` looks up the declaration of the requesting identity **for the slot the request comes from** (`origin.slot`).
- Declaring again from the same slot replaces that slot's declaration, and no other.
- An identity can therefore own several domains, one per slot. The "one domain, one owner" rule applies as it does today: a domain owned by another identity is refused. The same identity can also declare the same domain from two slots.
- Retention does not change: a domain stays with its owner as long as the broker runs, even when disconnected.
- A provider that publishes only one slot sees no difference.

### What follows the per-slot declaration

- **Concrete resources**: the escape rule (same native identifier under another path) applies within the slot's declaration.
- **Limit patterns (1.7.0)**: those of a declaration apply only to its slot; the operator's `resourceLimits` apply to all, as today.
- **`protects`**: a protection is confirmed by the declaration of the protected slot.
- **`resultsRequired`, `budgetUnits`, budgets**: per declaration, and therefore per slot.
- **Caller references**: already valid only on the request's slot; nothing changes.

### The native identifier, qualified by the domain

The native identifier of a check (`checks[].resource`) is read only by the audit. The documentation will recommend the qualified form `<domain>:<path>` (`vannes:/site/nord/valves/V-012`), so that an audit line reads unambiguously when two domains cover the same path.

### Visibility

- `broker_info` and `broker://authority` list the declarations with their slot and domain.
- A decision's audit carries the slot of the declaration used.

### Administrative withdrawal (optional)

`AGENTS.md` says so: moving a domain to another identity currently requires a restart. A host that publishes and withdraws slots on demand will run into this more often. Proposal: a `_broker` tool, `broker_declaration_release({ principal, slot })`, which requires `broker.authority.admin`, is audited, changes `policyVersion`, and frees the domain if no other declaration from the same owner carries it. Refused while the provider is connected to that slot.

## Compatibility

- **Additive** for a provider that publishes only one slot.
- **One behavior changes**: an identity that declared from one slot, then from another, used to see the second declaration replace the first; it now keeps both. No known provider in the family relies on this replacement (mcp-scada and mcp-vault declare from a single slot); to be verified before the release.
- Nothing that was accepted becomes refused.

## Lots

| lot | content | acceptance criterion |
| --- | --- | --- |
| 1 | declarations indexed by (identity, slot); `authorize` looks up by `origin.slot` | an identity serving `vannes` and `pompes`, two domains, keeps both declarations; each `authorize` sees the one for its slot |
| 2 | slot and domain in `broker_info`, `broker://authority` and the audit; qualified form of the native identifier documented | the rights views show each declaration with its slot |
| 3 | `broker_declaration_release` (optional) | a freed domain can be redeclared under another identity without a restart; refused if the provider is connected |

The test kit (`startTestBroker`) needs no changes: it already creates provider identities, and a test can serve several slots under the same one.

## Documentation to update

`AGENTS.md` ("Declared authorization" section: "an identity holds one declaration, hence one domain"), `docs/authorization.md`, the `broker_guide` guide (topic `publish-provider`).

## Open questions

- **The same domain from two slots of the same identity**: should it be accepted? The two declarations could carry concrete resources with the same native identifier but different limits.
- **Withdrawing a live provider**: lot 3 refuses it; should there be an option that disconnects the provider first?
