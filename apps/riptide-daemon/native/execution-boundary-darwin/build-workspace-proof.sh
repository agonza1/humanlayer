#!/bin/sh
set -eu
umask 077

if [ "$#" -ne 1 ]; then
    printf 'Usage: sh build-workspace-proof.sh /absolute/new/private-directory\n' >&2
    exit 64
fi
out=$1
case "$out" in
    /*) ;;
    *) printf 'Output directory must be absolute\n' >&2; exit 64 ;;
esac

src=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
project_git=$(/usr/bin/xcrun --no-cache --find git)
mkdir "$out"
/usr/bin/python3 -I -B - "$src/process-identity.h" "$project_git" "$out/project-fixture.h" <<'PY'
import json
from pathlib import Path
import sys

source, git, output = sys.argv[1:]
data = Path(source).read_bytes()
lines = ["    \"" + "".join(f"\\x{byte:02x}" for byte in data[start:start + 32]) + "\""
         for start in range(0, len(data), 32)]
Path(output).write_text("#define PROJECT_GIT " + json.dumps(git) +
                        "\nstatic const char project_fixture[] =\n" + "\n".join(lines) + ";\n")
PY
/usr/bin/xcrun --sdk macosx clang -std=c11 -Wall -Wextra -Werror \
    -I "$out" "$src/worker-handoff.c" "$src/kernel-groups.c" "$src/workspace-proof.c" \
    -o "$out/workspace-proof"
