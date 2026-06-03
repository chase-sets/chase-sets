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

`TCGAuthTicket_Production` is a provider session cookie and must be treated as a
secret.

- Store the cookie only in the target environment secret store.
- Use the configured provider user agent with the cookie so requests match the
automation-app client model.
- Never commit cookie values, copied browser request headers, local `.env`
overrides, screenshots containing cookies, or raw provider request captures.
- Rotate the cookie when an operator leaves the provider account, the provider
session is suspected stale, a rate-limit recovery asks for fresh auth, or any log
or artifact may have exposed the value.
- Revoke old sessions from TCGplayer after a replacement cookie is deployed and a
small Catalog option query succeeds.

Local development may run without the cookie for unit tests and fixture-backed
flows. Live option queries, imports, and Pricing signal jobs require the secret
in the environment that executes the job.

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

The client retries `403`, `429`, `502`, `503`, and `504`. A `403` can mean either
rate limiting or an expired/missing cookie, so operators should use the sequence
below before increasing traffic.

1. Check the durable job status for provider, domain, scope, HTTP status, and
   retry-exhaustion reason.
2. Check the persisted learned delay for the domain. Rate limits should increase
   request delay and learned minimum delay before the retry.
3. Pause new imports for the affected provider scope if the same domain is still
   cooling down.
4. Run a small product-line or set-name option query after the cooldown.
5. If `403` continues with no successful option query, rotate
   `TCGAuthTicket_Production` and redeploy/restart the worker that owns the job.
6. Resume one provider scope at a time. Do not reset learned delays unless the
   replacement cookie has been verified and the domain has a stable success
   streak.

Retry exhaustion should leave the durable job failed or partially failed with a
sanitized reason. Operators may requeue from the last durable checkpoint after
auth or rate-limit recovery.

## Health Signals

Catalog import jobs and Pricing signal jobs should report:

- completed and remaining work units by provider scope;
- latest successful provider call by domain;
- latest retryable failure status by domain;
- learned request delay and learned minimum delay by domain;
- stale or missing cookie symptoms, expressed without the cookie value;
- unresolved Catalog Product or SKU references for Pricing signal jobs.

Metrics labels must stay bounded: provider, domain key, context, job type, status
class, and retry outcome. Never use product ids, SKU ids, seller ids, account
ids, job ids, or request URLs as metric labels.

## Verification

Before enabling live TCGplayer imports in an environment:

1. Confirm the environment has `TCGAuthTicket_Production` and the configured user
   agent in secret/config management.
2. Run fixture-backed Catalog, Inventory, and Pricing tests.
3. Run a small Catalog product-line option query.
4. Run one set-name option query for a known product line.
5. Run a narrow product-id import and confirm Source Observation payloads do not
   contain cookies or seller identifiers.
6. Run a narrow Pricing SKU price-point signal and confirm it resolves through
   Catalog-owned external Product references.
7. Confirm failed provider calls expose only domain key, status, retry outcome,
   and redacted diagnostic preview.

Use live provider calls only for environment smoke checks. Automated CI must stay
fixture-backed and must not depend on live TCGplayer availability.
