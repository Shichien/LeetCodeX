#!/bin/bash

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$ROOT"

TARGET="x86_64-pc-windows-gnu"
for command in node pnpm cargo rustup zip unzip shasum file \
  x86_64-w64-mingw32-gcc x86_64-w64-mingw32-dlltool x86_64-w64-mingw32-objdump; do
  command -v "$command" >/dev/null 2>&1 || {
    printf 'Required command is missing: %s\n' "$command" >&2
    exit 1
  }
done

[ "$(uname -s)" = "Darwin" ] || {
  printf 'This cross-release script is intended for macOS.\n' >&2
  exit 1
}

VERSION="$(awk -F'"' '/^version = "/ { print $2; exit }' Cargo.toml)"
[ -n "$VERSION" ] || {
  printf 'Could not read the package version from Cargo.toml.\n' >&2
  exit 1
}
node scripts/check-release-version.mjs
node scripts/check-launchers.mjs

PACKAGE_NAME="Leetcodex-${VERSION}-windows-x64-gnu"
PACKAGE="$ROOT/release/$PACKAGE_NAME"
ARCHIVE="$ROOT/release/${PACKAGE_NAME}.zip"
ARCHIVE_CHECKSUM="${ARCHIVE}.sha256"
[ ! -e "$PACKAGE" ] || {
  printf 'Release directory already exists: %s\n' "$PACKAGE" >&2
  exit 1
}
[ ! -e "$ARCHIVE" ] || {
  printf 'Release archive already exists: %s\n' "$ARCHIVE" >&2
  exit 1
}
[ ! -e "$ARCHIVE_CHECKSUM" ] || {
  printf 'Release archive checksum already exists: %s\n' "$ARCHIVE_CHECKSUM" >&2
  exit 1
}

cleanup_on_error() {
  status=$?
  trap - EXIT
  if [ "$status" -ne 0 ]; then
    rm -rf "$PACKAGE" "$ARCHIVE" "$ARCHIVE_CHECKSUM"
  fi
  exit "$status"
}
trap cleanup_on_error EXIT

pnpm --dir web install --frozen-lockfile
node scripts/generate-third-party-notices.mjs --check
pnpm --dir web test
pnpm --dir web build
cargo fmt --check
cargo test --all-targets --locked
cargo clippy --all-targets --locked -- -D warnings
rustup target add "$TARGET"
cargo build --release --locked --target "$TARGET"

BINARY="$ROOT/target/$TARGET/release/leetcodex.exe"
file "$BINARY" | grep -q 'PE32+ executable.*x86-64' || {
  printf 'Cross-built binary is not a Windows x86-64 PE executable.\n' >&2
  exit 1
}
if x86_64-w64-mingw32-objdump -p "$BINARY" \
  | awk '/DLL Name:/ { print tolower($3) }' \
  | grep -Eq '^(libgcc|libstdc\+\+|libwinpthread)'; then
  printf 'Cross-built binary depends on an unbundled GCC runtime DLL.\n' >&2
  exit 1
fi

mkdir -p "$ROOT/release"
mkdir "$PACKAGE"
cp "$BINARY" "$PACKAGE/leetcodex.exe"
cp "$ROOT/dist/leetcodex.user.js" "$PACKAGE/leetcodex.user.js"
cp "$ROOT/windows/Start Leetcodex.cmd" "$PACKAGE/Start Leetcodex.cmd"
cp "$ROOT/windows/README.md" "$PACKAGE/README.md"
cp "$ROOT/LICENSE" "$PACKAGE/LICENSE"
cp "$ROOT/CHANGELOG.md" "$PACKAGE/CHANGELOG.md"
cp "$ROOT/THIRD_PARTY_NOTICES.md" "$PACKAGE/THIRD_PARTY_NOTICES.md"
cp "$ROOT/SECURITY.md" "$PACKAGE/SECURITY.md"

(
  cd "$PACKAGE"
  shasum -a 256 leetcodex.exe leetcodex.user.js "Start Leetcodex.cmd" README.md LICENSE CHANGELOG.md SECURITY.md THIRD_PARTY_NOTICES.md > SHA256SUMS.txt
  shasum -c SHA256SUMS.txt
)
(
  cd "$ROOT/release"
  zip -X -q -r "$(basename "$ARCHIVE")" "$PACKAGE_NAME"
)
unzip -tq "$ARCHIVE" >/dev/null
(
  cd "$ROOT/release"
  shasum -a 256 "$(basename "$ARCHIVE")" > "$(basename "$ARCHIVE_CHECKSUM")"
  shasum -c "$(basename "$ARCHIVE_CHECKSUM")"
)

printf 'Built %s\n' "$ARCHIVE"
trap - EXIT
