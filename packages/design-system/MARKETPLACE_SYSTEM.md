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

## Responsive Design Rules

All functionality must remain available on every supported form factor. Compose layouts from design-system primitives and token breakpoints (`sm`, `md`, `lg`, `xl`, and `2xl`); do not introduce fixed pixel dimensions, custom pixel breakpoints, or hide interactive functionality without a responsive counterpart. Deliberate fixed-format contracts such as print layouts require a leading `@responsive-exempt <reason>` comment.

`pnpm run check:responsive-safety` machine-enforces these rules with the ratcheted [`RESPONSIVE_SAFETY.json`](./RESPONSIVE_SAFETY.json) ledger. The check runs through `verify:static` in scope-gated CI for every pull request that touches production UI paths.

## Visual Language

The system uses polished utility: IBM Plex Sans, neutral surfaces, high contrast type, restrained borders, calm shadows, and one dominant marketplace-blue primary action. Teal is reserved for trust and protection, amber for ratings, deals, and warnings, red for destructive or error states, and neutral surfaces for most UI.

Avoid decorative gradients, ornamental animation, hidden fees, hidden policies, sparse cards that omit decision signals, and multiple competing primary actions.

Brand expression is allowed in homepage heroes, category campaigns, account stories, onboarding, featured collections, and confirmation moments. Search results, listing cards, detail pages, checkout, payment, support recovery, and policy comprehension should stay calm and task-first.

## Coverage Areas

Use `packages/design-system/src/` as the canonical component inventory. Marketplace commerce components (trust, listings, checkout, detail, search, account, panels, cart line item, and shared helpers) live under `packages/design-system/src/components/commerce/`; this is their canonical home. There is no `compat/` transition shelf for these primitives — import them from `@chase-sets/design-system` directly. Marketplace coverage should remain focused on these reusable decision areas:

- Listing comparison, filtering, sorting, and saved-search recovery.
- Product detail confidence, media, specifications, pricing context, and policy disclosure.
- Account trust, reviews, account reputation, and order-protection cues.
- Checkout, payment confidence, cost breakdowns, editable order sections, and post-purchase support.
- Negotiation, offer management, status timelines, empty states, loading states, and recovery paths.
- Marketplace dashboards and route templates that compose the same primitives without local overrides.

## Listing Card Contract

`ListingCard` is the primary marketplace comparison primitive. Every card must show price, listing account name, account trust, availability, fulfillment, and one primary action. Save, compare, and watchlist are secondary affordances and should never compete visually with the primary action.

Cards may adapt to products, services, rentals, bookings, digital goods, quotes, and local listings, but the signal hierarchy stays stable: item identity, price, account trust, fulfillment, availability, risk reduction, then action.

Real product media renders as the collectible, not as a framed UI thumbnail. Use the shared product media treatment for catalog imagery so alpha-shaped assets, such as Pokemon cards with transparent rounded corners, remain chrome-less in light and dark mode. Do not add image borders, square media backgrounds, wrapper shadows, padding, or forced corner radii around real product images. Empty states, placeholders, and loading-only fallbacks may use neutral surfaces because they describe UI state rather than the physical card.

Product media must use the shared responsive image source contract. Routes should pass the role-appropriate source, `srcset`, `sizes`, width, and height from the owning bounded context's asset set instead of hand-authoring route-local image policy. Search-card product media renders in the compact product slot so Catalog's 224 CSS pixel `search-card` role can use its 448w variant on high-DPR displays without being stretched blurry.

Search result cards use the `search-result` card layout. This layout is a compact horizontal card on mobile and desktop, so product media stays prominent while leaving enough room for wrapped product identity. Two-sided cards may show the permanent fallback image as a subtle card-back preview behind the front image; loading-only fallbacks do not render that preview. Search result cards avoid image-overlay and body status badges, keep the Catalog `search-card` responsive image within its crisp source-size contract, and use one dominant Buy or Sell action with secondary intents quieter beside it. Repeated metadata such as default language and common blueprint labels should not appear before the product title on every search result.

## Product Options Display Contract

Use `ProductOptions` whenever a resolved product's selected options are displayed. Visual presentation is option-only: `Raw • Excellent` or `Graded • PSA • 10 Gem Mint`. Do not show Dimension labels such as `Form:` or `Condition:` in the visual label unless the surface is explicitly Catalog authoring or technical diagnostics.

Pass Dimension labels when they are known so the component can produce accessible names such as `Product options: Form Raw, Condition Excellent`. Use the exported product image alt helper when media needs product-option context, for example `Pikachu, Raw, Excellent`. `ProductOptions` receives explicit option display values; route and read-model adapters must not pass raw summary strings to the component.

## Account Reputation Summary Contract

Use `AccountReputationSummary` whenever a marketplace card, offer row, purchase panel, or trust module shows reputation for an account. Reputation is account-scoped: listing surfaces show the account that published the listing, and offer surfaces show the account that submitted marketplace-wide demand.

The default account reputation presentation is compact stacked metadata, not a card: no icon, no border, no background, and no separate "View feedback" action. Render the account name on the first line and the rating, review count, or compact new-account state on the second line. Only the account name is interactive; the feedback state remains plain text. Use the framed variant only inside a dedicated trust module where a surrounding panel is not already providing structure.

Do not render the same account name, rating, or review count in multiple cells of the same listing, offer, or checkout row. The account row is the canonical home for account name, feedback summary, and profile navigation. Accounts without feedback use the compact visible label `New` with accessible text that explains there is no feedback yet. Aggregate marketplace labels such as "verified supply" or "marketplace sellers" are not accounts and must not use `AccountReputationSummary`. Public profile links use `/accounts/:accountSlug`; do not introduce `/sellers/:slug` or profile routes segmented by marketplace side.

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

## Product Action Surfaces

Marketplace product actions use three user-facing intents: Buy, Sell, and Watch. Search captures intent quickly from item cards. Item detail resolves the exact Product and, when needed, the selected Listing or Offer.

- Search result cards may use compact Buy / Sell / Watch language because the user is still scanning, but the card should show one dominant primary action at a time. Buy is primary when active supply exists; Sell is primary when supply is wanted. Watch and the opposite trade-side intent stay visually secondary.
- Item detail should use an action accordion rail, not a long flat action list. Buy, Sell, and Watch are the rail's top-level intent sections.
- Inside Buy and Sell, show selected counterparty actions before product-level actions. For Buy, selected Listing actions are `Buy this listing` and `Add listing to Buy Cart`; product actions are `Add product to Buy Cart` and `Make offer`. For Sell, selected Offer actions are `Accept offer` and `Add offer to Sell List`; product actions are `Add product to Sell List` and `Create listing`.
- Watch belongs beside Buy and Sell in the intent control. Listing alerts and offer alerts should not appear as buying or selling actions.
- Item-detail rail labels are object-first. Use `Best available listing` or `Selected listing`, `Selected product`, `Make an offer`, `Best available offer` or `Selected offer`, `List this product`, `Watch listings`, and `Watch offers` as the visible section frame before any mechanism copy.
- Guests see the same Buy, Sell, and Watch choices as signed-in accounts. The rail can explain that account setup happens before checkout, offer acceptance, listing publication, payout, or alert activation, but it must not replace the action with `Register to sell` or similar account-gate copy.
- Advanced matching, optimization, fallback, fee, payout-term, registration, stale-recovery, and alert-delivery rules do not belong in item-detail rails by default. Put them in Buy Cart, Sell List, checkout readiness, or Reference Info popups depending on where the user needs the detail.

## Reference Info

Use `ReferenceInfoTrigger` with `ReferenceInfoDialog` for compact marketplace and admin explanations that are useful to some users but would overload the main surface. This is the standard popup pattern for reference-data details in admin and for marketplace rail fine print; do not create competing tooltip, popover, or ad hoc disclosure patterns for the same job.

The canonical contract lives in [Reference Info Popup](./REFERENCE_INFO.md). Marketplace rail wrappers should own only localized topic copy and data mapping; overlay behavior, focus management, trigger treatment, and compact fact layout stay in the design-system primitive.

- Required decision facts stay visible. Price, quantity, selected product options, public account identity and reputation, availability, essential payout preview, blocking errors, and final action buttons must not be hidden behind Reference Info.
- Fine print goes in Reference Info. Use it for Buy Cart matching behavior, listing reservation nuance, Sell List matching behavior, payout calculation detail, standard-term explanations, fee basis, registration timing, stale quote recovery, and watch alert mechanics.
- Use at most one visible Reference Info trigger per workflow or action cluster. The trigger label names the topic, such as `Buying this listing`, `Listing in Buy Cart`, `Estimated payout`, `Standard terms`, `Creating a listing`, `Watch listings`, or `Watch offers`.
- Dialog copy should be structured and scannable: a one-sentence summary, then short key/value rows or short sections. Avoid multi-paragraph policy copy in the rail; link to durable policy pages from the dialog when the detail affects money or expectations.
- Tooltip-only disclosure is not enough for marketplace rail fine print because these explanations affect buying, selling, payout, or alert expectations.

## Market Book

Item detail market data should use a market-book tab set for `Listings`, `Offers`, `Sales`, and `Details`.

- Listings and Offers are the active liquidity views and should support row selection when exact counterparty action is available.
- Sales can be an empty or deferred state until a trustworthy sales-history read model exists.
- Details can wrap existing catalog facts, but it should not replace the selected Product summary.
- Keep the market book visually distinct from the action rail: the market book explains liquidity, while the rail commits or saves intent.

## Buy Cart And Sell List Review

Buy Cart and Sell List are checkout-plan review surfaces, not generic dashboards.

- Buy Cart groups `Selected listings` separately from `Products`. Selected listing lines preserve exact Listing intent; product lines use Smart Match listings and may fall back to offers.
- Sell List groups `Selected offers` separately from `Products`. Selected offer lines preserve exact Offer intent; product lines use Smart Match offers and may fall back to listing creation.
- Use `Smart Match` as the visible name for matching and optimization. Keep implementation terms such as optimize, locked listing, fulfillment mode, and batch id out of primary UI copy.
- Review surfaces should show the current optimization goal and fallback posture even when detailed controls are progressively disclosed.
- Sellers should see Sell List language, never cart language. The Sell List can still live in Checkout because payment readiness, ordering, payout, and fulfillment orchestration follow the checkout-plan shape.

## Checkout Confidence

Checkout must show item subtotal, shipping, fees, tax, discounts, wallet credit, and final total before payment. The sticky CTA should include the final action, payment confidence copy, and at most one secondary edit or escape action.

## Preview-Backed Forms

Marketplace forms that edit inputs while showing server-calculated previews, totals, fees, eligibility, or fulfillment state must use explicit submit commands. Field blur, keyboard tabbing, and ordinary select/input changes should update local UI state only; they must not route-submit, navigate, or reload the page.

When edits make a visible preview stale, show a concise stale-review state and keep the explicit command visible. Examples include `Refresh totals`, `Save changes`, or `Create purchases and continue to secure payment`. Route actions should keep refresh/review intent separate from commit intent so buyers understand whether they are updating a preview or creating a commercial commitment.

Autosave or live-preview behavior is allowed only when it uses a non-navigating fetcher-style interaction with cancellation or deduping, preserves keyboard flow, and does not clear partially entered values. Write-then-redirect flows that depend on projected read models must append fresh-write metadata so the reloaded page reads the written state before rendering defaults.

## Real-App Validation

The real marketplace and admin apps are the validation surfaces. Do not recreate a separate showcase project for marketplace UI validation.

Each marketplace route should keep the most decision-critical information visible:

- Relevance: title, category, media, condition, availability.
- Fair price: item price, fees, shipping, taxes, discounts, total.
- Account trust: verification, rating, review count, tenure, completed transactions, response time.
- Fulfillment: delivery estimate, pickup details, booking window, digital delivery.
- Risk: order protection, return/refund/cancellation policy, secure payment, dispute path.
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

## Promo Bar

Use `PromoBar` for marketplace-wide announcements, fee promotions, shipping-credit reminders, and short operational notices. The bar should stay above public marketplace content, use concise copy, link to durable policy pages when the message affects money or expectations, and cycle only when more than one active message is present. It must not replace required checkout, fee, policy, or payment disclosure inside transactional flows.

## Progressive Disclosure Defaults

Use progressive disclosure for advanced marketplace depth, not for required account or transaction-party comprehension. Required decision facts stay visible; optional controls and deeper explanation use `ProgressiveDisclosure` or `ProgressiveDisclosureGroup`.

Good disclosure candidates:

- optional search depth, saved-search recovery, and dense comparison controls
- listing limits, offer matching thresholds, fulfillment exceptions, and publishing recovery detail
- product specification depth, grading population context, certification extras, and market-history detail
- checkout support diagnostics and provider-safe payment explanations after the final total is visible
- payout verification reason detail, ledger context, and provider-safe settlement explanations

Do not disclose the current price, final total, account trust, availability, fulfillment expectation, order-protection summary, blocking error, primary action, or result-shaping search facets. If an advanced setting affects low-value card margins or buyer commitment, expose its current effect in the disclosure summary.

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
- After: checkout shows final cost, secure payment, delivery, policy, and order protection before confirmation.
- Before: empty and error states were mostly informational.
- After: recovery states provide next actions, recommendations, and support paths.

## Implementation Roadmap

1. Adopt marketplace tokens and `ThemeToggle` across marketplace-facing routes.
2. Replace listing grids with `ListingCard`, `SearchFilterPanel`, and mobile-card table behavior.
3. Replace listing detail pages with media, price, account attribution, protection, policy, review, specification, comparison, and sticky CTA modules.
4. Replace public seller-profile language with account profiles that use `AccountReputationSummary`, account listings, `ReviewCard`, and trust-building empty states; add contextual seller labels only inside listing, sale, or transaction modules.
5. Move checkout to transparent `PriceBreakdown`, editable sections, secure-payment messaging, and recovery notices.
6. Add messaging, offer, dashboard, empty, error, and status timeline patterns to post-purchase and negotiation flows.
7. Remove custom deployable overrides once each screen is backed by design-system primitives.
