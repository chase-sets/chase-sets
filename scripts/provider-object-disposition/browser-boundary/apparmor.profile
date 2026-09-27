abi <abi/4.0>,
include <tunables/global>

# This application-specific permission enables namespace construction. The native
# launcher, not this unconfined profile, enforces the no-network child boundary.
profile chase-sets-provider-window /usr/local/lib/chase-sets-provider-window/launcher flags=(unconfined) {
  userns,
}
