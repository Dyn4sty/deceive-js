#!/usr/bin/env bash
# Builds a universal (arm64 + x86_64) macOS tray helper for systray2.
# systray2@2.1.4 only ships an x86_64 helper, which fails without Rosetta on Apple Silicon.
# Must stay protocol-compatible with the installed systray2 version.
# Requires: macOS with Xcode Command Line Tools, curl, git, lipo.
set -euo pipefail

SYSTRAY_PORTABLE_COMMIT="6eddc917bf39fcc0d95b57a0741d0c065fbd1e23"
GO_VERSION="${GO_VERSION:-go1.27.4}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$ROOT/.tmp/tray-build"
OUT="$ROOT/assets/traybin/tray_darwin_release"

mkdir -p "$WORK" "$(dirname "$OUT")"
cd "$WORK"

HOST_ARCH="$(uname -m)"
[ "$HOST_ARCH" = "x86_64" ] && HOST_ARCH="amd64"

if [ ! -x go/bin/go ]; then
  curl -fsSL "https://dl.google.com/go/${GO_VERSION}.darwin-${HOST_ARCH}.tar.gz" | tar xz
fi

if [ ! -d systray-portable ]; then
  git clone -q https://github.com/felixhao28/systray-portable
fi
git -C systray-portable fetch -q origin
git -C systray-portable checkout -q "$SYSTRAY_PORTABLE_COMMIT"

export PATH="$WORK/go/bin:$PATH"
export GOPATH="$WORK/gopath" GOCACHE="$WORK/gocache" GOFLAGS=-mod=mod

cd systray-portable
for arch in arm64 amd64; do
  CGO_ENABLED=1 GOOS=darwin GOARCH="$arch" \
    go build -trimpath -ldflags '-s -w' -o "$WORK/tray_$arch" tray.go
done

lipo -create -output "$OUT" "$WORK/tray_arm64" "$WORK/tray_amd64"
chmod +x "$OUT"
lipo -info "$OUT"
