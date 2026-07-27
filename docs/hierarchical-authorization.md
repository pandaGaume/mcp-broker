# Hierarchical authorization

The broker can authorize MCP operations across a stable, domain-neutral
resource hierarchy. The model has three independent dimensions:

| Question | Configuration | Example |
|---|---|---|
| Who is calling? | JWT subjects | `group:maintenance-area-a` |
| What may they do? | Role capabilities | `mcp.tools.diagnose` |
| Where may they do it? | Resource path assignment | `/enterprise/site/area/**` |

Authorization is evaluated as:

```text
authorize(subject, capability, resourcePath) -> allow or deny
```

The broker remains an OAuth 2.1 resource server and enforcement point. It does
not issue identities, manage users, or replace the external authorization
server.

## Resource paths answer "where"

Resource paths are stable identities separated from slot names, transports,
hostnames, and IP addresses:

```text
/enterprise-a/site-paris/area-utilities/line-3/cell-2/compressor-03
```

Rules:

- Paths start with `/` and are case-sensitive.
- Empty intermediate segments, `.` and `..` are rejected.
- A final slash is normalized away.
- `*` in a policy matches exactly one segment.
- A final `**` matches the named resource and every descendant.
- Arbitrary regular expressions are not supported.

Examples:

| Pattern | Matches | Does not match |
|---|---|---|
| `/enterprise/site/area` | That exact area | Its children |
| `/enterprise/site/*` | Direct children of the site | Grandchildren |
| `/enterprise/site/**` | The site and every descendant | A sibling site |

Technical provider names may be mapped independently:

```json
{
  "auth": {
    "slotResources": {
      "spoony-00452": "/enterprise-a/site-paris/area-a/line-3/cell-2/motor-7"
    }
  }
}
```

Unmapped normal slots resolve to `/<slot>`. The reserved `_broker` slot resolves
to `/_system/broker`.

## Roles answer "what"

A role contains functional capabilities only. It never contains a resource
path:

```json
{
  "auth": {
    "roles": {
      "viewer": {
        "capabilities": [
          "mcp.resources.read",
          "mcp.tools.list",
          "mcp.prompts.read"
        ]
      },
      "maintenance": {
        "inherits": ["viewer"],
        "capabilities": [
          "mcp.tools.call",
          "mcp.tools.diagnose"
        ]
      },
      "administrator": {
        "capabilities": ["*"]
      }
    }
  }
}
```

Inheritance is expanded at startup. Duplicate capabilities are removed.
Undefined inherited roles and inheritance cycles stop startup. `*` grants every
capability within the resource paths assigned to that role.

The built-in MCP classification is:

| MCP operation | Capability |
|---|---|
| `resources/list`, `resources/read` | `mcp.resources.read` |
| `tools/list` | `mcp.tools.list` |
| `tools/call` | Configured tool capability, otherwise `mcp.tools.call` |
| `prompts/list`, `prompts/get` | `mcp.prompts.read` |
| `completion/complete` | `mcp.completion.use` |

Tool names are never interpreted as capabilities. Configure them explicitly:

```json
{
  "auth": {
    "toolCapabilities": {
      "diagnose_motor": "mcp.tools.diagnose",
      "start_motor": "mcp.tools.operate"
    },
    "providerToolCapabilities": {
      "/enterprise-a/site-paris/**": {
        "start_motor": "mcp.tools.site-operate"
      }
    }
  }
}
```

Provider-qualified mappings win over global mappings. The fallback is
`mcp.tools.call`.

For `_broker`, catalog and read-only introspection operations use
`broker.providers.read`. Existing `perSlotScopes["_broker"]` remains a coarse
OAuth gate evaluated first.

## JWT subjects answer "who"

Subjects are derived only from validated JWT claims. Values supplied inside an
MCP request are never trusted:

```json
{
  "auth": {
    "subjectMapping": {
      "userClaim": "sub",
      "groupClaims": ["groups", "realm.roles"],
      "clientClaim": "client_id"
    }
  }
}
```

This token:

```json
{
  "sub": "alice",
  "groups": ["maintenance-area-a", "employees"],
  "client_id": "local-assistant"
}
```

produces:

```text
user:alice
group:maintenance-area-a
group:employees
client:local-assistant
```

String and string-array claims are accepted. Missing optional claims are
ignored. A configured claim with another shape fails authorization safely.
Duplicate subjects are removed. Subject prefixes are extensible; the initial
model recognizes `user:`, `group:`, `client:`, and `service:`.

## Assign roles to subjects and paths

Assignments combine all three dimensions:

```json
{
  "auth": {
    "assignments": [
      {
        "id": "maintenance-area-a",
        "subject": "group:maintenance-area-a",
        "role": "maintenance",
        "resource": "/enterprise-a/site-paris/area-a/**"
      }
    ]
  }
}
```

A provider that later connects anywhere below that subtree is governed
automatically. No per-provider assignment is needed.

All identities derived for a caller participate in evaluation. An allow from
any matching assignment is enough, unless an explicit deny also matches.
Absence of a matching allow is a deny.

## Explicit deny

Denies handle exceptions without fragmenting stable roles:

```json
{
  "auth": {
    "denies": [
      {
        "id": "protect-critical-furnace",
        "subject": "group:maintenance-area-a",
        "capabilities": [
          "mcp.tools.configure-analysis",
          "mcp.tools.operate"
        ],
        "resource": "/enterprise-a/site-paris/area-a/line-2/cell-4/critical-furnace"
      }
    ]
  }
}
```

An explicit deny always overrides an allow, regardless of declaration order or
whether the deny is exact or inherited through `**`. A capability of `*` denies
all operations on matching resources.

## Provider namespace restrictions

Client authorization and provider authentication remain independent. A custom
provider authenticator may return a structured principal:

```ts
interface IProviderPrincipal {
  id: string;
  subjects?: readonly string[];
  allowedResources?: readonly string[];
  metadata?: Readonly<Record<string, unknown>>;
}
```

For example, a device principal with:

```text
id: device:serial-00452
allowedResources: /enterprise-a/site-paris/area-a/line-3/**
```

may publish `/enterprise-a/site-paris/area-a/line-3/cell-2/motor-7`, but cannot
publish a sibling line or a parent site. Dedicated provider connections are
rejected during the WebSocket upgrade. Multiplexed provider connections check
every announced slot separately.

The legacy shared secret returns an unrestricted principal with
`allowedResources: ["**"]`, preserving existing deployments. The abstraction is
compatible with a future mTLS authenticator.

## Enforcement and confidentiality

Coarse OAuth scopes run before hierarchical policy checks. Policies apply to
direct HTTP, SSE, and WebSocket operations.

For `_all`:

- Provider catalogs are filtered using the caller's policy.
- Tool calls are checked with their configured functional capability.
- A forbidden provider or tool produces the same response as an unknown one.
- Legacy `providerScopes`, when present, is also required to pass.

Provider names, tool names, and resource paths are not disclosed through a
distinct forbidden response.

Denied operations produce structured audit records containing subject ids,
client id, slot, resource, capability, provider, tool, decision reason, and
matching policy ids. Tokens and secrets are never logged. Allowed decisions are
not logged unless:

```json
{
  "auth": {
    "audit": {
      "logAllowed": true
    }
  }
}
```

## Small installation

A small installation can use one root hierarchy and two roles:

```json
{
  "auth": {
    "roles": {
      "viewer": {
        "capabilities": [
          "mcp.resources.read",
          "mcp.tools.list",
          "mcp.prompts.read"
        ]
      },
      "operator": {
        "inherits": ["viewer"],
        "capabilities": ["mcp.tools.operate"]
      }
    },
    "assignments": [
      {
        "subject": "group:employees",
        "role": "viewer",
        "resource": "/enterprise/**"
      },
      {
        "subject": "group:operators",
        "role": "operator",
        "resource": "/enterprise/**"
      }
    ]
  }
}
```

## Large installation

Keep roles global and stable, then assign them at site or area boundaries:

```json
{
  "auth": {
    "roles": {
      "viewer": {
        "capabilities": ["mcp.resources.read", "mcp.tools.list"]
      },
      "maintenance": {
        "inherits": ["viewer"],
        "capabilities": [
          "mcp.tools.diagnose",
          "mcp.tools.configure-analysis"
        ]
      },
      "operator": {
        "inherits": ["viewer"],
        "capabilities": ["mcp.tools.operate"]
      }
    },
    "assignments": [
      {
        "id": "paris-maintenance",
        "subject": "group:maintenance-paris",
        "role": "maintenance",
        "resource": "/enterprise-a/site-paris/**"
      },
      {
        "id": "line-3-operators",
        "subject": "group:operators-line-3",
        "role": "operator",
        "resource": "/enterprise-a/site-paris/area-a/line-3/**"
      },
      {
        "id": "central-observers",
        "subject": "group:central-observers",
        "role": "viewer",
        "resource": "/enterprise-a/**"
      }
    ]
  }
}
```

## Migration from `providerScopes`

Existing OAuth configurations remain valid and preserve their prior behavior
when no roles, assignments, or denies are configured.

To migrate:

1. Keep `requiredScopes` and `perSlotScopes` as coarse OAuth gates.
2. Create stable functional roles from the operations users perform.
3. Map technical slots to stable resource paths with `slotResources`.
4. Map JWT claims to canonical subjects.
5. Replace each `providerScopes` entry with one or more subtree assignments.
6. Test `_all` visibility and direct calls.
7. Remove `providerScopes` after the equivalent policies are verified.

While both models are configured, both restrictions must pass.
`providerScopes` is deprecated and emits a startup warning.

All policies are compiled, validated, and made immutable at startup. Invalid
paths, duplicate ids, unknown roles, role cycles, malformed capabilities, and
reserved path misuse stop startup rather than weakening authorization.
