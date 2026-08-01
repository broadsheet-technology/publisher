#!/usr/bin/env bash
set -euo pipefail

if [[ "$IMAGE" != ghcr.io/* ]]; then
  echo "::error::delete-tags currently supports GHCR images only."
  exit 1
fi

image_path="${IMAGE#ghcr.io/}"
if [[ "$image_path" != */* ]]; then
  echo "::error::image must include a GHCR owner and package: $IMAGE"
  exit 1
fi

owner="${image_path%%/*}"
package="${image_path#*/}"
encoded_package="$(jq -rn --arg value "$package" '$value|@uri')"

owner_type="$(gh api "/users/$owner" --jq '.type')"
case "$owner_type" in
  Organization)
    versions_path="/orgs/$owner/packages/container/$encoded_package/versions"
    ;;
  User)
    versions_path="/users/$owner/packages/container/$encoded_package/versions"
    ;;
  *)
    echo "::error::Unsupported GHCR owner type for $owner: $owner_type"
    exit 1
    ;;
esac

lookup_stdout="$(mktemp)"
lookup_stderr="$(mktemp)"
trap 'rm -f "$lookup_stdout" "$lookup_stderr"' EXIT

while IFS= read -r tag; do
  [ -z "$tag" ] && continue

  : > "$lookup_stdout"
  : > "$lookup_stderr"
  if gh api "$versions_path" --paginate --jq ".[] | select(.metadata.container.tags[]? == \"$tag\") | .id" \
    >"$lookup_stdout" 2>"$lookup_stderr"; then
    ids="$(cat "$lookup_stdout")"
  else
    if grep -Eq 'HTTP 404|"status"[[:space:]]*:[[:space:]]*"?404"?' "$lookup_stdout" "$lookup_stderr"; then
      continue
    fi
    if [ -s "$lookup_stdout" ]; then
      cat "$lookup_stdout" >&2
    fi
    if [ -s "$lookup_stderr" ]; then
      cat "$lookup_stderr" >&2
    fi
    exit 1
  fi

  [ -z "$ids" ] && continue

  while IFS= read -r id; do
    [ -z "$id" ] && continue
    gh api --method DELETE "$versions_path/$id"
    echo "::notice::Deleted GHCR package version $id for $IMAGE:$tag"
  done <<< "$ids"
done <<< "$DELETE_TAGS"
