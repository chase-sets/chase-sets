#!/usr/bin/env bash
set -Eeuo pipefail
stage=cleanup-start
mark() { stage="$1"; printf 'provider-boundary-cleanup-stage:%s\n' "$stage"; }
refuse() { stage="$1"; exit 1; }
require() { local code="$1"; shift; "$@" || refuse "$code"; }
trap 'status=$?; if test "$status" != 0; then printf "provider-boundary-cleanup-refused:%s\n" "$stage" >&2; fi' EXIT
input=/usr/local/lib/chase-sets-provider-window-input
# R1 input validation precedes even an attempted installation removal.
require input-not-symlink test ! -L "$input"
if test -e "$input"; then
  require input-path test "$(realpath -e -- "$input")" = "$input"
fi
mark remove-installation
if test -f "$input/scripts/provider-object-disposition/browser-boundary/install-ci.sh"; then
  sudo env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin /bin/bash \
    "$input/scripts/provider-object-disposition/browser-boundary/install-ci.sh" remove || refuse remove-installation
else
  require remove-installation test ! -e /usr/local/lib/chase-sets-provider-window
  require remove-installation test ! -e /etc/apparmor.d/chase-sets-provider-window
fi
mark remove-input
if test -e "$input"; then sudo rm -rf -- "$input"; fi
mark verify-exact-names
require target-absent test ! -e /usr/local/lib/chase-sets-provider-window
require target-absent test ! -L /usr/local/lib/chase-sets-provider-window
require profile-absent test ! -e /etc/apparmor.d/chase-sets-provider-window
require profile-absent test ! -L /etc/apparmor.d/chase-sets-provider-window
require input-absent test ! -e "$input"
require input-absent test ! -L "$input"
profiles="$(sudo /usr/bin/cat /sys/kernel/security/apparmor/profiles)" || refuse profile-census
case "$profiles" in
  *'chase-sets-provider-window (unconfined)'*) refuse profile-present ;;
esac
mark complete
