#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLAN_SCRIPT="$ROOT_DIR/scripts/plan-tags.sh"
IMAGE="ghcr.io/broadsheet-technology/my-service"

fail() {
  echo "not ok - $1" >&2
  exit 1
}

assert_eq() {
  local actual="$1"
  local expected="$2"
  local message="$3"
  if [ "$actual" != "$expected" ]; then
    printf 'not ok - %s\nexpected:\n%s\nactual:\n%s\n' "$message" "$expected" "$actual" >&2
    exit 1
  fi
}

run_plan() {
  local tags="$1"
  local delete_tags="$2"
  local output_file
  output_file="$(mktemp)"
  IMAGE="$IMAGE" TAGS="$tags" DELETE_TAGS="$delete_tags" GITHUB_OUTPUT="$output_file" "$PLAN_SCRIPT"
  cat "$output_file"
  rm -f "$output_file"
}

extract_multiline() {
  local key="$1"
  awk -v key="$key" '
    $0 == key "<<EOF" { capture = 1; next }
    capture && $0 == "EOF" { exit }
    capture { print }
  '
}

extract_scalar() {
  local key="$1"
  awk -F= -v key="$key" '$1 == key { print substr($0, length(key) + 2); exit }'
}

output="$(run_plan $'latest\nsha-123, latest' '')"
assert_eq "$(printf '%s\n' "$output" | extract_multiline tags)" \
  $'ghcr.io/broadsheet-technology/my-service:latest\nghcr.io/broadsheet-technology/my-service:sha-123' \
  "publish tags are normalized and deduplicated"
assert_eq "$(printf '%s\n' "$output" | extract_multiline delete_tags)" "" "delete tags are empty"
assert_eq "$(printf '%s\n' "$output" | extract_scalar publish)" "true" "publish flag is true"
assert_eq "$(printf '%s\n' "$output" | extract_scalar delete)" "false" "delete flag is false"

output="$(run_plan '' 'preview-pr-1, preview-pr-2')"
assert_eq "$(printf '%s\n' "$output" | extract_multiline tags)" "" "publish tags are empty"
assert_eq "$(printf '%s\n' "$output" | extract_multiline delete_tags)" \
  $'preview-pr-1\npreview-pr-2' \
  "delete tags are raw tag names"
assert_eq "$(printf '%s\n' "$output" | extract_scalar publish)" "false" "publish flag is false"
assert_eq "$(printf '%s\n' "$output" | extract_scalar delete)" "true" "delete flag is true"

output="$(run_plan 'preview-pr-3' 'old-preview-pr-3')"
assert_eq "$(printf '%s\n' "$output" | extract_multiline tags)" \
  "ghcr.io/broadsheet-technology/my-service:preview-pr-3" \
  "combined publish tag is normalized"
assert_eq "$(printf '%s\n' "$output" | extract_multiline delete_tags)" \
  "old-preview-pr-3" \
  "combined delete tag is preserved"
assert_eq "$(printf '%s\n' "$output" | extract_scalar publish)" "true" "combined publish flag is true"
assert_eq "$(printf '%s\n' "$output" | extract_scalar delete)" "true" "combined delete flag is true"

empty_output="$(mktemp)"
empty_error="$(mktemp)"
empty_stdout="$(mktemp)"
if IMAGE="$IMAGE" TAGS="" DELETE_TAGS="" GITHUB_OUTPUT="$empty_output" "$PLAN_SCRIPT" >"$empty_stdout" 2>"$empty_error"; then
  fail "empty plan should fail"
fi
empty_message="$(cat "$empty_stdout" "$empty_error")"
case "$empty_message" in
  *"No image tags were planned"*) ;;
  *) fail "empty plan reports useful error" ;;
esac
rm -f "$empty_output" "$empty_error" "$empty_stdout"

full_tag_output="$(mktemp)"
full_tag_error="$(mktemp)"
full_tag_stdout="$(mktemp)"
if IMAGE="$IMAGE" TAGS="ghcr.io/broadsheet-technology/my-service:latest" DELETE_TAGS="" GITHUB_OUTPUT="$full_tag_output" "$PLAN_SCRIPT" >"$full_tag_stdout" 2>"$full_tag_error"; then
  fail "full publish tag should fail"
fi
full_tag_message="$(cat "$full_tag_stdout" "$full_tag_error")"
case "$full_tag_message" in
  *"raw tag names only"*) ;;
  *) fail "full publish tag reports useful error" ;;
esac
rm -f "$full_tag_output" "$full_tag_error" "$full_tag_stdout"

full_delete_tag_output="$(mktemp)"
full_delete_tag_error="$(mktemp)"
full_delete_tag_stdout="$(mktemp)"
if IMAGE="$IMAGE" TAGS="" DELETE_TAGS="ghcr.io/broadsheet-technology/my-service:preview-pr-1" GITHUB_OUTPUT="$full_delete_tag_output" "$PLAN_SCRIPT" >"$full_delete_tag_stdout" 2>"$full_delete_tag_error"; then
  fail "full delete tag should fail"
fi
full_delete_tag_message="$(cat "$full_delete_tag_stdout" "$full_delete_tag_error")"
case "$full_delete_tag_message" in
  *"raw tag names only"*) ;;
  *) fail "full delete tag reports useful error" ;;
esac
rm -f "$full_delete_tag_output" "$full_delete_tag_error" "$full_delete_tag_stdout"

echo "ok - plan-tags"
