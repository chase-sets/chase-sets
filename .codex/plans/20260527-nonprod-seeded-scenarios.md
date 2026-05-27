# Representative Staging Commerce State

## Intent

Make staging production-like by giving it durable, realistic commerce usage over the real Catalog integration output: internal accounts, Inventory, Listings, Offers, Orders/Purchases/Sales, Shipments, Payments, Settlement, Reviews, Support requests, Notifications, and enough edge cases to evaluate real product and account surfaces.

The key design distinction is:

- **Production-safe bootstrap**: deploy-time schema, critical operating data, platform admin, and Catalog integration structure.
- **Production-like representative state**: explicit staging-only accounts and commerce usage generated against current Catalog Items from real integrations, created by an operator workflow or staging reset, not by ordinary production deployment bootstrap.

User clarification: keep the real Catalog integrations. The optimal target is a repeatable generator that creates accounts and then creates usage across current Catalog Items that have not been touched yet, so it can run after each new integration pull.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\20260527-nonprod-seeded-scenarios`
- Branch: `codex/nonprod-seeded-scenarios`
- Base: refreshed `origin/main` at `0ab4fb8ed3e79450a0a2a5116d9f4d90e29e63dd`
- Sandbox id: `7b0f3e80`
- Dependency setup status: `pnpm run deps:install` completed
- pnpm store path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\.chase-sets-pnpm-store`
- Setup blockers: none

## Current Implementation Progress

- `representative-commerce-state` exists in the environment data profile contract and runtime profile lists.
- Platform/admin config reject `representative-commerce-state` in production while allowing explicit staging configuration.
- The platform API representative command composes real provider/test adapters, requires confirmation, runs staging-only profiles, and reports untouched Catalog Item candidates.
- Catalog and Commercial Terms no longer run fixed fake scenario data for `representative-commerce-state`.
- Identity owns the first representative generator slice: staging collector, value buyer, card vault, sealed stockroom, and support ops accounts, users, memberships, consents, and shipping addresses.
- Marketplace owns current active untouched Catalog Item candidate selection behind its public context entrypoint.
- Inventory owns representative stock creation for selected current Catalog Items behind its public context entrypoint.
- Marketplace owns representative listing publication from that Inventory stock behind its public context entrypoint.
- Marketplace owns representative offer submission for selected current Catalog Items behind its public context entrypoint.
- Marketplace accepts a bounded subset of representative offers with current fee quotes, then the platform command drains Ordering projections so accepted offers create purchase/sale/order coverage.
- A manual `Platform Staging Representative Commerce State` workflow runs the command against live staging after reset or Catalog imports while normal staging deployment bootstrap stays representative-data-free.

## Owning Contexts

- **Catalog** owns product truth, provider-shaped item structure, product resolution, and product assets through real integrations. Representative commerce must not create fake Catalog Items.
- **Identity** owns internal staging users, accounts, memberships, permissions, profiles, contact methods, and shipping addresses.
- **Inventory** owns account-held stock, storage locations, ship-from mapping, quantities, and holds.
- **Commercial Terms** owns seller-side Marketplace Sales Fee schedules and account-specific agreements.
- **Marketplace** owns Listings, Offers, seller availability, and accepted-offer facts.
- **Checkout** owns cart/checkout session intent where a scenario needs pending checkout behavior.
- **Ordering** owns Orders, buyer-facing Purchases, seller-facing Sales, cancellation states, and economics snapshots.
- **Payments** owns Payment and Refund state and processor references.
- **Fulfillment** owns Shipments, package preparation, labels, dispatch, delivery, returns, and exceptions.
- **Settlement** owns wallet ledger, balances, payout readiness, payouts, and holds.
- **Reputation** owns post-transaction Reviews and review summaries.
- **Support** owns structured Support requests and support resolutions.
- **Notifications** owns notification-center feed items and read state projected from source facts.
- **Discovery** owns item detail/search/public account read models and product-page market presentation.
- **Platform Operations** owns admin/operator scenario catalog and refresh status surfaces.
- **Deployables** remain thin composition roots for running bootstrap/refresh jobs and routes only.

## Repo Evidence

- ADR 0003 currently says staging and production run only `critical-bootstrap` and `catalog-integration-bootstrap`, while `scenario-seed` is limited to dev, preview, and test. That policy keeps bootstrap safe but leaves staging under-representative.
- `EnvironmentDataProfile` currently has only `critical-bootstrap`, `catalog-integration-bootstrap`, and `scenario-seed`.
- `seedApiHostIfEmpty` runs the full cross-context projection drain only when `scenario-seed` is enabled.
- Most commerce context seeds default to `scenario-seed` and already create useful baseline states, but several are development-shaped: fake payment gateways, synthetic provider references, fixed fake Catalog Item ids, `seed://` attachments, March 2026 timestamps, and generic demo labels. They should not be reused directly for representative staging coverage.
- Staging reset already exists as `.github/workflows/platform-staging-reset.yml`; it destroys/recreates staging and smokes it. This is the natural hook for a fresh representative dataset.
- DigitalOcean `platform-bootstrap` is a `PRE_DEPLOY` App Platform job. Normal staging deploys should keep this production-safe.
- Discovery item detail already projects active Listings and submitted Offers. Its Sales tab currently renders unavailable sales history, so completed product sale comps require an additional Ordering-to-Discovery read model.

## Resolved Decisions

- Add a new data profile named `representative-commerce-state`.
- Do not add representative data to default staging deploy bootstrap.
- Run representative state only from explicit staging reset and a future manual refresh workflow.
- Hard-block `representative-commerce-state` in production config and runtime entrypoints.
- Keep real Catalog integration data. Representative generation should query active current Catalog Items from marketplace/discovery projections and prefer items with no existing listings, offers, or sales.
- Do not run fixed fake Catalog Item scenario seeds for `representative-commerce-state`.
- Use bounded-context commands, APIs, and source events; do not insert read-model rows directly.
- Keep generated usage idempotent through stable run ids, item-derived aliases, and reserved synthetic account/usage ids.
- Prefer realistic but internal data over copied production data. No production PII, payment details, payout details, or raw provider payloads.
- Use staging/test-mode providers. Allow local/test fake adapters only outside staging.
- Build a scenario catalog so people know which products/accounts/orders to inspect.
- Treat product-page completed sales history as a separate Discovery feature in the same delivery plan because staging data alone cannot render that tab.

## Implementation Plan

### Phase 1: Policy And Profile Contract

- Update `contracts/bounded-context-module` with `representative-commerce-state`.
- Update platform/admin config profile allow-lists.
- Add production guardrails:
  - reject `representative-commerce-state` when `DEPLOYMENT_ENVIRONMENT=production`;
  - require `DEPLOYMENT_ENVIRONMENT=staging` or an explicit local/test override for the staging refresh entrypoint;
  - require a confirmation phrase such as `REPRESENTATIVE_COMMERCE_STATE_CONFIRM=seed staging commerce`.
- Update `infrastructure/platform-runtime/api.ts` so full projection drain runs for `scenario-seed` or `representative-commerce-state`.
- Keep `productionLikeDataProfiles` unchanged for normal staging/production bootstrap.
- Add tests proving:
  - staging default remains production-safe;
  - staging can explicitly allow representative state;
  - production rejects representative state even with `PLATFORM_DATA_PROFILES`;
  - full projection drain runs for representative state.

### Phase 2: Staging Refresh Composition And Candidate Selection

- Add a thin platform API command, likely `deployables/platform-api/src/representative-commerce-state.ts`.
- Reuse `createPlatformApiHost`, `createPlatformApiPools`, configured object storage, Stripe payment adapter, Stripe Connect adapter, EasyPost adapter, and notification adapters from production composition.
- Expose package script: `pnpm --filter @chase-sets/app-platform-api run representative-commerce-state:production`.
- Add a platform-runtime helper that runs context seeds in lifecycle order with `enabledDataProfiles: ["critical-bootstrap", "catalog-integration-bootstrap", "representative-commerce-state"]`.
- Ensure the command logs a scenario-run id, profile, environment, and counts by context.
- Add a local/test mode that uses fake payment/postage/money movement adapters so DB tests can exercise the command without external providers.
- Add candidate selection from projected current Catalog Items:
  - source: Marketplace or Discovery catalog projections after Catalog import/promotion has replayed;
  - eligible: active Catalog Items with resolved products and product measurement snapshots;
  - priority 1: no listings, offers, or completed sales;
  - priority 2: stale or thin market state below configured density;
  - excluded: items already touched by the same representative run id unless reconciliation is requested.
- Make the item limit configurable so operators can run a small post-import coverage pass.

### Phase 3: Context-Owned Account And Usage Generators

Each context keeps its own behavior and scenario aliases under context-owned `seed-support`/`runtime-support`, with deployable code only composing them.

- Catalog:
  - continue to own integration structure and provider import/promotion;
  - expose enough read-model data for usage generators to pick current active items and valid product selections;
  - do not create representative fake Catalog Items.
- Identity/Auth:
  - create/reconcile internal staging accounts such as `staging-collector`, `staging-value-buyer`, `staging-card-vault`, `staging-sealed-stockroom`, `staging-support-ops`;
  - reconcile memberships, permissions, contact methods, and shipping addresses;
  - document or create safe sign-in credentials through existing admin/bootstrap policy.
- Inventory:
  - create storage locations mapped to ship-from locations;
  - create stock for selected current Catalog Items with high-volume low-value, scarce graded, sealed, and near-empty patterns;
  - include held/reserved inventory through downstream order scenarios.
- Commercial Terms:
  - reconcile default and negotiated fee schedules for low-value and high-value sellers.
- Marketplace:
  - create active, paused, draft, withdrawn, sold-out, and seller-unavailable Listings for selected current Catalog Items;
  - create Offers across high-intent, lowball, bulk, accepted, and no-listing demand cases for selected current Catalog Items;
  - include low-value card margin cases.
- Checkout:
  - create optional pending cart/checkout-session scenarios only when they add visible staging value.
- Ordering:
  - create pending-payment, paid/ready-for-fulfillment, cancelled, accepted-offer, buy-now/listing purchase, multi-seller split, and self-service-cancellation scenarios;
  - preserve Purchase/Sale language on buyer/seller read models.
- Payments:
  - create pending, captured, failed, cancelled, refunded, and refund-failed Payments;
  - use Stripe test-mode for live staging verification where feasible;
  - avoid fake processor references in staging-visible production-like scenarios unless clearly marked as historical synthetic.
- Fulfillment:
  - create awaiting-package, awaiting-label, label-attached, dispatched, delivered, returned, exception, and cancelled shipment states;
  - use EasyPost test mode for label purchase/void smoke scenarios where feasible.
- Settlement:
  - create pending sale credits, matured available credits, support holds, payout requested, payout in transit, completed payout, failed payout, and reversal states;
  - keep provider readiness/payout destination hosted by Stripe Connect, never stored directly.
- Reputation:
  - create buyer-to-seller and seller-to-buyer reviews from delivered orders;
  - include active, updated, and withdrawn reviews.
- Support:
  - create active and resolved support requests, including product-not-received, damaged product partial refund, and post-package-preparation buyer cancellation request.
- Notifications:
  - verify source facts create feed items for order creation and shipment delivery;
  - seed preferences only through Notifications-owned behavior if needed.
- Pricing/Insights:
  - project representative market activity so dashboards and recommendations have non-empty inputs, without taking ownership of source facts.

### Phase 4: Product Sales History

- Add a Discovery-owned product sales history read model sourced from Ordering/Fulfillment/Payments as appropriate.
- Recommended first fact: Ordering publishes completed or ready-for-fulfillment Order line economics; Fulfillment delivery can add completion timing if needed.
- Discovery item detail should show recent completed sale rows and summary stats by `catalog_item_id`/`product_id`.
- Keep Sales as Ordering-owned transaction truth; Discovery only owns browse presentation.
- Add tests for:
  - accepted-offer sale appears after commitment/payment/fulfillment path required by product policy;
  - cancelled/pending orders do not appear as completed sales;
  - stale replay rebuilds sales history idempotently.

### Phase 5: Operator Scenario Catalog

- Add durable runbook `docs/runbooks/staging-representative-commerce-state.md`.
- Add `docs/architecture/environment-data-profiles.md` updates and supersede or amend ADR 0003 with a new ADR.
- Add a Platform Operations admin route for staging scenario catalog:
  - scenario alias;
  - purpose;
  - involved accounts;
  - direct links to product, listing, seller account, buyer account, purchase, sale, shipment, payment, settlement, review, support, and notification surfaces;
  - last refreshed timestamp and source commit/run id.
- Keep the scenario index generated from stable scenario definitions, not hand-copied links.

### Phase 6: CI/CD And Staging Operations

- Add tests for the representative state command using local fake adapters and DB-backed context runtime.
- Extend `platform-staging-reset.yml` to run representative state after the App Platform reset/deploy succeeds and before final smoke, or add a gated `POST_DEPLOY` job enabled only by staging reset variables.
- Add a separate manual workflow for non-destructive representative data reconciliation after staging is already live.
- Extend smoke checks to verify:
  - representative products exist on search/detail pages;
  - at least one product has Listings, Offers, and Sales history;
  - account Sales/Purchases/Shipments/Payments/Wallet/Reviews/Support pages are non-empty for scenario accounts;
  - projection lag is drained after refresh.
- Ensure normal `platform-production.yml` staging deploys do not run representative refresh unless explicitly requested.

## Scenario Matrix

- Newly imported product with no market state before generation: proves the refresh can add coverage after every integration pull.
- Product with many active listings and many offers: tests market depth and sorting.
- Product with listings but no offers: tests buy-side path and empty demand state.
- Product with offers but no listings: tests seller opportunity and Offer Matches.
- Product intentionally left with no market state: tests empty marketplace affordances.
- Low-value raw card with bulk quantities: tests fee/margin policy.
- High-value graded card with scarce quantity: tests listing evidence, risk, and price presentation.
- Sealed product with multi-unit inventory: tests quantity caps and shipping.
- Seller unavailable with active listings: tests Marketplace seller availability overlay.
- Pending-payment purchase: tests buyer payment recovery.
- Cancelled purchase: tests order cancellation/refund effects.
- Ready-for-fulfillment sale: tests seller queue.
- Awaiting-label shipment: tests packing/label workflow.
- Dispatched and delivered shipments: tests tracking and review eligibility.
- Returned/exception shipment: tests support and downstream handling.
- Active support request: tests holds and support dashboard.
- Resolved partial refund: tests Payments/Settlement/Reputation consequences.
- Completed and failed payout: tests wallet/payout operations.

## Verification Plan

- Static:
  - `pnpm run verify:metadata`
  - `pnpm run verify:static`
  - `pnpm run check:structure`
  - `pnpm run check:localization`
- Targeted unit/db:
  - `pnpm --filter @chase-sets/app-platform-api run test`
  - DB seed tests for Catalog, Identity, Inventory, Marketplace, Ordering, Payments, Fulfillment, Settlement, Reputation, Support, Discovery.
  - `pnpm run test:db` or affected DB-profile tests.
- Runtime:
  - local sandbox bootstrap and representative refresh;
  - replay/rebuild relevant Discovery, Ordering, Payments, Fulfillment, Settlement, Reputation, Support, Notifications projections;
  - Playwright marketplace flows for scenario links.
- Deployment:
  - PR preview with representative command in local/fake mode;
  - staging reset workflow with representative refresh;
  - staging smoke plus scenario smoke.

## Documentation To Promote

- New ADR: `docs/adr/<next>-representative-staging-commerce-state.md`.
- Update `docs/architecture/environment-data-profiles.md`.
- Update `docs/runbooks/digitalocean-platform-deployment.md`.
- Add `docs/runbooks/staging-representative-commerce-state.md`.
- Update `docs/README.md`.
- Add or update context docs only where new behavior changes context language or invariants.

## Goal Completion Criteria

- PR submitted for the completed implementation or scoped non-product change.
- CI passing on the PR before merge.
- PR merged after required review and passing checks.
- Staging deployment verified green after merge.
- Representative staging commerce state refreshed successfully.
- Scenario catalog links verified in staging.
- Production deployment verified green after promotion or rollout.
- Local container or sandbox created for the worktree deleted with scoped cleanup.
- Worktree deleted after the retained plan is committed and the PR is merged.
- Remote PR branch deleted after merge when one exists.
- Local branch deleted after the worktree is removed and the PR is merged.
