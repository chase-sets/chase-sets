# Landing Page Audit Remediation

## Intent

Address the comprehensive marketing landing-page audit findings for Chase Sets public prelaunch conversion, UX, SEO, performance, accessibility, analytics readiness, and maintainability.

The implementation should make the public landing page clearer and more persuasive without violating the current prelaunch truth: Chase Sets is not yet processing live marketplace transactions. The page should convert qualified collectors and founding sellers into email-consented Waitlist Signups while making status, terms, risk, and next steps explicit.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\20260520-landing-page-audit-plan`
- Branch: `codex/landing-page-audit-plan`
- Sandbox id: `da1164fa`
- Dependency setup: complete via `pnpm run deps:install`
- Shared pnpm store: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\.chase-sets-pnpm-store`
- Sandbox doctor: passed via `pnpm run sandbox:doctor`
- Setup blockers: none found

## Owning Contexts

### Primary Owner: Public Presence

Public Presence owns public product pages, prelaunch policy surfaces, waitlist behavior, internal waitlist review, product copy, waitlist UI, read models, and tests.

Repo evidence:

- `bounded-contexts/README.md` identifies Public Presence as owner of public product pages, prelaunch policy surfaces, waitlist behavior, and internal waitlist review.
- `bounded-contexts/public-presence/README.md` says marketplace/admin deployables only compose routes from this context and that product copy, waitlist domain behavior, read models, UI, and tests stay here.
- `bounded-contexts/public-presence/GLOSSARY.md` defines Waitlist Signup as an email-consented request for early access qualified by account intent and product interests.
- `bounded-contexts/public-presence/context.json` contributes the public-web index route from `./routes/marketplace/home` and declares the `waitlist` slice.
- Landing UI lives in `bounded-contexts/public-presence/features/waitlist/ui/public-pages.tsx`.
- Landing copy lives in `contracts/localization/locales/en.ts`.

### Supporting Owner: Public Web Deployable

Public Web should remain a thin composition root for host concerns only.

Repo evidence:

- `deployables/public-web/app/routes.ts` composes public context routes, manifest, robots, sitemap, favicon, and not-found routes.
- `deployables/public-web/app/root.tsx` owns document-level canonical, indexing, manifest, favicon, scripts, and stylesheet composition.
- `deployables/public-web/app/seo.ts`, `routes/robots.ts`, `routes/sitemap.ts`, and `routes/manifest.ts` own host-level SEO/PWA behavior.

### Supporting Owner: Design System

Design-system changes are allowed only for canonical reusable component behavior, not page-specific overrides.

Repo evidence:

- `packages/design-system/src/patterns/app-shells.tsx` owns `MarketingImageHero` and `MarketingVisualCard`.
- `MarketingImageHero` and `MarketingVisualCard` currently render `img` elements without explicit loading/fetch-priority controls.
- Page-specific styling should remain in design-system primitives/patterns rather than custom overrides.

## Resolved Decisions

### 1. Scope And Ownership

Decision: Implement remediation primarily inside `bounded-contexts/public-presence`, with small host-level changes in `deployables/public-web` and reusable image-loading support in `packages/design-system`.

Why: The bounded-context model makes Public Presence the canonical home for public product pages, waitlist behavior, UI, copy, and tests. Public Web must stay a thin composition root.

Consequence: Do not move public landing copy or behavior into `deployables/public-web`. Do not create app-specific custom UI overrides outside the design system.

### 2. Landing Page Narrative

Decision: Rebuild the landing page around this narrative order:

1. Concrete hero: trading-card marketplace beta for collectors and sellers.
2. High-signal proof strip: seller math, buyer total clarity, prelaunch status.
3. Product preview near the top.
4. Seller path and buyer path with intent-aware CTAs.
5. Trust and objection handling before final conversion.
6. Final waitlist CTA.
7. FAQ and policy links.

Why: The audit found too much abstract repetition, proof buried below multiple sections, and immediate conversion pressure before trust.

Consequence: Merge or remove overlapping sections such as broad marketplace model, full participation, repeated “why join” claims, and late expectation copy when those points are moved earlier.

### 3. Hero Conversion Pattern

Decision: Test a lower-friction hero conversion path: keep the hero CTA prominent, but reduce the first interaction to either an email-first form or a CTA that jumps to a richer form after proof. The implementation can keep the full form lower on the page.

Recommended first implementation: email-first hero panel with email and consent, plus optional hidden defaults from intent CTAs. After submission, retain the server-side Waitlist Signup contract by sending default role `both` and first priority `low-sales-fees` unless the user selected a buyer/seller path.

Why: Current hero form requires email, marketplace intent, first priority, and consent before the visitor sees proof.

Consequence: If the full hero form stays, add stronger status/risk-reversal copy inside the hero and expect lower top-of-funnel conversion.

### 4. Audience Segmentation

Decision: Make buyer/seller path CTAs update or prefill the same Waitlist Signup intent rather than only scrolling to explanation sections.

Why: Current audience cards identify intent but do not reduce form work or improve attribution.

Consequence: The implementation should preserve canonical role values from existing contracts: `buy`, `sell`, and `both`.

### 5. Truthful Proof And Trust Signals

Decision: Use verified internal facts and clearly labeled prelaunch proof. Do not invent testimonials, signup counts, seller counts, live inventory, launch dates, security certifications, payment providers, or buyer protection guarantees that are not present in code/docs.

Acceptable proof sources now:

- Public policies are visible.
- Support email is visible.
- Waitlist confirmation email exists through the transactional email projector.
- UTM/source attribution and admin waitlist review exist.
- Seller fee-lock and buyer-total examples can remain if copy labels them as planned/prelaunch/sample.

Potential proof to add only after verification:

- Real waitlist count or invite-wave volume from the waitlist read model.
- Founder/operator credentials.
- Screenshots from implemented marketplace surfaces.
- Real seller/collector quotes.

### 6. Analytics Ownership

Decision: Add lightweight public-page analytics hooks as Public Presence UI behavior, while keeping any reusable event sender tiny and explicit. If the event sink is not selected yet, implement a typed no-op-safe browser event adapter and data attributes as a first step.

Why: The audit found no visible analytics instrumentation beyond UTM capture into Waitlist Signup source fields.

Consequence: Do not introduce a broad analytics platform dependency without a privacy/consent decision. Track only non-sensitive interaction metadata unless consent allows more.

### 7. SEO And Metadata

Decision: Public Web owns canonical, robots, sitemap, manifest, and document shell; Public Presence route meta owns route-specific title, description, Open Graph, Twitter, and structured-data content.

Why: This preserves deployable-host vs. route-content boundaries.

Consequence: Add complete social tags to route meta and add JSON-LD from the route or a context-owned SEO helper, but keep canonical link generation in `deployables/public-web/app/root.tsx`.

### 8. Performance

Decision: Only the hero image should be eager/high-priority. Below-the-fold landing images should be lazy-loaded and the large product PNG should be replaced or optimized.

Why: Production HTML preloads all three images, including a below-the-fold 637.7 kB PNG.

Consequence: Add reusable loading/fetch-priority props to design-system marketing image patterns, then set page-specific priorities from Public Presence.

### 9. Accessibility

Decision: Preserve existing semantic headings and design-system focus behavior, but add clearer consent/privacy context in the compact hero form and keep image dimensions/loading stable.

Why: Existing labels, skip link, and one-H1 structure are good; the compact consent description is suppressed and below-fold images lack explicit loading/dimensions.

### 10. Admin Review

Decision: Extend waitlist admin review only if new conversion attributes are persisted. CTA-click analytics and scroll events should not be pushed into Waitlist Signup read models unless they become part of the domain.

Why: Waitlist Signup is a domain fact; anonymous behavior analytics are not the same concept.

## Implementation Checklist

### Phase 1: Quick Conversion And Trust Wins

- Rewrite hero H1, subheadline, and CTA copy in `contracts/localization/locales/en.ts`.
- Make H1 explicitly include marketplace/category/audience/outcome.
- Add hero risk-reversal/status microcopy: prelaunch, no live transactions, email-consented updates, final terms before payments.
- Move `ProductSignalPreview` above abstract/repeated sections in `PublicPresenceHomePage`.
- Merge/remove duplicated “model,” “audience,” and “why join” claims into fewer higher-signal sections.
- Add a trust/proof section before the final form:
  - public policies visible,
  - support path visible,
  - sample totals labeled as sample,
  - waitlist confirmation expectations,
  - no live marketplace transactions yet.
- Add copy tests in `bounded-contexts/public-presence/features/waitlist/ui/public-pages.test.tsx` for the new headline, trust claims, and section order.

### Phase 2: Lower-Friction Conversion Flow

- Refactor `WaitlistSignupPanel` into reusable variants:
  - compact hero variant,
  - full final variant,
  - success/error banner handling shared.
- Add buyer/seller CTA intent handling:
  - seller CTA preselects role `sell` and priority `low-sales-fees` or `bulk-listing`,
  - buyer CTA preselects role `buy` and priority `set-completion`,
  - default remains `both` and `low-sales-fees`.
- Prefer a progressive pattern:
  - hero captures email + consent with hidden/default role and interest,
  - full form lower on page captures richer role/priority.
- Preserve the existing server action and API contract unless the UX requires a domain change.
- Add UI tests for prefilled roles/interests and duplicate form behavior.

### Phase 3: SEO And Structured Data

- Update route meta in `bounded-contexts/public-presence/routes/marketplace/home.tsx`:
  - stronger title,
  - stronger meta description,
  - `og:url`,
  - `twitter:title`,
  - `twitter:description`,
  - `twitter:image`.
- Keep canonical generation in `deployables/public-web/app/root.tsx`.
- Add `Organization` and `WebSite` JSON-LD for the home route.
- Add `FAQPage` JSON-LD for the FAQ route if FAQ content remains stable and visible.
- Add tests in `deployables/public-web/app/routes/public-web.test.tsx` or route-level tests for social metadata and schema output.
- Confirm `og:image` resolves to production asset paths after build.

### Phase 4: Performance

- Extend `MarketingImageHero` with image priority/loading props:
  - hero default can remain eager,
  - allow `fetchPriority="high"` for true hero,
  - allow width/height or aspect ratio if supported by the pattern.
- Extend `MarketingVisualCard` with `loading="lazy"` / `fetchPriority="low"` for below-fold visuals.
- Ensure `ListingCard` product preview image is lazy or page-provided priority is low if below the fold.
- Replace `pikachu-illustration-rare.png` with optimized WebP/AVIF or a smaller generated asset.
- Rebuild public web and compare asset sizes:
  - below-fold product image target under 150 kB,
  - no production preload links for below-fold images,
  - no new chunk-size warnings.
- Consider public-web-specific design-system import review only if `src-*.js` remains disproportionately large after image fixes.

### Phase 5: Analytics And Experimentation Readiness

- Add a context-local analytics adapter under Public Presence, for example `features/waitlist/ui/analytics.ts`.
- Keep the adapter no-op unless an explicit endpoint/provider is configured.
- Track:
  - `landing_page_view`,
  - `cta_clicked`,
  - `waitlist_form_started`,
  - `waitlist_form_submitted`,
  - `waitlist_signup_succeeded`,
  - `waitlist_signup_failed`,
  - `section_viewed`,
  - `policy_link_clicked`.
- Include properties:
  - `section`,
  - `cta_label`,
  - `cta_href`,
  - `role`,
  - `interest`,
  - `utm_source`,
  - `utm_medium`,
  - `utm_campaign`,
  - `variant`.
- Do not send email addresses or raw personal data in analytics events.
- Add tests around event function calls without binding to a third-party provider.

### Phase 6: PWA/Manifest And Host Hygiene

- Fix manifest icon URLs from `deployables/public-web/app/routes/manifest.ts`.
- Either add route-served PNG icons or remove missing PNG icon references until real assets exist.
- Add public-web tests that requested manifest icon URLs return `200`.
- Preserve favicon SVG route behavior.

### Phase 7: Accessibility And Responsive QA

- Add consent/privacy description to compact form or a nearby privacy link.
- Confirm one H1 remains.
- Confirm all form fields have labels and error/success banners announce clearly.
- Run keyboard navigation through nav, hero form, path CTAs, final form, and footer links.
- Run automated accessibility checks if the repo has or adds a Playwright/axe pattern.
- Capture desktop and mobile screenshots before PR.
- Verify no horizontal overflow at 320, 390, 768, and 1440 px widths.

### Phase 8: Verification

- Run targeted tests:
  - `pnpm --filter @chase-sets/public-presence run test`
  - `pnpm --filter @chase-sets/app-public-web run test`
  - `pnpm --filter @chase-sets/app-public-web run typecheck`
  - `pnpm --filter @chase-sets/app-public-web run build`
- Run broader checks if implementation touches design-system contracts:
  - `pnpm --filter @chase-sets/design-system run test`
  - root `pnpm run typecheck` if shared types change
  - root `pnpm run build` if route/build composition changes
- Run local rendered QA:
  - public-web dev/prod route at sandbox public-web port,
  - desktop/mobile screenshots,
  - verify manifest icons,
  - verify production HTML preload behavior,
  - verify waitlist submission success/failure in a sandbox with platform API available.

## Suggested Copy Direction

### Hero H1 Candidates

Preferred:

- `Trading-card marketplace beta for collectors and sellers`

Alternates:

- `The trading-card marketplace built for set completion and seller margin`
- `Buy missing cards with clearer totals. Sell cards with beta fee locks.`
- `Make low-value cards worth buying, listing, and shipping`
- `Join the card marketplace beta built around real collector workflows`

### Hero Subheadline Direction

Preferred:

- `Join early access for 0% beta seller fees, bulk listing workflows, and buyer-visible totals before checkout.`

Keep copy truthful: use “beta,” “prelaunch,” “sample,” or “planned” when describing not-yet-live behaviors.

### CTA Direction

Primary:

- `Join early access`
- `Reserve beta access`
- `Request an invite`

Secondary:

- `See seller math`
- `Preview buyer totals`
- `Read the launch FAQ`
- `View order protection`

## Suggested Page Structure

1. Navigation
   - Brand, Product, FAQ, Policies, primary CTA.
   - On narrow mobile, consider collapsing non-primary links or using a compact two-row layout.
2. Hero
   - Explicit marketplace beta H1.
   - One short prelaunch/status line.
   - Low-friction email/consent or prominent CTA.
3. Proof Strip
   - 0% beta seller fee lock.
   - No separate seller payment-processing fee.
   - Buyer-visible totals before payment.
   - No live transactions during prelaunch.
4. Product Preview
   - Sample listing and total preview.
   - Label sample clearly.
5. Seller Economics
   - $10 card math.
   - Fee-lock rules.
   - Link to marketplace sales fees.
6. Buyer Totals
   - Bundle math and shipping credit.
   - Link to order protection.
7. Trust And Objections
   - Current status.
   - Public policies.
   - Support contact.
   - What happens after signup.
8. Final Form
   - Full role/priority capture.
   - Discord link if configured.
9. FAQ Preview
   - Launch timing.
   - Seller fees.
   - Shipping.
   - Safety.
10. Footer

## Backlog

| Task | Category | Priority | Effort | Impact | Files likely involved | Acceptance criteria |
| --- | --- | --- | --- | --- | --- | --- |
| Rewrite hero headline/subheadline/CTA | Messaging | P0 | S | High | `contracts/localization/locales/en.ts` | H1 names marketplace/category/audience/outcome; tests updated |
| Move product preview above repeated abstract sections | CRO/UX | P0 | M | High | `bounded-contexts/public-presence/features/waitlist/ui/public-pages.tsx` | Product preview appears before generic model/audience sections |
| Add prelaunch trust and objection section | CRO/trust | P0 | M | High | `public-pages.tsx`, `en.ts` | Page states no live transactions, visible policies, support, sample/provisional status before final CTA |
| Reduce hero form friction | CRO/forms | P0 | M | High | `public-pages.tsx`, tests | Hero variant requires fewer fields or CTA jumps to full form; Waitlist Signup contract still satisfied |
| Make buyer/seller CTAs intent-aware | CRO/UX | P1 | M | Medium | `public-pages.tsx`, tests | Buyer/seller clicks preselect role and priority |
| Add route social metadata | SEO | P1 | S | Medium | `bounded-contexts/public-presence/routes/marketplace/home.tsx` | Includes `og:url`, Twitter title/description/image; tests cover metadata |
| Add JSON-LD schema | SEO | P1 | S | Medium | home/FAQ route modules or context SEO helper | Organization/WebSite and FAQPage schema render valid JSON-LD |
| Fix below-fold image preloads | Performance | P0 | M | High | `packages/design-system/src/patterns/app-shells.tsx`, `public-pages.tsx` | Production HTML preloads only hero image |
| Optimize large product preview image | Performance | P0 | S | High | `bounded-contexts/public-presence/features/waitlist/ui/assets/*` | Replacement asset is under 150 kB and visually acceptable |
| Add analytics adapter and events | Analytics | P0 | M | High | Public Presence UI files, possible context-local helper | CTA/form/success/failure/section events tracked without PII |
| Fix manifest icon references | Technical SEO/PWA | P1 | S | Medium | `deployables/public-web/app/routes/manifest.ts`, possible icon route/assets | Manifest icon URLs return 200 or references are removed |
| Add compact consent/privacy context | Accessibility/privacy | P1 | S | Medium | `public-pages.tsx`, `en.ts` | Hero form exposes consent meaning and removal/privacy path |
| Add mobile sticky CTA or compact nav treatment | Mobile CRO | P2 | M | Medium | `public-pages.tsx`, design-system if reusable | 320/390 px screenshots show CTA accessible without nav crowding |
| Add rendered QA scripts or tests | Quality | P2 | M | Medium | Playwright config/tests | Desktop/mobile screenshot and no-overflow checks are repeatable |
| Add public-web performance budget check | Performance | P2 | M | Medium | scripts/tests | Build fails or warns on oversized landing assets/chunks |

## 30 / 60 / 90 Plan

### 0-30 Days: Quick Wins

- Rewrite hero and CTA copy.
- Move product preview higher.
- Add trust/objection block.
- Optimize image loading and product preview asset.
- Fix manifest icons.
- Add route social metadata.
- Add basic analytics hooks.
- Verify with targeted public-presence/public-web tests, typecheck, build, and rendered screenshots.

### 31-60 Days: Structural Improvements

- Refactor waitlist form variants for lower-friction hero capture and richer final capture.
- Add buyer/seller intent-aware CTA prefill.
- Simplify page from many overlapping sections to fewer high-signal sections.
- Add JSON-LD schema.
- Add mobile sticky CTA or compact mobile nav if screenshots show continued friction.
- Add no-overflow/accessibility/performance checks to repeatable QA.

### 61-90 Days: Experiments And Deeper Optimization

- Run A/B tests:
  - hero H1,
  - email-only vs full hero form,
  - product-preview-before-form vs current form-first,
  - seller-first vs buyer-first narrative order,
  - CTA language: `Join early access` vs `Request an invite`.
- Add segment-specific landing variants if analytics shows seller and buyer intent diverge strongly.
- Add real proof when verified:
  - waitlist milestone,
  - founder/operator credibility,
  - real seller/collector quotes,
  - real marketplace screenshots.
- Add broader Core Web Vitals monitoring once production traffic exists.

## Stress Tests

### Normal Flow

Visitor lands, understands marketplace beta promise, sees proof/status, selects buyer/seller path or fills email, consents, submits Waitlist Signup, sees success, and receives confirmation email from existing transactional email projection.

### Partial Flow

Visitor clicks buyer/seller CTAs but does not submit. Analytics should record intent click without creating a Waitlist Signup. No domain event should be written.

### Duplicate Signup

Existing normalized email submits again. Current domain behavior updates existing Waitlist Signup. The UI should frame success as “you are on the list” rather than implying duplicate records.

### Missing Consent

Domain requires consent. Hero/full form variants must still provide a required consent mechanism and accessible explanation.

### Bot/Honeypot

Existing `website` honeypot must remain intact. Analytics should not bypass spam handling or write domain events.

### Stale UTM / Referrer

UTM source values are captured at loader time into hidden fields. If progressive form interaction changes page state, hidden attribution fields must continue to submit original source data.

### Cross-Context Boundaries

Do not pull Marketplace, Checkout, Payments, or Commercial Terms runtime truth into Public Presence for proof claims unless those contexts publish stable facts or the proof is explicitly copy-only/prelaunch.

### Low-Value Card Economics

Seller and buyer examples must keep low-value card economics visible: seller fee lock, no separate seller processing fee, shipping credit, and buyer-visible order processing before payment.

### Failure / Cancellation

Waitlist API failure should keep form data visible enough to retry and fire a non-PII failure event. No external analytics failure should block submission.

## Documentation To Promote

No durable architecture docs are required for the first implementation if changes stay within existing ownership rules.

Consider later docs only if:

- an analytics provider or event schema becomes a cross-context/platform standard, then document under `docs/architecture` or the Insights context;
- a public proof-source policy is needed for prelaunch marketing claims, then document under `bounded-contexts/public-presence/docs/`;
- a reusable marketing image-loading pattern changes design-system guidance, then update `packages/design-system/README.md` or related pattern docs.

## Goal Completion Criteria

- PR submitted for the completed implementation or scoped non-product change.
- CI passing on the PR before merge.
- PR merged after required review and passing checks.
- Staging deployment verified green after merge.
- Production deployment verified green after promotion or rollout.
