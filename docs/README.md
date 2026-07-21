# Documentation

This folder is a curated map for cross-cutting product, language, API, architecture, ADR, and operator documentation.

Documentation is organized by lifecycle:

- **Reference & architecture** — living cross-cutting design and policy in `docs/architecture/` and the context-owned `docs/` folders.
- **Operator runbooks** — how to run the system, in `docs/runbooks/`.
- **Decision records (ADRs)** — immutable architecture decisions, in `docs/adr/`.
- **Design system & shared contracts** — canonical UI and cross-context contracts in `packages/design-system/` and `contracts/`.

Bounded-context behavior lives with each context under `bounded-contexts/<context>/`. Start at the [Bounded Context Map](../bounded-contexts/README.md) and each context's `README.md` and `docs/`. Context-owned deep dives are intentionally found through their owning context rather than re-listed here.

Catalog Product Contents is documented with the Catalog context in [Product Contents Contract](../bounded-contexts/catalog/docs/product-contents-contract.md).
Catalog Scope Records are documented with the Catalog context in [Catalog Scope Registry](../bounded-contexts/catalog/docs/scope-registry.md).
The Catalog integration control-plane v2 IA (three pages, per-entity action vocabulary, disclosure rules) is documented with the Catalog context in [Catalog Control Plane Blueprint (v2)](../bounded-contexts/catalog/docs/catalog-control-plane-blueprint-v2.md).
The Seller Desk target IA (home attention queue + entity surfaces, per-entity action vocabulary, absorbed-route map, attention-queue ordering policy) is the cross-context [Seller Desk Blueprint](../contracts/seller-desk/blueprint.md).
Product Contents rollout QA is tracked in [Product Contents QA/UAT](./runbooks/product-contents-qa-uat.md).

Completed milestone evidence, signoff checklists, and audits live in the closing GitHub issue/PR and git history, not in this folder.

## Core References

### Product and language

- [Product Brief](./PRODUCT.md): product vision, users, and marketplace economics.
- [Marketplace Glossary](./GLOSSARY.md): canonical marketplace language, account-role naming rules, and cross-cutting architecture vocabulary.
- [Terms of Service Publication](../bounded-contexts/public-presence/docs/terms-of-service-publication.md): Public Presence ownership, counsel placeholder posture, version/consent metadata contract, publication procedure, and launch-copy gate.

### Campaigns

- [Offer Economics Claims Substantiation](./campaigns/offer-economics-claims-substantiation.md): the truth gate for beta campaign copy — every public claim about fees, protections, or graded-card support marked substantiated, softened, or dropped against shipped code, backed by the offer-economics monitor (#4075).
- [GTM Wave Targeting And Seller Positioning](./campaigns/wave-targeting.md): the ratified #4337 seller-outreach lead narrative (repricing + market-analytics proof), Wave 1-3 segment criteria (high-volume, mid-volume, brick-and-mortar hard gate), the permanent-free repricing pricing posture, and the m111/m112/m113 beta capability calendar.
- [High-Volume Seller Outreach Collateral](./campaigns/high-volume-seller-outreach.md): the Segment A ("250k archetype") one-pager and Wave-1 truth-gated variant; the policy-repricing demo script is explicitly out of scope pending #4332.
- [30-Day Campaign Content Calendar](./campaigns/30-day-content-calendar.md): the 2026-07-20 through 2026-08-18 channel/owner/claim-reference plan, with invite-wave moments and week-one copy.
- [Campaign Market-Data Series](./campaigns/market-data-series.md): deterministic Pricing rollup snippet generation, fixture/staging rehearsal, and production-only publication gate.
- [Open-Offer Demo Walkthrough](./campaigns/offer-flow-demo.md): the truth-gated 30-second staging capture script and honest TODD creative handoff.
- [Seller Migration Campaign Assets](./campaigns/seller-migration-assets.md): the #4085 guide, proof walkthrough, #4073 demo-clip handoff, and #4083 admission-mail link.
- [Brand & Distribution Kit](./campaigns/brand-distribution-kit.md): repo-owned OG/social cards, per-game share links, the /press creator & press fact sheet, claims-gated post templates for the weekly per-game series, and the operator follow-up list for creative assets (#4086).

### Contributing

- [Public Knowledge Base Change Convention](./contributing/public-knowledge-base.md): the `KB:` pull-request/issue marker, warning-only feature-slice ratchet, and documented post-launch block-mode transition.

### Bounded contexts and structure

- [Bounded Context Map](../bounded-contexts/README.md): strategic ownership and integration relationships.
- [Bounded Context Structure](./architecture/bounded-context-structure.md): directory, manifest, export, import-boundary, deployable-composition, and structure-gate failure rules.
- [Identifier Conventions](./architecture/identifier-conventions.md): branded typed-ID minting/parsing, trust-boundary parsing, cross-context ID ownership, camelCase-vs-snake_case field-naming scope, natural-key normalization, provider-scoped external uniqueness, and internal-vs-user-facing ID policy.
- [Settings Ownership](./architecture/settings-ownership.md): decision rule for behavior-coupled settings, User-owned presentation preferences, device-local ephemera, and deployable/design-system boundaries.
- [Platform Policy Conventions](./architecture/platform-policy-conventions.md): the platform-policy/environment-configuration/compiled-constant tier decision rule, `definePolicy` machinery, the feature-flags-are-not-policy boundary, and the business-literal structure guard.

### Checkout and guest flows

- [Checkout Fresh-State Start Gate](./architecture/checkout-fresh-state-start-gate.md): ownership, dependency order, unresolved-fulfillment readiness, first vertical slice, and launch readiness map for the Shopify-simple checkout rebuild.
- [Guest Rail Intent Persistence](./architecture/guest-rail-intent-persistence.md): context-owned anonymous listing draft and Watch alert intent persistence, registration return, claim, expiry, replay, and privacy contract for the simplified item-detail rail.
- [Cookie-Backed Continuation Handoff](./architecture/cookie-backed-continuation-handoff.md): document redirect, protected-loader recovery, and regression-test rules for auth/session cookie continuations.

### Post-write consistency and projection freshness

- [Post-Write Consistency Policy](./architecture/post-write-consistency.md): product-wide strategy taxonomy and default-safe route path for `navigateAfterWrite`, `loadAfterWrite`, recovery boundaries, lag-vs-readiness classification, and realtime as a bounded correction channel.
- [Cross-Context Request-Path Read Inventory](./architecture/cross-context-request-path-read-inventory.md): #2776 classification guide, decision flow, wake posture rule, and guardrail artifact for eliminating request-path foreign read fan-out.
- [Advanced Read-After-Write Route Author Checklist](./architecture/read-after-write-route-author-checklist.md): advanced/bespoke exact freshness dependencies, route inventory, transient recovery, cookie-backed continuation, and guardrail checks for post-write projection reads.
- [Semantic Post-Write Handoffs](./architecture/semantic-post-write-handoffs.md): lightweight `postWriteHandoff` query metadata paired with `navigateAfterWrite`/`loadAfterWrite` for `fresh-read` routes where stale `200` empty, stale resource, or `404` responses can hide a successful command.
- [Projection Freshness SLOs](./architecture/projection-freshness-slos.md): critical post-write read SLOs, rollout gates, and shared thresholds for guest Buy Now checkout freshness.
- [Projection Freshness Worker Capacity](./architecture/projection-freshness-worker-capacity.md): worker topology, capacity defaults, operator evidence, and scaling order for critical projection freshness.

### Push-driven wake pipeline

- [Push-Driven Projection Runtime Phase Map](./architecture/push-driven-projection-runtime-phase-map.md): phased rollout gates for the worker-owned relay, durable wake store, Checkout hot path, and platform work-signal composite.
- [Push-Wake SLO And Load Proof](./architecture/push-wake-slo-load-proof.md): consolidated numeric SLO, canary, load, and capacity evidence for the push-first runtime.
- [Event-Store Wake Notifications](./architecture/event-store-wake-notifications.md): after-commit source wake channel, envelope, privacy, failure, and relay expectations for push-driven projections.
- [Source-Context Wake Registry](./architecture/source-context-wake-registry.md): platform rollout contract for source wake eligibility, event-store wake emission, relay fan-out, and production evidence gates.
- [Projection Wake Relay](./architecture/projection-wake-relay.md): worker-owned relay runtime and fan-out core that catches up from durable event rows and maps source wakes into control-plane projection wake intents.
- [Projection Interest Index](./architecture/projection-interest-index.md): the versioned source-to-projection wake mapping — coarse-payload lookup semantics, safe over-wake invariant, stale-index policy, and operator surfaces.
- [Push-First Projection Migration Inventory](./architecture/push-first-projection-migration.md): migration report with a push-first disposition for every projection group and read-after-write route entry, opt-out evidence policy, and rollout-wave timeline.
- [Projection Wake-Intent Scheduler](./architecture/projection-wake-scheduler.md): worker-side consumer that claims durable wake intents by lane, runs projection groups under existing leases, and completes only on durable checkpoint advancement.
- [Push-Wake Connection Budget](./architecture/push-wake-connection-budget.md): per-environment DigitalOcean connection ledger, listener/channel inventory, PgBouncer-vs-direct semantics, topology parity contract, and plan-time Terraform budget checks.
- [Platform Work-Signal Composite](./architecture/work-signal-composite.md): internal wake-notification envelope contract, emitter/waiter primitives, adapter channels, rolling-deploy compatibility, and the tracked origin disposition inventory.

### Environment

- [Environment Domain Names](./architecture/environment-domain-names.md): production, staging, dev, and preview hostname convention.
- [Environment Data Profiles](./architecture/environment-data-profiles.md): bootstrap, Catalog integration, and scenario seed policy by environment.
- [Deployable Runtime Profiles](./architecture/deployable-runtime-profiles.md): `landing`/`proof`/`public` runtime profile contract, deployable role model, database lifecycle boundary, and topology evidence checklist.
- [Deployable Profile Database Companion](./architecture/deployable-profile-database-companion.md): database lifecycle companion sequence for profile migrations, including provisioned/active/exposed context sets, budget evidence, PgBouncer posture, and restore/rebuild gates.
- [Production PgBouncer Session-Safety Audit](./architecture/production-pgbouncer-session-safety.md): production pooling decision, traffic classes, and #3234 waiter-split follow-up for transaction-pool readiness.

### Event projection runtime

- [Projection Rebuild Replay](./architecture/projection-rebuild-replay.md): projection revision policy and automatic read-model rebuild behavior.
- [Event Projection Runtime](./architecture/event-projection-runtime.md): consumer-owned subscriptions, projection consumer states, scaling, idempotency, poison-event behavior, lag metrics, and ownership/reset-strategy rules.
- [Postgres Schema Migrations](./architecture/postgres-schema-migrations.md): bounded-context schema migration ledger, advisory-lock bootstrap model, concurrent-index policy, and migration authoring rules.
- [Postgres Retention Sweeps](./architecture/postgres-retention-sweeps.md): context-owned retention registration, bounded shared worker execution, table-class windows, and explicit archive/delete exemptions.
- [Postgres Event Store Partitioning And Retention](./architecture/postgres-event-store-partitioning-retention.md): global-position partitioning decision, archive/retention gates, snapshot criteria, and migration prerequisites for `event_store_events`.
- [Projection Helper Toolkit](./architecture/projection-toolkit.md): typed row/JSONB helper mapping, escape-hatch guidance, and row-identity migration proof.
- [Event Projection Operations](./architecture/event-projection-operations.md): durable operation queue, leases, fencing, rebuild strategies, and handler transaction rules.
- [Durable Job Workflows](./architecture/durable-job-workflows.md): durable job tables, worker claims, SSE progress, and migration expectations for long-running workflows.
- [Event Projection Query Plans](./architecture/event-projection-query-plans.md): projection read query shape, supporting indexes, and backlog validation expectations.
- [Stream-Isolated Projection Errors](./architecture/stream-isolated-projection-errors.md): poison-event isolation, blocked-stream semantics, and degraded projection health.

### Notifications, messaging, and integrations

- [Notification Center And Settings](./architecture/notification-center-and-settings.md): notification side sheet, settings, Product Alert placement, and Notifications bounded-context UI/feed/read-state ownership.
- [Notifications Channel And Provider Recommendation](./architecture/notifications-channel-and-provider-recommendation.md): canonical provider/channel doc — transactional vs marketing scope, Twilio SMS/RCS and Amazon SES provider recommendation, channel ladder, and cost controls.
- [UCP Agent Commerce](./architecture/ucp-agent-commerce.md): Universal Commerce Protocol facade, REST/MCP surfaces, and bounded-context ownership.

### API

- [Marketplace API](./api/marketplace-api.md): human-readable API guide.
- [Marketplace OpenAPI](./api/marketplace.openapi.json): machine-readable API contract.
- [UCP OpenAPI](./api/ucp.openapi.json): UCP REST transport contract.
- [Agent Connector Packaging](./api/agent-connectors.md): generated Claude directory, ChatGPT app, and Gemini metadata for the native MCP endpoint.

## Runbooks

- [Customer Feedback Privacy Operations](./runbooks/customer-feedback-privacy.md): retention preview/execution, privacy holds, redaction propagation, and sensitive export incident response.
- [Facility Return Intake](./runbooks/facility-return-intake.md) — custody, discrepancy, unidentified-package, outage, wrong-facility, and correction procedures.

- [Beta Wave Exposure](./runbooks/beta-wave-exposure.md): policy-gated waitlist admission, proportional Argo exposure, monitoring, halt, and rollback procedure.
- [Money Operations](./runbooks/money-operations.md): checkout, wallet, Stripe payments, Connect payouts, launch checks, and smoke tests.
- [Stripe Connect Accounts v2 Migration](./runbooks/stripe-connect-accounts-v2-migration.md): Accounts v1 compatibility selector, v2 rollout, existing-account disposition, and cleanup handoff for #3203.
- [Fraud Operations](./runbooks/fraud-operations.md): fraud-control operator policy, including negative-balance collections thresholds and recovery behavior.
- [Rate Limit Operations](./runbooks/rate-limit-operations.md): auth, offer, payment, and card-decline limiter defaults, env overrides, kill switches, and storage seam.
- [Checkout Fresh-State Release](./runbooks/checkout-fresh-state-release.md): Shopify-simple checkout route activation, disablement, smoke validation, and release-note template.
- [Checkout Support Operations](./runbooks/checkout-support-operations.md): support playbook for stuck checkout, payment dispute, downstream handoff, and refund request scenarios.
- [Marketplace Production Promotion](./runbooks/marketplace-production-promotion.md): public promotion gates, proof mode, owner approval variables, and final readiness preflight.
- [Email Operations](./runbooks/email-operations.md): Amazon SES identities, sender configuration, DNS requirements, and rollout checks.
- [Observability](./runbooks/observability.md): local and production OpenTelemetry/LGTM stack, dashboard access, and release telemetry evidence.
- [Account Cart Consistency Probe](./runbooks/account-cart-consistency-probe.md): redacted account-cart post-write consistency evidence for optimistic apply, reconciliation, stale-response discard, rollback probes, and privacy constraints.
- [Non-Buy-Now Post-Write Freshness UAT](./runbooks/non-buy-now-post-write-freshness-uat.md): Chrome staging checklist and redacted evidence shape for account cart, Sell List, payout-ready, and listing freshness flows not covered by the Buy Now freshness probe.
- [Catalog Integration Operations](./runbooks/catalog-integration-operations.md): provider adapter, option query, job, promotion/reapply, and read-model lag incident workflows.
- [Catalog Game Provider Sync Operations](./runbooks/catalog-game-provider-sync-operations.md): Magic, One Piece, and Lorcana provider credential posture, production defaults, bulk-first imports, rotation, UI-only UAT, and emergency disablement.
- [Release Process Evolution](./runbooks/release-process-evolution.md): release queue, production locks, post-deploy production verification, rollout controls, health metrics, and gate categories.
- [Release Qualification Evidence](./runbooks/release-qualification-evidence.md): durable merge-queue qualification records in the dedicated versioned Space, append-only attempt keys, fail-closed reader, dedicated credential rotation, 400-day retention, version recovery, and cost wager.
- [Deployment Transitions](./runbooks/deployment-transitions.md): graceful shutdown, resumable streams, worker cancellation, and durable cadence.
- [Local Worktree Sandboxes](./runbooks/local-worktree-sandboxes.md): isolated local dev/test stacks for simultaneous worktrees.
- [Postage Operations](./runbooks/postage-operations.md): postage policy administration, label provider configuration, value-based shipping evidence tiers, and label smoke checks.
- [Playwright E2E](./runbooks/playwright-e2e.md): e2e charter (what the browser layer owns vs vitest), suite coverage, local setup, and sandbox-aware run commands.
- [Product Contents QA/UAT](./runbooks/product-contents-qa-uat.md): seeded scenario, API, MCP, Admin, and Marketplace rollout evidence checklist.
- [Catalog Asset Storage](./runbooks/catalog-asset-storage.md): owned storage for provider-fed catalog imagery.
- [Catalog Provider Integration Profiles](./runbooks/catalog-provider-integration-profiles.md): profile activation, rollback, retirement, and bootstrap failure response.
- [TCGplayer Automation Operations](./runbooks/tcgplayer-automation-operations.md): provider cookie handling, throttling, redaction, retention, and recovery for the automation-app client.
- [Realtime SSE](./runbooks/realtime-sse.md): projection patch transport and operational checks.
- [Projection Operations](./runbooks/projection-operations.md): backlog, worker capacity, retry, rebuild triage, and poison-event/blocked-stream repair.
- [Postgres Slow Query Digest](./runbooks/postgres-slow-query-digest.md): support-safe `pg_stat_statements` aggregate evidence, interpretation, redaction exclusions, and extension ownership boundary.
- [Push-Wake Rollout Controls](./runbooks/push-wake-rollout-controls.md): kill-switch matrix, rollback recipes, verification, and scope assessment for the push-first projection wake runtime.
- [Push-Wake Operations](./runbooks/push-wake-operations.md): incident playbook for the push-wake pipeline — Grafana-first latency stage map, structural status inspection, failure classes, Checkout triage, and safe inspection commands.
- [Push-Wake Recovery Drills](./runbooks/push-wake-recovery-drills.md): disaster-recovery drill catalog — staging reconciliation/burst drill workflow, operator-driven failover/kill-switch/cursor-loss procedures, and evidence rules.
- [Projection Freshness Audit](./runbooks/projection-freshness-audit.md): read-after-write audit record fields, privacy rules, and guest Buy Now root-cause classification.
- [Guest Buy Now Freshness Probe](./runbooks/guest-buy-now-freshness-probe.md): guest and account Buy Now readiness probe, write-to-checkout-ready release gate, negative invalid-session probe, production proof-mode runs, fixture ownership, redacted evidence, and no-payment/no-order safety.
- [Staging Representative Commerce State](./runbooks/staging-representative-commerce-state.md): staging-only representative marketplace data refresh policy and verification.
- [Ephemeral Release Verification](./runbooks/ephemeral-release-verification.md): phase-1 DOKS verification namespaces, guaranteed cleanup, evidence, and the explicit persistent-staging retirement decision.
- [Remote Dev](./runbooks/remote-dev.md): disposable DigitalOcean preview sessions.
- [Social Login Operations](./runbooks/social-login-operations.md): Google and Facebook provider setup, callback URLs, smoke tests, and secret rotation.
- [DigitalOcean Platform Deployment](./runbooks/digitalocean-platform-deployment.md): current DOKS deployment workflow, durable Terraform state ownership, recovery, and destructive-plan approval boundaries; [ADR 0018](./adr/0018-doks-compute-runtime.md) records the pre-launch compute migration decision.
- [DigitalOcean DOKS Foundation](../infrastructure/digitalocean/doks/README.md): ADR 0018-aligned DOKS cluster, node-pool, and DOCR integration Terraform scaffold; #4044 remains open until live DigitalOcean evidence is recorded.
- [DOKS Platform Operations](./runbooks/doks-platform-operations.md): Kubernetes operator runbook for rollout status, diagnostics, rollback, runtime Secret rotation, ingress, certificates, and bootstrap-hook drills.
- [Admin Shell Smoke Matrix](./runbooks/admin-shell-smoke-matrix.md): admin shell, actor, link, API topology, download, SSE, and durable-job release evidence matrix.
- [Admin Workflows Staging QA](./runbooks/admin-workflows-staging-qa.md): support-safe admin actor matrix, evidence rules, and representative state checks for deployed staging QA.
- [UCP Agent Commerce](./runbooks/ucp-agent-commerce.md): UCP smoke checks, signed write expectations, and readiness gates.
- [Google Shopping Operations](./runbooks/google-shopping-operations.md): Merchant Center launch checklist, worker config, operating cadence, pause/withdrawal, diagnostics owner routing, and provider incident response.
- [Catalog Display Identity Propagation](./runbooks/catalog-display-identity-propagation.md): recomputation health, backfill, repair, downstream projection diagnosis, and rollout verification for resolved display identity.
- [Tax Production Readiness](../bounded-contexts/ordering/docs/production-tax-readiness.md): tax readiness evidence, no-provider launch posture, and provider-required collection gating.
- [Tax Nexus Tracking](../bounded-contexts/ordering/docs/tax-nexus-tracking.md): state-by-state threshold tracking for when Chase Sets must prepare registration or start collecting sales tax.

## Design System and Shared Contracts

- [Design System](../packages/design-system/README.md): foundations, props vocabulary, spacing/type scales, composition rules, forms, and motion.
- [Marketplace Design Direction](../packages/design-system/MARKETPLACE_SYSTEM.md)
- [Dense Admin Workbench Pattern](../packages/design-system/DENSE_ADMIN_WORKBENCH.md)
- [Progressive Disclosure](../packages/design-system/PROGRESSIVE_DISCLOSURE.md)
- [Reference Info Popup](../packages/design-system/REFERENCE_INFO.md)
- [Panel Interaction Patterns](../packages/design-system/PANEL_INTERACTIONS.md)
- [Section Navigation](../packages/design-system/SECTION_NAVIGATION.md)
- [Checkout Primitives](../packages/design-system/CHECKOUT_PRIMITIVES.md)
- [Operational Workflows](../packages/design-system/OPERATIONAL_WORKFLOWS.md)
- [Embedded Stripe Appearance](../packages/design-system/EMBEDDED_STRIPE_APPEARANCE.md)
- [Design System Milestones](../packages/design-system/DESIGN_SYSTEM_MILESTONES.md): completed form-system (#10) and legacy-eradication (#12) traceability and verification commands.
- [Localization Contract](../contracts/localization/README.md)

## ADRs

- [ADR 0001: Platform API Observability](./adr/0001-platform-api-observability.md)
- [ADR 0002: Adopt UCP For Agent Commerce](./adr/0002-adopt-ucp-for-agent-commerce.md)
- [ADR 0003: Environment Bootstrap And Scenario Data](./adr/0003-environment-bootstrap-and-scenario-data.md)
- [ADR 0004: Consumer-Owned Projection Subscriptions](./adr/0004-consumer-owned-projection-subscriptions.md)
- [ADR 0005: Representative Staging Commerce State](./adr/0005-representative-staging-commerce-state.md)
- [ADR 0006: Stripe Connect Custom Account Experience](./adr/0006-stripe-connect-custom-account-experience.md)
- [ADR 0007: Google Shopping Merchant Center Integration](./adr/0007-google-shopping-merchant-center-integration.md)
- [ADR 0008: Admin Shell And IA Model](./adr/0008-admin-shell-and-ia-model.md)
- [ADR 0009: Targeted Projection Catchup](./adr/0009-targeted-projection-catchup.md)
- [ADR 0010: Push-Driven Projection Runtime](./adr/0010-push-driven-projection-runtime.md)
- [ADR 0011: Production Observability Stack](./adr/0011-production-observability-stack.md)
- [ADR 0012: Unified Outbound Messaging](./adr/0012-unified-outbound-messaging.md)
- [ADR 0013: Checkout Payments Dependency Direction](./adr/0013-checkout-payments-dependency-direction.md)
- [ADR 0014: Stripe Connect Accounts API Boundary](./adr/0014-stripe-connect-accounts-api-boundary.md)
- [ADR 0015: Deployables As Runtime Composition Roots](./adr/0015-deployables-as-runtime-composition-roots.md)
- [ADR 0016: Profiled Production Topology](./adr/0016-profiled-production-topology.md)
- [ADR 0017: Database Provisioning Is Separate From Runtime Activation](./adr/0017-database-provisioning-runtime-activation.md)
- [ADR 0018: DOKS Compute Runtime](./adr/0018-doks-compute-runtime.md)
- [ADR 0019: Feature Flags And Rollout Boundaries](./adr/0019-feature-flags-rollout-boundaries.md)
- [ADR 0020: Wallet Adjustment Authority And Balance Types](./adr/0020-wallet-adjustment-authority-and-balance-types.md)
- [ADR 0021: Customer Feedback Bounded Context And Versioned CSAT Contract](./adr/0021-customer-feedback-bounded-context-and-csat-contract.md)
- [ADR 0022: Platform-Covered Resolution Ownership And Contracts](./adr/0022-platform-covered-resolution-contracts.md)
- [ADR 0023: ReturnShipment Aggregate And Platform Return-Facility Directory](./adr/0023-return-shipment-aggregate.md)
- [ADR 0024: Recovered Return Inventory And Protection Recovery](./adr/0024-recovered-return-inventory-and-value.md)
- [ADR 0025: Write-Path Inline Projection Apply](./adr/0025-write-path-inline-projection-apply.md)
- [ADR 0026: Market-Price Methodology](./adr/0026-market-price-methodology.md)

## Generated Markdown

`packages/design-system/COMPONENT_INDEX.md` is generated output. Regenerate it through the owning script instead of editing it by hand.
