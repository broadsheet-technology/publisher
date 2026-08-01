# Publisher

Reusable GitHub workflow for building, publishing, and deleting ARM64 GHCR container images.

Reference the workflow using:

```yaml
uses: broadsheet-technology/publisher/.github/workflows/publish.yml@v2
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
    uses: broadsheet-technology/publisher/.github/workflows/publish.yml@v2
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
    uses: broadsheet-technology/publisher/.github/workflows/publish.yml@v2
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

## Prebuild Node.js Applications

TypeScript and JavaScript output is architecture-independent. Set `prebuild-node: true` to run `npm ci` and `npm run build` directly on the runner before assembling the container:

```yaml
jobs:
  image:
    uses: broadsheet-technology/publisher/.github/workflows/publish.yml@v2
    with:
      image: ghcr.io/${{ github.repository }}
      tags: latest
      prebuild-node: true
      node-version: "20"
```

The corresponding Dockerfile should be a runtime-only image. If the compiled application has no external runtime dependencies, it can avoid target-platform `RUN` instructions entirely:

```dockerfile
FROM node:20-alpine

WORKDIR /app

COPY --chown=10001:10001 dist/src ./dist/src

USER 10001:10001

CMD ["node", "dist/src/index.js"]
```

If the application needs production dependencies at runtime, bundle them during compilation or copy the required production dependencies into the runtime image.

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

| Input           | Required | Default | Description                                                                          |
| --------------- | -------- | ------- | ------------------------------------------------------------------------------------ |
| `image`         | yes      |         | Full GHCR image name without a tag, e.g. `ghcr.io/broadsheet-technology/my-service`. |
| `tags`          | no       | `""`    | Newline- or comma-separated tags to build and publish.                               |
| `delete-tags`   | no       | `""`    | Newline- or comma-separated tags to delete from GHCR.                                |
| `prebuild-node` | no       | `false` | Run `npm ci` and `npm run build` before building the image.                          |
| `node-version`  | no       | `"20"`  | Node.js version used for the optional prebuild.                                      |

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
```
