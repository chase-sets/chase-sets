#!/usr/bin/env bash
set -euo pipefail

# https://github.com/chase-sets/chase-sets/issues/11174
repo="$(cd "$(dirname "$0")/.." && pwd)"
mode="${1:?acquire, lock or prove}"
material="${2:?acquisition directory}"
fixture="$repo/scripts/fixtures/terraform-provider-cache/registry.py"

case "$mode" in
  acquire)
    python3 "$fixture" acquire "$repo" "$material"
    ;;
  lock|prove)
    # A new network namespace has no external interfaces or routes. Do not
    # inherit job credentials, proxy settings, Terraform config or provider env.
    work="$(mktemp -d)"
    trap 'rm -rf "$work"' EXIT
    sudo unshare --net -- bash -c '
      set -euo pipefail
      ip link set lo up
      exec setpriv --reuid="$8" --regid="$9" --clear-groups env -i PATH="$1" HOME="$2" python3 "$3" "$4" "$5" "$6" "$2" "$7"
    ' bash "$PATH" "$work" "$fixture" "$mode" "$repo" "$material" "$(command -v terraform)" "$(id -u)" "$(id -g)"
    ;;
  *) echo "Unknown provider-cache proof mode: $mode" >&2; exit 2 ;;
esac
