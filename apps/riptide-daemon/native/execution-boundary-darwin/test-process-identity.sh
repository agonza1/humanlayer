#!/bin/sh
set -eu
umask 077

if [ "$#" -ne 1 ]; then
    printf 'Usage: sh test-process-identity.sh /absolute/new/private-directory\n' >&2
    exit 2
fi

out=$1
case "$out" in
    /*) ;;
    *) printf 'Output directory must be absolute\n' >&2; exit 2 ;;
esac
if [ "$(/usr/bin/id -u)" -eq 0 ]; then
    printf 'Run this disposable fixture as an ordinary user\n' >&2
    exit 2
fi

src=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
mkdir "$out"
/usr/bin/xcrun --sdk macosx clang -std=c11 -Wall -Wextra -Werror \
    "$src/process-identity.c" "$src/test-process-identity.c" -lbsm -o "$out/test-process-identity"
exec "$out/test-process-identity"
