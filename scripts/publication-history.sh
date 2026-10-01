# Shared by publication and recovery; squash releases retain source provenance
# in trailers instead of ancestry. Keep ancestry support for older releases.
is_published() {
  git merge-base --is-ancestor "$1" "$2" ||
    [ -n "$(git log --format=%H -1 --grep="^merge: $1$" "$2")" ]
}
