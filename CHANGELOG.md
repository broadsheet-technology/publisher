# Changelog

All notable changes to Publisher are documented in this file.

## [v5] - 2026-10-01

- Keep Node setup, versioning, tests/build, image tagging, publication, and cleanup in Publisher.
- Share Node preparation and Docker publishing through composite actions.
- Infer stage/release image tags and protect package versions with unrelated tags during cleanup.
- Consolidate metadata and release-label validation; derive recovery branches from PRs.
- Remove unused branch/label/runtime overrides, arbitrary command hooks, date versioning, automation-token inputs, and downstream release outputs.
- Keep explicit image/tag inputs and optional Node prebuild for existing image consumers.
- Squash each validated application release into one developer-attributed commit with contiguous `pr`, `merge`, and `version` trailers.
- Use `vX.Y.Z` consistently in project version files, release trailers, Git tags, and image tags.
- Remove temporary branch-testing triggers and pin Publisher's internal checkouts to `v5`.
- Publish the moving `v5` tag after successful tests on `main`; preserve the `v1` through `v4` interfaces.

## [v4] - 2026-08-04

### Added

- Add the optional `BT_PACKAGE_TOKEN` reusable-workflow secret for private GitHub Packages dependencies, with `github.token` as the fallback.
- Add the `prune-node` input to remove development dependencies after a successful worker-side build.
- Add static workflow coverage for the v4 interface, npm token isolation, Node preparation conditions, and documentation references.

### Changed

- Use Node.js 24 by default for worker-side Node preparation.
- Document runtime-only Dockerfiles for packaging worker-prepared build output and production dependencies.

## [v3] - 2026-08-03

### Changed

- Configure worker-side npm installs for the `@broadsheet-technology` scope at `https://npm.pkg.github.com`.
- Authenticate worker-side dependency installation with the reusable workflow's `github.token`.

## [v2]

### Changed

- Replace the root composite action with a reusable workflow at `.github/workflows/publish.yml`.
- Run image builds on the native GitHub-hosted `ubuntu-24.04-arm` runner.
- Add persistent GitHub Actions BuildKit caching scoped by image name.
- Add optional runner-native Node.js dependency installation and compilation.
- Disable Docker build summaries and build-record artifact uploads.
- Support deleting container package versions owned by personal accounts as well as organizations.
- Treat missing packages and tags as silent, idempotent deletion successes while surfacing other lookup errors.

### Removed

- Remove the root `action.yml` composite-action interface.
- Remove QEMU setup because v2 builds run natively on ARM64.

## [v1] - 2026-06-19

### Added

- Provide the `broadsheet-technology/publisher@v1` composite action.
- Build and publish `linux/arm64` images from the repository-root `Dockerfile`.
- Accept explicit newline- or comma-separated image tags.
- Delete GHCR tags for organization-owned container packages.
- Normalize, validate, and deduplicate publish and deletion tags.
- Set up QEMU and Docker Buildx for ARM64 builds on x64 GitHub-hosted runners.

### Supported interface

Version 1 was consumed as a workflow step:

```yaml
- uses: broadsheet-technology/publisher@v1
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    image: ghcr.io/${{ github.repository }}
    tags: latest
```

The v1 interface remains documented for repositories pinned to the `v1` tag. New integrations should use the v2 reusable workflow.
