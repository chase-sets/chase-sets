# Documentation

This folder is a curated map for cross-cutting product, language, API, ADR, and operator documentation. Bounded-context behavior belongs in `bounded-contexts/`, shared contracts belong in `contracts/`, infrastructure behavior belongs in `infrastructure/`, and design-system guidance belongs in `packages/design-system/`.

## Core References

- [Product Brief](./PRODUCT.md): product vision, users, and marketplace economics.
- [Marketplace Glossary](./GLOSSARY.md): canonical marketplace language and account-role naming rules.
- [Bounded Context Map](../bounded-contexts/README.md): strategic ownership and integration relationships.
- [Bounded Context Structure](./architecture/bounded-context-structure.md): directory, export, deployable-composition, and typed-ID rules.
- [Email Delivery Strategy](./architecture/email-delivery-strategy.md): transactional vs marketing scope, provider strategy, and cost-focused integration plan.
- [Email Delivery Completion Task List](./architecture/email-delivery-task-list.md): implementation checklist covering follow-up findings.
- [Marketplace API](./api/marketplace-api.md): human-readable API guide.
- [Marketplace OpenAPI](./api/marketplace.openapi.json): machine-readable API contract.

## Runbooks

- [Money Operations](./runbooks/money-operations.md): checkout, wallet, Stripe payments, Connect payouts, launch checks, and smoke tests.
- [Observability](./runbooks/observability.md): local OpenTelemetry and LGTM stack.
- [Postage Operations](./runbooks/postage-operations.md): postage label provider configuration and label smoke checks.
- [Realtime SSE](./runbooks/realtime-sse.md): projection patch transport and operational checks.
- [Remote Dev](./runbooks/remote-dev.md): disposable DigitalOcean preview sessions.
- [DigitalOcean Platform Deployment](./runbooks/digitalocean-platform-deployment.md): staging full-system platform and production deployment workflow.

## Owner-Owned Documentation

- [Design System](../packages/design-system/README.md)
- [Marketplace Design Direction](../packages/design-system/MARKETPLACE_SYSTEM.md)
- [Localization Contract](../contracts/localization/README.md)
- [MCP Contract](../contracts/mcp/README.md)
- [Catalog Graded Card Data Model](../bounded-contexts/catalog/docs/graded-card-data-model.md)
- [Ordering Self-Service Purchase Cancellation](../bounded-contexts/ordering/docs/self-service-purchase-cancellation.md)
- [Fulfillment Purchase Cancellation Cutoff](../bounded-contexts/fulfillment/docs/purchase-cancellation-cutoff.md)
- [Marketplace Seller Fee Confirmation](../bounded-contexts/marketplace/docs/seller-fee-confirmation.md)
- [Payments Marketplace Checkout Fee Policy](../bounded-contexts/payments/docs/marketplace-checkout-fee-policy.md)

## ADRs

- [ADR 0001: Platform API Observability](./adr/0001-platform-api-observability.md)

## Maintenance

- [Documentation Cleanup Tasks](./documentation-cleanup-tasks.md): completed cleanup checklist from the Markdown documentation review.

## Generated Markdown

Markdown under `artifacts/` is generated local output. Regenerate those files through the owning script instead of editing them by hand.
