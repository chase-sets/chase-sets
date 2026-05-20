# Landing Page Remaining Issues

## Intent

Address the fresh landing-page audit findings after the seller-first optimization shipped in PR #227. The next wave should improve conversion measurement, mobile first-screen conversion, metadata correctness, accessible consent, structured data, and future proof collection without weakening the bounded-context ownership model.

The implementation must keep Public Presence as the owner of public landing-page copy, waitlist behavior, waitlist UI, route metadata, and waitlist analytics event semantics. The `public-web` deployable remains the thin composition root for host SEO, indexing, sitemap/robots, and any environment/vendor-specific analytics adapter.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\20260520-landing-page-remaining-issues`
- Branch: `codex/landing-page-remaining-issues`
- Base: `origin/main` at `6939e99c Optimize public landing page conversion (#227)`
- Sandbox id: `227157ce`
- Dependency setup status: complete with `pnpm run deps:install`; sandbox doctor passed.
- pnpm store path: default embedded worktree store `.codex/worktrees/.chase-sets-pnpm-store`.
- Setup blockers: none known.

## Owning Contexts

- Public Presence owns public product pages, prelaunch policy surfaces, waitlist behavior, waitlist event names/properties, waitlist form UI, public route modules, and Public Presence docs.
- `public-web` owns host layout metadata composition, canonical origin resolution, robots, sitemap, deployable environment flags, and any deployable-level vendor analytics bridge.
- Design System owns reusable UI patterns. Mobile layout changes should use existing design-system primitives and only introduce design-system changes if a general responsive shell/hero capability is missing.
- Insights owns future cross-context analytics and reporting concepts. This pass should not create Insights projections unless the approved analytics path is first-party durable event collection rather than client-only vendor delivery.

## Resolved Decisions

### 1. Mobile above-the-fold density

- Decision: Treat mobile first-screen compression as the highest conversion UI fix.
- Evidence: Fresh render at 320px placed the H1 around 223px and the hero submit button around 855px. `PublicPresencePageShell` renders full brand, three nav links, and CTA before the hero in `bounded-contexts/public-presence/features/waitlist/ui/public-pages.tsx`; `MarketingImageHero` carries the hero image, long subheadline, and embedded form.
- Recommended implementation:
  - Make mobile nav materially shorter: keep brand plus primary CTA, move product/FAQ/policies into footer or a compact design-system-supported navigation pattern if available.
  - Shorten mobile hero description while preserving seller-first economics.
  - Reduce mobile hero vertical padding and form panel spacing through existing design-system props/classes, not deployable overrides.
  - Keep the primary CTA/form in the first screen on 390px and as close as practical on 320px.
- Stress test:
  - Normal flow: visitor sees seller outcome and email field without deep scroll.
  - Partial flow: nav anchors and footer policy links still exist for users seeking proof before signup.
  - Mobile/narrow: no horizontal overflow, no text clipping, no CTA pushed below a 390x844 viewport.
  - Accessibility: skip link remains first tabbable element.
- Likely files:
  - `bounded-contexts/public-presence/features/waitlist/ui/public-pages.tsx`
  - `contracts/localization/locales/en.ts`
  - possibly `packages/design-system/src/patterns/app-shells.tsx` only if a reusable hero/nav responsive capability is missing.

### 2. Duplicate canonical tags

- Decision: Remove route-level canonical metadata from the Public Presence home route and let the `public-web` root own canonical link rendering.
- Evidence: `bounded-contexts/public-presence/routes/marketplace/home.tsx` adds a canonical descriptor and `deployables/public-web/app/root.tsx` also renders a canonical link via `buildCanonicalUrl`. The live page currently renders two identical canonical tags.
- Recommended implementation:
  - Delete `{ tagName: "link", rel: "canonical", ... }` from the home route `meta`.
  - Update route tests to assert social metadata and structured data without route-owned canonical.
  - Keep deployable root canonical behavior as the single canonical source.
- Stress test:
  - Production page has exactly one canonical.
  - Staging and preview can still emit environment-appropriate noindex and canonical behavior from deployable SEO.
- Likely files:
  - `bounded-contexts/public-presence/routes/marketplace/home.tsx`
  - `bounded-contexts/public-presence/routes/marketplace/home.test.tsx`
  - `deployables/public-web/app/routes/public-web.test.tsx`

### 3. Hard-coded production origin in route metadata and JSON-LD

- Decision: Replace route-local `publicSiteUrl = "https://chasesets.com"` with origin supplied by the deployable loader or a small route-support contract, while preserving Public Presence ownership of metadata content.
- Evidence: `home.tsx` hard-codes production origin for `og:url`, `og:image`, Twitter image, and JSON-LD. `deployables/public-web/app/seo.ts` already owns `resolvePublicOrigin()`.
- Recommended implementation:
  - Have the home loader return `publicOrigin` from deployable host context, or expose an approved route-support helper that consumes the request URL/environment at the route boundary.
  - Make `buildHomeStructuredData(publicOrigin)` pure and testable.
  - Keep noindex behavior in `public-web`; do not move deployable environment policy into Public Presence internals.
- Stress test:
  - Production outputs `https://chasesets.com/`.
  - Staging/preview outputs their configured origin or remains noindexed.
  - Local development does not accidentally generate invalid absolute social image URLs.
- Likely files:
  - `bounded-contexts/public-presence/routes/marketplace/home.tsx`
  - `deployables/public-web/app/seo.ts`
  - route tests under Public Presence and public-web.

### 4. Analytics events not operationally captured

- Decision: Keep Public Presence provider-neutral and send waitlist analytics to the existing OpenTelemetry/Grafana observability path through a server-side bridge, not directly from the browser to Grafana or the OTLP collector.
- Evidence: `bounded-contexts/public-presence/features/waitlist/ui/analytics.ts` dispatches `chase-sets:waitlist-analytics` and optionally pushes to `window.dataLayer`. `bounded-contexts/public-presence/docs/landing-page-analytics.md` says a future adapter must listen and forward to an approved provider.
- Additional evidence: ADR 0001 chooses OpenTelemetry and the LGTM stack for vendor-neutral observability, keeps implementation in `infrastructure/observability`, requires bounded labels, and notes browser RUM/web deployable instrumentation was deferred until platform-api production readiness. The runbook confirms Grafana, Prometheus, Loki, Tempo, and OTLP are already supported locally/self-hosted.
- Recommended implementation:
  - Add a `public-web` browser adapter that listens for `chase-sets:waitlist-analytics` and POSTs bounded, non-PII analytics payloads to a server endpoint.
  - Add a server endpoint in the appropriate deployable/API composition surface that validates an allowlist of event names and bounded properties.
  - Extend `@chase-sets/observability` with landing/waitlist analytics counters such as `chase_sets_public_presence_waitlist_events_total`, labeled only by bounded dimensions: `event`, `section`, `role`, `interest`, `variant`, `environment`, and result/status where applicable.
  - Emit sanitized JSON logs for event diagnostics so Loki/Grafana can inspect event flow without storing email, raw URL, account/user IDs, cookies, or arbitrary text.
  - Add Grafana dashboard panels for landing page views, CTA clicks, form starts, submits, signup success/failure, and role/interest mix.
  - Do not expose the OTLP collector directly to browsers and do not import OTel SDKs into Public Presence UI.
- Stress test:
  - Normal flow: page view, CTA clicks, form start, submit, success/failure are visible in the chosen destination.
  - Partial flow: failed signup and validation friction remain visible.
  - Privacy: no email, account ID, raw URL, or unbounded text leaves the client analytics contract.
  - Failure/cancellation: missing or failed telemetry capture never blocks the landing page or waitlist submission.
  - Replay/stale data: the endpoint tolerates duplicate browser sends; metrics are directional funnel signals, not transactional truth.
- Likely files:
  - `bounded-contexts/public-presence/features/waitlist/ui/analytics.ts`
  - `bounded-contexts/public-presence/docs/landing-page-analytics.md`
  - `deployables/public-web/app/root.tsx` or browser-entry composition
  - `deployables/public-web` route/action or API proxy surface for capture
  - `infrastructure/observability/index.ts`
  - `infrastructure/observability/stack/grafana/dashboards/*`
  - `infrastructure/observability/stack.test.ts`

### 5. Trust proof remains self-asserted

- Decision: Do not invent proof. Add only repo-verifiable and currently real trust signals now; create documented placeholders/gates for future live proof.
- Evidence: `bounded-contexts/public-presence/docs/landing-page-positioning.md` explicitly forbids invented testimonials, waitlist counts, partnerships, founder bios, launch dates, transaction volume, or community proof.
- Recommended implementation:
  - Improve present proof by linking "Marketplace sales fees" from the hero/economics proof strip where relevant.
  - If there is real public community proof, founder identity, or beta cohort count, add it only after source verification.
  - Add durable doc criteria for future proof promotion: source, owner, freshness, legal/privacy review, and removal policy.
- Stress test:
  - Normal flow: visitor can verify fee/policy/support claims before signup.
  - Failure/cancellation: if a future proof source is stale or unavailable, the page must degrade to policy/support proof instead of showing fabricated credibility.
- Likely files:
  - `bounded-contexts/public-presence/docs/landing-page-positioning.md`
  - `bounded-contexts/public-presence/features/waitlist/ui/public-pages.tsx`
  - `contracts/localization/locales/en.ts`

### 6. Hero form hidden role and interest

- Decision: Keep current compact hero form for the primary implementation, but make it experiment-ready once analytics capture exists.
- Evidence: The hero form hides `role` and `interests` while the final form exposes them. The positioning doc says the embedded hero form should remain compact, seller-first, and explicit that joining does not require buying, listing, or payment.
- Recommended implementation:
  - Do not add visible role/interest controls to the hero until analytics can measure impact.
  - Add a documented experiment plan for compact hero form versus visible intent selector.
  - Ensure the hidden defaults are seller-first and transparent in copy.
- Stress test:
  - Normal flow: fast signup remains low-friction.
  - Lead quality: final form and audience path buttons still collect intent for users who engage deeper.
  - Experiment: event properties can segment by variant.
- Likely files:
  - `bounded-contexts/public-presence/docs/landing-page-analytics.md`
  - `bounded-contexts/public-presence/docs/landing-page-positioning.md`
  - future `public-pages.tsx` only when experiment variant is approved.

### 7. Required consent accessible description

- Decision: Hero consent must include the removal/privacy reassurance programmatically, even if the visible hero panel stays compact.
- Evidence: The hero suppresses `publicPresence.waitlist.consent.description`; fresh DOM showed the hero checkbox had no `aria-describedby`, while the full form checkbox did.
- Recommended implementation:
  - Pass a concise consent description to the hero checkbox, visually compact if necessary.
  - If visible copy would crowd mobile, add design-system support for screen-reader-only form descriptions instead of custom local CSS.
- Stress test:
  - Keyboard and screen-reader users hear both the required consent label and removal language.
  - Mobile form remains compact enough after adding description.
- Likely files:
  - `bounded-contexts/public-presence/features/waitlist/ui/public-pages.tsx`
  - `contracts/localization/locales/en.ts`
  - possibly `packages/design-system/src/components/forms/checkbox.tsx`.

### 8. FAQ structured data

- Decision: Add `FAQPage` JSON-LD only for FAQ items visibly rendered on the landing page, and keep it generated from the same localization keys as visible copy.
- Evidence: The route currently emits Organization and WebSite/RegisterAction JSON-LD only. The page renders a FAQ preview and has a full `/faq` route.
- Recommended implementation:
  - Extend `buildHomeStructuredData` to include FAQPage entries for visible FAQ preview content.
  - Keep the full FAQ page metadata separate unless it renders its own JSON-LD.
  - Test that schema text matches visible localized copy.
- Stress test:
  - Search engines do not receive hidden or contradictory FAQ answers.
  - Updating FAQ copy updates schema copy through shared keys.
- Likely files:
  - `bounded-contexts/public-presence/routes/marketplace/home.tsx`
  - `bounded-contexts/public-presence/routes/marketplace/home.test.tsx`
  - possibly `contracts/localization/locales/en.ts`.

### 9. Landing bundle weight

- Decision: Defer deep bundle work until after higher-impact conversion, metadata, accessibility, and analytics fixes unless implementation reveals an easy route-level split.
- Evidence: Built output still has a large shared `src-*.js` chunk, but the landing route itself is small and image payloads are now controlled.
- Recommended implementation:
  - During implementation verification, record bundle sizes before and after.
  - Avoid importing marketplace-heavy components into Public Presence if they are not needed.
  - Do not refactor shared chunks without a specific dependency culprit.
- Stress test:
  - Page remains static-render friendly.
  - Any design-system imports stay intentional and tree-shakeable.
- Likely files:
  - only if proven by bundle analysis: route imports, design-system exports, or deployable build config.

## Open Questions

No blocking questions remain.

## Implementation Checklist

- [x] Install dependencies in the worktree and run `pnpm run sandbox:doctor`.
- [x] Fix duplicate canonical by removing route-owned canonical metadata.
- [x] Replace hard-coded home route origin with host-provided origin for social metadata and JSON-LD.
- [x] Add FAQPage JSON-LD for visible landing-page FAQ content.
- [x] Add accessible consent description for the hero checkbox.
- [x] Compress the mobile first viewport without design-system overrides.
- [x] Implement the selected analytics capture path.
- [x] Add or update tests for metadata, schema, analytics adapter, consent accessibility, and mobile render expectations.
- [x] Run focused tests: Public Presence, public-web, observability.
- [x] Run production build and inspect rendered desktop/mobile/narrow screenshots.
- [x] Verify live-style head output has one canonical, correct social URLs, and expected JSON-LD.
- [x] Record bundle/resource size after implementation.

## Implementation Notes

- Public Presence home metadata now derives social URLs and JSON-LD URLs from the request origin with a production fallback, while `public-web` remains the only canonical link owner.
- Visible landing FAQ entries now appear in `FAQPage` JSON-LD.
- The hero and final consent checkboxes both render the removal-language description through `aria-describedby`.
- Mobile first-screen compression was achieved by simplifying the top nav, shortening the hero description, and preserving footer policy links.
- Waitlist analytics now flow through a `public-web` browser bridge to `/analytics/waitlist`, then into bounded OpenTelemetry metrics/logs for Grafana without sending email or arbitrary text.
- Waitlist analytics event names are exported from Public Presence and consumed by the deployable bridge and server route, keeping event vocabulary in the bounded context.
- Trust-proof promotion criteria were added to Public Presence docs without inventing testimonials, counts, partnerships, or launch claims.

## Verification Notes

- `pnpm --filter @chase-sets/public-presence run typecheck`
- `pnpm --filter @chase-sets/public-presence run test`: 7 files, 20 tests passed.
- `pnpm --filter @chase-sets/app-public-web run typecheck`
- `pnpm --filter @chase-sets/app-public-web run test`: 1 file, 11 tests passed; jsdom still emits known stylesheet parse warnings.
- `pnpm --filter @chase-sets/observability run typecheck`
- `pnpm --filter @chase-sets/observability run test`: 2 files, 7 tests passed.
- `pnpm run verify:static`
- `pnpm --filter @chase-sets/app-public-web run build`
- Local built render at `http://localhost:55834/` had exactly one canonical, origin-aware `og:url` and `twitter:image`, FAQ schema, analytics bridge script, and the new H1.
- Runtime consent check found both rendered checkboxes described by: `Ask support@chasesets.com to remove you from prelaunch updates or waitlist records.`
- Mobile render check at 390x844 had no horizontal overflow; H1 bottom was 210px and waitlist form top was 350px.
- `/analytics/waitlist` returned 204 for a valid `cta_clicked` payload, 400 for unsafe/arbitrary label text, 400 for an unsupported event, and 405 for GET.
- Build output retained controlled landing assets: hero image 133.79 kB, waitlist card panels 90.71 kB, rare preview 59.33 kB, route chunk 27.43 kB gzip 5.22 kB, shared `src` chunk 683.63 kB gzip 139.96 kB.

## Documentation To Promote

- Update `bounded-contexts/public-presence/docs/landing-page-analytics.md` after the analytics destination is chosen and implemented.
- Update `bounded-contexts/public-presence/docs/landing-page-positioning.md` with future-proof promotion criteria for trust signals.
- Update `docs/README.md` only if the landing-page docs should be promoted into the curated documentation map.

## Goal Completion Criteria

- PR submitted for the completed implementation or scoped non-product change.
- CI passing on the PR before merge.
- PR merged after required review and passing checks.
- Staging deployment verified green after merge.
- Production deployment verified green after promotion or rollout.
