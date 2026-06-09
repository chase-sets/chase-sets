# Guest Buy Now Freshness Canary

This runbook owns the staging synthetic canary for the guest Buy Now projection freshness contract. It is the symptom-level guard for the checkout failure where a signed-out shopper reached `/checkout/:sessionId` before `checkout_session_pages` caught up and saw permanent checkout-session-not-found recovery.

## Gate

The staging deployment workflow runs:

```powershell
pnpm run guest-buy-now:freshness-canary -- --environment staging --base-url https://marketplace.staging.chasesets.com --search-query charizard --fixture-key <fixture-key>
```

The workflow discovers the first active buyable item from `/api/marketplace/items?q=<query>&includeTotal=true`. The search query defaults to `STAGING_GUEST_BUY_NOW_CANARY_SEARCH_QUERY`, then `MARKETPLACE_E2E_SEARCH_QUERY`, then `charizard`. `STAGING_GUEST_BUY_NOW_CANARY_ITEM_PATH` is an optional override for a known item detail route. The fixture key defaults to `staging-guest-buy-now-fixture` but should be set to a stable operator-owned identifier when staging representative commerce state is refreshed.

## States

The canary uses the shared Checkout state model:

| State | Gate result | Meaning |
| --- | --- | --- |
| `pass` | Promote | Checkout review reached a payable state with `afterWrite` and guest cookie handoff intact. |
| `temporary` | Promote | Fresh receipt is valid and the customer sees preparing-checkout recovery, not permanent not-found. |
| `fail` | Abort | Permanent checkout-session-not-found appeared, the fresh receipt/cookie handoff was lost, or checkout review could not be detected. |

## Redacted Evidence

The script writes `artifacts/release-health/guest-buy-now-freshness-canary.json` with:

- schema version;
- checked timestamp;
- environment;
- fixture key;
- diagnostic correlation id;
- final state;
- promotion decision;
- failure reason when present;
- write-submit-to-final-state latency;
- wait mode when visible;
- booleans for `afterWrite`, guest cookie, permanent not-found, temporary recovery, and checkout review visibility.

The evidence must not contain guest email, contact name, guest token, cookie value, raw `afterWrite`, checkout session id, account/user ids, event ids, or full URLs.

## Fixture Ownership

- Operations owns the staging fixture search contract through `STAGING_GUEST_BUY_NOW_CANARY_SEARCH_QUERY`, with `STAGING_GUEST_BUY_NOW_CANARY_ITEM_PATH` available only for deliberate path pinning.
- The resolved fixture must be an item detail route with Buy Now available to signed-out shoppers.
- Representative commerce state refreshes must preserve at least one active buyable item for the canary search query or intentionally update the query and fixture key together.
- If discovery or the pinned fixture is unavailable, the canary fails closed. Fix representative marketplace state or update the query/path variable before promoting.

## Guest Data And Side Effects

- The workflow uses `guest-buy-now-canary+<run>-<attempt>@chasesets.test`.
- Guest checkout token/session cleanup is TTL-based unless an environment cleanup hook exists.
- The canary stops at checkout review or temporary preparing-checkout recovery.
- The canary must never click checkout confirmation, create payment intents, create orders, reserve inventory beyond normal checkout preview semantics, or trigger customer-visible fulfillment work.

## Production Decision

A production browser variant is not feasible for this milestone. Even without moving money, it creates persistent guest checkout artifacts and requires a production cleanup contract that does not exist yet. Production remains limited to synthetic/operator-safe endpoint canaries; staging remains the mandatory symptom-level gate for guest Buy Now freshness.

## Failure Triage

1. Inspect the canary evidence final state and failure reason.
2. If `missing-after-write` or `missing-guest-cookie`, check Checkout guest start and document redirect behavior.
3. If `permanent-checkout-session-not-found`, check API freshness middleware, `checkout.session-projection`, worker lag, and the Checkout temporary recovery path.
4. If fixture discovery reports no active buyable item, refresh representative commerce state or update `STAGING_GUEST_BUY_NOW_CANARY_SEARCH_QUERY`.
5. If `checkout-review-state-not-detected`, confirm the resolved fixture still exposes Buy Now and reaches checkout review copy.
6. Correlate the diagnostic id with read-after-write freshness audit records and projection operations.
