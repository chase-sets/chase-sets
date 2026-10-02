# TCGplayer Operator Extension

Thin Chrome MV3 composition root for Catalog's operator-session relay. This is
separate from the seller connector and is for Todd's normal, non-incognito
operator profile only. A cookie name does not prove an account's identity.

## Build And Handoff

`pnpm --filter @chase-sets/app-tcgplayer-operator-extension run build` emits the
load-unpacked `dist` directory. Tests bind its full file inventory and SHA-256
digests to the source head in an external handoff manifest. Only independently
reviewed bytes with that exact inventory may be installed. The public manifest
key pins `ghemdloifdkoadnapmigabiekchlholm`; it does not authenticate a download.
There is no private signing key, public ZIP, store release, remote update URL,
auto-updater, or other-user onboarding.

## Update And Offboarding

Replace only the reviewed unpacked artifact, then explicitly Reload that same
extension in Chrome. Do not create a second extension identity. Compatible
version-1 records retain their grant, revision and rate deadline; startup
restores alarms and reads the current applicable cookie. Unknown versions or
invalid records halt with Update required and remain byte-for-byte untouched,
including on pair/unpair. Never export or log local grant/cookie state to
troubleshoot an update.

Unpair removes local grant authority before best-effort server revocation. It
does not clear custody or end the browser/provider session. Offboarding is
Unpair plus Admin Disconnect. Uninstall cannot invoke revocation; server
expiry/revocation remains authoritative. The operator drill belongs to #8456.

## Boundaries

The trusted popup is only a message bridge. The Catalog-owned design-system UI
runs in an opaque sandbox without Chrome storage/cookie APIs. It receives only
closed status DTOs. Pairing grant input is transient and cleared on submit,
clear, environment change, Escape, and dismissal.

The worker reads only `TCGAuthTicket_Production` at the captured pricing URL,
`https://store.tcgplayer.com/admin/pricing`, from default store `0`. It never
enumerates cookies, reads event values, logs secrets, or calls TCGplayer.
Synthetic Chromium applicability tests establish browser behavior, not a live
provider/account assertion. The original names-only capture is #7026 comment
5554920388; additional provider attribute authority is not inferred.

Each environment has one serialized storage boundary. Reservations retain a
60-second push interval across eviction. Stale revisions cause at most three
fresh-read retries per trigger, under that interval; unavailable responses wait
at least five minutes. Permanent errors need a cookie set or explicit recovery,
not startup/alarm replay. Thirty-minute reconciliation renews idle grants.
