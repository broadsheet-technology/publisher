#!/usr/bin/env bash
set -euo pipefail

: "${RELEASE_BASE:?}"
: "${RELEASE_VERSION:?}"
: "${SOURCE_PR:?}"
: "${SOURCE_MERGE:?}"
: "${SOURCE_TITLE:?}"

# The validated tree becomes one commit directly on the main we prepared.
# Source author identity is retained for both author and committer.
git merge-base --is-ancestor "$RELEASE_BASE" HEAD
export GIT_AUTHOR_NAME="$(git show -s --format=%an "$SOURCE_MERGE")"
export GIT_AUTHOR_EMAIL="$(git show -s --format=%ae "$SOURCE_MERGE")"
export GIT_AUTHOR_DATE="$(git show -s --format=%aI "$SOURCE_MERGE")"
export GIT_COMMITTER_NAME="$GIT_AUTHOR_NAME"
export GIT_COMMITTER_EMAIL="$GIT_AUTHOR_EMAIL"
git config user.name "$GIT_AUTHOR_NAME"
git config user.email "$GIT_AUTHOR_EMAIL"
git add -A
tree="$(git write-tree)"
sha="$(printf '%s (#%s)\n\npr: #%s\nmerge: %s\nversion: %s\n' \
  "$SOURCE_TITLE" "$SOURCE_PR" "$SOURCE_PR" "$SOURCE_MERGE" "$RELEASE_VERSION" |
  git -c commit.gpgsign=false commit-tree "$tree" -p "$RELEASE_BASE")"
git checkout --detach "$sha"
echo "sha=$sha" >> "${GITHUB_OUTPUT:-/dev/stdout}"
