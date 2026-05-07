# Documentation

This folder is a curated map for cross-cutting product, language, API, ADR, and operator documentation. Bounded-context behavior belongs in `bounded-contexts/`, shared contracts belong in `contracts/`, infrastructure behavior belongs in `infrastructure/`, and design-system guidance belongs in `packages/design-system/`.

## Core References

- [Product Brief](./PRODUCT.md): product vision, users, and marketplace economics.
- [Marketplace Glossary](./GLOSSARY.md): canonical marketplace language and account-role naming rules.
- [Bounded Context Map](../bounded-contexts/README.md): strategic ownership, integration, and structure rules.
- [Marketplace API](./api/marketplace-api.md): human-readable API guide.
- [Marketplace OpenAPI](./api/marketplace.openapi.json): machine-readable API contract.
- [Marketplace API Parity Matrix](./api/marketplace-api-parity.md): marketplace-web API coverage inventory.

## Runbooks

- [Money Operations](./runbooks/money-operations.md): checkout, wallet, Stripe payments, Connect payouts, launch checks, and smoke tests.
- [Observability](./runbooks/observability.md): local OpenTelemetry and LGTM stack.
- [Realtime SSE](./runbooks/realtime-sse.md): projection patch transport and operational checks.
- [Remote Dev](./runbooks/remote-dev.md): disposable DigitalOcean preview sessions.

## Owner-Owned Documentation

- [Design System](../packages/design-system/README.md)
- [Marketplace Design Direction](../packages/design-system/MARKETPLACE_SYSTEM.md)
- [Localization Contract](../contracts/localization/README.md)
- [MCP Contract](../contracts/mcp/README.md)
- [Catalog Graded Card Data Model](../bounded-contexts/catalog/GRADED-CARD-DATA-MODEL.md)
- [Marketplace Seller Fee Confirmation](../bounded-contexts/marketplace/SELLER-FEE-CONFIRMATION.md)
- [Payments Marketplace Checkout Fee Policy](../bounded-contexts/payments/MARKETPLACE-CHECKOUT-FEE-POLICY.md)

## ADRs

- [ADR 0001: Platform API Observability](./adr/0001-platform-api-observability.md)

## Generated Markdown

Markdown under `artifacts/` is generated local output. Regenerate those files through the owning script instead of editing them by hand.
