# Post-M43 Checkout Consistency Baseline

Last reviewed: 2026-06-22 against `origin/main` at `25193838`.

This note is the baseline for milestone #45, Post-M43 Checkout Consistency Follow-ups. It ties the current route inventory to the four follow-up issues:

- #2161: post-write handoff receipts
- #2162: projection-lag recovery surfaces
- #2163: cross-context fresh-write fallback policy
- #2164: checkout readiness and source contracts

The generated inventory remains `artifacts/read-after-write-route-inventory.md`; regenerate it with `pnpm run check:structure` and do not edit it by hand. This note records the human decisions and sequencing that the generated report does not own.

## Current Evidence

`pnpm run check:structure` passes on this baseline. The generated read-after-write inventory covers the Post-M43 helper surfaces without structure violations. The only structure warnings at this review were unrelated Catalog single-slice support warnings.

Current `origin/main` already has these milestone-relevant contracts:

- `contracts/http/responses.ts` owns portable `afterWrite` receipts, `postWriteHandoff` metadata, transient fresh-write error classification, and semantic handoff evaluation.
- Checkout `context.json` declares exact freshness for Buy Cart, guest Buy Cart, Sell List, guest Sell List, Sell List confirmations, and checkout session pages.
- Discovery `context.json` declares item-detail publication freshness and Checkout-owned cart/Sell List handoff carrier exceptions.
- Marketplace `context.json` declares listing, submitted-offer, offer-match, and review detail fresh-read routes.
- Ordering `context.json` declares order and postage-policy fresh-read routes. Ordering is not the readiness owner for cart/list entry; it is the downstream owner of committed Order facts.

This review opened two fixed-scope follow-ups in milestone #45:

- #2250: inventory and harden the Discovery selected seller listing fallback.
- #2251: represent the Commercial Terms account-source fallback in the cross-context fallback policy.

## Cross-Issue Decisions

### Handoff Receipts

Keep `PostWriteHandoff` portable and intentionally small: `kind`, `expectation`, and optional `surface`. Do not add account ids, resource ids, event ids, or actor data to browser query metadata.

For #2161, the missing standardization layer should be a route/source declaration around the existing helpers, not a wider URL payload. Actor ownership, source context, destination read dependency, and freshness expectation belong in route inventory, server-side helper declarations, tests, and docs.

### Recovery States

For #2162, standardize route recovery by behavior, not by infrastructure error string:

| Recovery state | Meaning | Current examples |
| --- | --- | --- |
| `preparing` | The destination resource should exist, but the projection or route read is still catching up. | Checkout session preparing, listing detail preparing, submitted-offer detail preparing. |
| `refreshable-catching-up` | A collection/list route has a valid fresh-write receipt or semantic handoff but cannot yet show the expected collection member. | Buy Cart and Sell List add-line recovery. |
| `stale-but-usable` | The route can show previous safe data while a selected fresh write catches up. | Discovery item detail with selected seller listing fallback. |
| `action-required` | The data is current enough to know the user must change something before continuing. | Cart readiness changed, Sell List readiness required/stale/blocked. |
| `terminal-failure` | The route has a permanent business or access failure and must not keep retrying. | Unavailable supply, invalid offer, missing seller readiness, unauthorized access. |

Temporary recovery must terminate on token expiry, bounded retry budget exhaustion, or a permanent domain/API failure.

### Cross-Context Fallbacks

For #2163, cross-context fallback is allowed only when it is explicit and removable. Every fallback must declare:

- category: host-owned bridge, same-actor post-write recovery, synchronous projection, or forbidden shortcut;
- actor and ownership guard;
- catalog/source guard;
- freshness scope and the projection being waited on;
- termination rule proving the fallback does not become the default read path after projections catch up.

The fallback policy should be documented before adding more fallback behavior. Existing M43 fallbacks should be audited into that policy instead of copied as route-local precedent.

Current fallback gaps:

- Discovery selected seller listing fallback is behaviorally guarded and tested, but its manifest/policy metadata does not describe the full chain: fresh Discovery read, stale no-token Discovery read, Marketplace source read, and Marketplace no-token retry. #2250 owns hardening that route-specific contract.
- Discovery ship-from setup carries an Inventory receipt through item detail and reads Inventory storage locations. That is a cross-context destination-owned post-write read, not a generic `not-post-write-read` case; #2163 should name this category.
- Commercial Terms uses an Identity account-source fallback when its account projection has not caught up. That server-side fallback is tested but not represented in the policy inventory; #2251 owns that specific follow-up.

### Checkout Source Readiness

For #2164, Checkout is the owner of pre-commitment source readiness. Marketplace owns Listing and Offer lifecycle facts; Ordering owns committed Order facts and purchase/sale projections.

One naming mismatch must be made explicit: Checkout session sources use `cart`, `buy-now`, and `offer-intent`, while Ordering order sources use `cart-checkout`, `buy-now`, and `offer-acceptance`. `offer-intent` must never map directly to an Ordering source; Checkout submits a Marketplace Offer, and Ordering later sees `offer-acceptance` only after Marketplace accepts that offer.

Canonical source types should be documented and tested as:

| Source type | Checkout entry owner | Required readiness before continuing |
| --- | --- | --- |
| Locked listing buy-now | Checkout route over Marketplace listing facts | Listing id, product identity, selected listing still available, actor allowed, fresh receipt when coming from a post-write route. |
| Product-level cart line | Checkout Buy Cart | `checkout.cart-readiness.v1` snapshot with source revision, included line ids, no unresolved included line. |
| Offer intent | Checkout session source intent | Product identity, offer amount, quantity, account/guest continuation state, Marketplace offer submission handoff after confirmation. |
| Accepted offer | Marketplace Offer Acceptance into Ordering | Marketplace accepted-offer fact and Ordering commitment path; not a cart/list readiness source. |
| Sell List selected-offer line | Checkout Sell List | `checkout.sell-list-readiness.v1` snapshot with selected-offer action and Marketplace offer snapshot checks. |
| Sell List product line | Checkout Sell List | `checkout.sell-list-readiness.v1` snapshot with Smart Match or fallback-listing action, inventory/listing evidence, and no hidden client-manufactured facts. |

Session creation and route review must fail closed before side effects when these contracts are missing, stale, blocked, or unresolved.

The source/readiness contract should include a named mapping helper for Checkout-to-Ordering order source expectations so this relationship is tested instead of repeated as inline conditionals.

## Baseline Flow Matrix

| Flow | Source/write owner | Destination/read owner | Current consistency contract | Remaining milestone pressure |
| --- | --- | --- | --- | --- |
| Item detail add listing to Buy Cart, signed-in or guest | Discovery carries Checkout command receipt | Checkout Buy Cart or guest Buy Cart | `checkout.cart.add-line` semantic handoff plus exact cart-line projection freshness. | #2161 should make this declaration reusable; #2162 should normalize pending cart recovery. |
| Item detail add product/listing/offer to Sell List, signed-in or guest | Discovery carries Checkout command receipt | Checkout Sell List or guest Sell List | `checkout.sell-list.add-line` semantic handoff plus exact sell-list projection freshness. | #2161 and #2162 should make this parallel to Buy Cart without route-local drift. |
| Marketplace Offer Match add to Sell List | Marketplace source list posts selected offer to Checkout | Checkout Sell List | Marketplace classifies the form as a Checkout fresh-read handoff; Checkout owns Sell List receipt and recovery. | #2161 should document source-list carrier responsibility; #2164 should ensure selected-offer readiness agrees with Sell List checkout. |
| Buy Cart checkout | Checkout Cart readiness command | Checkout session page | `checkout.cart-readiness.v1`, fresh checkout-session receipt, exact session-page freshness, checkout preparing recovery. | #2164 should compare cart page readiness and session creation decisions. |
| Buy-now locked listing | Discovery item detail into Checkout session | Checkout session page | Buy-now source reaches checkout start/session with listing and selected product fields; session page uses fresh-read recovery. | #2164 should make locked-listing minimum fields and fail-closed behavior canonical. |
| Product-level best match | Checkout Buy Cart | Checkout session page and Ordering preview/confirmation | Product line must become cart readiness-selected fulfillment before checkout starts. | #2164 should keep product-level best match cart-based, not direct session creation. |
| Offer intent | Checkout offer-intent session | Marketplace submitted-offer detail after confirmation | Checkout preserves session receipt and Marketplace owns submitted-offer fresh-read recovery. | #2161 should clarify cross-context handoff receipts; #2162 should avoid generic 503 shells. |
| Listing create/publish/update | Marketplace, sometimes launched from Discovery item detail | Marketplace listing detail and Discovery item detail | Marketplace listing detail uses fresh-read recovery; Discovery item detail forwards Marketplace receipts for public listing projection catch-up. | #2163 should classify Discovery fallback and guard requirements. |
| Submitted offer / accepted offer detail | Marketplace | Marketplace offer pages; Ordering after accepted commitment | Submitted and accepted offer detail routes use Marketplace offer-page freshness and preparing recovery. | #2162 should normalize detail recovery states; #2164 should keep accepted-offer order commitment out of Sell List readiness semantics. |
| Sell List checkout start | Checkout Sell List readiness | Sell checkout session route | `checkout.sell-list-readiness.v1` is revalidated before review; missing/stale/blocked readiness fails closed. | #2164 should define selected-offer, Smart Match, and fallback-listing line contracts. |
| Sell checkout confirmation | Checkout Sell List confirmation command | Checkout Sell List confirmation page | Confirmation detail uses exact confirmation-page freshness and permanent fallback to Sell List recovery. | #2162 should align confirmation preparing/terminal states with the shared model. |
| Ship-from setup during listing creation | Inventory storage-location write carried by Discovery | Inventory storage-location read in item detail route support | Discovery carries Inventory receipt and treats fresh storage-location lag as temporary. | #2163 should classify this as cross-context same-actor recovery or document an exception. |
| Commercial Terms account source resolution | Commercial Terms resolver | Commercial Terms account terms projection, with Identity account source fallback | Server-side fallback uses Identity account source when `commercial_terms_account_pages` has not caught up. | #2251 should make the server-side fallback policy and termination rule explicit. |

## Implementation Sequence

1. **#2161 route/source declarations.** Add a small typed declaration layer around existing handoff helpers and route inventory entries. Migrate Buy Cart, Sell List, and item-detail create/listing handoffs to use the declarations or document why they differ.
2. **#2162 recovery model.** Introduce a shared recovery-state vocabulary and route helper adapters. Start with account cart, account Sell List, checkout session/start, Marketplace listing/offer detail, and item-detail selected-listing recovery.
3. **#2163 fallback policy.** Document fallback categories and require guard metadata. Audit Discovery selected seller listing fallback, Inventory storage-location freshness, and Commercial Terms/Identity fresh-account fallback. Use #2250 and #2251 for the route-specific hardening found by this baseline review.
4. **#2164 source readiness contracts.** Define canonical source contracts and regression matrix first, including the Checkout `cart` to Ordering `cart-checkout` mapping and the rule that `offer-intent` reaches Ordering only later as Marketplace `offer-acceptance`. Then centralize enough readiness evaluation that cart/list pages and session creation cannot disagree.
5. **Milestone closure pass.** Run scoped tests, `pnpm run test:scripts`, and `pnpm run check:structure`. Add new fixed-scope issues to milestone #45 for any newly discovered problem that is not a direct acceptance criterion of #2161-#2164.

## New-Issue Rule

Do not broaden #2161-#2164 in comments. If implementation finds a concrete defect, create a new issue in milestone #45 when the defect has its own owner, acceptance criteria, or staging evidence. Examples:

- a specific route still renders a root error for fresh projection lag;
- a readiness disagreement between page review and session creation has a failing regression test;
- a cross-context fallback lacks an actor/source guard and cannot be fixed inside the fallback policy PR;
- a manual staging flow regresses after the standardization changes.

Issues created from this baseline review:

- #2250 for Discovery selected seller listing fallback metadata and guard hardening.
- #2251 for Commercial Terms account-source fallback policy representation.
