# Changelog

All notable changes to Publisher are documented in this file.

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
