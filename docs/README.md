# Documentation

This folder is a curated map for cross-cutting product, language, API, ADR, and operator documentation. Bounded-context behavior belongs in `bounded-contexts/`, shared contracts belong in `contracts/`, infrastructure behavior belongs in `infrastructure/`, and design-system guidance belongs in `packages/design-system/`.

## Core References

- [Product Brief](./PRODUCT.md): product vision, users, and marketplace economics.
- [Marketplace Glossary](./GLOSSARY.md): canonical marketplace language and account-role naming rules.
- [Bounded Context Map](../bounded-contexts/README.md): strategic ownership and integration relationships.
- [Bounded Context Structure](./architecture/bounded-context-structure.md): directory, export, deployable-composition, and typed-ID rules.
- [Notification Center And Settings](./architecture/notification-center-and-settings.md): notification drawer, settings, Product Alert placement, and Notifications bounded-context ownership.
- [Email Delivery Strategy](./architecture/email-delivery-strategy.md): transactional vs marketing scope, provider strategy, and cost-focused integration plan.
- [Email Delivery Completion Task List](./architecture/email-delivery-task-list.md): implementation checklist covering follow-up findings.
- [Marketplace API](./api/marketplace-api.md): human-readable API guide.
- [Marketplace OpenAPI](./api/marketplace.openapi.json): machine-readable API contract.

## Runbooks

- [Money Operations](./runbooks/money-operations.md): checkout, wallet, Stripe payments, Connect payouts, launch checks, and smoke tests.
- [Email Operations](./runbooks/email-operations.md): Amazon SES identities, sender configuration, DNS requirements, and rollout checks.
- [Observability](./runbooks/observability.md): local OpenTelemetry and LGTM stack.
- [Local Worktree Sandboxes](./runbooks/local-worktree-sandboxes.md): isolated local dev/test stacks for simultaneous worktrees.
- [Postage Operations](./runbooks/postage-operations.md): postage label provider configuration and label smoke checks.
- [Catalog Asset Storage](./runbooks/catalog-asset-storage.md): owned storage for provider-fed catalog imagery.
- [Realtime SSE](./runbooks/realtime-sse.md): projection patch transport and operational checks.
- [Remote Dev](./runbooks/remote-dev.md): disposable DigitalOcean preview sessions.
- [Social Login Operations](./runbooks/social-login-operations.md): Google and Facebook provider setup, callback URLs, smoke tests, and secret rotation.
- [DigitalOcean Platform Deployment](./runbooks/digitalocean-platform-deployment.md): staging full-system platform and production deployment workflow.

## Owner-Owned Documentation

- [Design System](../packages/design-system/README.md)
- [Marketplace Design Direction](../packages/design-system/MARKETPLACE_SYSTEM.md)
- [Progressive Disclosure](../packages/design-system/PROGRESSIVE_DISCLOSURE.md)
- [Localization Contract](../contracts/localization/README.md)
- [MCP Contract](../contracts/mcp/README.md)
- [Catalog Graded Card Data Model](../bounded-contexts/catalog/docs/graded-card-data-model.md)
- [Catalog Source Observation Integration](../bounded-contexts/catalog/docs/source-observation-integration.md)
- [Notifications](../bounded-contexts/notifications/README.md)
- [Discovery Dynamic Search Filters](../bounded-contexts/discovery/docs/dynamic-search-filters.md)
- [Discovery Product Alerts](../bounded-contexts/discovery/docs/product-alerts.md)
- [Ordering Self-Service Purchase Cancellation](../bounded-contexts/ordering/docs/self-service-purchase-cancellation.md)
- [Fulfillment Purchase Cancellation Cutoff](../bounded-contexts/fulfillment/docs/purchase-cancellation-cutoff.md)
- [Marketplace Seller Fee Confirmation](../bounded-contexts/marketplace/docs/seller-fee-confirmation.md)
- [Marketplace Limited Offer Demand Signals](../bounded-contexts/marketplace/docs/limited-offer-demand-signals.md)
- [Marketplace Seller Listing Availability](../bounded-contexts/marketplace/docs/seller-listing-availability.md)
- [Auth Social Login Journey Policy](../bounded-contexts/auth/docs/social-login.md)
- [Marketplace Standard Listing Inventory Disclosure](../bounded-contexts/marketplace/docs/standard-listing-inventory-disclosure.md)
- [Inventory Automatic Listing Stock](../bounded-contexts/inventory/docs/automatic-listing-stock.md)
- [Payments Marketplace Checkout Fee Policy](../bounded-contexts/payments/docs/marketplace-checkout-fee-policy.md)
- [Settlement Account Money Navigation](../bounded-contexts/settlement/docs/account-money-navigation.md)

## ADRs

- [ADR 0001: Platform API Observability](./adr/0001-platform-api-observability.md)

## Maintenance

- [Documentation Cleanup Tasks](./documentation-cleanup-tasks.md): completed cleanup checklist from the Markdown documentation review.

## Generated Markdown

Markdown under `artifacts/` is generated local output. Regenerate those files through the owning script instead of editing them by hand.
