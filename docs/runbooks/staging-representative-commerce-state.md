# Staging Representative Commerce State

Representative commerce state makes staging useful for product and operational review without turning normal deployment bootstrap into demo-data creation.

## When To Run

Run representative state after staging has been reset or after Catalog integrations import/promote new items that need marketplace activity for product and workflow review.

Before dispatching `Platform Staging Reset`, run `pnpm run ops staging-refresh:preflight`; the reset workflow repeats the same read-only gate and requires explicit `allow_scrydex_usage_check` and `confirm_no_staging_evidence_overlap` decisions before it reads Scrydex usage/readiness or live Scrydex options and before it accepts the active-run overlap check. A `human-gated` result is not reset approval: resolve every named credential-value, credit, set-substitution, and overlap item first.

Use the `Catalog Staging Provider UAT` workflow with `journey_scope=staging-representative-catalog` as the standard catalog-refresh mechanism before layering representative commerce state over freshly imported Catalog Items.

Do not run it as part of production deployment. The platform API command rejects `DEPLOYMENT_ENVIRONMENT=production`.

## Command

The preferred staging operation is the `Platform Staging Representative Commerce State` GitHub Actions workflow. It is manually dispatched, requires the confirmation phrase, reads the live staging database users and databases from Terraform state, and runs the representative refresh command against current staging Catalog integration output. Use it after a staging reset or after a new Catalog integration import/promotion. Dispatch it with the release ref that is already deployed to staging, usually `main`. The workflow uses direct database URLs for the operator refresh so long projection syncs are not bounded by transaction-pool connection lifetimes. It defaults each bounded refresh step to a five-minute timeout; increase the `step_timeout_ms` input only when projection backlog evidence shows a healthy catch-up path that needs more time.

When this workflow is used as #2515 background-load context, record it in the [Projection Freshness Worker Capacity background workload matrix](../architecture/projection-freshness-worker-capacity.md#background-workload-controls). Public evidence should include only the workflow run, release ref, support-safe step timing, selector status, and whether the refresh completed, timed out, or was deferred. Do not run or extend representative refresh while a wake drill is already proving route freshness unless the drill is intentionally collecting active-background-pressure evidence.

The platform API package owns the runtime composition command:

```bash
REPRESENTATIVE_COMMERCE_STATE_CONFIRM="seed staging commerce" \
pnpm --filter @chase-sets/app-platform-api run representative-commerce-state:production
```

For local or non-standard non-production environments, set `REPRESENTATIVE_COMMERCE_STATE_ALLOW_LOCAL=true` with the same confirmation phrase.

Each refresh step logs a `representative-commerce-state.step.*` JSON line and has a bounded timeout. The command asks Catalog to resolve product measurements for the bounded current item window, skipping Catalog Items that already have resolved product measurement snapshots, selects the ordered representative Catalog Item set directly from Catalog-owned read models independently of surviving marketplace activity, and asks Marketplace and Inventory to reconcile only those selected Catalog Item facts into their local read models before usage generation. Usage generation is idempotent against retained representative state: stable scenario ids recognize the representative stock, listings, offers, and accepted offers a previous run already created, so a repeat run over the same retained databases reports equal counts instead of appending duplicates. This avoids replaying the full Catalog event history inline after large integration pulls. The command then syncs only the Marketplace and Ordering projections needed for each generated commerce handoff, and asks Discovery to reconcile the selected representative account/listing/offer facts for visible product/search market presentation without replaying the full Marketplace event backlog. Override the default two-minute timeout for steps with `REPRESENTATIVE_COMMERCE_STATE_STEP_TIMEOUT_MS`; Catalog measurement preparation uses a larger bounded timeout because it may need to resolve newly imported items after a provider pull.

On a nonzero exit, read the `representative-commerce-state.failed` JSON line for `lastCompletedStep` and `failedStep`. Resume the same command unchanged once against the retained database. If the same step fails again, stop: diagnose the named projection/provider or reset the disposable/local sandbox before a fresh run. Never place this command in an automatic retry loop.

The completion payload also includes `chromeUatSelector`, a support-safe selector for the remaining projection freshness Chrome UAT, and `pendingPaymentSaleSelector`, a support-safe selector for pending-payment seller-surface QA. Both evaluate the representative selling persona aliases `card-vault` and `sealed-stockroom` without printing account ids, user ids, emails, provider references, inventory ids, listing ids, order ids, item details, compact tokens, or URLs. Use only these selector fields in public issue or PR evidence.

For `pendingPaymentSaleSelector`:

- `status`: `ready` means one magic-link-ready seller persona has at least one pending-payment sale visible through normal seller navigation; `not-available` means rerun the representative state workflow after checking projection catch-up.
- `selectedPersonaAlias`: the alias to use from private operator credential tooling when `status=ready`.
- `sellerSalesPath`: the normal seller navigation target `/account/sales`.
- `selectedSaleRouteTemplate`: the route shape `/account/sales/:orderId`; do not publish the concrete order id in public evidence.
- `personas[].chromeLogin`, `pendingPaymentSaleCount`, and `pendingPaymentOfferAcceptanceSaleCount`: support-safe readiness counts only.
- `nextOperatorAction`: when ready, sign in with the selected private persona and record redacted UI-only evidence that pending-payment sales cannot be packed, labeled, dispatched, released, or paid out.

For `chromeUatSelector`:

- `status`: `ready` means one persona can be used for Chrome UAT; `operator-action-required` means staging still needs private payout setup or representative state refresh.
- `selectedPersonaAlias`: the alias to use from private operator credential tooling when `status=ready`.
- `recommendedOperatorActionPersonaAlias`: the support-safe alias to use for the next private operator action when the selector can identify one. This field does not expose account ids, emails, provider references, listing ids, inventory ids, or URLs.
- `personas[].chromeLogin`: whether the alias has a Chrome-login-capable magic-link identity.
- `personas[].payoutReadiness`: whether Settlement shows provider-backed payout readiness.
- `personas[].listingState`, `activeListingCount`, `mutableListingCount`, and `inventoryItemCount`: whether the alias owns mutable representative listing and inventory state.
- `personas[].blockerCategories`: support-safe missing-state categories such as `payout-not-ready` or `owned-active-listing-missing`.

If `chromeUatSelector.status=operator-action-required`, do not treat sandbox provider verification as Chrome UAT evidence. Complete the private operator action named by `nextOperatorAction`, then rerun this workflow. When `nextOperatorAction=complete-private-payout-setup-for-recommended-persona`, use `recommendedOperatorActionPersonaAlias` with private operator credential tooling, open that account's staging `/account/payouts/setup` flow, finish provider-managed embedded payout setup until Settlement records `onboarding_status=complete`, `payout_capability_status=active`, and `payout_destination_status=ready`, then rerun the workflow. When `nextOperatorAction=refresh-representative-state-and-rerun-selector`, rerun the representative commerce state workflow after confirming current Catalog candidates and projection catch-up. Do not publish the underlying login email, account id, provider account reference, payout id, listing id, inventory id, concrete order id, or item detail used to satisfy either selector. `pendingPaymentSaleSelector` intentionally does not require payout readiness because pending-payment seller QA proves fulfillment and payout actions stay unavailable before buyer payment completes.

## Expected Data

The representative profile keeps real Catalog integration output in place and adds only the explicitly owned Prismatic Evolutions Product Contents acceptance fixture. It projects that fixture's container and contained Catalog Items, reconciles the Product Contents relationship, and synchronizes Catalog Product Contents plus Discovery detail/search before selecting commerce candidates. The fixture is prioritized outside the bounded candidate budget so `catalog_item_limit` cannot drop it. The refresh then resolves product measurements for the required fixture and a bounded active Catalog Item window, selects the ordered candidate set, reconciles those selected item facts into Marketplace and Inventory, and layers representative usage over them idempotently.

Representative Inventory stock prefers raw/non-graded product options when a current Catalog Item exposes raw-vs-graded form choices. Graded stock scenarios should include graded-card certification details before being enabled for staging-visible usage.

After generating Marketplace usage, the command reconciles Discovery market presentation for the representative listings and offers so public item detail and search surfaces show the generated activity.

The representative usage layer should reconcile:

- internal staging accounts that can buy, sell, or support workflows, including staging collector, value buyer, card vault, sealed stockroom, and support ops accounts;
- current provider-shaped Catalog Items and resolved Products selected from integration output;
- Inventory and storage locations;
- active, paused, draft, withdrawn, sold-out, and unavailable Listings;
- submitted and accepted Offers;
- Purchases and Sales across pending, cancelled, ready-for-fulfillment, and fulfilled states;
- Shipments across awaiting-package, awaiting-label, labeled, dispatched, delivered, returned, and exception states;
- Payments and Refunds across pending, captured, failed, cancelled, issued, and failed-refund states;
- Settlement wallets, holds, balances, payout requests, completed payouts, failed payouts, and reversals;
- Reviews, Support requests, and Notification feed items.

## Safety Rules

- Use bounded-context behavior for business usage. Deployable code must not insert read-model rows directly; Marketplace and Inventory may run their own selected Catalog Item fact reconciliation before generating usage.
- Use staging/test provider rails such as Stripe test mode and EasyPost test mode.
- Do not copy production PII, payment details, payout destination details, raw provider payloads, or production account data.
- Keep scenario ids stable and idempotent.
- Do not add broad fake Catalog datasets to staging representative runs. New fixed acceptance fixtures require an explicitly named behavior that provider data cannot prove deterministically; otherwise import/promote Catalog Items through Catalog integration workflows first.
- Select the current ordered Catalog candidate set independently of surviving representative listings or offers; stable scenario ids reconcile that set idempotently and stale projection rows must not narrow the next run.
- Skip Catalog Items without product measurement snapshots because accepted offers flow into Ordering and order creation requires product measurements.
- Keep Chrome UAT listing mutations fixture-owned: use the `selectedPersonaAlias`, mutate only representative staging inventory/listings owned by that alias, and restore the previous listing state or withdraw any temporary listing in the same UAT window. If cleanup cannot happen immediately, record a private cleanup owner and a 24-hour TTL outside public evidence.
- Document direct scenario links in Platform Operations or this runbook as they become available.

## Verification

After the command runs:

1. Confirm the command reports `sourceCatalogCandidateCount`, `untouchedCatalogCandidateCount`, and non-zero Marketplace/Inventory reconciliation counts.
2. Confirm marketplace search and at least one product detail page show listings and offers created from current Catalog Items.
3. Confirm at least one purchasing account has purchases, payments, shipments, reviews, notifications, and support requests.
4. Confirm at least one selling account has listings, offer matches, sales, shipments, wallet activity, payouts, reviews, and support requests.
5. Confirm the command emitted `representative-commerce-state.complete`; if a step timeout occurs, inspect the named projection backlog before retrying.
6. Confirm `pendingPaymentSaleSelector.status=ready` before using representative state as the source for pending-payment seller-surface QA. If it is not ready, rerun the representative state workflow after checking the Ordering/Inventory reservation projection backlog.
7. Confirm `chromeUatSelector.status=ready` before using representative state as the source for payout-ready return or listing-freshness Chrome UAT. If it is not ready, follow the support-safe blocker categories instead of guessing at a private account.
8. Run staging smoke checks before promoting the release.
9. For #2515 evidence, pair the refresh with the nearest `representative-volume` wake load and reconciliation artifacts, then state whether the refresh was active, completed, throttled by step timeout, or intentionally deferred during the hot-path proof window.
