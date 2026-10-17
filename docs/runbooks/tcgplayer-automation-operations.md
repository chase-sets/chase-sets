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

For production packages, use the shared [Operator-Package Target Reachability](../../.agents/skills/delivery/SKILL.md#operator-package-target-reachability) gate before package READY, at host signal and at window-open re-verification. The #9374-production inventory includes Admin `/catalog/providers/tcgplayer`, the extension's `/api/public/catalog/operator-session/grant` and `/api/public/catalog/operator-session/tcgplayer` on that Admin origin, and permitted provider entry/sign-in routes. Do not mint, revoke or push a grant to probe reachability. Staging remains independently gated; existing custody, recovery and G1-G7 authority below is unchanged, and routing proof grants no execution GO.

Complete the [passive recovery gate](#rate-limits-and-recovery) before pairing,
re-pairing, or changing the provider login for a rotation drill. Pairing can push
the current session immediately. A cookie change is forwarded to every paired
environment, so leave environments whose gate says `not-needed`, `held`, or
`unknown` unpaired for the drill. Proceed staging first, then independently gate
production; do not force a second login to manufacture production evidence.
Each environment's one-time first pairing for #9374 instead follows
[Initial Cutover (#9374)](#initial-cutover-9374), which keeps every hard stop.

1. The host confirms `CATALOG_OPERATOR_SESSION_KEYRING_JSON` exists in the target
   environment using secret metadata only and supplies the independently
   reviewed unpacked extension artifact with its exact-head handoff inventory.
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
   its local storage; it is not a session push or provider acceptance.
5. Popup paste (fallback): if Admin instead shows the grant with Automatic
   pairing was not confirmed, that is not proof the extension did not receive
   the grant or that anything was rolled back. Copy the once-shown grant only
   into the extension popup's Pairing grant field, choose Staging or Production
   to match Admin, and choose Pair. Dismiss grant in Admin. In either path,
   never record the grant or inspect/export extension storage.
6. If the gate permits a provider session change, sign in to TCGplayer in that
   paired browser. Refresh the popup and reload Admin. Record only Revision,
   Stored at, Custody available, and Extension grant metadata. A new stored
   session advances Revision; an identical cookie under the same active key is
   `unchanged`, not revision-increment proof. Do not rotate again for evidence.
7. Follow [Verification](#verification) through the next already-scheduled
   ordinary capture, without manual provider queries, deploys, or restarts.

### Initial Cutover (#9374)

Todd's 2026-10-11 ruling on #4388 makes operator-session custody the required
TCGplayer credential path and retires the manual env cookie; #9374 pairs staging,
then production. Until an environment is paired, its runtime still resolves the
env fallback above; #9375 owns removing it. This subsection covers only the
first pairing of each previously unpaired environment. It replaces the rotation
justification of the [recovery gate](#rate-limits-and-recovery) for that one
pairing and relaxes no other stop, privacy bound, or traffic rule here.

- **Scope.** With G1-G7 clear, pair and push even when the historical baseline
  is `not-needed`, or `unknown` solely because no usable baseline or only a lone
  ambiguous `403` exists. Record that classification unchanged as before-state;
  never relabel it healthy, expired, or rotation-authorized. A `429` remains
  throttling; its active cooldown stops until a fresh passive snapshot shows it
  expired, with no probe or login to change the baseline. The exception is
  consumed by the first pairing, not renewed until success. Unexpected prior
  custody or pairing goes to G3 reconciliation; later grant replacement,
  Disconnect or re-pair, staging-reset re-pair, rotation, and retry after a
  failed ordinary pass follow the recovery gate and drill unchanged.
- **Current session.** Push the TCGplayer session already signed in to Todd's
  normal operator profile. Do not log out or log in again. If that profile is
  signed out, tell the host; one manual sign-in follows only after the target
  and every already-paired receiving environment clear their gates. Never log in
  again for production evidence; a provider challenge or failed login is not
  authority to retry or automate. Admin step-up sign-in is separate.
- **Evidence timing.** Every fact is per environment: record context, UTC,
  image digest and commit, deploy run, pod UID/start/restart identity, and
  snapshot time, gathered fresh immediately before that environment's Pair. A
  deploy, reset, restart, new possible sender, changed database authority, or
  stale observation needs fresh evidence, not an earlier GO.

Hard stops are per environment; an unknown result is STOP.

| Gate | Required proof; anything else stops |
| --- | --- |
| G1 Keyring and custody | A normal Platform Deploy after 2026-10-11T21:49Z applied runtime secrets successfully in BOTH environments with a masked non-empty `CATALOG_OPERATOR_SESSION_KEYRING_JSON` (run/job and timestamps). Secret-name existence is insufficient. Target Admin shows Custody available before minting. Never redeploy just for proof. |
| G2 Artifact and operator | The [extension](../../deployables/tcgplayer-operator-extension/README.md) is the independently reviewed exact head and installed byte inventory; Todd's normal non-incognito profile; intended environment selected; recent platform-admin authentication. Local tests are not installation authority. |
| G3 First pair | Admin metadata and the operator record show no completed initial pairing; record Revision, Stored at, and grant metadata without custody SQL reads. A missing outcome row alone does not prove no custody. Unexpected custody or pairing goes to host reconciliation, not grant replacement. |
| G4 One authority, no predecessor | Every API, worker, or other platform TCGplayer caller sharing the egress, across environments too, uses one Catalog limiter authority, bound to pod/controller census (UID, deletion, owners, readiness, container state/restarts, imageID, actual replicas), Catalog Secret refs in pods and templates (no literals, duplicates, or unexpected `envFrom`), and non-secret database-authority evidence. No old sender may be running, terminating, restarting, pending, or schedulable by an old controller; Ready or zero ready replicas proves nothing alone. Todd's separate automation app is out of scope. |
| G5 Shipped pacing and detection | Each sender's live imageID maps through release/build evidence to a commit containing #8458 (`d8c137c9`), #8460 (`67fc253b`), and #8493 (`6dd05a03`) with no later removal. Guessed-tag ancestry or run history alone is insufficient. |
| G6 Shared budget | Rate rows are readable; `mpApi` effective delay is at least `10000ms` and the verified configured floor, preserving stronger learned delay; bounded concurrency and the shipped limiter remain configured; `mpApi` and every domain of the ordinary pass are out of cooldown by database snapshot time. A live lease is activity, not a stop. Never reset leases, delays, epoch, or cooldown. |
| G7 Ordered window | Staging first. Pair production only after staging is verified by the post-push proof below AND production clears G1-G6 at its own moment under its own GO. On any failure hold that path: no repeat login, synthetic call, extra capture, budget reset, or unpair/re-pair loop. |

The host reads rate and outcome facts by direct SELECT through an existing
approved Catalog read-only route proven to reach each live caller's authority;
reaching some Catalog database is not enough. Never call a runtime initializer,
admission, recorder, or schema boot, since they can write. Keep credentials,
URLs, and keyring values out of argv, output, traces, and reports; no
`SELECT *`, schema exploration, locks, writes, temporary tables, or provider
requests; keep driver errors sanitized. Never read
`catalog_tcgplayer_operator_sessions` or grant storage. A missing approved route
is `unknown`, not authority to install tools or read secrets. Run only this fixed
transaction, fresh before Pair, and end it promptly:

```sql
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '5s';
SET LOCAL lock_timeout = '1s';
SET LOCAL idle_in_transaction_session_timeout = '10s';
SELECT current_database() AS database_name, inet_server_addr()::text AS server_address,
       inet_server_port() AS server_port, pg_is_in_recovery() AS is_replica,
       current_setting('transaction_read_only') AS transaction_read_only,
       clock_timestamp() AS snapshot_at
  FROM catalog_tcgplayer_automation_domain_rate_limits WHERE domain_key = 'mpApi';
SELECT r.domain_key, r.effective_request_delay_ms AS request_delay_ms,
       r.effective_learned_min_delay_ms AS learned_min_delay_ms,
       r.min_request_delay_ms AS floor_request_delay_ms, r.cooldown_until::text AS cooldown_until,
       (SELECT COUNT(*) FROM catalog_tcgplayer_automation_domain_rate_limit_leases l
         WHERE l.domain_key = r.domain_key AND l.expires_at > clock_timestamp()) AS live_lease_count,
       r.epoch, clock_timestamp()::text AS snapshot_at
  FROM catalog_tcgplayer_automation_domain_rate_limits r
 WHERE r.domain_key IN ('mpApi', 'mpSearchApi', 'infiniteApi', 'mpGateway')
 ORDER BY r.domain_key;
SELECT source, revision, custody_revision, state, state_since, ever_succeeded, updated_at,
       clock_timestamp() AS snapshot_at
  FROM catalog_tcgplayer_operator_session_outcomes WHERE provider_key = 'tcgplayer';
ROLLBACK;
```

Keep server identity host-private and match it to the current authority map; a
replica, null identity, or unmapped pool alias does not establish the shared
writable authority, and matching rows do not either. The raw floor column is
persisted state; compare it with the live revision's configured minimum. Pricing
capture tables are rejected as baseline or source proof: status classes cannot
separate `401`/`403`/`429`, and the authenticated flag names no custody
revision. Correlate with existing sanitized scheduled-job/capture evidence.

Post-push proof follows [Verification](#verification) steps 1 and 3-5. Admin
shows Revision > 0, Stored at, an active grant, and Custody available. The
outcome row read after the push and after the next already-scheduled ordinary
request shows `source=operator-session`, `revision` and `custody_revision` equal
to the stored revision, `state=healthy`, `ever_succeeded=true`, and
`state_since` after Stored at; readiness is `configured`. Retain the scheduled
job/capture identity and the request, status, domain, rate, and timing facts that
support the correlation; the row has no capture id, so its health alone is not a
job join. An absent row, `untested`, an env or older success, or an unbound
capture is not PASS. No deploy, restart, or secret change between push and
success: compare pod UID, container restart count, and container start times,
not pod start time alone. An identical cookie need not advance an existing
revision and never justifies a forced login. Post metadata-only evidence per
environment on #9374. If no scheduled pass arrives in the signaled window,
verification stays pending and production waits; never start a capture to meet
it.

### Grant And Custody Lifecycle

- Grants expire after 30 idle days. Completed pushes renew the idle deadline;
  the extension reconciles every 30 minutes while running. Expired or revoked
  grants cannot revive. A Re-pair required badge means mint a new grant in Admin
  and pair that environment again, subject to the recovery gate.
- Each mint pairs through the Admin pair handoff first and falls back to popup
  paste only when Admin shows the grant as not confirmed ([Pairing](#pairing)).
  A not-confirmed handoff may still have been committed; neither path retries,
  mints again or rolls back automatically, and the grant is never recorded.
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
   pairing or a login change; the only exception is an environment's first
   pairing under [Initial Cutover (#9374)](#initial-cutover-9374), for a missing
   or ambiguous baseline with every hard stop clear. Preserve shared learned
   delays, cooldown, leases, and epoch; never reset a budget to test
   credentials. If rotation is justified,
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
   `not-needed`, `held`, or `unknown` and stop without pairing or login changes,
   unless [Initial Cutover (#9374)](#initial-cutover-9374) permits the
   environment's first pairing.
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
