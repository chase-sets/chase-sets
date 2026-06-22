# Semantic Post-Write Handoff Audit

Last reviewed: 2026-06-18.

This audit is the migration inventory for semantic post-write handoffs. It classifies candidate Marketplace and Admin flows against the existing post-write consistency strategies first. Use semantic handoffs only when a successful command can be hidden by an immediate stale destination read, especially a normal-looking `200` empty collection, stale unchanged resource, or `404`.

## Migration Inventory

| Platform | Context | Source action | Destination and read model | Current strategy | Semantic handoff decision | Risk | Phase |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Marketplace | Discovery + Checkout | Item detail add-to-cart, then View cart | `/account/cart`, `checkout_cart_line_pages` | `fresh-read` source receipt plus command snapshot | Migrate with Checkout-owned `checkout.cart.add-line` handoff and `collection-non-empty` expectation. Empty read is pending only while `afterWrite` is fresh. | Critical | Phase 1 done |
| Marketplace | Checkout | Cart quantity and fulfillment self-refresh | `/account/cart`, `checkout_cart_line_pages` | `optimistic-with-correction` plus `fresh-read` redirect | Do not add semantic add recovery. Quantity and fulfillment are satisfied by returned/loader state; remove-to-empty must remain a normal empty cart. | Important | No semantic migration |
| Marketplace | Checkout | Cart remove | `/account/cart`, `checkout_cart_line_pages` | `fresh-read` redirect | Do not add semantic add recovery. Empty or absent rows are the intended satisfied state. | Important | No semantic migration |
| Marketplace | Checkout | Checkout session start/update/confirm | `/checkout/buy/session/:sessionId`, checkout session pages | `fresh-read` with bounded `404`/timeout recovery | Keep existing receipt recovery. Detail `404` is already handled by the fresh-write contract; add semantic metadata only if a future stale `200` shape can hide an accepted command. | Critical | Watch |
| Marketplace | Payments | Payment create/retry/detail | Account payment routes, payment read models | `fresh-read` and provider recovery | Keep existing payment recovery. Do not put payment ids or provider state in browser handoff metadata. | Critical | Watch |
| Marketplace | Discovery + Marketplace | Item detail listing publish or price/quantity update | `/items/:id`, Discovery item detail and market listing read models | `fresh-read` detail recovery with Marketplace command receipts | Migrate Discovery item-detail redirects with `marketplace.listing.publish` / `resource-present` and `marketplace.listing.update` / `resource-updated` handoffs for the selected item-detail surface. Keep Marketplace account listing routes on existing exact waits unless a separate stale `200` gap is proven there. | Critical | Phase 1 done |
| Marketplace | Marketplace | Offer submit, accept, and offer match flows | Submitted offer and account sales routes | `fresh-read` or command-owned snapshots | Keep current fresh-read handoffs where they already wait on exact projections. Add semantic handoff only for a list destination where stale empty would hide the accepted/submitted offer. | Important | Watch; no semantic migration now |
| Marketplace | Marketplace | Review submit | Review detail/account reputation read models | `fresh-read` | Keep existing `404` recovery. Do not show pending on missing review without a valid receipt. | Important | No semantic migration now |
| Marketplace | Inventory | Inventory item create/adjust/hold/release | Inventory item detail and marketplace supply projections | `fresh-read` for detail, snapshot/operation status for commands | Keep detail `404` recovery and job/status snapshots; use semantic handoff only if account listing/supply lists render stale empty after a successful publish/availability command. | Critical | Watch; no semantic migration now |
| Admin | Catalog | Provider import, promotion, bulk review, profile activation | Durable job/status rows, admin control-plane read models | Durable job/status, realtime correction, command feedback | Do not use browser semantic handoffs. Jobs need durable status resources and operator diagnostics, not short-lived browser metadata. | Important | No semantic migration |
| Admin | Identity/Auth | Admin account, user, API key, invitation, membership writes | Admin detail/list read models | `fresh-read` | Keep existing exact freshness and protected-resource behavior. Never mask `401` or `403` as pending. | Critical | No semantic migration now |
| Admin | Commercial Terms | Schedule/agreement create/update | Admin detail/list read models | `fresh-read` | Keep existing exact freshness. Add semantic `resource-updated` only if stale `200` detail proves misleading in practice. | Important | Watch |
| Admin | Ordering | Postage policy create/update | Admin detail/list read models | `fresh-read` | Keep existing exact freshness; remove/archive paths must treat absent state as satisfied when commanded. | Important | No semantic migration now |
| Admin | Platform Operations | Projection operations, support workflows, exports | Operation/job/status resources | Durable status and realtime correction | Do not use semantic browser handoffs. Operators need durable operation state and lag diagnostics. | Important | No semantic migration |

## Required Negative Classifications

- `200 empty` can be stale and needs semantic pending only for add/create commands where the destination can locally prove the expected collection member is not yet visible. The canonical Phase 1 example is item detail add-to-cart to Buy Cart.
- `404` can be stale for create-to-detail flows while the paired `afterWrite` receipt is fresh. Existing `loadFreshlyWrittenResource` recovery remains enough unless a stale `200` also needs semantic interpretation.
- Remove, delete, archive, cancel, and quantity-to-zero flows must not reuse add-style pending recovery. Empty, absent, or unchanged views can be the satisfied command result.
- Durable imports, provider jobs, projection operations, export jobs, and support workflows should expose durable job/status resources with polling, SSE, or snapshots. A semantic browser handoff would hide the operational state operators need.

## Marketplace Evidence

| Flow | Decision evidence |
| --- | --- |
| Add-to-cart to Buy Cart | `bounded-contexts/discovery/support/route-support/item-detail/action.ts` appends the Checkout-owned semantic add-line handoff to `viewCartHref`; `bounded-contexts/checkout/routes/account-cart.tsx` evaluates it and emits semantic post-write diagnostics. Tests: `bounded-contexts/discovery/tests/item-detail-buy-now-checkout.test.ts`, `bounded-contexts/checkout/routes/account-cart-route.test.ts`. |
| Cart quantity, preferred listing, remove | `bounded-contexts/checkout/features/cart/ui/optimistic-correction.ts` and `bounded-contexts/checkout/routes/account-cart.tsx` keep quantity as `optimistic-with-correction` plus fresh-read redirect. Tests cover rapid repeated clicks, stale loader data, rollback, absolute quantity submits, grouped remove, and remove-to-empty normal empty state. |
| Marketplace listings | `bounded-contexts/discovery/support/route-support/item-detail/action.ts` carries Marketplace listing publish/update receipts plus item-detail semantic handoffs back to the selected item-detail listing surface. `bounded-contexts/marketplace/routes/account-listing.tsx` and `account-listings.tsx` continue to use existing fresh-read redirects and exact Marketplace projection waits; stale detail `404` and projection freshness timeout are already temporary under `afterWrite`. Tests include item-detail listing redirect metadata, listing route recovery, and write consistency metadata coverage. |
| Marketplace offers and reviews | `bounded-contexts/marketplace/routes/account-offer-submitted.tsx`, `account-offer-match.tsx`, and `routes/marketplace/account-review.tsx` already route through fresh-read detail recovery or command-owned snapshots. Tests cover offer metadata forwarding and review fresh-read behavior. |
| Inventory and fulfillment | `bounded-contexts/inventory/routes/marketplace/account-inventory-item.tsx`, `bounded-contexts/fulfillment/routes/marketplace/account-sale-shipment.tsx`, and `account-sale-shipment-packing.tsx` use fresh-read detail recovery or command/job snapshots. Packing line edits remain optimistic correction. |

## Admin And Operator Evidence

| Flow | Decision evidence |
| --- | --- |
| Auth session detail | `bounded-contexts/auth/routes/access-admin/sessions-detail.tsx` uses fresh-read command receipts. Test: `bounded-contexts/auth/routes/access-admin/sessions-detail.test.ts`. |
| Identity admin accounts, users, API keys, invitations, memberships | `bounded-contexts/identity/routes/admin/*` use fresh-read redirects or command snapshots; tests live in `bounded-contexts/identity/tests/mutation-consistency-route-actions.test.ts` and `api-mutation-snapshots.test.ts`. |
| Commercial Terms schedules and agreements | `bounded-contexts/commercial-terms/routes/admin/*` use fresh-read list/detail recovery and command snapshots. Test: `bounded-contexts/commercial-terms/routes/admin/admin-routes.test.ts`. |
| Ordering postage policies | `bounded-contexts/ordering/routes/admin/postage-policies*.tsx` use fresh-read for create/list/detail and snapshots for preview. Test: `bounded-contexts/ordering/tests/postage-policy-routes.test.ts`. |
| Catalog Source Observations and integrations | Provider imports, bulk review, reapply/reject, promotion, and integration work stay durable job/status plus realtime correction. Tests include `bounded-contexts/catalog/features/source-observations/api/route-integration-jobs.test.ts`, `runtime-provider-integration-jobs.test.ts`, and `bounded-contexts/catalog/tests/admin-integrations-route.test.tsx`. |
| Platform Operations | Projection operations and wake status remain operator status/diagnostics resources. Tests: `deployables/admin-support-api/__tests__/app.test.ts` and `bounded-contexts/platform-operations/tests/mutation-consistency-route-actions.test.ts`. |

## Migration Rules

- Keep migrated surfaces in `mutationConsistencyInventory` as `fresh-read`; semantic handoff is not a separate strategy.
- Add `appendPostWriteHandoff` or `appendPostWriteHandoffFromSources` only from the command owner or a source that carries the command owner's commit metadata. Contexts may own semantic constants and satisfaction predicates, but production routes must use the shared helper rather than hand-built `postWriteHandoff` query metadata.
- Add `evaluatePostWriteHandoff`, `readPostWriteHandoff`, or `readPostWriteHandoffState` to `readAfterWriteRouteInventory` for destinations that consume the metadata.
- Record low-cardinality diagnostics with `strategy="fresh-read"`, `correction_source="semantic-handoff:<kind>"`, and outcomes such as `handoff_satisfied`, `handoff_pending`, `handoff_expired`, `handoff_invalid`, `handoff_malformed`, or `handoff_permanent`.
- Never put account ids, cart ids, listing ids, session ids, payment ids, order ids, emails, cookies, event ids, raw receipts, item details, provider payloads, or full URLs in the handoff or telemetry labels.
