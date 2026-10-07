# Brief: engineering limits by resource pattern, and RE2 in the broker

Status: proposal, 2026-10-05. Requested by mcp-open-api; useful to mcp-scada.

## In one sentence

Today, an engineering limit (`minValue`, `maxValue`, `allowedValues`, `destinations`) attaches only to a **concrete** resource, looked up by its exact native identifier. We propose also attaching it to a path **pattern** (`/nord/valves/{id}`), declared by the provider or set by the operator in the security file, with all applicable rules **intersected**. Along the way, the broker evaluates all of its regular expressions with RE2 (`re2js`), in linear time.

## What exists

- A declaration carries concrete resources: `{ resource, resourcePath, effect?, limits? }` (`authority/declaration.ts`).
- On each `broker/authorize`, the broker looks up the limits by the check's exact native identifier (`authority/broker.authority.ts`, `declaration.resources.get(nativeResource)`). A resource that is not declared but lies within the namespace is allowed without limits.
- The same native identifier under another path is refused (`undeclared-resource`): otherwise a caller would escape the limits declared for it.
- The limits go out in `obligations.constraints` with `effect: "allow-with-constraints"` and `allowed: false`. **The provider applies them**; the broker does not see the written value.
- The existing path patterns (`ResourcePathPattern`, for `allowedResources` and assignments) accept only whole segments: `*` for one segment, `**` as the last segment. No `V-1*`.

## The problem

1. **Instances that cannot be enumerated.** A REST API published by mcp-open-api exposes thousands of valves (`/valves/{id}`), whose list changes without the provider knowing. mcp-scada will have the same problem on an installation with a few thousand tags. Declaring them one by one is impossible, or unsustainable.
2. **Equipment classes.** The `V-0xx` valves go from 0 to 100%, the `V-1xx` series is capped at 60%. This is knowledge of the process, not of the API.
3. **An operator who tightens without republishing.** A maintenance window imposes 0-80% for a week. Today only the provider declares limits: its manifest must be republished, or its code modified. And when the same author writes both the input schema and the declared limits, the latter add nothing: the provider checks the same thing twice.

Point 3 is the real gain: a limit set by **an authority other than the provider**, tracked as a policy change.

## The proposal

### One entry per pattern in declarations

```json
"resources": [
    { "resourcePattern": "/nord/valves/{id}", "limits": { "minValue": 0, "maxValue": 100 } },
    { "resourcePattern": "/nord/valves/{id}", "where": { "id": "V-1\\d{2}" }, "limits": { "maxValue": 60 } },
    { "resource": "valve:V-012", "resourcePath": "/nord/valves/V-012", "limits": { "maxValue": 40 } }
]
```

- `resourcePattern`: a path whose segments are literals, `*` (one segment), `**` (last segment, zero or more), or `{name}` (one segment, named). Same form as OpenAPI paths and as mcp-open-api's templates, so mcp-open-api can declare its `resourcePath` values as is.
- `where`: one RE2 expression per named segment, which must cover the entire segment (implicit anchoring). Without `where`, `{name}` is equivalent to `*`.
- An entry has either `resource` and `resourcePath` (concrete, as today), or `resourcePattern` (pattern). Never both.
- The pattern must stay within the declaration's namespace, like a concrete resource.

### Limits set by the operator

In the security file, under `authorization`:

```json
"resourceLimits": [
    { "id": "maintenance-nord-2026-10", "pattern": "/nord/valves/{id}", "where": { "id": "V-0\\d{2}" }, "limits": { "maxValue": 80 } }
]
```

Same syntax, with an `id` for the audit. These limits apply regardless of the provider's declaration. They are included in the file's hash, and therefore in `policyVersion`: adding or removing a limit is a policy change, tracked as such.

### Intersection, without arbitration

For a check, the broker gathers **all** the limits that apply: the concrete entry for the native identifier, every pattern in the declaration that matches the path, every `resourceLimits` entry that matches. It computes their intersection:

| limit | intersection |
| --- | --- |
| `minValue` | the largest |
| `maxValue` | the smallest |
| `allowedValues` | the values present in every list |
| `destinations` | same |

There is no "most specific pattern" to choose: limits only ever tighten, consistent with the principle the broker already applies. The order of entries does not matter.

If the intersection is empty (`minValue` above `maxValue`, or empty `allowedValues`), the decision is a denial, with reason `empty-limits`. A constraint that nothing can satisfy must not go out as an approval.

### Audit and diagnostics

- The decision's audit event lists the sources of the constraint: `limitSources: ["declaration:/nord/valves/{id}", "security:maintenance-nord-2026-10"]`.
- `broker_diagnose` reports `empty-limits` denials (with the sources involved), and declaration patterns whose `where` does not compile.
- `broker_info` and the `_broker` authority resource expose the declared patterns and the `resourceLimits`, for the rights views of the SCADA UI brief.

### What does not change

- The provider still applies the constraints; the broker does not see the value.
- A concrete resource keeps its escape rule: same native identifier, different path, `undeclared-resource`. Patterns are indexed by path and have no native identifier, so no escape is possible that way.
- Budgets (`broker/budget/reserve`) use the same intersection as `broker/authorize`.

## RE2 in the broker

Today the broker evaluates a regular expression with the V8 engine, on input controlled by any client: the `{ pattern, flags }` form of `allowedOrigins` (`bin.ts`), tested against the `Origin` header of each HTTP request. The V8 engine uses backtracking: a poorly written expression from the operator, such as `^(https?://)?([a-z]+)+\.exemple\.fr$`, lets a client block the event loop with a single crafted header.

Measured in mcp-open-api (`bench/regex.mjs`, Node 22.20, Intel Core Ultra 7 255H), `^(a+)+$` on 29 characters:

| engine | time |
| --- | --- |
| V8 | 860 ms, doubling with each additional character |
| `re2js` | 1 µs |

On an ordinary pattern, `re2js` costs 0.1 to 0.6 µs, versus a few tens of nanoseconds for V8: negligible at the scale of a request.

**Proposal: the broker evaluates all of its regular expressions with `re2js`**: the `where` clauses of patterns, and `allowedOrigins`.

- `re2js` is pure JavaScript, 872 KB, with no dependencies, covered by the lockfile hash. mcp-open-api ruled out the native `re2` module (Node 22 and later only, binary downloaded without verification, `node-gyp` otherwise).
- It works with `--disallow-code-generation-from-strings`, which mcp-open-api proposes enabling by default.
- RE2 supports neither backreferences nor lookahead or lookbehind assertions. An expression it rejects makes startup fail with a message saying so, like the rest of the configuration since 1.4.1. **This is the only breaking change**: an `allowedOrigins.pattern` that uses `(?=` no longer starts.

## Performance

A check walks through the patterns of the relevant declaration and the `resourceLimits`. Patterns are compiled when the declaration is accepted and when the security file is loaded, never during a decision. So that the cost does not grow with the number of patterns, they are indexed by their leading literal segments.

Target, to be measured in a benchmark: under 10 µs per check with 1,000 declared patterns.

## Lots

| lot | content | acceptance criterion |
| --- | --- | --- |
| 1 | `re2js` for `allowedOrigins`; startup error if RE2 rejects the expression | a crafted `Origin` header against a vulnerable pattern responds in under one millisecond |
| 2 | `resourcePattern` and `where` in declarations; intersection; `empty-limits`; `limitSources` in the audit | a `/nord/valves/{id}` declaration at 0-100 and a `V-1\d{2}` pattern at 60 give `maxValue: 60` for `V-123`, `100` for `V-012` |
| 3 | `authorization.resourceLimits` in the security file; `policyVersion`; views in `broker_info` and `_broker` | an operator limit tightens without touching the declaration; removing it changes `policyVersion` |
| 4 | budgets on the same intersection; `broker_diagnose`; performance benchmark | the benchmark meets the target with 1,000 patterns |

The test kit (`startTestBroker`) accepts the two new forms starting with lot 2 (declarations) and lot 3 (`policy.resourceLimits`).

## Documentation to update

`docs/authorization.md`, the "Declared authorization" section of `AGENTS.md`, the `broker_guide` guide (topic `publish-provider`), `node/packages/broker/docs/config.md` for `allowedOrigins` and `resourceLimits`, `node/packages/broker/docs/testing.md`.

## Open questions

- **Validity period.** An operator limit for a maintenance window has an end. Should `resourceLimits` have an `until` (date), or should the operator be left to remove it?
- **Limits without a declaration.** A `resourceLimits` entry on a path that no provider has declared: refused at load time, or accepted and applied as soon as a declaration covers that path? The second option allows limits to be set before the provider's first startup.
- **`where` on `*`.** Should constraining an anonymous `*` be allowed, or only named segments?
