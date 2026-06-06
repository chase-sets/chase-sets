# Documentation

This folder is a curated map for cross-cutting product, language, API, ADR, and operator documentation. Bounded-context behavior belongs in `bounded-contexts/`, shared contracts belong in `contracts/`, infrastructure behavior belongs in `infrastructure/`, and design-system guidance belongs in `packages/design-system/`.

## Core References

- [Product Brief](./PRODUCT.md): product vision, users, and marketplace economics.
- [Marketplace Glossary](./GLOSSARY.md): canonical marketplace language and account-role naming rules.
- [Bounded Context Map](../bounded-contexts/README.md): strategic ownership and integration relationships.
- [Bounded Context Structure](./architecture/bounded-context-structure.md): directory, export, deployable-composition, and typed-ID rules.
- [Cookie-Backed Continuation Handoff](./architecture/cookie-backed-continuation-handoff.md): document redirect, protected-loader recovery, and regression-test rules for auth/session cookie continuations.
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
- [Discovery Google Shopping Feed Mapping](../bounded-contexts/discovery/docs/google-shopping-feed-mapping.md): product, offer, image, condition, shipping, returns, and eligibility mapping for Google Shopping rows.
- [Marketplace API](./api/marketplace-api.md): human-readable API guide.
- [Marketplace OpenAPI](./api/marketplace.openapi.json): machine-readable API contract.
- [UCP OpenAPI](./api/ucp.openapi.json): UCP REST transport contract.

## Runbooks

- [Money Operations](./runbooks/money-operations.md): checkout, wallet, Stripe payments, Connect payouts, launch checks, and smoke tests.
- [Marketplace Launch Evidence](./runbooks/marketplace-launch-evidence.md): redacted launch evidence packet, verifier, Tax posture, provider rehearsals, and launch-supply measurement proof.
- [Email Operations](./runbooks/email-operations.md): Amazon SES identities, sender configuration, DNS requirements, and rollout checks.
- [Tax Production Readiness](../bounded-contexts/tax/docs/production-tax-readiness.md): Tax readiness evidence, no-provider launch posture, and provider-required collection gating.
- [Tax Nexus Tracking](../bounded-contexts/tax/docs/tax-nexus-tracking.md): state-by-state threshold tracking for when Chase Sets must prepare registration or start collecting sales tax.
- [Observability](./runbooks/observability.md): local OpenTelemetry and LGTM stack.
- [Release Process Evolution](./runbooks/release-process-evolution.md): release queue, production locks, canary path, rollout controls, health metrics, and gate categories.
- [Deployment Transitions](./runbooks/deployment-transitions.md): graceful shutdown, resumable streams, worker cancellation, and durable cadence.
- [Local Worktree Sandboxes](./runbooks/local-worktree-sandboxes.md): isolated local dev/test stacks for simultaneous worktrees.
- [Postage Operations](./runbooks/postage-operations.md): postage label provider configuration and label smoke checks.
- [Playwright E2E](./runbooks/playwright-e2e.md): local browser e2e setup and sandbox-aware run commands.
- [Catalog Asset Storage](./runbooks/catalog-asset-storage.md): owned storage for provider-fed catalog imagery.
- [Catalog Provider Integration Profiles](./runbooks/catalog-provider-integration-profiles.md): profile activation, rollback, retirement, and bootstrap failure response.
- [TCGplayer Automation Operations](./runbooks/tcgplayer-automation-operations.md): provider cookie handling, throttling, redaction, retention, and recovery for the automation-app client.
- [Realtime SSE](./runbooks/realtime-sse.md): projection patch transport and operational checks.
- [Projection Poison Events](./runbooks/projection-poison-events.md): triage and repair for degraded projection consumers.
- [Projection Operations](./runbooks/projection-operations.md): backlog, worker capacity, retry, and rebuild triage.
- [Remote Dev](./runbooks/remote-dev.md): disposable DigitalOcean preview sessions.
- [Social Login Operations](./runbooks/social-login-operations.md): Google and Facebook provider setup, callback URLs, smoke tests, and secret rotation.
- [DigitalOcean Platform Deployment](./runbooks/digitalocean-platform-deployment.md): staging full-system platform and production deployment workflow.
- [UCP Agent Commerce](./runbooks/ucp-agent-commerce.md): UCP smoke checks, signed write expectations, and readiness gates.
- [Google Shopping Operations](./runbooks/google-shopping-operations.md): Merchant Center launch checklist, worker config, operating cadence, pause/withdrawal, diagnostics owner routing, and provider incident response.

## Owner-Owned Documentation

- [Design System](../packages/design-system/README.md)
- [Marketplace Design Direction](../packages/design-system/MARKETPLACE_SYSTEM.md)
- [Progressive Disclosure](../packages/design-system/PROGRESSIVE_DISCLOSURE.md)
- [Panel Interaction Patterns](../packages/design-system/PANEL_INTERACTIONS.md)
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
- [Catalog Integration Job Consistency](../bounded-contexts/catalog/docs/catalog-integration-job-consistency.md)
- [Catalog Integration Schema Compatibility](../bounded-contexts/catalog/docs/catalog-integration-schema-compatibility.md)
- [Catalog Integration Data Migration Reset](../bounded-contexts/catalog/docs/catalog-integration-data-migration-reset.md)
- [Catalog Integration Legacy Cleanup](../bounded-contexts/catalog/docs/catalog-integration-legacy-cleanup.md)
- [Catalog Integration New-Provider Walkthrough](../bounded-contexts/catalog/docs/catalog-integration-new-provider-walkthrough.md)
- [Catalog Integration Milestone Release Plan](../bounded-contexts/catalog/docs/catalog-integration-milestone-release-plan.md)
- [Catalog Source Conflict Resolution](../bounded-contexts/catalog/docs/source-conflict-resolution.md)
- [Catalog Provider Integration Profiles](../bounded-contexts/catalog/docs/provider-integration-profiles.md)
- [Catalog Provider Integration Admin Module](../bounded-contexts/catalog/docs/provider-integration-admin-module.md)
- [Catalog Admin Control Plane Query Contracts](../bounded-contexts/catalog/docs/admin-control-plane-query-contracts.md)
- [Catalog Admin Control Plane Read-Model SLOs](../bounded-contexts/catalog/docs/admin-control-plane-read-model-slos.md)
- [Catalog External Product References](../bounded-contexts/catalog/docs/external-product-references.md)
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

## Maintenance

- [Documentation Cleanup Tasks](./documentation-cleanup-tasks.md): completed cleanup checklist from the Markdown documentation review.

## Generated Markdown

Markdown under `artifacts/` is generated local output. Regenerate those files through the owning script instead of editing them by hand.
