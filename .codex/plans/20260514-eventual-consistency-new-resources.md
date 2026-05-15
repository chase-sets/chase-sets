# Eventual Consistency For Newly Created Resources

## Intent

Make newly created resources feel reliable even when read models and route projections lag the write that created them. The solution should keep bounded contexts as owners of behavior and read models while giving deployable routes and API clients a small, reusable way to distinguish a genuinely missing resource from a freshly accepted command whose projection has not caught up yet.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets-20260514-eventual-consistency`
- Branch: `codex/eventual-consistency-new-resources`
- Base: created from source repo `HEAD` at `8cc4f1e6`, then rebased onto `origin/main` at `d85da0f8`
- Sandbox id: `1996a555`
- Dependency setup status: `pnpm run deps:install` succeeded
- Setup blockers: none identified

## Owning Contexts

- Platform runtime should own the cross-cutting consistency token mechanics because it already owns API mount composition, write-drain behavior, forwarded request fetches, realtime transport, and React Router helpers.
- Each bounded context should continue to own its resource routes, read-model lookups, copy, and any pending-resource UI shown for a context-owned noun.
- Marketplace is the first high-value implementation target because creating Listings and Submitted Offers currently redirects to read-model-backed detail routes.
- Checkout, Ordering, Payments, Reputation, Inventory, and Fulfillment have related create-to-detail flows that should use the same platform helper where they redirect immediately after command acceptance.

## Resolved Decisions

- Do not make write-side aggregate state the source for detail pages. Existing docs make read models and projections context-owned, and route loaders already consume those read models.
- Do not solve this by globally treating every `404` as retryable. Only routes carrying an explicit fresh-write consistency token should show pending behavior; ordinary missing resources stay ordinary not-found responses.
- Keep synchronous projector draining as a best-effort fast path. The platform API already supports `drainProjectorsOnWrite` and tests prove it drains when enabled, but deployments can disable it and cross-process worker lag can still happen.
- Reuse existing commit metadata. `contracts/event-core/consistency.ts` records committed event ids and max global position; `attachWriteConsistencyMiddleware` already exposes `Chase-Sets-Consistency`, `Chase-Sets-Commit-Position`, and compact committed event ids on non-GET responses.
- Scope the first implementation across every visible create-to-detail redirect found in the current marketplace web surface, using one shared platform pattern instead of only a Marketplace-only slice.
- Implement the first UX pass as quiet, bounded loader retries rather than a visible pending page. This avoids adding route UI states unless projection lag proves longer than the retry window in practice.

## Verification

- `pnpm run deps:install` succeeded.
- `pnpm run sandbox:doctor` succeeded with sandbox id `1996a555`.
- `pnpm --filter @chase-sets/app-marketplace-web run test -- account-listings.test.tsx account-listing.test.tsx account-payment-new.test.tsx account-inventory.test.tsx account-purchase-review.test.tsx account-sale-review.test.tsx` passed.
- `pnpm --filter @chase-sets/marketplace run test` passed.
- `pnpm run typecheck` passed after rerunning with a longer timeout.
- `pnpm run test:fast` passed.
- `pnpm run check:structure` passed.
- Visual verification was not applicable because the implementation adds no new rendered UI state.
- After rebasing onto `origin/main` at `40baa1b9`, `pnpm run sandbox:doctor`, focused marketplace route tests, `pnpm run typecheck`, `pnpm run test:fast`, and `pnpm run check:structure` passed again.
- After rebasing onto `origin/main` at `d85da0f8`, focused marketplace route tests, `pnpm run typecheck`, `pnpm run test:fast`, and `pnpm run check:structure` passed again.

## Repo Evidence

- `infrastructure/bounded-context-runtime/index.ts` wraps mounted API writes in `runWithEventCommitMetadata` and returns consistency headers after successful writes.
- `deployables/platform-api/src/app.ts` attaches write consistency and optional write-drain middleware before mounting context APIs.
- `deployables/platform-api/__tests__/app.test.ts` verifies write draining and the configuration switch that disables it.
- `docs/api/marketplace-api.md` says command endpoints return `{ id, version, status: "accepted" }`, but detail endpoints still document ordinary `404`.
- Marketplace `account-listings` action creates a listing, optionally publishes it, and redirects directly to `/account/listings/{id}`. The target `account-listing` loader catches API `404` and throws a permanent `404`.
- Marketplace submitted-offer, checkout confirmation, payment creation, review creation, and import-batch creation routes have similar create-to-detail redirects.

## Recommendation

Implement a small platform consistency contract:

1. API client parse helpers should preserve response metadata from command responses: committed position, event ids, and consistency mode.
2. Route actions that redirect to a read-model-backed detail page after a command should append a short query token such as `?afterWrite=<commitPosition>` when the API response includes commit metadata.
3. Detail loaders should use a shared HTTP helper when catching `404`: if the request carries a recent `afterWrite` token, retry the read on a short bounded backoff before throwing the context-owned not-found response.
4. Keep the first UX pass quiet instead of adding pending pages. Most consistency gaps should resolve inside the loader retry window; longer failures should remain visible as the context-owned not-found or error path so they can be investigated.
5. The query token is short-lived and harmless after its retry window expires. Token cleanup can be added later if URLs become noisy in practice.

This keeps the write model, projections, and UI ownership intact while making the consistency gap explicit and observable.

## Open Questions

None currently blocking.

## Implementation Checklist

- Add platform-runtime helpers for consistency metadata extraction from `Response` headers and redirect query-token construction.
- Add an HTTP loader helper that retries `404` reads on bounded backoff only when a fresh-write token is present.
- Update relevant context request clients to expose command response metadata without leaking Hono internals.
- Update selected create-to-detail actions to append the token.
- Update selected detail loaders to retry instead of immediately throwing permanent `404` during the bounded consistency window.
- Add focused tests for metadata capture, redirect token construction, loader fallback, token cleanup, and at least one create-to-detail route.
- Run `pnpm run deps:install` or `node ./scripts/worktree-deps.mjs install`, `pnpm run sandbox:doctor`, `pnpm run typecheck`, `pnpm run test:fast`, and `pnpm run check:structure`.

## Documentation To Promote

- Add or update `docs/api/marketplace-api.md` to document consistency headers and the client behavior for newly accepted resources.
- Consider `docs/architecture/eventual-consistency.md` if the implementation crosses multiple contexts in this pass.
- Add `docs/README.md` entry only if a new durable architecture doc is promoted.

## Goal Completion Criteria

- Implementation is completed in this worktree and branch.
- Durable docs are promoted to the owning doc location and retained with this plan.
- Automated checks pass: dependency setup, sandbox doctor, typecheck, fast tests, structure checks, and any changed package tests.
- Mobile and desktop visual verification covers at least one pending-resource page if UI changes are made.
- A PR is submitted, CI passes, the PR is merged, staging deploy succeeds, and the retained `.codex/plans/20260514-eventual-consistency-new-resources.md` remains committed.
