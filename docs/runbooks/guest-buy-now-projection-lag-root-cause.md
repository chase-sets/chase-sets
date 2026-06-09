# Guest Buy Now Projection Lag Root Cause

## Summary

A signed-out buyer used Buy Now on staging, submitted guest checkout contact details, and was redirected to the Checkout-owned session page. The page initially rendered permanent checkout-session-not-found recovery, then the checkout appeared later without a new purchase attempt.

The incident classification is `Checkout session projection lag escaped as permanent not-found recovery`. The Checkout Session write succeeded, but the first route load read `checkout_session_pages` before `checkout.session-projection` had made the new session visible. At the time of the incident, the platform did not yet have the complete exact-dependency freshness gate, transient checkout recovery policy, and redacted freshness audit instrumentation that now exist in this milestone.

The user-facing contract failure was not that a guest cared whether a checkout session resource existed. The failure was that a successful Buy Now action did not keep the buyer on a pay-ready or safely temporary checkout path.

## Evidence

- Checkout owns the guest Buy Now start-to-detail handoff. The critical route inventory names `checkout.session-start-to-detail` as a critical read-after-write path from `checkout-start` to `checkout-session`, backed by `checkout_session_pages`.
- Guest checkout submit creates guest checkout state, creates a Checkout Session, sets the `chase_sets_guest_checkout` cookie, and uses a document redirect to `/checkout/:sessionId` with an `afterWrite` receipt.
- The Checkout Session loader calls `loadFreshlyWrittenResource` and reads the session through the Checkout request client. The request client forwards browser cookies, the `afterWrite` receipt as `Chase-Sets-Read-After-Write`, and `Chase-Sets-Read-Target-Context: checkout`.
- The API route declaration for Checkout `/account/checkout-sessions/:sessionId` depends on `checkout_session_pages`, which is owned by `checkout.session-projection`.
- `checkout_session_pages` has `session_id` as its primary key, and the loader query reads by `session_id` plus `buyer_account_id`; the immediate lookup is not a broad list scan.
- The checkout appeared later for the same buyer flow, which rules out a permanently missing aggregate, permanently invalid session id, completed payment handoff, or permanent guest-auth failure as the primary cause.

The strongest available classification is therefore projection lag between the committed Checkout event and the `checkout.session-projection` read model. Because the original request happened before #1067 was deployed, the exact lag duration, checkpoint position, and worker state for that request were not captured in a redacted audit record.

## Ruled Out Or Less Likely

| Candidate | Finding |
| --- | --- |
| Missing Checkout Session write | Ruled out by the later successful appearance of checkout. |
| Payment already started | Ruled out by the original recovery copy and lack of payment handoff state; the customer had not reached payment. |
| Guest token permanently missing or expired | Less likely because the same flow later loaded checkout; current route/client code also uses a document redirect when setting the guest cookie. |
| Missing `afterWrite` redirect token | Less likely for the current code because both signed-in and guest checkout creation append the token before redirect. Historical confirmation requires the new audit record. |
| Missing target-context forwarding | Less likely for the current code because the Checkout request client sets `readTargetContextName: "checkout"`. Historical confirmation requires the new audit record. |
| Over-broad context wait | Less likely for the current contract because the route now declares an exact `checkout_session_pages` dependency. |
| Slow `checkout_session_pages` lookup | Less likely because the lookup uses the primary key and buyer-account filter. |

## Failed Contract

The failed platform contract was:

1. A write response that creates a projection-backed resource must carry source-aware commit receipt metadata.
2. The browser handoff must carry that metadata as a short-lived `afterWrite` token.
3. The destination route must forward the receipt and target read context to the API.
4. The API must wait for only the exact required projection groups.
5. While the original receipt is fresh, the browser route must render temporary recovery for `404` or `projection_freshness_timeout`, not permanent not-found copy.

The incident showed the customer-visible consequence of violating item 5 and lacking complete proof for items 1 through 4. The platform now has exact route dependency metadata, hardened forwarding helpers, transient recovery classification, and freshness audit records; the remaining milestone work must prove these guarantees through SLOs, topology review, tests, and canaries.

## Audit Evidence For Future Reproduction

For `/api/marketplace/account/checkout-sessions/:sessionId`, use `type=read-after-write.freshness` with route template `/account/checkout-sessions/:sessionId`.

Expected records:

- `outcome=missing-receipt` means the route reached the API without a usable receipt. Investigate redirect token creation or server-side forwarding.
- `readTargetContextHeaderPresent=false` means the Checkout route client did not forward the target context on the shared `/api/marketplace` mount.
- `waitMode=target-context` means exact route dependency matching failed and the read may be waiting on unrelated projections.
- `outcome=timeout` with `projectionName=checkout.session-projection` and `sourceContextName=checkout` means the Checkout session projection did not catch up inside the bounded timeout.
- `outcome=fresh` followed by permanent not-found means the API gate completed and the defect is in the route loader, authorization, or read-model row contents.

Audit summaries must stay route-template based. Do not attach raw `afterWrite` tokens, cookies, checkout session ids, guest tokens, contact names, email addresses, account ids, user ids, tenant ids, event ids, or full request URLs to GitHub issues or runbooks.

## Follow-Up Mapping

- #1078 must define critical Checkout session freshness targets and a zero-tolerance rule for permanent not-found recovery while the `afterWrite` receipt is fresh.
- #1082 must determine whether worker topology, replica count, projection concurrency, restart behavior, or deploy skew can make `checkout.session-projection` miss the critical freshness target.
- #1074 must reproduce the start-to-detail path with guest cookie handoff, `afterWrite`, exact API middleware, projection lag, temporary recovery, retry, and eventual checkout readiness.
- #1086 must add a staging symptom-level canary that fails on permanent checkout-session-not-found during a fresh guest Buy Now flow and records redacted latency/finality evidence.
- #1075 must turn the audit record into operational metrics, alerts, and a triage path that can classify missing receipt, missing target context, exact-dependency mismatch, projection timeout, and post-fresh route fallback.

## Closure Notes

This report intentionally does not claim measured lag for the historical request. That measurement was unavailable before #1067. Milestone closure requires the synthetic canary and E2E coverage to reproduce or continuously rule out this same failure mode with the new audit fields.

The shared thresholds and rollout gate definitions live in [Projection Freshness SLOs](../architecture/projection-freshness-slos.md).
