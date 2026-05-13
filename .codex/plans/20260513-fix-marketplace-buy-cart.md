# Fix Marketplace Buy And Cart Actions

## Intent

Staging reports that signed-in buyer `demo@chasesets.com` sees all buyer purchase actions fail: Buy optimized and Buy locked to this seller render the Marketplace error page, while Add to cart only shows an added state and does not produce useful cart behavior. The fix should restore buyer purchase intent without moving cart/session ownership out of Checkout.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets-20260513-fix-marketplace-buy-cart`
- Branch: `codex/fix-marketplace-buy-cart`
- Base: rebased onto local `origin/main` at `9e0a0da8fcc4c547f788e755ee86d1d82f35fe65`.
- Sandbox id: `b3c77d75`
- Sandbox services: Marketplace `http://localhost:8453`, Platform API `http://localhost:8462`
- Dependency setup: `pnpm run deps:install` completed; warning remains that local Node is `v26.1.0` while the repo wants Node `24.x`.
- Sandbox setup: `pnpm run sandbox:doctor` completed.

## Owning Contexts

- Discovery owns the item detail and public listing buyer-facing surfaces where these buttons are presented.
- Checkout owns Cart, Checkout Session, cart APIs, buy-now session creation, and `/checkout/start` orchestration.
- Marketplace owns Listing and Offer facts only; it should not own cart mutation or checkout session creation.

## Resolved Decisions

- Keep Add to cart and Buy now behavior routed through Checkout-owned client/API contracts.
- Treat Discovery as the presentation and form/action owner for item detail purchase intent.
- Treat Marketplace listing availability as an input to Discovery/Checkout behavior, not as the owner of checkout orchestration.
- Treat buyer cart and checkout-session start as signed-in account behavior, not seller/order-management permission behavior. A signed-in account without `orders.manage` must not be downgraded into an anonymous cart.

## Open Questions

- None blocking yet; code should answer whether the staging error is caused by malformed form/query payloads, missing action routing, permission fallback, or API/projection mismatch.

## Implementation Checklist

- Inspect Discovery item-detail action and public-listing checkout links. Done.
- Inspect Checkout start route and cart/session API contracts. Done.
- Reproduce the failing path with focused route/action tests before changing behavior when practical. Baseline tests passed but did not cover signed-in actors without `orders.manage`. Done.
- Fix the smallest owning-context code path that restores signed-in buy-now and add-to-cart behavior. Done.
- Add or update focused tests covering signed-in buyer behavior without `orders.manage`, optimized buy-now, seller-locked buy-now, add-to-cart cart visibility, Ordering checkout preview/confirmation access, and preview fallback. Done.
- Run focused tests, then broader relevant package checks if the change touches shared behavior. Done.
- Start the local marketplace stack if needed and visually verify desktop/mobile buyer flows. Done with Platform API + Marketplace local stack.

## Verification

- `pnpm exec vitest run bounded-contexts/checkout/routes/checkout-routes.test.ts bounded-contexts/ordering/features/orders/api/route.test.ts bounded-contexts/checkout/features/sessions/api/route.test.ts bounded-contexts/checkout/features/cart/api/route.test.ts bounded-contexts/discovery/tests/item-detail-buy-now-action.test.ts deployables/marketplace/app/routes/layout.test.tsx` passed: 6 files, 59 tests.
- After the final rebase, affected package tests passed:
  - `pnpm --filter @chase-sets/checkout run test`: 8 files, 46 tests.
  - `pnpm --filter @chase-sets/ordering run test`: 10 passed, 1 skipped; 26 passed, 1 skipped.
  - `pnpm --filter @chase-sets/discovery run test`: 13 passed, 1 skipped; 62 passed, 3 skipped.
  - `pnpm --filter @chase-sets/app-marketplace-web run test`: 19 files, 80 tests.
- After the final rebase, `pnpm --filter @chase-sets/app-marketplace-web run typecheck` and `pnpm run check:structure` passed.
- Local visual check against `demo@chasesets.test` on `http://localhost:8453` confirmed:
  - Add product to cart updates the account cart and `/account/cart` shows the Twilight Masquerade Elite Trainer Box line.
  - Desktop Buy optimized reaches `/checkout/...` without Marketplace error.
  - Desktop Buy locked to this seller reaches `/checkout/...` without Marketplace error.
  - Mobile Buy optimized opens the buy sheet, reaches `/checkout/...`, and does not show Marketplace error.
- Full `marketplace-full` local stack can exhaust the small sandbox Postgres pool because the platform worker starts many runners; final visual verification used Platform API + Marketplace without the worker. Checkout now also degrades preview failures into an inline warning instead of the Marketplace error page.

## Documentation To Promote

- No durable docs expected yet. Promote a Checkout/Discovery note only if the fix uncovers a surprising cross-context contract.

## Goal Completion Criteria

- Implementation happens in this worktree and branch.
- Plan is retained with implementation for review.
- Durable docs are promoted only if the code investigation finds a lasting cross-context rule.
- Automated checks cover the restored behavior.
- Desktop and mobile visual checks confirm buttons no longer fail and cart reflects added lines.
- PR is submitted, CI passes, PR is merged, and staging deploy is verified against `demo@chasesets.com`.
