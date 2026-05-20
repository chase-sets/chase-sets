# Landing Page Optimization

## Intent

Address the marketing landing-page audit recommendations with a bounded-context implementation plan before changing product/runtime code.

The planned work should improve conversion clarity, trust, analytics readiness, technical SEO, performance, accessibility, and maintainability for the public Chase Sets prelaunch landing page.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\20260520-landing-page-optimization`
- Branch: `codex/landing-page-optimization`
- Sandbox id: `54f4c5ac`
- Dependency setup status: complete via `pnpm run deps:install`
- Sandbox doctor status: passed via `pnpm run sandbox:doctor`
- Public web sandbox URL: `http://localhost:7804`
- Platform API sandbox URL: `http://localhost:7812`
- pnpm store path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\.chase-sets-pnpm-store`
- Setup blockers: none known

## Owning Contexts

- Public Presence owns public product pages, prelaunch policy surfaces, waitlist behavior, product copy, waitlist UI, waitlist read models, and tests. Evidence: `bounded-contexts/public-presence/README.md`, `bounded-contexts/public-presence/context.json`, and `bounded-contexts/README.md`.
- Public Web is a thin deployable composition root for host routes, root metadata shell, sitemap, robots, and manifest routes. Evidence: `deployables/public-web/app/routes.ts`, `deployables/public-web/app/host.ts`, and `deployables/public-web/app/root.tsx`.
- Design System owns reusable UI primitives and shared marketing/marketplace components. Page-specific persuasion, copy, analytics events, and waitlist behavior should not move into the design system. Evidence: `packages/design-system/README.md` and `packages/design-system/MARKETPLACE_SYSTEM.md`.

## Resolved Decisions

- Product/runtime edits are paused until planning decisions are resolved.
- The landing-page hero should be seller-first. Lead with seller margin, fee-lock, no separate seller processing fee, and faster repeat card listing; use buyer delivered-total and set-completion proof as demand-side confidence and marketplace completeness.
- Trust and credibility copy must use repo-verifiable facts only for this pass: prelaunch status, no live transactions, public policies, visible support contact, waitlist consent/removal language, fee-lock terms, sample product previews, and provider-backed payment language already present in Public Presence copy. Do not invent testimonials, waitlist counts, partnerships, founder bios, launch dates, or community proof.
- Analytics should be provider-neutral in this pass. Add a small Public Presence event contract/adapter with no-op default behavior and testable event dispatch points for CTA clicks, form start, role/priority selection, consent, submit attempt, submit success/error rendering, and key section views. Do not add a third-party script or vendor SDK yet.
- Keep the compact embedded hero waitlist form. Strengthen it with seller-first proof, prelaunch/no-commitment reassurance, and clearer CTA copy rather than replacing it with role-first cards or moving the form below the hero.
- Landing page copy, section order, waitlist form reassurance, CTA labels, SEO schema content, and UI tests belong in `bounded-contexts/public-presence`.
- Route metadata and the existing action/loader for waitlist submissions belong in `bounded-contexts/public-presence/routes/marketplace/home.tsx`.
- The public deployable should stay thin; do not move landing-page behavior into `deployables/public-web`.
- Performance support for image loading should be added to reusable design-system marketing image components if the page needs first-class `loading`, `decoding`, `fetchPriority`, `width`, or `height` controls. Page-specific image choices remain in Public Presence.
- Existing UTM and referrer capture should be preserved. Evidence: `bounded-contexts/public-presence/routes/marketplace/home.tsx` captures `utm_source`, `utm_medium`, `utm_campaign`, `utm_content`, `utm_term`, and referrer, and `public-pages.tsx` posts hidden fields.
- Existing waitlist domain invariants should not change unless explicitly needed: email consent is required, duplicate normalized emails update the same signup, and a Waitlist Signup is not an Account, User, Buyer, or Seller. Evidence: `bounded-contexts/public-presence/GLOSSARY.md`, `features/waitlist/domain/domain.ts`, and `features/waitlist/domain/common.ts`.
- Existing protection should remain in place: honeypot rejection and per-IP rate limiting in `bounded-contexts/public-presence/api.ts`.
- The implementation should keep account language where durable identity is meant, and use buyer/seller only as marketplace transaction roles or user-selected waitlist intent. Evidence: `bounded-contexts/README.md` and `packages/design-system/MARKETPLACE_SYSTEM.md`.

## Repo Evidence

- Landing route contribution: `bounded-contexts/public-presence/context.json` contributes the root `home` route to `public-web`.
- Main landing page component: `bounded-contexts/public-presence/features/waitlist/ui/public-pages.tsx`.
- Current hero copy: `publicPresence.home.title` is `Finish sets. Keep more card margin.` and `publicPresence.home.description` combines seller and buyer benefits in `contracts/localization/locales/en.ts`.
- Current page order: hero with compact form, signal strip, buyer/seller paths, seller economics, why join, buyer proof, product preview, marketplace model, audience section, launch priority, signup expectations, final CTA, FAQ.
- Current page tests assert the hero heading, form targets, fee-lock copy, buyer-total proof, default priority, consent behavior, and Discord link behavior in `bounded-contexts/public-presence/features/waitlist/ui/public-pages.test.tsx`.
- Current SEO metadata includes title, description, OG site/title/description/type/image, and Twitter card in `bounded-contexts/public-presence/routes/marketplace/home.tsx`.
- Public-web canonical, noindex, sitemap, and robots are already covered in `deployables/public-web/app/root.tsx`, `deployables/public-web/app/routes/sitemap.ts`, `deployables/public-web/app/routes/robots.ts`, and `deployables/public-web/app/routes/public-web.test.tsx`.
- Marketing image components do not expose image loading attributes; `MarketingImageHero` renders a plain `<img>` in `packages/design-system/src/patterns/app-shells.tsx`.
- Page assets are: hero WebP `133796` bytes, workflow panels WebP `90716` bytes, sample card PNG `637704` bytes.
- No local analytics provider or client event-tracking hook was found in the inspected public-presence/public-web/design-system surfaces.

## Open Questions

None blocking.

## Implementation Checklist

- [x] Resolve primary hero positioning and CTA strategy.
- [x] Rewrite hero headline/subheadline and meta description around the seller-first audience strategy.
- [x] Reorder sections so seller fee math, beta fee-lock clarity, and no separate seller processing fee appear before broader buyer proof.
- [x] Add above-the-fold reassurance that Chase Sets is prelaunch, joining does not require buying/listing/payment, and public policies/support remain visible.
- [x] Keep the hero form embedded and add seller-first proof/reassurance inside or adjacent to it.
- [x] Reduce duplicate buyer/seller sections and tighten the narrative arc.
- [x] Add a credibility/trust module using only repo-verifiable facts currently available in Public Presence.
- [x] Add schema metadata, likely JSON-LD in the public-presence home route.
- [x] Add provider-neutral analytics event instrumentation and tests.
- [x] Preserve UTM/referrer capture and waitlist domain invariants.
- [x] Add or extend tests for hero copy, trust/reassurance, schema metadata, CTA/form behavior, analytics hooks, and image-loading attributes.
- [x] Add design-system image-loading props only where reusable marketing image components need them.
- [x] Optimize the sample card asset or replace it with a lighter format, then verify build output.
- [x] Verify public-web typecheck, public-presence tests, public-web route tests, public-web build, and local browser desktop/mobile rendering.

## Documentation To Promote

- [x] Durable positioning decision recorded in `bounded-contexts/public-presence/docs/landing-page-positioning.md`.
- [x] Public Presence analytics event convention recorded in `bounded-contexts/public-presence/docs/landing-page-analytics.md`.
- [x] Design-system image-loading props covered by component tests rather than page-specific design-system docs.

## Goal Completion Criteria

- PR submitted for the completed implementation or scoped non-product change.
- CI passing on the PR before merge.
- PR merged after required review and passing checks.
- Staging deployment verified green after merge.
- Production deployment verified green after promotion or rollout.
