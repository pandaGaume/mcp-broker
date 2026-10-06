# Workflow triggers

- `ci-node`, `ci-c` and `ci-dotnet` run on relevant pull requests into `main`,
  or manually through `workflow_dispatch`. They do not run again after a merge.
  A new push to the same PR cancels its obsolete CI run.
- Releases keep their full validation and publication steps, triggered only by
  the matching package's tag series.
- `ci-c` selects checks from the changed files: broker runtime changes run the
  C/Node roundtrip, host code runs native checks, shared `libmcpb` code runs all
  checks, and ESP-IDF changes run the firmware build. Manual runs check all targets.
- `pages` builds the existing Jekyll site from `docs/` only when that directory
  or its workflow changes on `main`. It can also be started manually. Deployment
  is restricted to `main`.

GitHub Pages must use **GitHub Actions** as its publishing source, replacing the
automatic branch-based build from `main:/docs`. The custom workflow preserves
Markdown rendering and the existing site URL. Changing the source preserves the
currently deployed site; merging this workflow triggers the next deployment.

Direct pushes to `main` do not run CI. Use a PR for changes, or manually start the
relevant CI workflow when a direct push needs validation.
