# Publisher

Reusable GitHub workflow for building, publishing, and deleting ARM64 GHCR container images.

Reference the workflow using:

```yaml
uses: broadsheet-technology/publisher/.github/workflows/publish.yml@v4
```

## Examples

The reusable workflow is the preferred interface. It runs on GitHub's native `ubuntu-24.04-arm` runner, so ARM64 builds do not require QEMU.

### Publish

Recommended workflow for publishing an image on pushes to `main`:

```yaml
name: Publish Image

on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read
  packages: write

jobs:
  image:
    uses: broadsheet-technology/publisher/.github/workflows/publish.yml@v4
    with:
      image: ghcr.io/${{ github.repository }}
      tags: |
        ${{ github.sha }}
        latest
```

The workflow publishes exactly the tags listed under `tags`.

Some other common tag choices:

| Tag                                | Use when                                                                           |
| ---------------------------------- | ---------------------------------------------------------------------------------- |
| `${{ github.sha }}`                | You want an immutable tag for the exact commit. Recommended for every publish.     |
| `latest`                           | You want a moving production tag for the current `main` image.                     |
| `release-${{ github.run_number }}` | You want a monotonically increasing workflow release tag.                          |
| `${{ github.ref_name }}`           | You publish from Git tags or named branches and want the Git ref as the image tag. |
| `v1.2.3`                           | Your workflow computes or receives an explicit semantic version.                   |

### Staging PR Images

To manage development deployments, you can publish a staging image for pull requests driven by a specific label, or other pull request state.

This example publishes `stage-pr-<number>` when a pull request has the `stage` label. It deletes that tag when the label is absent or the pull request closes.

```yaml
name: Staging Image

on:
  pull_request:
    types: [opened, synchronize, reopened, labeled, unlabeled, closed]

permissions:
  contents: read
  packages: write
  pull-requests: read

jobs:
  image:
    uses: broadsheet-technology/publisher/.github/workflows/publish.yml@v4
    with:
      image: ghcr.io/${{ github.repository }}
      tags: >-
        ${{ github.event.action != 'closed' &&
            contains(github.event.pull_request.labels.*.name, 'stage') &&
            format('stage-pr-{0}', github.event.pull_request.number) || '' }}
      delete-tags: >-
        ${{ (github.event.action == 'closed' ||
            !contains(github.event.pull_request.labels.*.name, 'stage')) &&
            format('stage-pr-{0}', github.event.pull_request.number) || '' }}
```

## Prepare Node.js Applications on the Worker

Set `prebuild-node: true` to install dependencies and build directly on the native ARM64 worker before Docker packages the prepared files. Set `prune-node: true` to run `npm prune --omit=dev --no-audit` after the build, leaving production dependencies in `node_modules`. The default Node.js version is 24.

```yaml
jobs:
  image:
    uses: broadsheet-technology/publisher/.github/workflows/publish.yml@v4
    with:
      image: ghcr.io/${{ github.repository }}
      tags: latest
      prebuild-node: true
      prune-node: true
      node-version: "24"
    secrets:
      BT_PACKAGE_TOKEN: ${{ secrets.BT_PACKAGE_TOKEN }}
```

`BT_PACKAGE_TOKEN` is optional. It is exposed as `NODE_AUTH_TOKEN` only while npm installs dependencies so private `@broadsheet-technology` packages can be installed from GitHub Packages. When the secret is omitted, Publisher uses the caller's `github.token`, preserving the existing prebuild behavior. The package token is never passed to Docker; GHCR login continues to use `github.token`.

Consumers using worker-prepared production dependencies should use a runtime-only Dockerfile that copies the build output and `node_modules` without running npm:

```dockerfile
FROM node:24-bookworm-slim

WORKDIR /app

COPY --chown=10001:10001 package.json ./
COPY --chown=10001:10001 dist ./dist
COPY --chown=10001:10001 node_modules ./node_modules

USER 10001:10001

CMD ["node", "dist/src/index.js"]
```

Native dependencies built on the Ubuntu worker require a compatible Linux/glibc runtime image. Do not copy Ubuntu-built `node_modules` into an Alpine/musl image. If the application has no runtime dependencies, it can instead copy only its compiled output.

## Dockerfile Build Cache

The publisher imports and exports persistent GitHub Actions BuildKit cache automatically. Dockerfiles that still install Node.js dependencies inside the image should also isolate dependency installation and use an npm cache mount:

```dockerfile
# syntax=docker/dockerfile:1

FROM node:20-alpine AS build
WORKDIR /app

COPY package.json package-lock.json tsconfig.json ./

RUN --mount=type=cache,target=/root/.npm \
    npm ci --prefer-offline --no-audit

COPY src ./src
RUN npm run build
```

Keep dependency manifests before source code so source changes do not invalidate the dependency layer.

## Inputs

| Input           | Required | Default | Description                                                                                   |
| --------------- | -------- | ------- | --------------------------------------------------------------------------------------------- |
| `image`         | yes      |         | Full GHCR image name without a tag, e.g. `ghcr.io/broadsheet-technology/my-service`.          |
| `tags`          | no       | `""`    | Newline- or comma-separated tags to build and publish.                                        |
| `delete-tags`   | no       | `""`    | Newline- or comma-separated tags to delete from GHCR.                                         |
| `prebuild-node` | no       | `false` | Run `npm ci` and `npm run build` before building the image.                                   |
| `prune-node`    | no       | `false` | When prebuilding, prune development dependencies after the build.                             |
| `node-version`  | no       | `"24"`  | Node.js version used for the optional prebuild.                                               |

## Secrets

| Secret             | Required | Description                                                                                                            |
| ------------------ | -------- | ---------------------------------------------------------------------------------------------------------------------- |
| `BT_PACKAGE_TOKEN` | no       | Token for private GitHub Packages dependencies. Falls back to `github.token`; used only as npm's `NODE_AUTH_TOKEN`.    |

## Notes

- Publishing uses the repository root as the Docker build context and `Dockerfile` as the Dockerfile.
- Publishing always targets `linux/arm64` for every GHCR tag.
- BuildKit cache is stored in GitHub Actions cache and scoped to the full image name.
- Build summaries and build-record artifact uploads are disabled.
- Publishing runs natively on `ubuntu-24.04-arm`; QEMU is not installed.
- Deletion supports GHCR packages owned by either organizations or personal accounts.
- Deleting a tag that does not exist, including before a package's first publish, succeeds without output.
- GHCR lookup failures other than a missing package are reported and fail the workflow.

## Test

Run the tests with:

```sh
./tests/plan-tags.test.sh
./tests/delete-tags.test.sh
./tests/workflow.test.sh
```
