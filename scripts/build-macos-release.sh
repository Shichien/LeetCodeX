#!/bin/bash

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$ROOT"

for command in node pnpm cargo rustup lipo zip unzip shasum; do
  command -v "$command" >/dev/null 2>&1 || {
    printf 'Required command is missing: %s\n' "$command" >&2
    exit 1
  }
done

[ "$(uname -s)" = "Darwin" ] || {
  printf 'This release script must run on macOS.\n' >&2
  exit 1
}

VERSION="$(awk -F'"' '/^version = "/ { print $2; exit }' Cargo.toml)"
[ -n "$VERSION" ] || {
  printf 'Could not read the package version from Cargo.toml.\n' >&2
  exit 1
}
node scripts/check-release-version.mjs
node scripts/check-launchers.mjs

PACKAGE_NAME="Leetcodex-${VERSION}-macos-universal"
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

rustup target add aarch64-apple-darwin x86_64-apple-darwin
cargo build --release --locked --target aarch64-apple-darwin
cargo build --release --locked --target x86_64-apple-darwin

mkdir -p "$ROOT/release"
mkdir "$PACKAGE"
lipo -create \
  "$ROOT/target/aarch64-apple-darwin/release/leetcodex" \
  "$ROOT/target/x86_64-apple-darwin/release/leetcodex" \
  -output "$PACKAGE/leetcodex"
chmod 755 "$PACKAGE/leetcodex"
actual_version="$($PACKAGE/leetcodex --version)"
[ "$actual_version" = "leetcodex $VERSION" ] || {
  printf 'Packaged binary reported an unexpected version: %s\n' "$actual_version" >&2
  exit 1
}
cp "$ROOT/dist/leetcodex.user.js" "$PACKAGE/leetcodex.user.js"
cp "$ROOT/macos/Start Leetcodex.command" "$PACKAGE/Start Leetcodex.command"
chmod 755 "$PACKAGE/Start Leetcodex.command"
cp "$ROOT/macos/README.md" "$PACKAGE/README.md"
cp "$ROOT/LICENSE" "$PACKAGE/LICENSE"
cp "$ROOT/CHANGELOG.md" "$PACKAGE/CHANGELOG.md"
cp "$ROOT/THIRD_PARTY_NOTICES.md" "$PACKAGE/THIRD_PARTY_NOTICES.md"
cp "$ROOT/SECURITY.md" "$PACKAGE/SECURITY.md"

lipo "$PACKAGE/leetcodex" -verify_arch arm64 x86_64
(
  cd "$PACKAGE"
  shasum -a 256 leetcodex leetcodex.user.js "Start Leetcodex.command" README.md LICENSE CHANGELOG.md SECURITY.md THIRD_PARTY_NOTICES.md > SHA256SUMS.txt
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
