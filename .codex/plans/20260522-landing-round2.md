# Landing Round 2 Conversion Backlog

## Intent

Address the second-round landing audit backlog for the public Chase Sets marketing page without expanding marketplace runtime scope. The work focuses on conversion clarity, founder access motivation, objection handling, analytics readiness, SEO depth, asset performance, and verification.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\20260522-landing-round2`
- Branch: `codex/landing-round2`
- Base: freshly fetched `origin/main`
- Sandbox id: `8a5b1991`
- Dependency setup status: `pnpm run sandbox:doctor` completed; any failed concurrent install was treated as a setup collision, not a product blocker.
- Pnpm store path: `.codex/worktrees/.chase-sets-pnpm-store`
- Setup blockers: none currently known.

## Owning Contexts

- Public Presence owns marketing positioning, waitlist UI, public policy pages, and public landing docs.
- Public Web owns the deployable route composition, SEO shell, client-to-server analytics bridge, and analytics route.
- Observability owns provider-neutral metric attributes used by Public Web.
- Design System owns shared font imports and primitives used by the public experience.

## Resolved Decisions

- Use "earliest qualified beta accounts" and "first invite waves" for founder access language because the codebase does not define a numeric cap.
- Do not import the Identity Founding Account SVG into Public Presence. Identity remains canonical for account badge assets; Public Presence should market the benefit using its own presentation and copy.
- Keep one seller-first landing page. Move audience self-selection closer to the top so buyers are not stranded, but preserve seller economics as the primary differentiator.
- Keep analytics provider-neutral. Public Presence emits bounded events, Public Web validates and records them, and Observability receives only bounded metric labels.
- UTM values may contain campaign text such as spaces and plus signs, but analytics labels must remain bounded and must reject email addresses or URLs.
- Keep sales-fee content prelaunch-safe. Explain intended beta economics and terms that must be published before live transactions without inventing unavailable fee schedules.
- The public-web Vite config already includes the React Router plugin on this base, so the prior local dev failure is treated as resolved upstream.

## Implementation Checklist

- [x] Improve founder access messaging in hero, launch priority, final CTA, and waitlist success copy.
- [x] Move audience path selection before deeper proof sections.
- [x] Add a mobile sticky waitlist CTA with analytics.
- [x] Keep objection handling visible before final conversion.
- [x] Expand the seller-fees page and metadata for SEO and buyer/seller clarity.
- [x] Broaden UTM sanitization while preserving strict label validation.
- [x] Include bounded target and field values in waitlist metrics; keep page path and UTM details in logs only.
- [x] Reduce IBM Plex Sans imports to Latin subsets.
- [x] Add and update tests for founder copy, section order, sticky CTA, seller-fee content, analytics sanitization, and metric attributes.
- [x] Update landing analytics documentation with the round-two funnel and experiment plan.
- [x] Verify the local public-web route at `http://127.0.0.1:8765/` and `/sales-fees`.

## Verification

- `pnpm --filter @chase-sets/public-presence run test`
- `pnpm --filter @chase-sets/app-public-web run test`
- `pnpm --filter @chase-sets/observability run test`
- `pnpm --filter @chase-sets/design-system run test`
- `pnpm --filter @chase-sets/public-presence run typecheck`
- `pnpm --filter @chase-sets/app-public-web run typecheck`
- `pnpm --filter @chase-sets/observability run typecheck`
- `pnpm --filter @chase-sets/design-system run typecheck`
- `pnpm --filter @chase-sets/app-public-web run build`
- `pnpm run check:localization`
- `pnpm run format:check`
- Rendered desktop/mobile inspection with Playwright against `pnpm --filter @chase-sets/app-public-web run dev --host 127.0.0.1 --port 8765`
- `pnpm run verify`

## Documentation To Promote

- `bounded-contexts/public-presence/docs/landing-page-analytics.md`
- `.codex/plans/20260522-landing-round2.md`

## Goal Completion Criteria

- PR submitted for the completed implementation.
- CI passing on the PR before merge.
- PR merged after required review and passing checks.
- Staging deployment verified green after merge.
- Production deployment verified green after promotion or rollout.
- Local container or sandbox created for this worktree deleted with scoped cleanup.
- Worktree deleted after the retained plan is committed and the PR is merged.
- Remote PR branch deleted after merge when one exists.
- Local branch deleted after the worktree is removed and the PR is merged.
