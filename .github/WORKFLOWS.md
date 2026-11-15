# Workflow triggers

- `ci-node`, `ci-c` and `ci-dotnet` run on relevant pull requests into `main`,
  or manually through `workflow_dispatch`. They do not run again after a merge.
  A new push to the same PR cancels its obsolete CI run.
- Releases keep their full validation and publication steps, triggered only by
  the matching package's tag series.
- `ci-c` selects checks from the changed files: broker runtime changes run the
  C/Node roundtrip, host code runs native checks, shared `libmcpb` code runs all
  checks, and ESP-IDF changes run the firmware build. Manual runs check all targets.
- `pages` stages the site with `node/scripts/build-site.mjs --stage` (`docs/`,
  the repository documents mirrored at their paths with links rewritten,
  `llms.txt`, `llms-full.txt`, `sitemap.xml`, `robots.txt`), then builds it with
  Jekyll. It runs when `docs/`, a mirrored document, `broker.guides.ts`, the
  script or the workflow changes on `main`. It can also be started manually. Deployment
  is restricted to `main`. A broker release refreshes it without a trigger of
  its own: the `version` lifecycle script rewrites the version badges in
  `docs/*.html`, so the release commit changes `docs/`.
- `ci-docs` runs `node/scripts/sync-versions.mjs --check` on pull requests that
  touch the README, `docs/`, the broker's `package.json` or `.mcpb` manifest,
  `mcpb.h`, a mirrored document or `broker.guides.ts`. It fails when a version or
  a description there contradicts its source (the package version,
  `MCPB_VERSION_STRING`, `docs/positioning.md`), when `docs/guide/` is stale, or
  when a published document has a broken relative link. `npm run docs:sync`
  from `node/` fixes the first two kinds.

GitHub Pages must use **GitHub Actions** as its publishing source, replacing the
automatic branch-based build from `main:/docs`. The custom workflow preserves
Markdown rendering and the existing site URL. Changing the source preserves the
currently deployed site; merging this workflow triggers the next deployment.

Direct pushes to `main` do not run CI. Use a PR for changes, or manually start the
relevant CI workflow when a direct push needs validation.
