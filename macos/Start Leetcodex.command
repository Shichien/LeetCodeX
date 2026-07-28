#!/bin/bash

set -uo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd -P)"
"$ROOT/leetcodex" run "$@"
status=$?
if [ "$status" -ne 0 ]; then
  printf '\nLeetcodex failed with exit code %s. Review the error above.\n' "$status" >&2
  if [ -t 0 ]; then
    printf 'Press Return to close this window.' >&2
    read -r _
  fi
fi
exit "$status"
