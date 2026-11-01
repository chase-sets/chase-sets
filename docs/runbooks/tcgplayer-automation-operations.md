# TCGplayer Automation Operations (Retired Server Transport)

Chase Sets does not make TCGplayer integration calls. The server transport,
credential configuration, cookie custody, and market-capture jobs are retired.
Browser extensions relay provider data and no extension code reads or pushes
TCGplayer cookies.

Catalog retains provider-neutral Source Observation and external-reference
records. Any queued TCGplayer integration job is terminally failed without a
request; new server enqueue and preview commands return an explicit retired-
provider refusal.

## Secret Provisioning (Prohibited)

The extension never accepts, reads, stores, or forwards a TCGplayer cookie or
credential. Do not provision `TCGPLAYER_AUTOMATION_*` or
`CATALOG_OPERATOR_SESSION_KEYRING_JSON`; those settings are removed. Pairing
grants contain no provider credential and are used only for browser handoff.

### Pairing

For production packages, use the shared [Operator-Package Target Reachability](../../.agents/skills/delivery/SKILL.md#operator-package-target-reachability) gate before package READY, at host signal and at window-open re-verification. The production inventory is Admin `/catalog/providers/tcgplayer` and the extension's unpair route `/api/public/catalog/operator-session/grant` on that Admin origin. Do not mint or revoke a grant to probe reachability. Staging remains independently gated; retired custody and server recovery are not restored, and routing proof grants no execution GO.

Pairing hands the extension one opaque grant that carries no provider
credential. It never pushes a provider session, forwards a cookie, or proves
that TCGplayer accepted anything. Pair staging first, then independently gate
production.

1. The host confirms `CATALOG_OPERATOR_SESSION_KEYRING_JSON` has been removed
   from the target environment using secret metadata only and supplies the
   independently reviewed unpacked extension artifact with its exact-head
   handoff inventory.
2. Todd uses his authorized normal, non-incognito operator browser, never the
   shared `Pokebash TCG` or work profile. In Chrome Extensions, enable Developer
   mode and choose Load unpacked for the supplied `dist` directory. Updates use
   Reload on the same extension identity, not a second installation.
3. In that browser, open Admin's `/catalog/providers/tcgplayer` in the target
   environment, then Operator session > Pair extension. Minting requires
   `catalog.manage`, the platform-admin role, and authentication within ten
   minutes; use Sign in again if prompted. Minting replaces the environment's
   previous active grant.
4. Admin pair handoff (primary): after a successful mint, Admin sends the new
   grant once to the installed extension without displaying it, waits at most
   15 seconds, and never retries or mints again. The extension takes the
   environment from the Admin origin that sent the grant, never from the
   message. That origin is the trust principal, not proof of a recent mint.
   Paired with extension means only that the extension committed the grant to
   its local storage; it transfers no provider session and is not provider
   acceptance.
5. Popup paste (fallback): if Admin instead shows the grant with Automatic
   pairing was not confirmed, that is not proof the extension did not receive
   the grant or that anything was rolled back. Copy the once-shown grant only
   into the extension popup's Pairing grant field, choose Staging or Production
   to match Admin, and choose Pair. Dismiss grant in Admin. In either path,
   never record the grant or inspect/export extension storage.
6. Do not sign in to TCGplayer or change a provider session for this workflow.
   Refresh the popup and reload Admin. Record only extension grant metadata and
   the handoff outcome; never record cookies, grants, or provider sessions.
7. Confirm the result as described in [Verification](#verification).

### Grant Lifecycle

- A grant expires 30 days after it is minted; no route renews it. Expired or
  revoked grants cannot revive. When Admin shows the grant as Inactive, mint a
  new grant and pair that environment again.
- Each mint pairs through the Admin pair handoff first and falls back to popup
  paste only when Admin shows the grant as not confirmed ([Pairing](#pairing)).
  A not-confirmed handoff may still have been committed; neither path retries,
  mints again or rolls back automatically, and the grant is never recorded.
- Re-pair staging after every staging integration-data reset; do not assume a
  locally retained grant survived the reset. Unpair the old local pairing first.
- Disconnect in the target Admin Operator session panel revokes every active
  grant. Confirm the result and refresh grant metadata. Conflict or incomplete
  completion is not a successful clear; inspect the refreshed state before
  retrying. Disconnect does not end any browser or provider session.
- Unpair in the extension removes its local grant and then asks Catalog to
  revoke that grant; the grant is the only authority that route accepts.
- Offboarding or suspected grant exposure: Disconnect in Admin, confirm the
  refreshed metadata shows no active grant, and Unpair that environment in the
  extension. Uninstall alone cannot revoke a grant. Any provider-side sign-out
  is the operator's own browser action, never a Chase Sets step; never test
  live logout or expiry on the seller session.
- There is no keyring or server custody to rotate or recover. A
  `custody-unavailable` response from an operator-session route means grant
  storage could not be read; hold, confirm the retired keyring remains absent,
  and retry the Admin action later. Never restore a key or export grant storage.

Never commit cookies, copied request headers, local `.env` overrides, grant
values, screenshots containing values, or raw provider request captures.

## Boundary

- Chase Sets never contacts TCGplayer servers and never stores or uses a
  TCGplayer cookie, session, or credential. Any TCGplayer request must happen
  in the operator's own browser, never from a Chase Sets server.
- The Catalog operator-session routes are only Admin grant metadata, mint and
  Disconnect, plus the extension's grant-authenticated unpair. None accepts or
  returns a provider credential.
- Catalog credential readiness reports TCGplayer as `not-required`, with source
  kind `none`, state `unknown`, diagnostic `provider-retired`, and evidence
  `transport: browser-extension-only`; transport diagnostics report
  `provider-retired`. TCGplayer readiness is never `configured`, and neither
  that readiness nor an active grant proves that TCGplayer accepted anything.
- Retired provider hosts and domain keys are history only; see the
  [TCGplayer Automation Client Contract](../../bounded-contexts/catalog/docs/tcgplayer-automation-client-contract.md).

## Logging And Retention

Logs and operator-facing job status may include provider key, domain key, HTTP
status, retry count, scope, checkpoint counts, durable job id, and sanitized
provider diagnostic text.

Do not log or persist these values in logs, events, job payloads, Source
Observations, Price Signals, screenshots, or launch evidence:

- `TCGAuthTicket_Production` or complete `Cookie` headers;
- `Authorization` headers;
- seller names, seller ids, seller keys, seller email, phone, or account-specific
  marketplace identifiers;
- raw provider request bodies when they include account, seller, or listing
  controls;
- raw provider response bodies outside the bounded context's explicit
  source-payload or Price Signal retention policy.

Catalog Source Observations may retain product and SKU provider payload evidence
needed for review. Catalog observation hashes must exclude price, latest sales,
listing, seller, seller quantity, and other Pricing or Inventory signals.
Pricing may retain price-point, sale, listing, and price-history payloads in
Pricing-owned tables. Keep only redacted diagnostic previews of rejected
provider payloads.

Metrics labels must stay bounded: provider, context, job type, and status
class. Never use product ids, SKU ids, seller ids, account ids, job ids, or
request URLs as metric labels.

## Verification

After pairing, Disconnect or Unpair, staging first and then production:

1. Reload Admin's Operator session panel. Below its fixed Operator session
   unavailable notice it shows only Revision and the Extension grant state
   (Active, Inactive or No grant), plus Created, Last used and Idle expiry when
   a grant exists. A failed read shows that notice without Revision. Record
   that metadata and the handoff outcome only.
2. Confirm Admin Provider setup or Integration health still reports TCGplayer
   credential readiness `not-required` with diagnostic `provider-retired`.
   Neither an active grant nor that readiness proves that TCGplayer accepted
   anything.
3. Do not deploy, restart, edit secrets, reset state, query grant storage, or
   start any import or capture to produce evidence. An unavailable observation
   remains `unknown`.

Fixture-backed Catalog, Inventory, and Pricing checks remain the automated
proof; CI must not depend on live TCGplayer availability.
