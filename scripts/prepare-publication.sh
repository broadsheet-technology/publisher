#!/usr/bin/env bash
set -euo pipefail

RELEASE_BRANCH=main
: "${INTEGRATION_BRANCH:?}"
: "${SOURCE_MERGE:?}"
git check-ref-format "refs/heads/$RELEASE_BRANCH"
git check-ref-format "refs/heads/$INTEGRATION_BRANCH"
git fetch --tags origin "+refs/heads/$RELEASE_BRANCH:refs/remotes/origin/$RELEASE_BRANCH"
tip="$(git ls-remote --refs origin "refs/heads/$INTEGRATION_BRANCH" | cut -f1)"
if [ "$tip" != "$SOURCE_MERGE" ]; then
  echo '::error::The integration branch changed before publication.'
  exit 1
fi
if [ "$(git rev-parse HEAD)" != "$SOURCE_MERGE" ]; then
  echo '::error::The checkout is not the source merge.'
  exit 1
fi
source "$(dirname "${BASH_SOURCE[0]}")/publication-history.sh"
if is_published "$SOURCE_MERGE" "refs/remotes/origin/$RELEASE_BRANCH"; then
  echo '::error::This candidate is already on the release branch; reconcile the existing release instead of publishing it again.'
  exit 1
fi
git config user.name 'github-actions[bot]'
git config user.email '41898282+github-actions[bot]@users.noreply.github.com'
git merge --no-edit "refs/remotes/origin/$RELEASE_BRANCH"
echo "base=$(git rev-parse "refs/remotes/origin/$RELEASE_BRANCH")" >> "${GITHUB_OUTPUT:-/dev/stdout}"
