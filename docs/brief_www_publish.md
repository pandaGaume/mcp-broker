# Brief: a provider publishes a page into the broker's static content

Status: proposal, 2026-10-06. Requested by mcp-open-api, for the Tier 4 page of its designer.

## In one sentence

Today, the broker serves static content only from `www.mounts[]`, fixed at startup and read from disk. We propose that a connected provider, under an identity allowed to do so, push a small page that the broker serves under `/ui/<slot>/` for as long as the provider is connected.

## Why

A provider that needs a human in the loop has to show that human a page: mcp-open-api's designer, where an operator reviews and signs a slot before it is published; a SCADA approval page; a maintenance console. Serving that page from the provider's own port puts it on another origin, outside `allowedOrigins`, and makes the operator configure two addresses. Serving it from a config mount works only when the provider runs on the broker's machine, and the operator has to declare the folder by hand.

The page belongs on the broker's origin, next to the slot it drives, and it should come and go with its provider.

## The model

- **What is pushed**: a set of files, not a folder path. The broker never reads the provider's disk.
- **Where it is served**: `/ui/<slot>/`, the slot the push came from. A provider cannot choose another prefix, so two providers never share one, and a pushed page never shadows a config mount.
- **How long**: as long as a provider is connected to that slot. After a disconnection, `/ui/<slot>/` answers `503 provider not connected` with a short text body; the files are dropped.
- **Who may push**: a provider identity from the security file's `providers` table carrying `www: true`. Never an anonymous provider, never the shared secret.

## The method

The provider sends, on its socket, for its slot:

```json
{
  "jsonrpc": "2.0",
  "id": 7,
  "method": "broker/www/publish",
  "params": {
    "entry": "index.html",
    "files": [
      { "path": "index.html", "contentType": "text/html", "base64": "..." },
      { "path": "designer.js", "contentType": "text/javascript", "base64": "..." }
    ],
    "sha256": "<hex of the canonical file list>"
  }
}
```

The broker answers `{ "url": "/ui/designer/", "sha256": "...", "files": 2, "bytes": 18342 }`. A new push replaces the previous one as a whole: no partial update, no stale file left behind. `broker/www/unpublish` (no params) removes it before disconnecting.

Refusals are JSON-RPC errors, `-32602` for an invalid request with every problem in `error.data.errors`, `-32003` for an identity without `www: true`:

- a path with `..`, a leading `/`, a backslash, a control character, or more than 8 segments;
- a content type outside the accepted list;
- the total over the size cap, or more files than the file cap;
- an `entry` that is not one of the files;
- a `sha256` that does not match.

On the provider side, `transport.broker.publishWww(files, { entry })` in `@cyanmycelium/mcp-broker-provider` builds the request, and a Node helper `filesFromDir(dir)` reads a folder.

## Rules

| rule | proposed value |
| --- | --- |
| who can push | an identity from `providers` with `www: true` |
| size | 2 MB per page in total, 200 files |
| accepted types | HTML, JS, CSS, JSON, SVG, PNG, WOFF2 |
| served headers | `Content-Security-Policy: default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`, `Cache-Control: no-store`, `Referrer-Policy: no-referrer` |
| origin | the broker's: it must be listed in `allowedOrigins` like any self-served page (`self-served-page-blocked` otherwise) |
| lifetime | while a provider is connected to the slot; on takeover by a new provider, the page stays until the newcomer pushes or disconnects |
| trace | each push and each drop is audited with the slot, the identity, the `sha256` and the size |

The CSP has no `'unsafe-inline'`: a pushed page loads its scripts and styles from its own files. This rules out the commonest way a pushed page could run something it did not ship.

## Visibility

- `providers_list` and `provider_status` carry `www: { url, sha256, files, bytes, publishedAt }` for a slot with a page.
- The launcher page (when there is one) links to it.
- `broker_diagnose` reports `www-origin-not-allowed` when a page is published but the broker's own origin is not in `allowedOrigins`: every call from the page would be refused with 403, and the operator would see a page that cannot do anything.

## Security, plainly

A pushed page runs on the broker's origin. It can therefore call every HTTP route of the broker that the person viewing it can call, with the token that person gives it. It has no ambient right of its own: the broker sets no cookie, and a page cannot read a token another page holds in its own storage unless they share an origin, which they do. Two measures contain this:

- only an identity explicitly marked `www: true` can push;
- the operator decides which identities those are, in the security file, and each push is audited.

A separate origin per page (a subdomain or a second port) would isolate pages from each other. It is left as an open question, because it costs every deployment a DNS entry or a port.

## Compatibility

Additive. Config mounts are unchanged, and a pushed page never shadows one: `/ui/` is reserved for pushed pages, and a config mount under `/ui/` is refused at startup with a message naming the conflict.

## Lots

| lot | content | acceptance criterion |
| --- | --- | --- |
| 1 | `broker/www/publish` and `unpublish`, in-memory store per slot, `/ui/<slot>/` route with the headers above, `www: true` on provider identities | a provider pushes two files and they are served with the CSP; a disconnection gives 503; an identity without `www` is refused |
| 2 | `publishWww` and `filesFromDir` in the provider package; test kit: `providers: { x: { www: true } }` | mcp-open-api's designer pushes its page from a test |
| 3 | visibility: `providers_list`, `provider_status`, `broker_diagnose` (`www-origin-not-allowed`), launcher link, audit | a page published without its origin allowed is reported with its fix |

## Documentation to update

`AGENTS.md` (topology table: "a page a provider pushes"; anti-goals: the CSP and the reserved `/ui/` prefix), `docs/endpoints.md`, `docs/protocol.md`, the `broker_guide` topics `publish-provider` and `host-config`, the configuration guides for `providers[].www`.

## Open questions

Review questions added 2026-10-07. The recommendations below are proposals, not accepted decisions. Resolve them before implementation, then update the corresponding rules and acceptance criteria above.

### Origin, CSP and publishing permission

- [ ] Is a shared origin an accepted trust boundary, or is a separate origin per page worth its DNS or port configuration cost? With a shared origin, should the security section explicitly describe `www: true` as permission to execute code on the broker's origin and access origin-shared storage?
- [ ] Should the claim that a page loads scripts only from its published files be removed or replaced by a stronger mechanism? `script-src 'self'` permits scripts from the entire origin, including other providers' pages and config mounts; it does not confine scripts to this publication. Reference: [Content Security Policy Level 3](https://www.w3.org/TR/CSP/).
- [ ] Should the CSP add `base-uri 'none'` and `form-action 'self'`? Recommendation: add both explicitly, since neither falls back to `default-src`.
- [ ] Should `www` be a boolean, or a list of the slots an identity may push a page for? How does that permission combine with existing `allowedResources` checks?
- [ ] Is publication supported only for WebSocket providers authenticated through the security file, or also for embedded loopback providers and custom authenticators? If supported, how do those identities receive an explicit `www` permission?

### Lifetime and takeover

- [ ] May a page survive takeover by a different identity, or by a provider without `www: true`? Recommendation: retain it only when the incoming identity is the same and still authorized; otherwise drop it immediately. Keep the original publisher identity in publication metadata and audit events.
- [ ] Should a page survive a brief disconnection (served from memory for N seconds), so that a provider restart does not break an operator's open session? If so, what grace period applies, and does an identity change end it immediately?
- [ ] How are delayed close events or messages from the displaced connection handled? Recommendation: only the connection currently holding the slot may publish, unpublish or trigger disconnect cleanup.

### Memory and request limits

- [ ] Does "2 MB" mean 2,000,000 or 2,097,152 decoded bytes? Recommendation: specify an exact decoded-byte limit and a separate limit on the encoded JSON request, including base64 overhead.
- [ ] What total memory budget and publication count apply globally and per identity? A per-page cap alone does not bound memory when one provider can create many slots.
- [ ] How is the transient memory cost of an atomic replacement bounded while the old page, encoded request and decoded candidate coexist? Recommendation: check request size before decoding and account for pending replacements in the budgets.
- [ ] Which errors report global or per-identity quota exhaustion, and is the previous publication preserved on every refused replacement?

### Canonical digest and file validation

- [ ] What exact, versioned byte representation is hashed? Specify file ordering, string encoding, serialization and whether `entry`, paths, MIME types and decoded contents are included. Recommendation: cover all of them and provide a fixed input with its expected SHA-256 for broker and provider tests.
- [ ] Are duplicate paths, empty paths or segments, `.` segments, malformed base64 and unknown fields refused? What are the path-length limit, Unicode rules and case-sensitivity rules?
- [ ] What are the exact accepted MIME strings, including whether parameters such as `charset=utf-8` are allowed? Must the entry file be HTML, and must extensions agree with their MIME types?

### Routing and HTTP behavior

- [ ] How does reserving `/ui/` interact with the existing slot named `ui`, whose MCP endpoint is `/ui/mcp`, and with configurable endpoint paths? Specify route precedence and startup conflict validation before calling the change additive.
- [ ] How is a slot name encoded into one URL segment? Recommendation: percent-encode it, so a slot such as `a/b` has an unambiguous URL, and define decoding and rejection rules for malformed or ambiguous paths.
- [ ] Which mounts conflict with the reservation: `/ui`, descendants of `/ui/`, or a root mount containing files under `ui/`? Does an unpublished UI URL ever fall through to a config mount? Recommendation: give the reserved namespace explicit ownership and no fallback.
- [ ] What responses apply to an unknown slot, a connected slot without a page, an explicitly unpublished page and a page dropped on disconnect? Recommendation: `404` without a publication and `503` after provider loss; define how long any disconnect marker remains.
- [ ] Are only `GET` and `HEAD` supported? Define unsupported-method responses, missing-file responses, the redirect from `/ui/<slot>` to `/ui/<slot>/`, and whether subdirectories or SPA fallback are supported. Which security and cache headers also apply to redirects and errors?

### Node helper, diagnostics and audit

- [ ] Should `filesFromDir` be exported from a dedicated Node entry point so browser consumers never import filesystem modules? Recommendation: yes. Define recursion, MIME inference, symlink handling and whether files resolving outside the source directory are rejected.
- [ ] How does `www-origin-not-allowed` determine the public origin behind a reverse proxy or when multiple hostnames are used? Specify whether an explicit public URL is required and which forwarded headers, if any, are trusted.
- [ ] What audit event schema covers publication, replacement, unpublish, disconnect and identity-changing takeover? Specify publisher identity, reason, digest, file count, byte count and timestamp, and whether refused pushes are audited.
- [ ] How does the launcher discover publications added or removed after it loads, and do publication changes trigger the existing provider-resource update notifications?

### Acceptance criteria to add after arbitration

- [ ] Cover takeover with the same identity, a different identity and a successor without `www`, including late events from the old connection.
- [ ] Cover per-page, per-identity and global limits, encoded request limits, and peak memory during replacement.
- [ ] Cover a shared digest test vector, duplicate paths, malformed base64 and refused replacement preserving the old page.
- [ ] Cover the `ui` slot collision, config mount conflicts, encoded slot names, path decoding and every agreed HTTP state.
- [ ] Cover browser imports of the provider package, Node helper symlinks, reverse-proxy origin diagnostics, launcher updates and audit attribution.
