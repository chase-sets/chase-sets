# Marketplace Design System Direction

This package is the canonical source for the conversion-first marketplace UI. Product teams should build marketplace screens from these components and patterns instead of adding local overrides in deployables.

## Operating Hierarchy

Trust -> Clarity -> Speed -> Comparison -> Aesthetic polish -> Delight

When tradeoffs appear, choose the option that helps buyers make confident purchasing decisions faster.

## Design Principles

1. Trust before persuasion.
2. Clarity before cleverness.
3. Speed before visual complexity.
4. Comparison before exploration.
5. Consistency before novelty.
6. Accessibility before aesthetics.
7. Conversion through confidence, not pressure.

## Visual Language

The system uses polished utility: IBM Plex Sans, neutral surfaces, high contrast type, restrained borders, calm shadows, and one dominant marketplace-blue primary action. Teal is reserved for trust and protection, amber for ratings, deals, and warnings, red for destructive or error states, and neutral surfaces for most UI.

Avoid decorative gradients, ornamental animation, hidden fees, hidden policies, sparse cards that omit decision signals, and multiple competing primary actions.

Brand expression is allowed in homepage heroes, category campaigns, seller stories, onboarding, featured collections, and confirmation moments. Search results, listing cards, detail pages, checkout, payment, support recovery, and policy comprehension should stay calm and task-first.

## Coverage Areas

Use `packages/design-system/src/` as the canonical component inventory. Marketplace coverage should remain focused on these reusable decision areas:

- Listing comparison, filtering, sorting, and saved-search recovery.
- Product detail confidence, media, specifications, pricing context, and policy disclosure.
- Seller trust, reviews, account reputation, and buyer-protection cues.
- Checkout, payment confidence, cost breakdowns, editable order sections, and post-purchase support.
- Negotiation, offer management, status timelines, empty states, loading states, and recovery paths.
- Marketplace dashboards and route templates that compose the same primitives without local overrides.

## Listing Card Contract

`ListingCard` is the primary marketplace comparison primitive. Every card must show price, seller name, seller trust, availability, fulfillment, and one primary action. Save, compare, and watchlist are secondary affordances and should never compete visually with the primary action.

Cards may adapt to products, services, rentals, bookings, digital goods, quotes, and local listings, but the signal hierarchy stays stable: item identity, price, seller trust, fulfillment, availability, risk reduction, then action.

## Checkout Confidence

Checkout must show item subtotal, shipping, fees, tax, discounts, wallet credit, and final total before payment. The sticky CTA should include the final action, payment confidence copy, and at most one secondary edit or escape action.

## Real-App Validation

The real marketplace and admin apps are the validation surfaces. Do not recreate a separate showcase project for marketplace UI validation.

Each marketplace route should keep the most decision-critical information visible:

- Relevance: title, category, media, condition, availability.
- Fair price: item price, fees, shipping, taxes, discounts, total.
- Seller trust: verification, rating, review count, tenure, completed sales, response time.
- Fulfillment: delivery estimate, pickup details, booking window, digital delivery.
- Risk: buyer protection, return/refund/cancellation policy, secure payment, dispute path.
- Next action: one primary action per decision area.

## Mobile-First Rules

- Listing cards must stay information-rich on mobile and support compact comparison.
- Tables must collapse into scan-friendly cards in mobile contexts.
- Filters should be drawer-friendly, reversible, and summarized as chips.
- Sticky CTAs are mobile-first; desktop should prefer sticky sidebars or inline CTAs that do not cover content.
- Touch targets must remain at least 44px where interaction is expected.

## Accessibility Rules

- Do not rely on color alone for trust, warnings, or status.
- Keep focus states visible through `ds-focus`.
- Use semantic labels on search, filters, controls, and media.
- Preserve readable type sizes and tabular numerals for prices, fees, ratings, and quantities.
- Respect reduced motion and avoid heavy animated surfaces in transactional flows.

## Content Rules

- Required marketplace facts should not be hidden behind tooltip-only disclosure.
- Reusable primitives should receive titles, descriptions, and reassurance copy through props instead of embedding page-specific English.
- Trust copy should be calm and specific: explain verification, payment safety, return paths, delivery expectations, and support options without using alarmist language.
- Promotional copy should not compete with checkout, policy, or payment comprehension.

## Before / After Direction

- Before: attractive components could omit delivery, seller trust, policy, or total-cost context.
- After: marketplace components require decision signals and make hidden risk explicit.
- Before: checkout could feel like a generic SaaS form.
- After: checkout shows final cost, secure payment, delivery, policy, and buyer protection before confirmation.
- Before: empty and error states were mostly informational.
- After: recovery states provide next actions, recommendations, and support paths.

## Implementation Roadmap

1. Adopt marketplace tokens and `ThemeToggle` across marketplace-facing routes.
2. Replace listing grids with `ListingCard`, `SearchFilterPanel`, `FilterRail`, and mobile-card table behavior.
3. Replace listing detail pages with media, price, seller, protection, policy, review, specification, comparison, and sticky CTA modules.
4. Replace seller profiles with `SellerProfileHeader`, `SellerTrustCard`, `ReviewCard`, and trust-building empty states.
5. Move checkout to transparent `PriceBreakdown`, editable sections, secure-payment messaging, and recovery notices.
6. Add messaging, offer, dashboard, empty, error, and status timeline patterns to post-purchase and negotiation flows.
7. Remove custom deployable overrides once each screen is backed by design-system primitives.
