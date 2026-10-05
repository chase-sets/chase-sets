# TCGplayer Automation Operations

TCGplayer integration calls use the automation-app client behavior reviewed from
`todd-skelton/tcgplayer-automation-app` at commit `bf42aa8`. Do not replace this
runbook with assumptions from the official TCGplayer API docs.

Catalog owns product-line, set-name, product-detail, Source Observation, and
external reference ingestion. Pricing owns market price, latest sales, active
listing, and price-history signals. Inventory consumes Catalog-owned references
for import resolution. Provider transport configuration belongs in operations
and infrastructure, not deployable-local code.

## Secret Provisioning

The [TCGplayer Operator Extension](../../deployables/tcgplayer-operator-extension/README.md)
is the primary path for Todd's operator session. It forwards the applicable
`TCGAuthTicket_Production` cookie into encrypted Catalog custody; it never takes
a password or another user's credentials. Use the configured provider user agent
with the resolved cookie. No secret edit, deploy, or restart is needed to adopt a
stored revision: Catalog and Pricing resolve custody on each automation request.

`TCGPLAYER_AUTOMATION_TCG_AUTH_COOKIE` remains a secret-store fallback only when
custody is absent or cleared. A stored session takes precedence; unreadable
custody refuses requests instead of silently falling back. Local fixture-backed
development needs neither source. Live jobs need a usable resolved credential,
not necessarily an environment cookie.

### Pairing

Complete the [passive recovery gate](#rate-limits-and-recovery) before pairing,
re-pairing, or changing the provider login for a rotation drill. Pairing can push
the current session immediately. A cookie change is forwarded to every paired
environment, so leave environments whose gate says `not-needed`, `held`, or
`unknown` unpaired for the drill. Proceed staging first, then independently gate
production; do not force a second login to manufacture production evidence.

1. The host confirms `CATALOG_OPERATOR_SESSION_KEYRING_JSON` exists in the target
   environment using secret metadata only and supplies the independently
   reviewed unpacked extension artifact with its exact-head handoff inventory.
2. Todd uses his authorized normal, non-incognito operator browser, never the
   shared `Pokebash TCG` or work profile. In Chrome Extensions, enable Developer
   mode and choose Load unpacked for the supplied `dist` directory. Updates use
   Reload on the same extension identity, not a second installation.
3. Open Admin's `/catalog/providers/tcgplayer` in the target environment, then
   Operator session > Pair extension. Minting requires `catalog.manage`, the
   platform-admin role, and authentication within ten minutes; use Sign in again
   if prompted. Minting replaces the environment's previous active grant.
4. Copy the once-shown grant only into the extension popup's Pairing grant field,
   choose Staging or Production to match Admin, and choose Pair. Dismiss grant
   in Admin. Never record the grant or inspect/export extension storage.
5. If the gate permits a provider session change, sign in to TCGplayer in that
   paired browser. Refresh the popup and reload Admin. Record only Revision,
   Stored at, Custody available, and Extension grant metadata. A new stored
   session advances Revision; an identical cookie under the same active key is
   `unchanged`, not revision-increment proof. Do not rotate again for evidence.
6. Follow [Verification](#verification) through the next already-scheduled
   ordinary capture, without manual provider queries, deploys, or restarts.

### Grant And Custody Lifecycle

- Grants expire after 30 idle days. Completed pushes renew the idle deadline;
  the extension reconciles every 30 minutes while running. Expired or revoked
  grants cannot revive. A Re-pair required badge means mint a new grant in Admin
  and pair that environment again, subject to the recovery gate.
- Re-pair staging after every staging integration-data reset; do not assume a
  locally retained grant survived the reset. Unpair the old local pairing first.
- Disconnect in the target Admin Operator session panel is break-glass: it
  revokes all push grants before a fresh fenced custody clear. Confirm the
  Disconnect result and refresh metadata. Conflict or incomplete completion is
  not a successful clear; inspect the refreshed state before retrying. Cleared
  custody retains its revision fence and restores the env fallback only if that
  fallback is configured. Disconnect does not end the browser/provider session.
- Offboarding or suspected exposure: stop unsafe traffic with the approved
  provider/unit emergency-stop controls, confirm Admin Disconnect, and Unpair
  that environment in the extension. Unpair alone does not clear custody;
  uninstall alone cannot revoke a grant. Any provider-side session revocation
  is a separate operator action, not part of the rotation drill. Never test live
  logout or expiry on the seller session.
- For keyring rotation, retain keys needed by stored custody until a permitted
  next push re-encrypts under the new usable active key. For key loss or
  `operator-session-custody-unavailable`, hold requests and recover the keyring
  through the approved secret-management path, or confirm Disconnect to clear
  custody. A later permitted push can re-encrypt only with a usable active key;
  it cannot repair a missing write key. Use the popup's Retry current session after
  recovery if its permanent-error state needs an explicit retry. Never export
  custody or grant material to recover it.

Never commit cookies, copied request headers, local `.env` overrides, grant
values, screenshots containing values, or raw provider request captures.

## Provider Domains

The automation-app client splits work by domain so rate limits and cooldowns are
tracked independently.

| Domain key | Host | Owner and use |
| --- | --- | --- |
| `mpSearchApi` | `mp-search-api.tcgplayer.com` | Catalog product lines, product search, product details, listings evidence for Pricing. |
| `mpApi` | `mpapi.tcgplayer.com` | Catalog set names and Pricing latest sales. |
| `infiniteApi` | `infinite-api.tcgplayer.com` | Pricing price history and secondary price-guide evidence. |
| `mpGateway` | `mpgateway.tcgplayer.com` | Pricing SKU market price points. |

Order-management and message domains from the automation app are not part of the
Catalog ingestion path. Add a new owning context and runbook section before using
them.

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
Pricing-owned tables. Store only redacted diagnostic previews for failed provider
calls.

## Rate Limits And Recovery

The client retries `403`, `429`, `502`, `503`, and `504`. Admission, spacing,
cooldown, concurrency, and adaptive learning are shared through the Catalog
Postgres authority. API and worker callers on one database must not be enabled
against split authorities; unknown topology is fail-closed.

The bounded read-only state projection is available through the Catalog server
authority. It returns only domain key, effective/persisted delay, learned
minimum, configured floor, cooldown deadline, live lease count, epoch, and the
database snapshot instant. It never returns cookies, accounts, URLs, bodies, or
driver exception text. Treat the snapshot instant as separate from the time of
the provider pass being investigated.

1. Confirm API and worker callers for the same egress use one Catalog database
   authority and that no predecessor deployment can send. Unknown topology or
   missing deployed pacing/detector proof means `unknown`; stop without pairing
   or a login change.
2. Read the projection and compare the effective `mpApi` delay with its
   `10000ms` floor before speculating about session expiry. Preserve the current
   pass/image and do not reset learned state.
3. Bind the deployed image to shipped shared pacing (#8446) and status-preserving
   detection (#8454). Observe one already-scheduled ordinary baseline using
   durable job/capture evidence: provider, domain, scope, request UTC, HTTP status,
   rate context, readiness diagnostic, credential identity, and outcome. Do not
   start a capture or issue a manual provider request to obtain the baseline.
4. Pause new imports for the affected provider scope if the same domain is still
   cooling down.
5. Resume one provider scope at a time after the shared cooldown. A `403` alone
   is ambiguous; a `429` is throttling evidence, not credential-expiry proof.
6. Rotate only if attributable persistent `403`/auth suspicion remains with
   verified pacing. A successful baseline is `not-needed`; `429` is `held`
   through cooldown; missing baseline, unknown pacing/topology or deployed
   detector proof, or a lone unattributed `403` is `unknown`. None justifies
   pairing or a login change. Preserve shared learned delays, cooldown, leases,
   and epoch; never reset a budget to test credentials. If rotation is justified,
   use [Pairing](#pairing) once and compare only the next ordinary capture pass.

Apply readiness diagnostics within that gate, not as a bypass:

| Diagnostic | Action |
| --- | --- |
| `credential-refresh-needed` / `operator-session-expired` | Once the gate permits rotation, check the browser is paired to the intended environment and sign in to TCGplayer there. Confirm a newly stored revision in Admin, then verify the next ordinary pass. |
| `rejected-after-refresh` | Not expiry proof: the new stored revision has not succeeded. Preserve cooldown/rate state and escalate with sanitized status, revision, and pacing evidence; do not repeatedly rotate. |
| `operator-session-custody-unavailable` | Requests fail closed. Recover the keyring or confirm Disconnect as described in Grant And Custody Lifecycle; do not assume env fallback or successful pairing. |
| `adapter-authentication-failed` / `credential-missing` | Unknown authentication/rate context or no usable resolved credential. Inspect passive metadata and the baseline; do not infer expiry or issue test traffic. |

The integration-data reset may clear learned delay values back to conservative
floors, but it must not delete live leases or an unexpired cooldown. Never use a
manual row delete as a recovery step.

Retry exhaustion should leave the durable job failed or partially failed with a
sanitized reason. Requeue from a durable checkpoint only under the owning import
workflow after recovery, never as extra traffic for the session drill.

## Health Signals

Catalog import jobs and Pricing signal jobs should report:

- completed and remaining work units by provider scope;
- latest successful provider call by domain;
- latest retryable failure status by domain;
- learned request delay and learned minimum delay by domain;
- stale or missing cookie symptoms, expressed without the cookie value;
- unresolved Catalog Product or SKU references for Pricing signal jobs.

Inspect `lastHttpStatus` in transport stage facts and Pricing capture endpoint
diagnostics: it retains the last provider status even when cooldown aborts the
request. Pricing capture endpoint diagnostics also include `failureClass`, the
sanitized terminal failure classification. Missing diagnostic evidence is
unknown, not authentication success or expiry proof. These are capture/transport
facts, not new fields promised in the Operator session panel.

Metrics labels must stay bounded: provider, domain key, context, job type, status
class, and retry outcome. Never use product ids, SKU ids, seller ids, account
ids, job ids, or request URLs as metric labels.

## Verification

For a session drill, staging first and then production:

1. Reload Admin's Operator session panel and confirm the stored revision,
   Stored at, custody availability, and active grant metadata. Source follows
   custody precedence: stored row => operator session; absent/cleared row => env
   fallback; unreadable custody => requests refused. A retained revision with no
   Stored at is cleared, not stored. Provider Connections must show credential
   readiness `configured`, but no shipped UI shows a credential-source field.
   Neither an active grant nor `configured` proves provider acceptance.
2. Record the passive snapshot, deployed pacing/detector proof, topology and
   ordinary baseline from the recovery gate. If rotation is not justified, record
   `not-needed`, `held`, or `unknown` and stop without pairing or login changes.
3. When justified, record before/after revisions and `storedAt` from Pairing.
   The host reads only the #8455 outcome row through the approved passive
   read-only route after the push and after the next already-scheduled capture:
   `catalog_tcgplayer_operator_session_outcomes` fields `source`, `revision`,
   `custody_revision`, `state`, `state_since`, `ever_succeeded`, `updated_at`,
   plus the snapshot UTC. Never read `catalog_tcgplayer_operator_sessions`.
4. Bind that capture's success to `source=operator-session`, with `revision` and
   `custody_revision` equal to the newly stored revision, `state=healthy`,
   `ever_succeeded=true`, and `state_since` after `storedAt`; readiness must be
   `configured`. `untested`, an old/env success, or missing attribution is not
   success. Compare one bounded pass only; failure means hold and escalate, not
   another rotation. Do not deploy, restart, edit secrets, reset budgets, issue
   manual queries, or start an extra capture between push and success.
5. Record snapshot/baseline/push/capture UTC instants, status/rate/readiness
   context, revision-bound outcome metadata, image/deploy-history identifiers,
   and unchanged API/worker pod start times spanning push to success. Paste a
   sanitized ops-check comment on #8456 separately for staging and production;
   include no cookies, grants, headers, account facts, raw payloads, or screenshots
   containing values. An unavailable observation remains `unknown`.

This drill does not activate imports or replace game-specific rollout/signoff
gates. Fixture-backed Catalog, Inventory, and Pricing checks remain the automated
proof; CI must not depend on live TCGplayer availability. Inspect already-recorded
Source Observations and Pricing references for their existing privacy/ownership
requirements without generating additional provider traffic for this drill.
