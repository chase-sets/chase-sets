#!/usr/bin/env bash
set -Eeuo pipefail
stage=setup-start
mark() { stage="$1"; printf 'provider-boundary-setup-stage:%s\n' "$stage"; }
refuse() { stage="$1"; exit 1; }
require() { local code="$1"; shift; "$@" || refuse "$code"; }
trap 'status=$?; if test "$status" != 0; then printf "provider-boundary-setup-refused:%s\n" "$stage" >&2; fi' EXIT
mark runner-identity
require hosted-runner test "$GITHUB_ACTIONS:$RUNNER_ENVIRONMENT:$ImageOS" = true:github-hosted:ubuntu24
printf 'Runner image: %s / %s\n' "$ImageOS" "$ImageVersion"
uname -srvm
mark install-chromium
pnpm exec playwright install --with-deps chromium
mark install-native-dependencies
sudo apt-get update
sudo apt-get install --yes gcc libc6-dev libssl-dev pax-utils apparmor
mark resolve-browser
browser="$(node --input-type=module -e "import { chromium } from '@playwright/test'; import { dirname } from 'node:path'; console.log(dirname(chromium.executablePath()))")"
input=/usr/local/lib/chase-sets-provider-window-input
mark validate-input-parent
for parent in / /usr /usr/local /usr/local/lib; do
  require input-parent-not-symlink test ! -L "$parent"
  require input-parent-ownership test "$(stat -c '%u:%a' "$parent")" = 0:755
done
require input-absent test ! -e "$input"
require input-not-symlink test ! -L "$input"
mark validate-checkout
/usr/bin/git cat-file -e "$BOUNDARY_HEAD_SHA^{commit}"
require checkout-ancestry /usr/bin/git merge-base --is-ancestor "$BOUNDARY_HEAD_SHA" HEAD
# Shared Static guards retain the normal PR merge-ref provenance. Native inputs
# must still be byte-identical to the candidate, and installation uses its archive.
require checkout-boundary-bytes /usr/bin/git diff --quiet "$BOUNDARY_HEAD_SHA" -- \
  scripts/provider-object-disposition/browser-boundary scripts/provider-object-disposition/test-window-browser.mjs
printf 'provider-boundary-candidate:%s\n' "$BOUNDARY_HEAD_SHA"
mark create-input
sudo install -d -o root -g root -m 0755 "$input"
mark archive-input
/usr/bin/git archive "$BOUNDARY_HEAD_SHA" -- scripts/provider-object-disposition/browser-boundary scripts/provider-object-disposition/test-window-browser.mjs | \
  sudo /bin/tar --extract --directory="$input" --no-same-owner --no-same-permissions --mode=u=rwX,go=rX
mark install-boundary
sudo env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin GITHUB_ACTIONS=true RUNNER_ENVIRONMENT=github-hosted \
  ImageOS="$ImageOS" ImageVersion="$ImageVersion" /bin/bash \
  "$input/scripts/provider-object-disposition/browser-boundary/install-ci.sh" install "$(id -un)" "$browser"
mark complete
