#!/usr/bin/env bash
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
out="$repo/artifacts/context-server-direct-dm-rc.tar.gz"
source_revision="$(git -C "$repo" rev-parse HEAD)"
branch="$(git -C "$repo" branch --show-current)"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/context-release.XXXXXX")"
cleanup() {
  node -e 'require("node:fs").rmSync(process.argv[1], { recursive: true, force: true })' "$tmp"
}
trap cleanup EXIT

stage="$tmp/stage"
mkdir -p "$stage"
cp -a "$repo/README.md" "$repo/package.json" "$repo/package-lock.json" "$repo/dist" "$stage/"
printf 'source_revision=%s\nbranch=%s\n' "$source_revision" "$branch" > "$stage/BUILD-INFO.txt"

tar --sort=name --mtime='@0' --owner=0 --group=0 --numeric-owner -C "$stage" -cf - . \
  | gzip -n > "$out.tmp"
mv "$out.tmp" "$out"
sha256sum "$out"
