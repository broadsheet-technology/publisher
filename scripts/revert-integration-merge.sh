#!/usr/bin/env bash
set -euo pipefail

: "${INTEGRATION_BRANCH:?}"
: "${MERGE_SHA:?}"
RELEASE_BRANCH=main
git check-ref-format "refs/heads/$INTEGRATION_BRANCH"
git check-ref-format "refs/heads/$RELEASE_BRANCH"
if [ "$INTEGRATION_BRANCH" = "$RELEASE_BRANCH" ]; then
  echo '::error::Cannot revert on the release branch.'
  exit 1
fi
git fetch origin "+refs/heads/$RELEASE_BRANCH:refs/remotes/origin/$RELEASE_BRANCH"
source "$(dirname "${BASH_SOURCE[0]}")/publication-history.sh"
if is_published "$MERGE_SHA" "refs/remotes/origin/$RELEASE_BRANCH"; then
  echo '::error::Candidate was promoted; reconcile the existing release instead of reverting it.'
  exit 1
fi
if [ "$(git rev-parse HEAD)" != "$MERGE_SHA" ]; then
  echo '::error::Integration branch changed since the failed merge; manual recovery is required.'
  exit 1
fi
git config user.name 'github-actions[bot]'
git config user.email '41898282+github-actions[bot]@users.noreply.github.com'
if git rev-parse --verify "$MERGE_SHA^2" >/dev/null 2>&1; then
  git revert --no-edit -m 1 "$MERGE_SHA"
else
  git revert --no-edit "$MERGE_SHA"
fi
# This is a normal fast-forward push. A racing branch update cannot be lost.
git push origin "HEAD:refs/heads/$INTEGRATION_BRANCH"
