#!/usr/bin/env bash
# Only the authorized ephemeral ubuntu-24.04 CI setup/teardown uses root here.
set -euo pipefail
readonly target=/opt/chase-sets-provider-window
readonly profile=/etc/apparmor.d/chase-sets-provider-window
readonly source_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
test "$(id -u)" = 0
test "$#" -ge 1

remove_installation() {
  if test -f "$profile"; then
    /usr/sbin/apparmor_parser -R "$profile"
    rm -- "$profile"
  fi
  if test -e "$target"; then
    test "$(realpath -e -- "$target")" = "$target"
    test ! -L "$target"
    rm -rf -- "$target"
  fi
}

if test "$1" = remove && test "$#" = 1; then
  remove_installation
  exit 0
fi
test "$1" = install && test "$#" = 3
readonly principal="$2"
readonly browser="$(realpath -e -- "$3")"
readonly uid="$(id -u "$principal")"
readonly gid="$(id -g "$principal")"
test "$uid" != 0
test "$(. /etc/os-release; printf '%s:%s' "$ID" "$VERSION_ID")" = ubuntu:24.04
test "$(uname -m)" = x86_64
test -f "$browser/chrome"
test ! -e "$target"
test ! -e "$profile"
test "$(stat -c '%u:%a' /opt)" = 0:755
install -d -o root -g "$gid" -m 0750 "$target"
trap 'remove_installation' ERR
install -d -m 0755 "$target/source" "$target/root/browser" "$target/root/tmp" "$target/root/proc" \
  "$target/root/dev/shm" "$target/root/etc" "$target/root/usr/share/fonts" "$target/root/etc/fonts"
sources=(browser-boundary/launcher.c browser-boundary/apparmor.profile browser-boundary/install-ci.sh test-window-browser.mjs)
for name in "${sources[@]}"; do
  install -D -o root -g root -m 0644 "$source_dir/$name" "$target/source/$name"
done
cp -aL --no-preserve=ownership -- "$browser/." "$target/root/browser/"
cp -aL --no-preserve=ownership -- /usr/share/fonts/. "$target/root/usr/share/fonts/"
cp -aL --no-preserve=ownership -- /etc/fonts/. "$target/root/etc/fonts/"

# lddtree parses ELF rather than executing a workspace-provided binary as root.
# Include every ELF (including dlopen libraries), the interpreter and transitive
# dependencies at their original absolute paths inside the private root.
while IFS= read -r -d '' binary; do
  if /usr/bin/readelf -h "$binary" >/dev/null 2>&1; then
    dependencies="$(/usr/bin/python3 /usr/bin/lddtree -l "$binary")"
    while IFS= read -r dependency; do
      case "$dependency" in
        "$target"/*) continue ;;
        /*) install -D -o root -g root -m 0755 "$(realpath -e "$dependency")" "$target/root$dependency" ;;
        *) printf 'Unresolved ELF dependency\n' >&2; exit 1 ;;
      esac
    done <<< "$dependencies"
  fi
done < <(find "$target/root/browser" -type f -print0)

printf 'provider-window:x:%s:%s::/tmp:/nonexistent\n' "$uid" "$gid" > "$target/root/etc/passwd"
printf 'provider-window:x:%s:\n' "$gid" > "$target/root/etc/group"
printf 'hosts: files\npasswd: files\ngroup: files\n' > "$target/root/etc/nsswitch.conf"
touch "$target/root/etc/resolv.conf" "$target/root/etc/hosts"
for device in null:1:3 random:1:8 urandom:1:9; do
  IFS=: read -r name major minor <<< "$device"
  mknod -m 0666 "$target/root/dev/$name" c "$major" "$minor"
done
chown -R root:root "$target/source" "$target/root"
find "$target/source" "$target/root" -type d -exec chmod 0755 {} +
find "$target/source" "$target/root" -type f -exec chmod u+rw,go+r,go-w,u-s,g-s {} +
test -z "$(find "$target/source" "$target/root" -type l -print -quit)"
{
  /usr/bin/gcc --version | head -n 1
  /usr/bin/ld --version | head -n 1
  dpkg-query -W gcc libc6-dev libssl-dev apparmor pax-utils
  sha256sum "$(readlink -f /usr/bin/gcc)" "$(gcc -print-prog-name=cc1)" "$(gcc -print-file-name=libcrypto.a)"
  uname -srvm
} > "$target/build.txt"
build_launcher() {
  source_digest="$(cd "$target/source"; sha256sum "${sources[@]}" | sha256sum | cut -d ' ' -f 1)"
  find "$target/source" "$target/root" -type f ! -name installation.h -print0 | sort -z | xargs -0 sha256sum > "$target/files.sha256"
  sha256sum "$target/build.txt" >> "$target/files.sha256"
  files_digest="$(sha256sum "$target/files.sha256" | cut -d ' ' -f 1)"
  printf '#define ADMITTED_UID %s\n#define ADMITTED_GID %s\n#define SOURCE_DIGEST "%s"\n#define FILES_DIGEST "%s"\n' \
    "$uid" "$gid" "$source_digest" "$files_digest" > "$target/source/browser-boundary/installation.h"
  /usr/bin/gcc -std=c11 -O2 -Wall -Wextra -Werror -Wno-deprecated-declarations -static \
    "$target/source/browser-boundary/launcher.c" -o "$target/launcher" -lcrypto -ldl -pthread
  chown "root:$gid" "$target/launcher"
  chmod 0750 "$target/launcher"
  sha256sum "$target/launcher" | cut -d ' ' -f 1 > "$target/launcher.sha256"
  printf '%s\n' "$source_digest" > "$target/source.sha256"
}
build_launcher
install -o root -g root -m 0644 "$target/source/browser-boundary/apparmor.profile" "$profile"
/usr/sbin/apparmor_parser -r "$profile"

probe() { runuser -u "$principal" -- "$target/launcher" probe "$source_digest"; }
refusal() {
  local stage="$1"
  shift
  local result
  set +e
  result="$("$@" 2>&1)"
  local status="$?"
  set -e
  test "$status" = 78
  test "$result" = "provider-boundary-refused:$stage"
  printf 'negative:%s:PASS\n' "$stage"
}

# These are serialized, credential-free setup controls, before any browser test.
# Every mutation restores the same installed bytes; the administrator is trusted.
refusal arguments runuser -u "$principal" -- "$target/launcher" /bin/sh "$source_digest"
refusal arguments runuser -u "$principal" -- "$target/launcher" browser "$source_digest" --no-sandbox
refusal source-identity runuser -u "$principal" -- "$target/launcher" probe "$(printf '0%.0s' {1..64})"
refusal automation-pipes runuser -u "$principal" -- "$target/launcher" browser "$source_digest"
cp -p -- "$target/launcher" "$target/launcher.original"
printf 'SYNTHETIC_TAMPER_CONTROL\n' >> "$target/launcher"
refusal launcher-identity probe
cp -p -- "$target/launcher.original" "$target/launcher"
rm -- "$target/launcher.original"
cp -- "$target/launcher" "$target/unprofiled-comparison"
chmod 0750 "$target/unprofiled-comparison"
chown "root:$gid" "$target/unprofiled-comparison"
refusal attachment runuser -u "$principal" -- "$target/unprofiled-comparison" probe "$source_digest"
rm -- "$target/unprofiled-comparison"

/usr/sbin/apparmor_parser -R "$profile"
refusal attachment probe
/usr/sbin/apparmor_parser -r "$profile"
sed 's/profile chase-sets-provider-window /profile chase-sets-provider-window-wrong /' "$profile" > "$target/wrong.profile"
/usr/sbin/apparmor_parser -R "$profile"
/usr/sbin/apparmor_parser -r "$target/wrong.profile"
refusal attachment probe
/usr/sbin/apparmor_parser -R "$target/wrong.profile"
rm -- "$target/wrong.profile"
/usr/sbin/apparmor_parser -r "$profile"

cp -- "$target/root/etc/hosts" "$target/hosts.original"
printf 'SYNTHETIC_TAMPER_CONTROL\n' >> "$target/root/etc/hosts"
refusal dependency-identity probe
cat "$target/hosts.original" > "$target/root/etc/hosts"
rm -- "$target/hosts.original"
mv -- "$target/launcher" "$target/launcher.held"
if runuser -u "$principal" -- "$target/launcher" probe "$source_digest" >/dev/null 2>&1; then exit 1; fi
mv -- "$target/launcher.held" "$target/launcher"
printf 'negative:missing-installation:PASS\n'
if runuser -u nobody -- "$target/launcher" probe "$source_digest" >/dev/null 2>&1; then exit 1; fi
printf 'negative:disallowed-principal:PASS\n'
refusal principal runuser -u nobody -g "$(getent group "$gid" | cut -d: -f1)" -- "$target/launcher" probe "$source_digest"

# A real governing-only OS mutant retains the installed profile and parent URL
# policy. Bind its actual changed source/build bytes, never an invented real
# runner identity. The interface guard must refuse before any browser or packet.
install -d -m 0700 "$target/original"
for file in launcher launcher.sha256 files.sha256 source.sha256; do
  cp -p -- "$target/$file" "$target/original/$file"
done
cp -p -- "$target/source/browser-boundary/launcher.c" "$target/original/launcher.c"
cp -p -- "$target/source/browser-boundary/installation.h" "$target/original/installation.h"
sed 's/unshare(CLONE_NEWNET | CLONE_NEWNS/unshare(CLONE_NEWNS/' \
  "$target/original/launcher.c" > "$target/source/browser-boundary/launcher.c"
test "$(grep -c 'unshare(CLONE_NEWNET | CLONE_NEWNS' "$target/original/launcher.c")" = 1
build_launcher
printf 'SYNTHETIC governing OS mutant source-sha256:%s\n' "$source_digest"
refusal external-interface probe
for file in launcher launcher.sha256 files.sha256 source.sha256; do
  cp -p -- "$target/original/$file" "$target/$file"
done
cp -p -- "$target/original/launcher.c" "$target/source/browser-boundary/launcher.c"
cp -p -- "$target/original/installation.h" "$target/source/browser-boundary/installation.h"
test "$(realpath -e -- "$target/original")" = "$target/original"
rm -rf -- "$target/original"
source_digest="$(cat "$target/source.sha256")"
files_digest="$(sha256sum "$target/files.sha256" | cut -d ' ' -f 1)"
probe
printf 'source-sha256:%s\nfiles-sha256:%s\n' "$source_digest" "$files_digest"
cat "$target/launcher.sha256"
trap - ERR
