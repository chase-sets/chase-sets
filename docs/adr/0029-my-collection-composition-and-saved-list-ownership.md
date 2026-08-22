# ADR 0029: My Collection Composition And Saved List Ownership

## Status

Accepted. Decision #6150 closed completed after Todd approved its recommendations in [comment 5085487245](https://github.com/chase-sets/chase-sets/issues/6150#issuecomment-5085487245).

## Context

My Collection is the customer-facing path prefix and deep-module composition for account collection work. It is not a bounded context, aggregate, persistence owner, cross-context page component, or behavior owner. Collections owns Saved Lists, which express intent. Inventory owns account-held stock and acquisition cost. Pricing owns market-estimate facts. Marketplace's Seller Desk slice owns seller actions and seller information architecture.

That split makes a single cross-context page shell unsafe. It would either move behavior into the shell, import another context's React components, read another context's tables, or duplicate projections. Context-owned sibling routes instead let each context retain its behavior, authorization, read models, and persistence while presenting one coherent My Collection section through the shared design-system navigation pattern.

Adoption anchor (2026-08-21): fork-point base `4a373bdbd4f9e9e2a55ca3c635208e5ec22b1f87`. At this anchor, the Collections router mounts all of its routes after its actor-presence fence. The anonymous Saved List intent handler therefore exists but an actorless request receives `401` before reaching it, and its single shared local capture bucket is inert composition rather than durable authority. [#7191](https://github.com/chase-sets/chase-sets/issues/7191) owns the future split that may mount only that guest router before the fence and replace the local bucket with the required dual policy. Live ownership and surface inventory come from the bounded-context READMEs and manifests; live Collections route reachability also comes from `bounded-contexts/collections/api.ts` mount order.

## Decision

### Owner and surface matrix

Every behavior, truth, and presentation surface has one owner. My Collection is composition only and never becomes a second owner.

| Surface or truth | Sole owner | Durable boundary |
| --- | --- | --- |
| My Collection path-prefix and mount composition | Platform Runtime | Will mechanically mount only future context-owned sibling routes under `/account/collection`; the generated marketplace registry and deployable remain thin mount tables and own no page or domain behavior. |
| Lists, Saved Lists, Tracked Quantity, aggregate commands/events, owner and viewer contracts, and Inventory handoff snapshots | Collections | Collections owns domain truth and public contracts. A Saved List expresses intent and never represents owned stock. |
| Saved List Estimated Market Value and Estimate Coverage | Collections | Collections owns the projection and read surface, consumes Pricing facts, remains owner-account scoped, and stores no stock, acquisition-cost, profit-and-loss, or owned-stock history truth. |
| Product market-estimate facts and estimation method | Pricing | Pricing publishes estimates; consumers do not re-own the method or source fact. |
| Owned Cards, Inventory Item quantity and availability, acquisition cost, cost basis, owned-stock valuation/history, and stock read models | Inventory | The future collector-IA Owned Cards route is `/account/collection/owned-cards` and reuses the Inventory-owned `InventoryItemListPage`; it is not the seller-IA `/account/inventory` route. |
| Overview | Inventory | The future `/account/collection/overview` is an Inventory-owned summary and cannot ship until [#4317](https://github.com/chase-sets/chase-sets/issues/4317) supplies owned-stock valuation/history and the My Collection route foundation is live. Missing valuation is never rendered as zero, stale value, or a placeholder. |
| Current Inventory route behavior | Inventory | `/account/inventory` continues to expose Inventory behavior and uses Inventory authorization. This ADR does not retain, retire, or redirect it. |
| Seller actions and seller-IA route disposition | Marketplace (Seller Desk slice) | Seller work opens the existing Marketplace/Seller Desk modules contextually. `contracts/seller-desk/index.ts` remains the authority that absorbs `/account/inventory` into `/account/desk`; Collections does not orchestrate commerce. |
| Published cross-context facts and public contracts | Publishing bounded context | The publisher owns meaning and compatibility. Consumers use the contract or project the fact; they do not redefine it. |
| Consumer read models and projections | Consuming bounded context | Each consumer owns its local projection and queries. No context reads another context's tables directly. |
| Domain persistence | Truth-owning bounded context | Aggregates, schemas, event streams, and durable state remain with the context that owns the truth. |
| Browser route and UI behavior | Contributing bounded context | Each context owns its sibling route module and renders the canonical design-system section navigation. Cross-context React imports and page components are forbidden. |

The future Collections-owned Lists surfaces are `/account/collection` and `/account/collection/lists/:listId`; [#6152](https://github.com/chase-sets/chase-sets/issues/6152) owns those routes, the sole My Collection top-navigation entry, the `collection.view` and `collection.manage` grants with their exact role assignments, and the compatibility redirect for Discovery's existing deep link. Neither route nor grant is current at the adoption anchor.

Owned Cards stays parked until #6152 closes completed with its routes, navigation, and grants live; that completion un-parks a planning pass for a fixed-scope Inventory route slice under [#5010](https://github.com/chase-sets/chase-sets/issues/5010). Overview stays parked until both #6152 and #4317 close completed; only then may planning create its fixed-scope Inventory route slice. Tracking issue [#5018](https://github.com/chase-sets/chase-sets/issues/5018) owns neither implementation.

### Authorization and capability matrix

Authorization stays with the owning context and is separate from navigation, visibility, content disclosure, and copy eligibility.

| Permission key | Subject | Owner check | Actor fence | Wired/exported | Ports declared/bound | HTTP/UI reachability | Owner |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `none (actor-presence + ownerAccountId scope)` | `GET /api/collections/saved-lists` | Actor account becomes `ownerAccountId` | Collections actor fence | route=yes / public client=yes | n/a | HTTP mounted; UI state is not implied | Collections |
| `none (actor-presence + ownerAccountId scope)` | `GET /api/collections/saved-lists/:listId` | Actor account becomes `ownerAccountId` | Collections actor fence | route=yes / public client=yes | n/a | HTTP mounted; UI state is not implied | Collections |
| `accounts.view` | `GET /api/collections/saved-lists/:listId/valuation` | Actor account becomes `ownerAccountId` | Collections actor fence plus handler check | route=yes / public contract=yes | n/a | HTTP mounted; UI state is not implied | Collections |
| `accounts.view` | `GET /api/collections/account/lists/recent` | Actor account is the query owner | Collections actor fence plus handler check | route=yes / public contract=yes | n/a | HTTP mounted; Discovery's recent-list request uses its Discovery-owned endpoint | Collections |
| `accounts.view` | `POST /api/collections/account/list-additions` | Actor account becomes `ownerAccountId` | Collections actor fence plus handler check | route=yes / public client=yes | n/a | HTTP mounted and called by Discovery | Collections |
| `none (anonymous-owner header + capture rate limit)` | `POST /api/collections/guest/saved-list-intents` | `x-collections-anonymous-saved-list-id` | At adoption, incorrectly behind the actor fence; #7191 must put only this guest router ahead of it | route=yes / public client=yes | policy resolver declared; current limiter local; future owner and surface policies required | mounted=yes / guest-reachable=no at adoption; no direct UI route | Collections; #7191 owns reachability repair |
| `accounts.view` | `GET /api/collections/account/saved-list-intents/:id` | Actor account plus anonymous-owner header | Collections actor fence plus handler check | route=yes / public client=yes | n/a | HTTP mounted and called by Discovery claim preparation | Collections |
| `accounts.view` | `POST /api/collections/account/saved-list-intents/:id/claim` | Actor account plus anonymous-owner header | Collections actor fence plus handler check | route=yes / public client=yes | n/a | HTTP mounted and called by Discovery | Collections |
| Future `collection.view` reads and `collection.manage` mutations | Collections Lists routes | Saved List data remains owner-account scoped | Authenticated context route | future under #6152 | n/a | not current at adoption | Collections; #6152 owns routes and grants |
| `inventory.view` reads and `inventory.manage` mutations | Current `/account/inventory` and future Inventory-owned Owned Cards | Inventory account ownership | Authenticated Inventory route | current route=yes; Owned Cards=future | n/a | `/account/inventory` current; Owned Cards not current | Inventory |
| `accounts.view` | Future owner sharing commands | Saved List owner authorization | Authenticated Collections route | sharing runtime=yes / HTTP=future | exactly three live sharing ports must be bound by #6144 | not HTTP/UI reachable at adoption | Collections; [#6144](https://github.com/chase-sets/chase-sets/issues/6144) owns HTTP |
| `none` | Future anonymous public or unlisted shared read | Public visibility, or a revocable high-entropy secret verified server-side against its stored verifier | Explicit Collections public-router amendment | shared-access seam=yes/exported=yes | live sharing ports are currently unbound | not HTTP/UI reachable at adoption | Collections; #6144 owns HTTP and [#6145](https://github.com/chase-sets/chase-sets/issues/6145) owns the page |
| `none` | `savedListSharedAccess` and `copyCapability` | Owner/public/unlisted access decision; copy eligibility never grants edit | No mounted route at adoption | wired=yes / exported=yes | `savedListCapabilities`, `savedListSharingRateLimits`, `savedListSharingAudit`, `savedListAbuseReports`: declared=yes, bound=no | HTTP=no / UI=no | Collections |
| Not an RBAC key | `SavedListSharingDisclosure` | Owner-controlled content-disclosure decision only | Depends on an independently authorized read | wired=yes / exported=yes | n/a | No reachability by itself | Collections |

The two Saved List owner-query GETs deliberately require an authenticated actor and `ownerAccountId` scope without a permission key. This ADR ratifies that posture. The five other authenticated Saved List integration endpoints retain `accounts.view` and owner scoping. Future Lists presentation uses `collection.view` for reads and `collection.manage` for mutations as settled by #6152; those keys do not replace Saved List owner authorization. Inventory reads and mutations retain `inventory.view` and `inventory.manage` and never switch to a Collections key.

The future actorless capture contract under #7191 has no permission key. It must key the per-owner `collections.saved-list.anonymous-capture` policy by the anonymous-owner header and enforce a separate, non-client-controlled `collections.saved-list.anonymous-capture-surface` ceiling. Every other Collections route remains behind the actor fence. Any future anonymous Collections route, including the shared reads owned by #6144 and #6145, must explicitly amend the context-owned public-route composition; a deployable cannot silently bypass it.

Owner sharing commands retain `accounts.view` plus owner authorization. Anonymous public access has no actor permission. Unlisted access requires a revocable high-entropy secret, verified server-side against the stored verifier, and grants read-only access without edit authority. #6144 owns request transport and this ADR does not select body, cookie, or header transport for that secret.

`savedListSharedAccess` and `copyCapability` are wired into `CollectionsServices`, publicly exported, and backed by the Collections-owned shared-page projection, but no route or UI consumes them. The four-port census intentionally includes the retired `savedListAbuseReports` declaration. Under the completed [Decision #6143 approval](https://github.com/chase-sets/chase-sets/issues/6143#issuecomment-5085484768), [#7157](https://github.com/chase-sets/chase-sets/issues/7157) exclusively owns retiring that port. #6144 owns HTTP reachability and may bind only the three remaining live host ports: `savedListCapabilities`, `savedListSharingRateLimits`, and `savedListSharingAudit`. Unavailable stubs continue to deny, limit, or throw until a live owner binds them.

Saved List report intake and triage is owned by [#7156](https://github.com/chase-sets/chase-sets/issues/7156), the anonymous report fact and transport by #7157, and the accessible reporting affordance by [#7158](https://github.com/chase-sets/chase-sets/issues/7158). Copy behavior is owned by [#5026](https://github.com/chase-sets/chase-sets/issues/5026). None of those future slices changes the authorization boundary here.

The future Saved List-to-Seller Desk handoff adapter is owned only by [#5028](https://github.com/chase-sets/chase-sets/issues/5028); it does not make Collections a seller-workflow owner.

`SavedListSharingDisclosure` never substitutes for authorization, and `copyCapability` never grants edit authority. No `collection.share` or `collection.copy` permission is authorized. Saved Lists are private when created, and visibility never replaces authorization.

## Alternatives Considered

- Put the decision only in one bounded-context README. Rejected because no bounded context may claim authority for the other contexts' ownership and authorization rows.
- Make Collections own one cross-context My Collection shell. Rejected because it would move or duplicate Inventory behavior, encourage cross-context React imports or direct foreign-table reads, and turn a presentation label into a behavior owner.
- Reuse `/account/inventory` as Owned Cards. Rejected because that route is seller information architecture with a separate Seller Desk disposition; Owned Cards is a future Inventory-owned collector surface that may reuse the list component but not the route.
- Put the composition in a deployable. Rejected because deployables are thin composition roots, not owners of page, authorization, or domain behavior.
- Treat missing owned-stock valuation as zero or ship an Overview placeholder. Rejected because [#4317](https://github.com/chase-sets/chase-sets/issues/4317) is the prerequisite for honest owned-stock value, cost, and history.

## Consequences

Existing Saved List IDs, routes, APIs, facts/events, public contracts, read models, persistence, data, Inventory handoff, Inventory routes, and Seller Desk route dispositions remain unchanged. This ADR does not implement future My Collection routes, grants, navigation, sharing, copy, CSV, reporting, seller handoff, Owned Cards, Overview, or rollout work.

There are no schema or data migrations. Routine operation immediately after this documentation-only change is identical to routine operation before it.

Rollback is a revert of this ADR, its docs-index entry, and the two context README references. A later architecture reversal requires a superseding ADR and updates to both context READMEs in the same change so the durable authorities cannot disagree.
