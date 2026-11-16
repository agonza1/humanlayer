#!/bin/sh
set -eu
umask 077

if [ "$#" -ne 1 ]; then
    printf 'Usage: sh build-proof.sh /absolute/empty/output-directory\n' >&2
    exit 2
fi
out=$1
case "$out" in
    /*) ;;
    *) printf 'Output directory must be absolute\n' >&2; exit 2 ;;
esac
if [ ! -d "$out" ] || [ -n "$(ls -A -- "$out")" ]; then
    printf 'Output directory must exist and be empty\n' >&2
    exit 2
fi
src=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
mkdir "$out/media"
/usr/bin/xcrun --sdk macosx swiftc -target arm64-apple-macos14.0 -swift-version 6 \
    -warnings-as-errors -module-cache-path "$out/module-cache" \
    -o "$out/HLNativeProof" "$src/ExecutionBoundaryDarwin.swift" "$src/NativeProof.swift"
/usr/bin/xcrun --sdk macosx clang -arch arm64 -mmacosx-version-min=14.0 -std=c17 \
    -Wall -Wextra -Werror -O2 -o "$out/media/guest-fixture" "$src/guest-fixture.c"
/usr/bin/hdiutil makehybrid -hfs -iso -joliet -default-volume-name HL40B8FIXTURE \
    -o "$out/fixture.iso" "$out/media"
cat > "$out/proof-entitlements.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>com.apple.security.virtualization</key>
    <true/>
    <key>com.apple.security.network.client</key>
    <true/>
</dict>
</plist>
PLIST
/usr/bin/xcrun --sdk macosx swiftc -target arm64-apple-macos14.0 -swift-version 6 \
    -parse-as-library -D HL_IMAGE_INSPECT_ONLY -warnings-as-errors -module-cache-path "$out/module-cache" \
    -o "$out/HLImageCheck" "$src/NativeProof.swift"
cat > "$out/image-check-entitlements.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>com.apple.security.virtualization</key>
    <true/>
</dict>
</plist>
PLIST
/usr/bin/codesign --force --sign - --entitlements "$out/image-check-entitlements.plist" "$out/HLImageCheck"
/usr/bin/codesign --verify --strict "$out/HLImageCheck"
printf 'Prepared native runner, read-only image checker and fixture media\n'
