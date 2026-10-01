#!/usr/bin/env bash
set -euo pipefail

# Ignore prerelease/date tags and drain the pipe instead of relying on head under pipefail.
current="$(git tag --list 'v*' --sort=-v:refname | awk '/^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/ && !found { print substr($0, 2); found=1 }')"
IFS=. read -r major minor patch <<< "${current:-0.0.0}"
case "${RELEASE_INTENT:?}" in
  release:major) major=$((major + 1)); minor=0; patch=0 ;;
  release:minor) minor=$((minor + 1)); patch=0 ;;
  release:patch|release:none) patch=$((patch + 1)) ;;
  *) echo '::error::Unsupported semantic release intent'; exit 1 ;;
esac
version="v$major.$minor.$patch"
{
  echo "version=$version"
  echo "tag=$version"
} >> "${GITHUB_OUTPUT:-/dev/stdout}"
