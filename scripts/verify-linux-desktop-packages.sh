#!/usr/bin/env bash
set -euo pipefail

bundle_root=${1:-apps/desktop/src-tauri/target/release/bundle}
smoke_seconds=${LOOM_DESKTOP_SMOKE_SECONDS:-15}

shopt -s nullglob
appimages=("$bundle_root"/appimage/*.AppImage)
debs=("$bundle_root"/deb/*.deb)

test "${#appimages[@]}" -eq 1 || {
  printf 'Expected one AppImage under %s, found %s\n' "$bundle_root" "${#appimages[@]}" >&2
  exit 1
}
test "${#debs[@]}" -eq 1 || {
  printf 'Expected one deb under %s, found %s\n' "$bundle_root" "${#debs[@]}" >&2
  exit 1
}

appimage=${appimages[0]}
deb=${debs[0]}

test -s "$appimage"
test -s "$deb"
[[ $(file -b "$appimage") == *"ELF 64-bit"* ]]
test "$(dpkg-deb --field "$deb" Package)" = "loom-desktop"
test "$(dpkg-deb --field "$deb" Architecture)" = "amd64"
dpkg-deb --info "$deb" >/dev/null
dpkg-deb --contents "$deb" >/dev/null

workdir=$(mktemp -d)
trap 'rm -rf "$workdir"' EXIT

cp "$appimage" "$workdir/Loom_Desktop.AppImage"
chmod +x "$workdir/Loom_Desktop.AppImage"
(
  cd "$workdir"
  ./Loom_Desktop.AppImage --appimage-extract >/dev/null
)

test -x "$workdir/squashfs-root/AppRun"
desktop_entries=("$workdir"/squashfs-root/*.desktop)
test "${#desktop_entries[@]}" -ge 1

set +e
WEBKIT_DISABLE_DMABUF_RENDERER=1 timeout "${smoke_seconds}s" \
  xvfb-run --auto-servernum "$workdir/squashfs-root/AppRun" \
  >"$workdir/startup.log" 2>&1
status=$?
set -e

if test "$status" -ne 124; then
  cat "$workdir/startup.log" >&2
  printf 'AppImage startup smoke exited with status %s before %ss\n' "$status" "$smoke_seconds" >&2
  exit 1
fi

printf 'Verified %s and %s; AppImage remained live for %ss\n' \
  "$(basename "$appimage")" "$(basename "$deb")" "$smoke_seconds"
