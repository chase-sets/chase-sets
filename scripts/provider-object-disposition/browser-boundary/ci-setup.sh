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
if test "$#" = 0; then
  mark install-chromium
  pnpm exec playwright install --with-deps chromium
  mark install-native-dependencies
  sudo apt-get update
  sudo apt-get install --yes gcc libc6-dev libssl-dev pax-utils apparmor
else
  require reinstall-arguments test "$#:$1" = 1:reinstall
fi
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
protected_inputs=(scripts/provider-object-disposition/browser-boundary scripts/provider-object-disposition/test-window-browser.mjs scripts/provider-object-disposition/test-window-policy.mjs)
/usr/bin/git cat-file -e "$BOUNDARY_HEAD_SHA^{commit}"
parents="$(/usr/bin/git rev-list --parents --max-count=1 HEAD)"
read -r checkout base candidate extra <<<"$parents"
source_role=head
source_sha="$BOUNDARY_HEAD_SHA"
if test "$checkout" != "$BOUNDARY_HEAD_SHA"; then
  # Shared Static guards retain the normal PR merge-ref provenance: parents
  # [base tip, candidate]. The synthetic merge commit is never native authority.
  require checkout-ancestry test "$candidate:$extra" = "$BOUNDARY_HEAD_SHA:"
  if ! /usr/bin/git diff --quiet "$BOUNDARY_HEAD_SHA" -- "${protected_inputs[@]}"; then
    # Otherwise only a base tip that landed main contains may supply them; bytes
    # changed on both sides match neither commit and still refuse below.
    /usr/bin/git cat-file -e "$base^{commit}"
    require checkout-boundary-bytes /usr/bin/git merge-base --is-ancestor "$base" refs/remotes/origin/main
    source_role=base
    source_sha="$base"
  fi
fi
# Native inputs must be byte-identical to the selected exact commit, and
# installation uses its archive.
require checkout-boundary-bytes /usr/bin/git diff --quiet "$source_sha" -- "${protected_inputs[@]}"
printf 'provider-boundary-candidate:%s\n' "$BOUNDARY_HEAD_SHA"
printf 'provider-boundary-native-source:%s:%s\n' "$source_role" "$source_sha"
mark create-input
sudo install -d -o root -g root -m 0755 "$input"
mark archive-input
/usr/bin/git archive "$source_sha" -- "${protected_inputs[@]}" | \
  sudo /bin/tar --extract --directory="$input" --no-same-owner --no-same-permissions --mode=u=rwX,go=rX
mark install-boundary
sudo /usr/bin/gcc -std=gnu11 -O2 -Wall -Wextra -Werror \
  "$input/scripts/provider-object-disposition/browser-boundary/census-stimulus.c" \
  -o "$input/scripts/provider-object-disposition/browser-boundary/census-stimulus"
sudo chmod 0755 "$input/scripts/provider-object-disposition/browser-boundary/census-stimulus"
sudo env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin GITHUB_ACTIONS=true RUNNER_ENVIRONMENT=github-hosted \
  ImageOS="$ImageOS" ImageVersion="$ImageVersion" /bin/bash \
  "$input/scripts/provider-object-disposition/browser-boundary/install-ci.sh" install "$(id -un)" "$browser"
mark complete
