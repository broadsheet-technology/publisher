#!/usr/bin/env bash
set -euo pipefail

full_image_tag() {
  local tag="$1"
  if [[ "$tag" == *"/"* || "$tag" == *":"* ]]; then
    echo "::error::tags and delete-tags must contain raw tag names only, not full image tags: $tag" >&2
    exit 1
  fi
  printf '%s:%s\n' "$IMAGE" "$tag"
}

append_publish_tag() {
  local tag="$1"
  [ -z "$tag" ] && return 0
  full_image_tag "$tag" >> "$publish_tags_file"
}

append_delete_tag() {
  local tag="$1"
  [ -z "$tag" ] && return 0
  if [[ "$tag" == *"/"* || "$tag" == *":"* ]]; then
    echo "::error::tags and delete-tags must contain raw tag names only, not full image tags: $tag" >&2
    exit 1
  fi
  printf '%s\n' "$tag" >> "$delete_tags_file"
}

append_list() {
  local value="$1"
  local append_fn="$2"
  printf '%s\n' "$value" | tr ',' '\n' | while IFS= read -r tag; do
    tag="$(printf '%s' "$tag" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
    "$append_fn" "$tag"
  done
}

publish_tags_file="$(mktemp)"
delete_tags_file="$(mktemp)"
trap 'rm -f "$publish_tags_file" "$delete_tags_file"' EXIT

append_list "${TAGS:-}" append_publish_tag
append_list "${DELETE_TAGS:-}" append_delete_tag

publish_tags="$(awk 'NF && !seen[$0]++' "$publish_tags_file")"
delete_tags="$(awk 'NF && !seen[$0]++' "$delete_tags_file")"

publish="false"
if [ -n "$publish_tags" ]; then
  publish="true"
fi

delete="false"
if [ -n "$delete_tags" ]; then
  delete="true"
fi

if [ "$publish" != "true" ] && [ "$delete" != "true" ]; then
  echo "::error::No image tags were planned; provide tags or delete-tags."
  exit 1
fi

{
  echo "tags<<EOF"
  printf '%s\n' "$publish_tags"
  echo "EOF"
  echo "delete_tags<<EOF"
  printf '%s\n' "$delete_tags"
  echo "EOF"
  echo "publish=$publish"
  echo "delete=$delete"
} >> "$GITHUB_OUTPUT"
