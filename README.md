# Publisher

Reusable GitHub Actions for developing, validating, building and publishing Node applications and Docker images.

Employs the following workflows:
- `pr-route.yml`: Routes pull requests to `merge/*` branches to run validation and integration workflows.
- `pr-validate.yml`: Validates pull request metadata.
- `validate-node.yml`: Validates Node applications.
- `publish-strategy.yml`: Publishes Node applications and Docker images.

## Current policy

- Release branch: `main`.
- Integration branch: `merge/<PR number>/<source branch>`.
- PR titles use Conventional Commit syntax.
- Exactly one of `release:major`, `release:minor`, `release:patch`, or
  `release:none` is required.
- Bot PRs and PRs labeled `base:main-authorized` may target `main` directly.
- Node builds use Node 24, `npm ci`, `npm run build`, and production dependency
  pruning. Validation also runs `npm test`.
- Images use `ghcr.io/<repository>` and `linux/arm64` by default.

## Pull requests

Call `pr-route.yml` from `pull_request_target` for opened/reopened PRs. It creates
the PR's integration branch from current `main` and retargets the PR. Routing is
idempotent and never overwrites an existing integration branch.

Call `pr-validate.yml` for metadata checks, after routing when both run in the
same workflow. It reads current PR metadata through the API rather than the
possibly stale triggering event. Call `validate-node.yml` on `pull_request` to
install dependencies, run tests, and build. Application code must not run from
a `pull_request_target` job.

```yaml
jobs:
  metadata:
    uses: broadsheet-technology/publisher/.github/workflows/pr-validate.yml@v5
  application:
    uses: broadsheet-technology/publisher/.github/workflows/validate-node.yml@v5
    secrets:
      BT_PACKAGE_TOKEN: ${{ secrets.BT_PACKAGE_TOKEN }}
```

Metadata needs `contents: read` and `pull-requests: read`. Application validation
needs `contents: read` and `packages: read`. Routing needs `contents: write` and
`pull-requests: write`. A caller can use `needs: route` to order metadata checks.

## Release a Node application

```yaml
name: Publish Release
on:
  push:
    branches: ["merge/**"]
permissions:
  contents: write
  pull-requests: write
  packages: write
jobs:
  publish:
    uses: broadsheet-technology/publisher/.github/workflows/publish-strategy.yml@v5
    secrets:
      BT_PACKAGE_TOKEN: ${{ secrets.BT_PACKAGE_TOKEN }}
```

Only a push matching a merged PR's exact integration branch and merge SHA can
publish. Branch creation/deletion, refresh pushes, recovery commits, and stale
candidates are skipped. The workflow:

1. Merges current `main` into the candidate and fetches release tags.
2. Calculates the semantic version from the newest stable `vX.Y.Z` tag and the
   source PR's release label, starting at `v0.0.0` when there are no release tags.
3. Writes the `vX.Y.Z` version to `package.json` and the project entries in
   `package-lock.json`, tests, builds, and prunes.
4. Squashes the validated changes and version update into one commit directly
   on current `main`, with the PR title and number. Both author and committer
   use the source merge's author identity. The commit has `pr`,
   `merge`, and `version: vX.Y.Z` trailers. It is fast-forwarded
   to `main` and tagged `vX.Y.Z`.
5. Publishes the prepared checkout with the release SHA, `vX.Y.Z`, and
   `latest` image tags.
6. Deletes the integration branch only after image publication succeeds,
   refreshes other open integration bases, and reports the outcome on the PR.

All release steps, including the image push, share one serialization group.
There is no downstream push-trigger dependency: `GITHUB_TOKEN` pushes do not
start another push workflow. Images use the generated release commit, not the
original integration merge SHA. Publisher scripts live outside the application
checkout and are not included in release commits or Docker contexts.

Publication and recovery recognize already published candidates by their
`merge` trailers (or ancestry for older releases), preventing a squash
release from being published twice or reverted as a failed candidate.

A failed test/build leaves `main` unchanged. A failure after promotion leaves
the release on `main`; retry the image workflow on the release tag rather than
reverting a published candidate. Cleanup and refresh failures are reported
separately. A successful standalone image retry does not remove a retained
integration branch automatically.

## Images and staging

Use `publish.yml` for direct pushes to `main`, manual image retries, and PR
staging. The workflow infers tags when explicit tags are omitted:

- A PR labeled `stage` publishes `stage-pr-<number>`.
- Closing the PR or removing `stage` requests deletion of that tag.
- Other events publish the checked-out SHA, the package version, and `latest`.

```yaml
name: Stage Image
on:
  pull_request:
    types: [opened, synchronize, reopened, labeled, unlabeled, closed]
permissions:
  contents: read
  packages: write
jobs:
  image:
    uses: broadsheet-technology/publisher/.github/workflows/publish.yml@v5
    with:
      prebuild-node: true
    secrets:
      BT_PACKAGE_TOKEN: ${{ secrets.BT_PACKAGE_TOKEN }}
```

The same job can be used under `push: {branches: [main]}` and
`workflow_dispatch` for release image retries. Select the release tag when
starting a manual retry. Stage publishing is limited to same-repository PRs.
Deletion-only runs do not check out or build application code.

| Input | Default | Use |
| --- | --- | --- |
| `image` | `ghcr.io/<repository>` | An explicit GHCR package name. |
| `tags` | inferred | Newline/comma-separated raw tags to publish. |
| `delete-tags` | inferred for PRs | Newline/comma-separated raw tags to remove. |
| `prebuild-node` | `false` | Prepare Node output and production dependencies before Docker. |

Explicit tags take precedence over inference and support non-Node images.
The Docker build uses the repository-root `Dockerfile` and prepared checkout
as its context, with persistent BuildKit caching per image. Node runtime
Dockerfiles can copy `package*.json`, `node_modules`, and `dist`.

GHCR deletes whole package versions, not individual tags. Cleanup preserves
versions that also carry tags outside the requested deletion set and emits a
warning. This prevents stage cleanup from deleting a shared release image.
Missing packages/versions are idempotent successes; authorization errors fail.

## Authentication

`BT_PACKAGE_TOKEN` is the one optional secret on Node validation, release, and
image workflows. It falls back to the caller's `github.token` and is supplied
only to npm package operations, never to Docker. The selected token needs read
access to private dependencies. GHCR login always uses `github.token`.

Consumers must allow release commits and tags to be pushed by their workflow
token and provide the semantic release labels and `stage` label. Configure
required metadata/application checks for `merge/**`.

## Recovery and refresh

`recover-publication.yml` accepts `source-pr` and `merge-sha`. It derives the
integration branch from the PR and checks that the failed merge belongs to it.
It refuses already-promoted candidates and changed branch tips, then reverts
the failed merge with a normal fast-forward push. Multi-commit rebase merges
require manual recovery; use a merge commit for a recoverable first release.
It applies `publication:failed` and attempts to reopen the source PR. If GitHub
refuses reopening a merged PR, the comment says to create a follow-up PR.

`refresh-integrations.yml` can be called on direct pushes to `main`. Releases
also invoke refresh directly after promotion, including when an image push
fails. Refresh only fast-forwards open integration branches and preserves
concurrent merges and divergent work.

Release, recovery, refresh, and standalone release-image runs share
`publish-<repository>` concurrency with `queue: max`. Stage images serialize
per PR. Do not add the publisher's concurrency group to a caller workflow;
that would make caller and callee wait on each other.

## Releasing Publisher

Merge Publisher changes to `main`. After the Publisher Tests job passes on a
push to `main`, the release job creates or updates the moving `v5` tag to that
tested commit. PRs and other branches cannot update the release tag; outdated
runs cannot move it back after a newer main commit has been tested.

All reusable workflows check out Publisher's scripts and composite actions
from `v5`. Merge and release Publisher before merging consumers that switch
to the v5 interface. Existing `v1` through `v4` tags are unchanged.

## Development

```sh
node --test tests/*.test.cjs
```

Tests use Node, Ruby's YAML parser, npm, and temporary local Git repositories;
they do not publish images or contact GitHub. They cover routing races, current
metadata, version updates before validation, exact image tags, shared-tag
cleanup, concurrent release branches, failed promotion, and recovery.
