# Documentation

This folder is a curated map for cross-cutting product, language, API, ADR, and operator documentation. Bounded-context behavior belongs in `bounded-contexts/`, shared contracts belong in `contracts/`, infrastructure behavior belongs in `infrastructure/`, and design-system guidance belongs in `packages/design-system/`.

## Core References

- [Product Brief](./PRODUCT.md): product vision, users, and marketplace economics.
- [Marketplace Glossary](./GLOSSARY.md): canonical marketplace language and account-role naming rules.
- [Bounded Context Map](../bounded-contexts/README.md): strategic ownership and integration relationships.
- [Bounded Context Structure](./architecture/bounded-context-structure.md): directory, export, deployable-composition, and typed-ID rules.
- [Checkout Fresh-State Start Gate](./architecture/checkout-fresh-state-start-gate.md): ownership, dependency order, unresolved-fulfillment readiness, first vertical slice, and launch evidence map for the Shopify-simple checkout rebuild.
- [Cookie-Backed Continuation Handoff](./architecture/cookie-backed-continuation-handoff.md): document redirect, protected-loader recovery, and regression-test rules for auth/session cookie continuations.
- [Read-After-Write Route Author Checklist](./architecture/read-after-write-route-author-checklist.md): exact freshness dependencies, route inventory, transient recovery, cookie-backed continuation, and guardrail checks for post-write projection reads.
- [Projection Freshness SLOs](./architecture/projection-freshness-slos.md): critical post-write read SLOs, rollout gates, and shared thresholds for guest Buy Now checkout freshness.
- [Projection Freshness Worker Capacity](./architecture/projection-freshness-worker-capacity.md): worker topology, capacity defaults, operator evidence, and scaling order for critical projection freshness.
- [Push-Driven Projection Runtime Phase Map](./architecture/push-driven-projection-runtime-phase-map.md): phased rollout gates for the worker-owned relay, durable wake store, Checkout hot path, and platform work-signal composite.
- [Checkout Surface Audit](./architecture/checkout-surface-audit.md): Shopify-simple Buy Cart and Sell List checkout gap inventory, fresh-state cleanup targets, and sequencing recommendation.
- [Environment Domain Names](./architecture/environment-domain-names.md): production, staging, dev, and preview hostname convention.
- [Environment Data Profiles](./architecture/environment-data-profiles.md): bootstrap, Catalog integration, and scenario seed policy by environment.
- [Staging Representative Commerce State](./runbooks/staging-representative-commerce-state.md): staging-only representative marketplace data refresh policy and verification.
- [Projection Rebuild Replay](./architecture/projection-rebuild-replay.md): projection revision policy and automatic read-model rebuild behavior.
- [Event Projections](./architecture/event-projections.md): consumer-owned subscriptions, replay, lag metrics, and ownership rules.
- [Event Projection Operations](./architecture/event-projection-operations.md): durable operation queue, leases, fencing, rebuild strategies, and handler transaction rules.
- [Durable Job Workflows](./architecture/durable-job-workflows.md): durable job tables, worker claims, SSE progress, and migration expectations for long-running workflows.
- [Event Projection Query Plans](./architecture/event-projection-query-plans.md): projection read query shape, supporting indexes, and backlog validation expectations.
- [Event Projection Runtime](./architecture/event-projection-runtime.md): projection consumer states, scaling, idempotency, and poison-event behavior.
- [Stream-Isolated Projection Errors](./architecture/stream-isolated-projection-errors.md): poison-event isolation, blocked-stream semantics, and degraded projection health.
- [Notification Center And Settings](./architecture/notification-center-and-settings.md): notification side sheet, settings, Product Alert placement, and Notifications bounded-context ownership.
- [Email Delivery Strategy](./architecture/email-delivery-strategy.md): transactional vs marketing scope, provider strategy, and cost-focused integration plan.
- [Email Delivery Completion Task List](./architecture/email-delivery-task-list.md): implementation checklist covering follow-up findings.
- [UCP Agent Commerce](./architecture/ucp-agent-commerce.md): Universal Commerce Protocol facade, REST/MCP surfaces, and bounded-context ownership.
- [ADR 0007: Google Shopping Merchant Center Integration](./adr/0007-google-shopping-merchant-center-integration.md): Merchant account posture, feed ownership, export projection, and launch exclusions.
- [ADR 0008: Admin Shell And IA Model](./adr/0008-admin-shell-and-ia-model.md): admin section taxonomy, Commercial Terms placement, shell navigation model, operations authorization, root hub, and admin page primitive direction.
- [ADR 0009: Targeted Projection Catchup](./adr/0009-targeted-projection-catchup.md): no-go decision for route-time projection catchup, baseline freshness contract, and reopening criteria.
- [ADR 0010: Push-Driven Projection Runtime](./adr/0010-push-driven-projection-runtime.md): worker-owned projection wake relay, durable control-plane wake store, and phased platform work-signal composite.
- [Checkout Fresh-State Route Strategy](../bounded-contexts/checkout/docs/fresh-state-route-strategy.md): Shopify-simple checkout route map, legacy route disposition, readiness guardrails, and kill-switch behavior.
- [Checkout Fresh Session Contracts](../bounded-contexts/checkout/docs/fresh-checkout-session-contracts.md): Milestone #17 buy/sell checkout snapshot, commands, state machine, idempotency, guest merge, and fresh-state compatibility rules.
- [Checkout Session Projection Performance](../bounded-contexts/checkout/docs/checkout-session-projection-performance.md): guest Buy Now checkout freshness path, supporting indexes, projection transaction behavior, and remaining platform evidence gates.
- [Guest Buy Now Freshness Verification](../bounded-contexts/checkout/docs/guest-buy-now-freshness-verification.md): signed-out Buy Now freshness contract, shared test/canary states, fixture ownership, and no-payment/no-order side-effect rules.
- [Discovery Google Shopping Feed Mapping](../bounded-contexts/discovery/docs/google-shopping-feed-mapping.md): product, offer, image, condition, shipping, returns, and eligibility mapping for Google Shopping rows.
- [Marketplace API](./api/marketplace-api.md): human-readable API guide.
- [Marketplace OpenAPI](./api/marketplace.openapi.json): machine-readable API contract.
- [UCP OpenAPI](./api/ucp.openapi.json): UCP REST transport contract.

## Runbooks

- [Money Operations](./runbooks/money-operations.md): checkout, wallet, Stripe payments, Connect payouts, launch checks, and smoke tests.
- [Checkout Fresh-State Release](./runbooks/checkout-fresh-state-release.md): Shopify-simple checkout route activation, disablement, smoke validation, and release-note template.
- [Marketplace Launch Evidence](./runbooks/marketplace-launch-evidence.md): redacted launch evidence packet, verifier, Tax posture, provider rehearsals, and launch-supply measurement proof.
- [Email Operations](./runbooks/email-operations.md): Amazon SES identities, sender configuration, DNS requirements, and rollout checks.
- [Tax Production Readiness](../bounded-contexts/tax/docs/production-tax-readiness.md): Tax readiness evidence, no-provider launch posture, and provider-required collection gating.
- [Tax Nexus Tracking](../bounded-contexts/tax/docs/tax-nexus-tracking.md): state-by-state threshold tracking for when Chase Sets must prepare registration or start collecting sales tax.
- [Observability](./runbooks/observability.md): local OpenTelemetry and LGTM stack.
- [Catalog Integration Operations](./runbooks/catalog-integration-operations.md): provider adapter, option query, job, promotion/reapply, and read-model lag incident workflows.
- [Release Process Evolution](./runbooks/release-process-evolution.md): release queue, production locks, canary path, rollout controls, health metrics, and gate categories.
- [Deployment Transitions](./runbooks/deployment-transitions.md): graceful shutdown, resumable streams, worker cancellation, and durable cadence.
- [Local Worktree Sandboxes](./runbooks/local-worktree-sandboxes.md): isolated local dev/test stacks for simultaneous worktrees.
- [Postage Operations](./runbooks/postage-operations.md): postage policy administration, label provider configuration, signature enforcement, and label smoke checks.
- [Playwright E2E](./runbooks/playwright-e2e.md): local browser e2e setup and sandbox-aware run commands.
- [Catalog Asset Storage](./runbooks/catalog-asset-storage.md): owned storage for provider-fed catalog imagery.
- [Catalog Provider Integration Profiles](./runbooks/catalog-provider-integration-profiles.md): profile activation, rollback, retirement, and bootstrap failure response.
- [TCGplayer Automation Operations](./runbooks/tcgplayer-automation-operations.md): provider cookie handling, throttling, redaction, retention, and recovery for the automation-app client.
- [Realtime SSE](./runbooks/realtime-sse.md): projection patch transport and operational checks.
- [Projection Poison Events](./runbooks/projection-poison-events.md): triage and repair for degraded projection consumers.
- [Projection Operations](./runbooks/projection-operations.md): backlog, worker capacity, retry, and rebuild triage.
- [Projection Freshness Audit](./runbooks/projection-freshness-audit.md): read-after-write audit record fields, privacy rules, and guest Buy Now root-cause classification.
- [Guest Buy Now Projection Lag Root Cause](./runbooks/guest-buy-now-projection-lag-root-cause.md): staging incident classification, evidence limits, failed contract, and follow-up mapping for Checkout projection lag.
- [Guest Buy Now Freshness Canary](./runbooks/guest-buy-now-freshness-canary.md): staging synthetic browser canary, fixture ownership, redacted evidence, and no-payment/no-order safety.
- [Remote Dev](./runbooks/remote-dev.md): disposable DigitalOcean preview sessions.
- [Social Login Operations](./runbooks/social-login-operations.md): Google and Facebook provider setup, callback URLs, smoke tests, and secret rotation.
- [DigitalOcean Platform Deployment](./runbooks/digitalocean-platform-deployment.md): staging full-system platform and production deployment workflow.
- [Admin Shell Smoke Matrix](./runbooks/admin-shell-smoke-matrix.md): Milestone #13 admin shell, actor, link, API topology, download, SSE, and durable-job release evidence matrix.
- [UCP Agent Commerce](./runbooks/ucp-agent-commerce.md): UCP smoke checks, signed write expectations, and readiness gates.
- [Google Shopping Operations](./runbooks/google-shopping-operations.md): Merchant Center launch checklist, worker config, operating cadence, pause/withdrawal, diagnostics owner routing, and provider incident response.
- [Catalog Display Identity Propagation](./runbooks/catalog-display-identity-propagation.md): recomputation health, backfill, repair, downstream projection diagnosis, and rollout verification for resolved display identity.

## Owner-Owned Documentation

- [Design System](../packages/design-system/README.md)
- [Marketplace Design Direction](../packages/design-system/MARKETPLACE_SYSTEM.md)
- [Dense Admin Workbench Pattern](../packages/design-system/DENSE_ADMIN_WORKBENCH.md)
- [Progressive Disclosure](../packages/design-system/PROGRESSIVE_DISCLOSURE.md)
- [Panel Interaction Patterns](../packages/design-system/PANEL_INTERACTIONS.md)
- [Section Navigation](../packages/design-system/SECTION_NAVIGATION.md)
- [Localization Contract](../contracts/localization/README.md)
- [MCP Contract](../contracts/mcp/README.md)
- [UCP Contract](../contracts/ucp/README.md)
- [Catalog Graded Card Data Model](../bounded-contexts/catalog/docs/graded-card-data-model.md)
- [Catalog Source Observation Integration](../bounded-contexts/catalog/docs/source-observation-integration.md)
- [Catalog Integration Control Plane](../bounded-contexts/catalog/docs/catalog-integration-control-plane.md)
- [Catalog Integration Diagnostic Taxonomy](../bounded-contexts/catalog/docs/catalog-integration-diagnostic-taxonomy.md)
- [Catalog Integration Data Governance](../bounded-contexts/catalog/docs/catalog-integration-data-governance.md)
- [Catalog Integration Credential Readiness](../bounded-contexts/catalog/docs/catalog-integration-credential-readiness.md)
- [Catalog Integration Audit Evidence](../bounded-contexts/catalog/docs/catalog-integration-audit-evidence.md)
- [Catalog Integration Fixture Lifecycle](../bounded-contexts/catalog/docs/catalog-integration-fixture-lifecycle.md)
- [Catalog Integration Job Consistency](../bounded-contexts/catalog/docs/catalog-integration-job-consistency.md)
- [Catalog Integration Rollout Controls](../bounded-contexts/catalog/docs/catalog-integration-rollout-controls.md)
- [Catalog Integration Provider Option Query Controls](../bounded-contexts/catalog/docs/catalog-integration-provider-option-query-controls.md)
- [Catalog Integration Impact Analysis](../bounded-contexts/catalog/docs/catalog-integration-impact-analysis.md)
- [Catalog Integration Admin Control Plane RBAC](../bounded-contexts/catalog/docs/catalog-integration-admin-control-plane-rbac.md)
- [Catalog Integration Observability](../bounded-contexts/catalog/docs/catalog-integration-observability.md)
- [Catalog Integration Test Architecture](../bounded-contexts/catalog/docs/catalog-integration-test-architecture.md)
- [Catalog Integration Schema Compatibility](../bounded-contexts/catalog/docs/catalog-integration-schema-compatibility.md)
- [Catalog Integration Data Migration Reset](../bounded-contexts/catalog/docs/catalog-integration-data-migration-reset.md)
- [Catalog Integration Legacy Cleanup](../bounded-contexts/catalog/docs/catalog-integration-legacy-cleanup.md)
- [Catalog Control Plane Primary Path](../bounded-contexts/catalog/docs/catalog-control-plane-primary-path.md)
- [Catalog Control Plane Information Architecture](../bounded-contexts/catalog/docs/catalog-control-plane-information-architecture.md)
- [Catalog Control Plane Section Navigation](../bounded-contexts/catalog/docs/catalog-control-plane-section-navigation.md)
- [Catalog Control Plane Clean Contract Handoff](../bounded-contexts/catalog/docs/catalog-control-plane-clean-contract-handoff.md)
- [Catalog Control Plane First-Slice Stage Board](../bounded-contexts/catalog/docs/catalog-control-plane-first-slice-stage-board.md)
- [Catalog Primary Workbench Admin Contract](../bounded-contexts/catalog/docs/primary-workbench-admin-contract.md)
- [Catalog Integration New-Provider Walkthrough](../bounded-contexts/catalog/docs/catalog-integration-new-provider-walkthrough.md)
- [Catalog Integration MTGJSON And Scryfall Validation](../bounded-contexts/catalog/docs/catalog-integration-mtgjson-scryfall-validation.md)
- [Catalog Integration Milestone Release Plan](../bounded-contexts/catalog/docs/catalog-integration-milestone-release-plan.md)
- [Catalog Source Conflict Resolution](../bounded-contexts/catalog/docs/source-conflict-resolution.md)
- [Catalog Provider Integration Profiles](../bounded-contexts/catalog/docs/provider-integration-profiles.md)
- [Catalog Provider Integration Admin Module](../bounded-contexts/catalog/docs/provider-integration-admin-module.md)
- [Catalog Integration Operator Acceptance Journeys](../bounded-contexts/catalog/docs/catalog-integration-operator-acceptance-journeys.md)
- [Catalog Admin Control Plane Query Contracts](../bounded-contexts/catalog/docs/admin-control-plane-query-contracts.md)
- [Catalog Admin Control Plane Read-Model SLOs](../bounded-contexts/catalog/docs/admin-control-plane-read-model-slos.md)
- [Catalog External Product References](../bounded-contexts/catalog/docs/external-product-references.md)
- [Catalog Resolved Display Identity](../bounded-contexts/catalog/docs/resolved-display-identity.md)
- [Catalog TCGplayer Automation Client Contract](../bounded-contexts/catalog/docs/tcgplayer-automation-client-contract.md)
- [Catalog Admin Bulk Workflows](../bounded-contexts/catalog/docs/admin-bulk-workflows.md)
- [Catalog Bulk Catalog Item Publish](../bounded-contexts/catalog/docs/bulk-catalog-item-publish.md)
- [Catalog Item Imagery](../bounded-contexts/catalog/docs/catalog-item-imagery.md)
- [Notifications](../bounded-contexts/notifications/README.md)
- [Discovery Dynamic Search Filters](../bounded-contexts/discovery/docs/dynamic-search-filters.md)
- [Discovery Google Shopping Feed Mapping](../bounded-contexts/discovery/docs/google-shopping-feed-mapping.md)
- [Discovery Product Alerts](../bounded-contexts/discovery/docs/product-alerts.md)
- [Ordering Self-Service Purchase Cancellation](../bounded-contexts/ordering/docs/self-service-purchase-cancellation.md)
- [Fulfillment Purchase Cancellation Cutoff](../bounded-contexts/fulfillment/docs/purchase-cancellation-cutoff.md)
- [Marketplace Sales Fee Confirmation](../bounded-contexts/marketplace/docs/marketplace-sales-fee-confirmation.md)
- [Marketplace Limited Offer Demand Signals](../bounded-contexts/marketplace/docs/limited-offer-demand-signals.md)
- [Marketplace Seller Listing Availability](../bounded-contexts/marketplace/docs/seller-listing-availability.md)
- [Auth Social Login Journey Policy](../bounded-contexts/auth/docs/social-login.md)
- [Marketplace Standard Listing Inventory Disclosure](../bounded-contexts/marketplace/docs/standard-listing-inventory-disclosure.md)
- [Inventory Automatic Listing Stock](../bounded-contexts/inventory/docs/automatic-listing-stock.md)
- [Inventory Import Product Resolution](../bounded-contexts/inventory/docs/import-product-resolution.md)
- [Inventory Agent Listing Integrations](../bounded-contexts/inventory/docs/agent-listing-integrations.md)
- [Payments Marketplace Checkout Fee Policy](../bounded-contexts/payments/docs/marketplace-checkout-fee-policy.md)
- [Settlement Account Money Navigation](../bounded-contexts/settlement/docs/account-money-navigation.md)
- [Platform Operations](../bounded-contexts/platform-operations/README.md)

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

## Maintenance

- [Documentation Cleanup Tasks](./documentation-cleanup-tasks.md): completed cleanup checklist from the Markdown documentation review.

## Generated Markdown

Markdown under `artifacts/` is generated local output. Regenerate those files through the owning script instead of editing them by hand.
