# Embedded Stripe Appearance

Embedded Stripe flows resolve `embedded-surface-theme/v1` through the design system, then use this browser-only adapter before introducing any bounded-context styling workaround. This extraction ends qualification-pending, not provider-qualified.

The design system owns nearest-scope resolution, snapshot and observation. This adapter owns Stripe translation and fallback validation. Payments, Settlement, and future bounded contexts own when a Stripe flow appears, which client secret or session is used, and how provider outcomes map back into Chase Sets language.

## Supported Styling Surface

Pass `resolveEmbeddedSurfaceTheme({ scope })` as `theme` to `createStripeElementsAppearance` for Stripe Elements and Custom Checkout surfaces that accept Elements Appearance API variables. Use `includeRules: false` when the Stripe surface only accepts variables.

Use `createStripeConnectAppearance` for Stripe Connect embedded components. It maps Chase Sets color, typography, spacing, radius, button, form, badge, and overlay tokens into the Connect appearance variables that Stripe exposes.

Use `observeEmbeddedSurfaceTheme` and `embeddedSurfaceThemeSnapshot` when a mounted provider surface needs to react to light, dark, scoped, or overridden theme changes. Token resolution is scoped to the nearest `[data-chase-theme]` or `[data-chase-theme-scope]` host so embedded flows follow the current design-system mode. Missing or malformed values fall back to the predecessor appearance literals; `pageBackground` falls back to `#f7f5f1` and is not mapped to Stripe.

## Provider Boundary

Stripe remains the owner of secure collection and verification UI inside its embedded components. Chase Sets can theme the supported appearance variables and host the iframe in design-system chrome, but must not reach into Stripe iframes, duplicate Stripe validation UI, or replace Stripe-owned collection with custom forms for visual parity alone.

Residual provider-owned areas include:

- secure card, wallet, Link, payout destination, identity, tax, and document upload collection
- browser autofill, wallet buttons, 3DS or authentication handoffs, and Stripe-hosted redirects or modals
- validation timing, provider copy, service-agreement presentation, verification field ordering, and provider loading states
- internal iframe layout, exact spacing, focus treatment, and unsupported rule-level styling on surfaces that accept variables only

When visual parity is limited by Stripe-owned behavior, document the gap as provider-owned rather than adding local CSS overrides.

## Acceptance Checklist

- The Stripe surface receives an adapter-translated appearance from a design-system theme snapshot.
- The appearance object is resolved from the mounted theme scope.
- Light and dark modes are covered by focused unit tests or browser evidence.
- Provider-owned residual gaps are recorded in the milestone or release evidence.
- No bounded context reaches into Stripe-owned iframe internals or creates custom KYC/payment-sensitive forms for styling parity.
