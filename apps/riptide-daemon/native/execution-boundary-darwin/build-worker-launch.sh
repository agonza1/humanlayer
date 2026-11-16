#!/bin/sh
set -eu
umask 077
if [ "$#" -ne 1 ]; then
    printf 'Usage: sh build-worker-launch.sh /absolute/new/private-directory\n' >&2
    exit 64
fi
case "$1" in /*) ;; *) exit 64 ;; esac
src=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
mkdir "$1"
/usr/bin/xcrun --sdk macosx clang -std=c11 -Wall -Wextra -Werror \
    "$src/worker-launch.c" "$src/worker-handoff.c" "$src/kernel-groups.c" \
    -o "$1/worker-launch"
