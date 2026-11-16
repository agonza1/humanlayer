#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
    printf 'Usage: sh compile-only.sh /absolute/existing/output-directory\n' >&2
    exit 2
fi

out=$1
case "$out" in
    /*) ;;
    *) printf 'Output directory must be absolute\n' >&2; exit 2 ;;
esac
if [ ! -d "$out" ]; then
    printf 'Output directory must exist\n' >&2
    exit 2
fi

src=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec /usr/bin/xcrun --sdk macosx swiftc \
    -parse-as-library -emit-module -module-name ExecutionBoundaryDarwin \
    -swift-version 6 -warnings-as-errors \
    -module-cache-path "$out/module-cache" \
    -emit-module-path "$out/ExecutionBoundaryDarwin.swiftmodule" \
    "$src/ExecutionBoundaryDarwin.swift"
