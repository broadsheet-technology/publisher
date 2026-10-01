#!/usr/bin/env bash
set -euo pipefail

: "${INTEGRATION_BRANCH:?}"
: "${SOURCE_MERGE:?}"
RELEASE_BRANCH=main
git check-ref-format "refs/heads/$INTEGRATION_BRANCH"
if [ "$INTEGRATION_BRANCH" = "$RELEASE_BRANCH" ]; then
  echo '::error::Cannot delete the release branch.'
  exit 1
fi
tip="$(git ls-remote --refs origin "refs/heads/$INTEGRATION_BRANCH" | cut -f1)"
if [ -z "$tip" ]; then exit 0; fi
git push "--force-with-lease=refs/heads/$INTEGRATION_BRANCH:$SOURCE_MERGE" origin ":refs/heads/$INTEGRATION_BRANCH"
