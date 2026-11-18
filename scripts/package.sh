#!/usr/bin/env bash
# Builds the Chrome Web Store / "Load unpacked" zip: manifest.json at the root of the zip.
# Usage: scripts/package.sh            -> dist/notifier-for-youtrack-<version>.zip
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EXT="$ROOT/extension"
DIST="$ROOT/dist"

VERSION="$(sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([^"]*\)".*/\1/p' "$EXT/manifest.json" | head -n1)"
if [[ -z "$VERSION" ]]; then
  echo "Could not read version from extension/manifest.json" >&2
  exit 1
fi

# Optional: make sure a release tag matches the manifest version.
if [[ -n "${EXPECT_VERSION:-}" && "${EXPECT_VERSION#v}" != "$VERSION" ]]; then
  echo "Tag ${EXPECT_VERSION} does not match manifest version ${VERSION}" >&2
  exit 1
fi

# Quick syntax check of every script (if Node is available).
if command -v node >/dev/null 2>&1; then
  for f in "$EXT"/*.js; do node --check "$f"; done
fi

mkdir -p "$DIST"
OUT="$DIST/notifier-for-youtrack-$VERSION.zip"
rm -f "$OUT"
( cd "$EXT" && zip -rq -X "$OUT" . -x '.*' -x '*/.*' -x '*.map' )

echo "Built $OUT"
unzip -l "$OUT" | tail -n +1
