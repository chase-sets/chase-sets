# Marketplace Design System Direction

This package is the canonical source for the conversion-first marketplace UI. Product teams should build marketplace screens from these components and patterns instead of adding local overrides in deployables.

## Operating Hierarchy

Trust -> Clarity -> Speed -> Comparison -> Aesthetic polish -> Delight

When tradeoffs appear, choose the option that helps buyers make confident purchasing decisions faster.

Design for accounts that can both buy and sell. Buyer and seller labels are contextual transaction roles; account identity, navigation, setup, reputation, profile, inventory, wallet, and onboarding patterns should use account language.

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

Brand expression is allowed in homepage heroes, category campaigns, account stories, onboarding, featured collections, and confirmation moments. Search results, listing cards, detail pages, checkout, payment, support recovery, and policy comprehension should stay calm and task-first.

## Coverage Areas

Use `packages/design-system/src/` as the canonical component inventory. Marketplace coverage should remain focused on these reusable decision areas:

- Listing comparison, filtering, sorting, and saved-search recovery.
- Product detail confidence, media, specifications, pricing context, and policy disclosure.
- Account trust, reviews, account reputation, and buyer-protection cues.
- Checkout, payment confidence, cost breakdowns, editable order sections, and post-purchase support.
- Negotiation, offer management, status timelines, empty states, loading states, and recovery paths.
- Marketplace dashboards and route templates that compose the same primitives without local overrides.

## Listing Card Contract

`ListingCard` is the primary marketplace comparison primitive. Every card must show price, listing account name, account trust, availability, fulfillment, and one primary action. Save, compare, and watchlist are secondary affordances and should never compete visually with the primary action.

Cards may adapt to products, services, rentals, bookings, digital goods, quotes, and local listings, but the signal hierarchy stays stable: item identity, price, account trust, fulfillment, availability, risk reduction, then action.

## Account Reputation Summary Contract

Use `AccountReputationSummary` whenever a marketplace card, offer row, purchase panel, or trust module shows reputation for an account. Reputation is account-scoped, not seller-only: listing surfaces show the account that published the listing, and offer surfaces show the account that submitted marketplace-wide demand.

The default account reputation presentation is compact stacked metadata, not a card: no icon, no border, no background, and no separate "View feedback" action. Render the account name on the first line and the rating, review count, or compact new-account state on the second line. Only the account name is interactive; the feedback state remains plain text. Use the framed variant only inside a dedicated trust module where a surrounding panel is not already providing structure.

Do not render the same account name, rating, or review count in multiple cells of the same listing, offer, or checkout row. The account row is the canonical home for account name, feedback summary, and profile navigation. Accounts without feedback use the compact visible label `New` with accessible text that explains there is no feedback yet. Aggregate marketplace labels such as "verified supply" or "marketplace sellers" are not accounts and must not use `AccountReputationSummary`. Public profile links use `/accounts/:accountSlug`; do not introduce `/sellers/:slug` or buyer-only/seller-only profile routes.

## Search And Filtering

Marketplace search filters must preserve buyer momentum: selections stay visible, result counts refresh predictably, and scrolling always has one obvious owner.

- Applied filters stay outside temporary filter surfaces as reversible chips. A selected value also remains visible in its owning facet group even if the refreshed Result Set would otherwise hide that option.
- Facet groups are ordered by usefulness, not by fewest options alone. Use buyer decision value, active-result coverage, selected state, meaningful distinct counts, and stable labels before falling back to alphabetical order.
- Facet option counts refresh from the active Result Set. Counts for one facet group should answer "what options remain if every other filter stays applied and this group can vary?"
- Hide unavailable zero-count options by default, except selected values must remain visible. Do not fill marketplace filters with disabled taxonomy rows unless an expert workflow explicitly needs unavailable comparison.
- Long option lists use progressive depth, not nested scrollbars. Show the most useful values first, provide `Show more` / `Show less`, and add option search for high-cardinality facets such as card name, card number, set, player, team, listing owner, franchise, character, or other catalog-specific attributes.
- Desktop uses a persistent left filter rail or side sheet with one scrollable filter surface. Individual facet groups must not create their own independent scroll containers.
- Mobile uses a compact filter bar plus Bottom Sheet for normal filtering. The sheet body may scroll as one surface with a sticky footer for `Clear` and `Show results`; dense single-facet search should become a focused sheet section or Full Page rather than a scrollbar inside the sheet.
- Live dynamic filtering should update results, counts, and availability without making the layout jump unpredictably. Preserve active chips, group ordering stability, and the user's current place in the filter surface whenever possible.

## Checkout Confidence

Checkout must show item subtotal, shipping, fees, tax, discounts, wallet credit, and final total before payment. The sticky CTA should include the final action, payment confidence copy, and at most one secondary edit or escape action.

## Real-App Validation

The real marketplace and admin apps are the validation surfaces. Do not recreate a separate showcase project for marketplace UI validation.

Each marketplace route should keep the most decision-critical information visible:

- Relevance: title, category, media, condition, availability.
- Fair price: item price, fees, shipping, taxes, discounts, total.
- Account trust: verification, rating, review count, tenure, completed transactions, response time.
- Fulfillment: delivery estimate, pickup details, booking window, digital delivery.
- Risk: buyer protection, return/refund/cancellation policy, secure payment, dispute path.
- Next action: one primary action per decision area.

## Mobile-First Rules

- Listing cards must stay information-rich on mobile and support compact comparison.
- Tables must collapse into scan-friendly cards in mobile contexts.
- Filters should be sheet-friendly, reversible, and summarized as chips. Use desktop side sheets or filter rails and mobile bottom sheets; do not describe filter controls as navigation drawers.
- Facet controls that allow more than one value, such as dynamic condition filters, should use the marketplace facet `multiple` selection mode and keep each selected value reversible as an applied chip.
- Avoid scrollbars inside facet groups on mobile. The filter sheet owns vertical scroll, while dense option lists use search, show more/show less, focused section replacement, or a full page.
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

## Progressive Disclosure Defaults

Use progressive disclosure for advanced marketplace depth, not for required account or transaction-party comprehension. Required decision facts stay visible; optional controls and deeper explanation use `ProgressiveDisclosure` or `ProgressiveDisclosureGroup`.

Good disclosure candidates:

- optional search depth, saved-search recovery, and dense comparison controls
- listing limits, offer matching thresholds, fulfillment exceptions, and publishing recovery detail
- product specification depth, grading population context, certification extras, and market-history detail
- checkout support diagnostics and provider-safe payment explanations after the final total is visible
- payout verification reason detail, ledger context, and provider-safe settlement explanations

Do not disclose the current price, final total, account trust, availability, fulfillment expectation, buyer-protection summary, blocking error, primary action, or result-shaping search facets. If an advanced setting affects low-value card margins or buyer commitment, expose its current effect in the disclosure summary.

Recommended first flows:

1. Marketplace listing creation and listing management.
   Keep inventory identity, price, quantity cap, fee preview, status, and publish controls visible. Move optional listing limits, fee-lock history, stale quote recovery detail, grading population depth, and certification extras into disclosure.
2. Discovery search and item detail.
   Keep primary filters, ranked dynamic facets, applied filter chips, result count, item identity, listing/offer comparison, and commerce actions visible. Move optional specification depth, policy explanation, market-history detail, and saved-search recovery into disclosure.
3. Checkout session and payment recovery.
   Keep fulfillment state, final cost, wallet credit, selected destination, payment method, secure payment cue, blocking failure copy, and the payment or recovery action visible. Checkout owns session/fulfillment disclosure; Payments owns payment fee quote, confirmation, provider event, support detail, claim-token fallback, and recovery diagnostic disclosure.
4. Settlement payout readiness and payout requests.
   Keep payout readiness status, available amount, amount policy, destination status, unavailable state, and setup/preview/confirm actions visible. Move grouped verification requirement detail, provider capability detail, ledger context, unavailable reason detail, optional payout note, and provider-safe payout explanations into disclosure.
5. Catalog admin authoring and setup.
   Keep entity identity, status, lifecycle controls, current blueprint/category assignment, required field state, and publish action visible. Move field rules, dimension rules, product-resolution rules, external references, tag/image URL management, automation settings, and audit/history detail into disclosure.

## Before / After Direction

- Before: attractive components could omit delivery, account trust, policy, or total-cost context.
- After: marketplace components require decision signals and make hidden risk explicit.
- Before: checkout could feel like a generic SaaS form.
- After: checkout shows final cost, secure payment, delivery, policy, and buyer protection before confirmation.
- Before: empty and error states were mostly informational.
- After: recovery states provide next actions, recommendations, and support paths.

## Implementation Roadmap

1. Adopt marketplace tokens and `ThemeToggle` across marketplace-facing routes.
2. Replace listing grids with `ListingCard`, `SearchFilterPanel`, `FilterRail`, and mobile-card table behavior.
3. Replace listing detail pages with media, price, account attribution, protection, policy, review, specification, comparison, and sticky CTA modules.
4. Replace public seller-profile language with account profiles that use `AccountReputationSummary`, account listings, `ReviewCard`, and trust-building empty states; add contextual seller labels only inside listing, sale, or transaction modules.
5. Move checkout to transparent `PriceBreakdown`, editable sections, secure-payment messaging, and recovery notices.
6. Add messaging, offer, dashboard, empty, error, and status timeline patterns to post-purchase and negotiation flows.
7. Remove custom deployable overrides once each screen is backed by design-system primitives.
