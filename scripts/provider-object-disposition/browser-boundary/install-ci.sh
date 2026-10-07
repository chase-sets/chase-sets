#!/usr/bin/env bash
# Only the authorized ephemeral ubuntu-24.04 CI setup/teardown uses root here.
set -Eeuo pipefail
stage=initialize
mark() { stage="$1"; printf 'provider-boundary-installer-stage:%s\n' "$stage"; }
refuse() { stage="$1"; exit 1; }
require() { local code="$1"; shift; "$@" || refuse "$code"; }
finish() {
  local status="$?"
  trap - EXIT
  if test "$status" != 0; then
    printf 'provider-boundary-installer-refused:%s\n' "$stage" >&2
  fi
  exit "$status"
}
trap finish EXIT
readonly target=/usr/local/lib/chase-sets-provider-window
readonly profile=/etc/apparmor.d/chase-sets-provider-window
mark source-location
source_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
readonly source_dir
require root-principal test "$(id -u)" = 0
require arguments-present test "$#" -ge 1

remove_installation() {
  require remove-target-symlink test ! -L "$target"
  if test -e "$target"; then
    require remove-target-path test "$(realpath -e -- "$target")" = "$target"
  fi
  require remove-profile-symlink test ! -L "$profile"
  if test ! -e "$target" && test ! -e "$profile"; then mark complete; return; fi
  mark remove-ownership
  local ownership status
  set +e
  ownership="$(timeout --signal=KILL 3s /usr/bin/python3 "$source_dir/browser-boundary/ownership.py" 2>/dev/null)"
  status="$?"
  set -e
  if test "$status" != 0 || test "$ownership" != none; then
    case "$ownership:$status" in
      remove-live-owner:1|remove-orphan-owner:1|remove-ambiguous-owner:1) refuse "$ownership" ;;
      *) refuse remove-ownership-census ;;
    esac
  fi
  mark remove-profile
  if test -f "$profile"; then
    /usr/sbin/apparmor_parser -R "$profile"
    rm -- "$profile"
  fi
  mark remove-target
  if test -e "$target"; then
    require remove-target-path test "$(realpath -e -- "$target")" = "$target"
    require remove-target-symlink test ! -L "$target"
    rm -rf -- "$target"
  fi
  mark complete
}

if test "$1" = remove && test "$#" = 1; then
  remove_installation
  exit 0
fi
require install-mode test "$1" = install
require install-arguments test "$#" = 3
readonly principal="$2"
mark resolve-browser
browser="$(realpath -e -- "$3")"
readonly browser
mark resolve-principal
uid="$(id -u "$principal")"
gid="$(id -g "$principal")"
readonly uid gid
require nonroot-principal test "$uid" != 0
require ubuntu-version test "$(. /etc/os-release; printf '%s:%s' "$ID" "$VERSION_ID")" = ubuntu:24.04
require architecture test "$(uname -m)" = x86_64
require hosted-runner test "${GITHUB_ACTIONS:-}" = true
require hosted-runner test "${RUNNER_ENVIRONMENT:-}" = github-hosted
require hosted-image test "${ImageOS:-}" = ubuntu24
require hosted-image test -n "${ImageVersion:-}"
mark administrator-binding
require runner-administrator runuser -u "$principal" -- /usr/bin/sudo -n /usr/bin/true
printf 'provider-boundary-administrator:uid=%s,gid=%s,sudo=true\n' "$uid" "$gid"
require browser-present test -f "$browser/chrome"
require target-absent test ! -e "$target"
require target-not-symlink test ! -L "$target"
require profile-absent test ! -e "$profile"
require profile-not-symlink test ! -L "$profile"
for parent in / /usr /usr/local /usr/local/lib; do
  require parent-not-symlink test ! -L "$parent"
  require parent-ownership test "$(stat -c '%u:%a' "$parent")" = 0:755
done
mark create-installation
install -d -o root -g "$gid" -m 0750 "$target"
# The workflow's always() step owns teardown even after an early refusal. Do not
# let a cleanup command replace the original failing stage or exit status.
mark copy-inputs
install -d -m 0755 "$target/source" "$target/root/browser" "$target/root/tmp" "$target/root/proc" "$target/root/old-root" \
  "$target/root/dev/shm" "$target/root/etc" "$target/root/usr/share/fonts" "$target/root/etc/fonts"
sources=(browser-boundary/launcher.c browser-boundary/apparmor.profile browser-boundary/install-ci.sh browser-boundary/ownership.py browser-boundary/protocol.mjs test-window-browser.mjs)
for name in "${sources[@]}"; do
  install -D -o root -g root -m 0644 "$source_dir/$name" "$target/source/$name"
done
cp -aL --no-preserve=ownership -- "$browser/." "$target/root/browser/"
cp -aL --no-preserve=ownership -- /usr/share/fonts/. "$target/root/usr/share/fonts/"
cp -aL --no-preserve=ownership -- /etc/fonts/. "$target/root/etc/fonts/"

# lddtree parses ELF rather than executing a workspace-provided binary as root.
# Include every ELF (including dlopen libraries), the interpreter and transitive
# dependencies at their original absolute paths inside the private root.
mark resolve-dependencies
while IFS= read -r -d '' binary; do
  if /usr/bin/readelf -h "$binary" >/dev/null 2>&1; then
    dependencies="$(/usr/bin/python3 /usr/bin/lddtree -l "$binary")"
    while IFS= read -r dependency; do
      case "$dependency" in
        "$target"/*) continue ;;
        /*) install -D -o root -g root -m 0755 "$(realpath -e "$dependency")" "$target/root$dependency" ;;
        *) refuse dependency-unresolved ;;
      esac
    done <<< "$dependencies"
  fi
done < <(find "$target/root/browser" -type f -print0)

mark private-root-files
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
require installed-symlink test -z "$(find "$target/source" "$target/root" -type l -print -quit)"
mark build-inventory
{
  /usr/bin/gcc --version | head -n 1
  /usr/bin/ld --version | head -n 1
  dpkg-query -W gcc libc6-dev libssl-dev apparmor pax-utils
  sha256sum "$(readlink -f /usr/bin/gcc)" "$(gcc -print-prog-name=cc1)" "$(gcc -print-file-name=libcrypto.a)"
  uname -srvm
  printf 'ImageOS=%s\nImageVersion=%s\nUID=%s\nGID=%s\nAdministrator=sudo-capable\n' "$ImageOS" "$ImageVersion" "$uid" "$gid"
} > "$target/build.txt"
build_launcher() {
  mark build-launcher
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
mark load-profile
install -o root -g root -m 0644 "$target/source/browser-boundary/apparmor.profile" "$profile"
/usr/sbin/apparmor_parser -r "$profile"

direct_probe() { timeout --signal=TERM --kill-after=1s 5s runuser "$@"; }
probe() { direct_probe -u "$principal" -- "$target/launcher" probe "$source_digest"; }
readonly transition='{"transition":"seed-joined","uidMap":"exact","gidMap":"exact","setgroups":"deny","seed":"reaped"}'
refusal() {
  local expected_stage="$1"
  shift
  local result
  set +e
  result="$("$@" 2>&1; status=$?; printf '.'; exit "$status")"
  local status="$?"
  set -e
  result="${result%.}"
  printf 'provider-boundary-control:%s,status=%s,bytes=%s,redacted=true,truncated=false\n' "$expected_stage" "$status" "${#result}"
  if test "$status" = 124 || test "$status" = 137; then refuse "negative-$expected_stage-deadline"; fi
  require "negative-$expected_stage-status" test "$status" = 78
  local expected="provider-boundary-refused:$expected_stage"$'\n'
  case "$expected_stage" in
    external-interface) expected="$transition"$'\n'"$expected" ;;
  esac
  require "negative-$expected_stage-output" test "$result" = "$expected"
  printf 'negative:%s:PASS\n' "$expected_stage"
}

# These are serialized, credential-free setup controls, before any browser test.
# Every mutation restores the same installed bytes; the administrator is trusted.
mark negative-arguments
refusal arguments direct_probe -u "$principal" -- "$target/launcher" /bin/sh "$source_digest"
refusal arguments direct_probe -u "$principal" -- "$target/launcher" browser "$source_digest" --no-sandbox
mark negative-source-identity
refusal source-identity direct_probe -u "$principal" -- "$target/launcher" probe "$(printf '0%.0s' {1..64})"
mark negative-automation-pipes
refusal automation-pipes direct_probe -u "$principal" -- "$target/launcher" browser "$source_digest"
mark negative-launcher-identity
cp -p -- "$target/launcher" "$target/launcher.original"
printf 'SYNTHETIC_TAMPER_CONTROL\n' >> "$target/launcher"
refusal launcher-identity probe
cp -p -- "$target/launcher.original" "$target/launcher"
rm -- "$target/launcher.original"
mark negative-unprofiled-executable
cp -- "$target/launcher" "$target/unprofiled-comparison"
chmod 0750 "$target/unprofiled-comparison"
chown "root:$gid" "$target/unprofiled-comparison"
refusal attachment direct_probe -u "$principal" -- "$target/unprofiled-comparison" probe "$source_digest"
rm -- "$target/unprofiled-comparison"

mark negative-missing-attachment
/usr/sbin/apparmor_parser -R "$profile"
refusal attachment probe
/usr/sbin/apparmor_parser -r "$profile"
mark negative-wrong-attachment
sed 's/profile chase-sets-provider-window /profile chase-sets-provider-window-wrong /' "$profile" > "$target/wrong.profile"
/usr/sbin/apparmor_parser -R "$profile"
/usr/sbin/apparmor_parser -r "$target/wrong.profile"
refusal attachment probe
/usr/sbin/apparmor_parser -R "$target/wrong.profile"
rm -- "$target/wrong.profile"
/usr/sbin/apparmor_parser -r "$profile"

mark negative-dependency-identity
cp -- "$target/root/etc/hosts" "$target/hosts.original"
printf 'SYNTHETIC_TAMPER_CONTROL\n' >> "$target/root/etc/hosts"
refusal dependency-identity probe
cat "$target/hosts.original" > "$target/root/etc/hosts"
rm -- "$target/hosts.original"
mark negative-missing-installation
mv -- "$target/launcher" "$target/launcher.held"
set +e
direct_probe -u "$principal" -- "$target/launcher" probe "$source_digest" >/dev/null 2>&1
status="$?"
set -e
if test "$status" = 124 || test "$status" = 137; then refuse negative-missing-installation-deadline; fi
require missing-installation-status test "$status" = 1
mv -- "$target/launcher.held" "$target/launcher"
printf 'negative:missing-installation:PASS\n'
mark negative-disallowed-principal
set +e
direct_probe -u nobody -- "$target/launcher" probe "$source_digest" >/dev/null 2>&1
status="$?"
set -e
if test "$status" = 124 || test "$status" = 137; then refuse negative-disallowed-principal-deadline; fi
require disallowed-principal-status test "$status" = 1
printf 'negative:disallowed-principal:PASS\n'
refusal principal direct_probe -u nobody -g "$(getent group "$gid" | cut -d: -f1)" -- "$target/launcher" probe "$source_digest"

# A real governing-only OS mutant retains the installed profile and parent URL
# policy. Bind its actual changed source/build bytes, never an invented real
# runner identity. The interface guard must refuse before any browser or packet.
mark negative-os-mutant
install -d -m 0700 "$target/original"
for file in launcher launcher.sha256 files.sha256 source.sha256; do
  cp -p -- "$target/$file" "$target/original/$file"
done
cp -p -- "$target/source/browser-boundary/launcher.c" "$target/original/launcher.c"
cp -p -- "$target/source/browser-boundary/installation.h" "$target/original/installation.h"
sed 's/unshare(CLONE_NEWNET | CLONE_NEWNS/unshare(CLONE_NEWNS/' \
  "$target/original/launcher.c" > "$target/source/browser-boundary/launcher.c"
require os-mutant-predicate test "$(grep -c 'unshare(CLONE_NEWNET | CLONE_NEWNS' "$target/original/launcher.c")" = 1
build_launcher
mark negative-os-mutant
printf 'SYNTHETIC governing OS mutant source-sha256:%s\n' "$source_digest"
refusal external-interface probe
for file in launcher launcher.sha256 files.sha256 source.sha256; do
  cp -p -- "$target/original/$file" "$target/$file"
done
cp -p -- "$target/original/launcher.c" "$target/source/browser-boundary/launcher.c"
cp -p -- "$target/original/installation.h" "$target/source/browser-boundary/installation.h"
require os-mutant-restore-path test "$(realpath -e -- "$target/original")" = "$target/original"
rm -rf -- "$target/original"
source_digest="$(cat "$target/source.sha256")"
files_digest="$(sha256sum "$target/files.sha256" | cut -d ' ' -f 1)"
mark admission-probe
probe
printf 'source-sha256:%s\nfiles-sha256:%s\n' "$source_digest" "$files_digest"
cat "$target/launcher.sha256"
mark complete
