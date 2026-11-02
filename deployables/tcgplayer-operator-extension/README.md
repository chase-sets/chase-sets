# TCGplayer Operator Extension

Thin Chrome MV3 composition root for Catalog's operator-session relay. This is
separate from the seller connector and is for Todd's normal, non-incognito
operator profile only. It relays an opaque pairing grant and never handles
provider credentials.

## Build And Handoff

`pnpm --filter @chase-sets/app-tcgplayer-operator-extension run build` emits the
load-unpacked `dist` directory. Tests bind its full file inventory and SHA-256
digests to the source head in an external handoff manifest. Only independently
reviewed bytes with that exact inventory may be installed. The public manifest
key pins `ghemdloifdkoadnapmigabiekchlholm`; it does not authenticate a download.
There is no private signing key, public ZIP, store release, remote update URL,
auto-updater, or other-user onboarding.

The hosted operator-suite job publishes only validated `summary.json` and
`scan.json`. The summary embeds the complete handoff inventory and binds the
source PR head separately from the executed checkout, run, attempt, job and
suite. Successful evidence requires identical builds and compatible/unknown
record reload proof. Failure/retry summaries never authorize installation;
independent exact-head review remains required even for successful evidence.
Raw browser profiles, traces, reports and extension bytes are never uploaded.

## Update And Offboarding

Replace only the reviewed unpacked artifact, then explicitly Reload that same
extension in Chrome. Do not create a second extension identity. Compatible
version-1 records retain their grant and revision. Unknown versions or invalid
records halt with Update required and remain byte-for-byte untouched, including
on pair/unpair. Never export or log local grant state to troubleshoot an update.

Unpair removes local grant authority before best-effort server revocation. It
does not manage browser/provider sessions. Offboarding is Unpair plus Admin
Disconnect. Uninstall cannot invoke revocation; server expiry/revocation
remains authoritative. The operator drill belongs to #8456.

## Boundaries

The trusted popup is only a message bridge. The Catalog-owned design-system UI
runs in an opaque sandbox without Chrome storage/cookie APIs. It receives only
closed status DTOs. Pairing grant input is transient and cleared on submit,
clear, environment change, Escape, and dismissal.

The Admin pair handoff is the primary pairing path; popup paste is the
fallback. After a successful mint, the Admin `/catalog/providers/tcgplayer`
page sends `{action:"pair-handoff", grant}` once and holds the grant unrendered
for at most 15 seconds. A separate external receiver takes the environment
only from the exact attested Admin origin, never from the message. That origin
is the trust principal, not proof of a recent mint. Its `paired` reply means
only that the grant was committed to local storage, not that a push succeeded.
A refusal, a missing or late reply, or no runtime leaves Admin showing the
grant as not confirmed for popup paste; that is not proof of non-receipt or a
rollback. Neither side retries or mints again, and the grant is never recorded.

The extension never reads or writes provider cookies, logs secrets, or calls
TCGplayer. Synthetic Chromium applicability tests establish browser behavior,
not a live provider/account assertion.

Each environment has one serialized storage boundary. Pairing and unpairing are
serialized per environment. A refused or missing handoff remains an explicit
pairing failure and is not retried or minted again.
