# Publisher

GitHub Action for building, publishing, and deleting GHCR container images.

Reference the action using:

```yaml
uses: broadsheet-technology/publisher@v1
```

## Examples

Two common use cases are publishing production images on pushes to `main` and publishing/deleting staged images for active pull requests. Below are example workflows for these two cases:

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
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: broadsheet-technology/publisher@v1
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          image: ghcr.io/${{ github.repository }}
          tags: |
            ${{ github.sha }}
            latest
```

The action publishes exactly the tags listed under `tags`.

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
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Publish staged image
        if: github.event.action != 'closed' && contains(github.event.pull_request.labels.*.name, 'stage')
        uses: broadsheet-technology/publisher@v1
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          image: ghcr.io/${{ github.repository }}
          tags: stage-pr-${{ github.event.pull_request.number }}

      - name: Delete staged image
        if: github.event.action == 'closed' || !contains(github.event.pull_request.labels.*.name, 'stage')
        uses: broadsheet-technology/publisher@v1
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          image: ghcr.io/${{ github.repository }}
          delete-tags: stage-pr-${{ github.event.pull_request.number }}
```

## Inputs

| Input          | Required | Description                                                                          |
| -------------- | -------- | ------------------------------------------------------------------------------------ |
| `github-token` | yes      | Token for GHCR login and tag deletion.                                               |
| `image`        | yes      | Full GHCR image name without a tag, e.g. `ghcr.io/broadsheet-technology/my-service`. |
| `tags`         | no       | Newline or comma-separated tags to build and publish.                                |
| `delete-tags`  | no       | Newline or comma-separated tags to delete from GHCR.                                 |

## Notes

- Publishing uses the repository root as the Docker build context and `Dockerfile` as the Dockerfile.
- Publishing always targets `linux/arm64` for every GHCR tag.
- Deletion currently targets GHCR organization packages, which matches `ghcr.io/${{ github.repository }}` for organization-owned repositories.

## Test

Run `scripts/plan-tags.sh` tests with:

```sh
./tests/plan-tags.test.sh
```
