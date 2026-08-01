#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DELETE_SCRIPT="$ROOT_DIR/scripts/delete-tags.sh"
FIXTURE_BIN="$ROOT_DIR/tests/fixtures"
TEST_DIR="$(mktemp -d)"
trap 'rm -rf "$TEST_DIR"' EXIT

fail() {
  echo "not ok - $1" >&2
  exit 1
}

assert_contains() {
  local file="$1"
  local expected="$2"
  local message="$3"
  if ! grep -Fq "$expected" "$file"; then
    printf 'not ok - %s\nexpected to find:\n%s\nactual:\n' "$message" "$expected" >&2
    cat "$file" >&2
    exit 1
  fi
}

assert_empty() {
  local file="$1"
  local message="$2"
  if [ -s "$file" ]; then
    printf 'not ok - %s\nactual:\n' "$message" >&2
    cat "$file" >&2
    exit 1
  fi
}

run_delete() {
  local case_name="$1"
  local image="$2"
  local owner="$3"
  local owner_type="$4"
  local lookup="$5"
  local tag="${6:-stage-pr-1}"
  local case_dir="$TEST_DIR/$case_name"
  mkdir -p "$case_dir"

  if PATH="$FIXTURE_BIN:$PATH" \
    LC_ALL=C \
    GH_CALL_LOG="$case_dir/calls" \
    MOCK_OWNER="$owner" \
    MOCK_OWNER_TYPE="$owner_type" \
    MOCK_VERSION_LOOKUP="$lookup" \
    IMAGE="$image" \
    DELETE_TAGS="$tag" \
    "$DELETE_SCRIPT" >"$case_dir/stdout" 2>"$case_dir/stderr"; then
    return 0
  fi
  return 1
}

if ! run_delete organization \
  "ghcr.io/broadsheet-technology/core/demo" \
  "broadsheet-technology" \
  "Organization" \
  "success"; then
  fail "organization package deletion succeeds"
fi
assert_contains "$TEST_DIR/organization/calls" \
  "api /orgs/broadsheet-technology/packages/container/core%2Fdemo/versions" \
  "organization lookup uses the organization package endpoint"
assert_contains "$TEST_DIR/organization/calls" \
  "api --method DELETE /orgs/broadsheet-technology/packages/container/core%2Fdemo/versions/123" \
  "organization package version is deleted"

if ! run_delete user \
  "ghcr.io/wjhdev/pluto" \
  "wjhdev" \
  "User" \
  "success"; then
  fail "user package deletion succeeds"
fi
assert_contains "$TEST_DIR/user/calls" \
  "api /users/wjhdev/packages/container/pluto/versions" \
  "user lookup uses the user package endpoint"
assert_contains "$TEST_DIR/user/calls" \
  "api --method DELETE /users/wjhdev/packages/container/pluto/versions/123" \
  "user package version is deleted"

if ! run_delete missing-tag \
  "ghcr.io/broadsheet-technology/demo" \
  "broadsheet-technology" \
  "Organization" \
  "missing-tag"; then
  fail "a missing tag is an idempotent success"
fi
assert_empty "$TEST_DIR/missing-tag/stdout" "a missing tag is silent"
assert_empty "$TEST_DIR/missing-tag/stderr" "a missing tag has no error output"
if grep -Fq "api --method DELETE" "$TEST_DIR/missing-tag/calls"; then
  fail "a missing tag does not issue a delete request"
fi

if ! run_delete missing-package \
  "ghcr.io/broadsheet-technology/new-service" \
  "broadsheet-technology" \
  "Organization" \
  "missing-package"; then
  fail "a missing package is an idempotent success"
fi
assert_empty "$TEST_DIR/missing-package/stdout" "a missing package is silent"
assert_empty "$TEST_DIR/missing-package/stderr" "a missing package has no error output"
if grep -Fq "api --method DELETE" "$TEST_DIR/missing-package/calls"; then
  fail "a missing package does not issue a delete request"
fi

if run_delete permission-error \
  "ghcr.io/broadsheet-technology/demo" \
  "broadsheet-technology" \
  "Organization" \
  "permission-error"; then
  fail "a package lookup permission error must fail"
fi
assert_contains "$TEST_DIR/permission-error/stderr" \
  "Resource not accessible by integration" \
  "a package lookup permission error is surfaced"
if grep -Fq "api --method DELETE" "$TEST_DIR/permission-error/calls"; then
  fail "a failed package lookup does not issue a delete request"
fi

echo "ok - delete-tags"
