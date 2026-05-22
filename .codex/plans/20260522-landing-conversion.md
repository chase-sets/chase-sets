# Landing Conversion Remediation

## Context

- Date: 2026-05-22
- Worktree: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\20260522-landing-conversion`
- Branch: `codex/landing-conversion`
- Base: `origin/main` at `816e90be Fix passkey registration identity flow`
- Sandbox id: `2b58aaa7`
- Sandbox public web URL: `http://localhost:8354`
- Dependencies: `pnpm run deps:install` completed with the shared worktree store.
- Sandbox doctor: `pnpm run sandbox:doctor` completed and assigned ports.

## Owning Contexts

- Public Presence owns landing-page positioning, waitlist copy, waitlist UI, public-page SEO intent, and public waitlist analytics taxonomy.
- Public web owns the Remix composition root, analytics bridge script, and operational route that receives browser analytics events.
- Identity owns durable account badge concepts and the existing `founding-account-badge.svg` asset. Public Presence can talk about the Founding Account badge, but should not import Identity feature internals directly.

## User-Supplied Product Truth

- Early signups should know they get a Founding Account badge.
- Early signups should know they get access to a special founders circle on Discord to help pave the way for the platform.

## Decisions

- Use the existing ubiquitous term `Founding Account badge` for the account marker already present in Identity copy.
- Use `founders circle on Discord` as the community access phrase in Public Presence copy.
- Do not invent testimonials, waitlist counts, live transaction volume, partnerships, or launch dates.
- Keep sample marketplace UI clearly labeled as sample/preview content, not market proof.
- Add a compact intent selector in the hero signup panel so first-time visitors can immediately choose seller, buyer, or both intent before joining.
- Fix the waitlist email consent field so the form posts a stable native value with and without client JavaScript.
- Preserve reduced-motion preference when scrolling from audience-path actions to the signup form.
- Forward only bounded landing source fields for operational analytics: `page_path`, `utm_source`, `utm_medium`, and `utm_campaign`. Continue to avoid raw referrer, full URL, email, `utm_content`, and `utm_term` in operational labels/logs.

## Implementation Checklist

- [x] Update Public Presence copy for the Founding Account badge and Discord founders circle.
- [x] Add hero intent selection to `WaitlistSignupPanel` using design-system controls.
- [x] Repair native consent submission in the waitlist form and server action handling.
- [x] Label preview proof/sample content more clearly.
- [x] Add reduced-motion-aware scroll behavior for audience-path CTA interactions.
- [x] Update public-web analytics bridge and route schema to retain bounded page/UTM source fields.
- [x] Update positioning and analytics docs to match the shipped behavior.
- [x] Add or update focused tests for copy, hero intent selection, consent submission, and analytics field filtering.
- [x] Run relevant typecheck, unit tests, localization checks, and build.
- [x] Run the app locally and inspect the page in-browser.

## Verification

- `pnpm --filter @chase-sets/public-presence run test`
- `pnpm --filter @chase-sets/public-presence run typecheck`
- `pnpm --filter @chase-sets/app-public-web run test`
- `pnpm --filter @chase-sets/app-public-web run typecheck`
- `pnpm --filter @chase-sets/app-public-web run build`
- `pnpm --filter @chase-sets/design-system run typecheck`
- `pnpm --filter @chase-sets/design-system run test`
- `pnpm run check:localization`
- `git diff --check`
- Browser inspection through local public-web dev server at `http://localhost:8399` with desktop and mobile Playwright passes. Confirmed first-screen Founding Account/founders circle copy, hero intent tabs, native consent value, and removal of fake rating/account proof. The first desktop click was intentionally retried after full hydration because the first pass clicked before client JavaScript was ready.

## Completion Criteria

- Product/runtime changes are isolated to Public Presence, public-web composition, or explicit shared design-system support if required.
- The plan is committed alongside the code changes.
- Verification commands pass or any failures are documented with exact cause.
- A pull request is opened from `codex/landing-conversion`.
- CI status is checked and failing checks are addressed or documented.
- Deployment readiness is stated with any known follow-up.
- Local cleanup is completed after merge/deployment if applicable.
