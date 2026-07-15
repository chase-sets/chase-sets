# Seller Desk Blueprint

The target information architecture for the redesigned seller experience — the seller
analog of the catalog control-plane v2 blueprint. This is the design-first contract the
Seller Desk implementation surfaces build against. The machine-readable contract is
[`index.ts`](./index.ts); this document is its narrative rationale, capability crosswalk,
and disclosure rules.

## Why a Seller Desk

Seller work today is scattered across ~40 `/account` routes with no unified "what needs
me": inventory (`/account/inventory*`, an import-batch page with in-cell resolution
forms), listings (a 930-line list page with eight row intents), fulfillment
(`/account/sales/shipments*`, a shipment-detail page plus a packing workspace), money
(payouts, payout setup, settlement, wallet adjustments), and offers / sell-list (a
1,443-line sell-list page). This mirrors the pre-redesign catalog control plane: **the
internals are the interface.**

The Seller Desk inverts that into a deep module — one **Seller Desk home** (attention
queue + KPIs), a small set of **entity surfaces** (inventory item, listing, sale,
shipment, payout, sell-list), and **drawers** — with the same capabilities behind one
mental model. It is built on transport-agnostic query/command modules so the agent
connector exposes the identical deep modules as MCP tools: "everything from your AI
assistant" and "everything from one desk" are the same backend modules behind two
facades. The differentiator is shrinking the interface, not reorganizing internals.

## Surfaces

Pages carry forward navigation; the two drawers open over the current page and never
change the route.

| Surface | Kind | Route (`/account/desk`) | The seller job it completes |
| --- | --- | --- | --- |
| Seller Desk | page | `/` | See everything that needs you, most important first, with the KPIs; open the entity that needs work. |
| Inventory item | page | `/inventory/:itemId` | Run one item's whole life — stock, locations, restock, holds, list-from-inventory. |
| Listing | page | `/listings/:listingId` | Price and repricing, evidence and photos, availability and order capacity, pause/withdraw/publish. |
| Sale | page | `/sales/:orderId` | Follow one sold order from payment through fulfillment to review. |
| Shipment | page | `/shipments/:shipmentId` | Pack, buy the label, print the slip, dispatch, and track — ordered by ship-by. |
| Money | page | `/money` | One settlement view of wallet, payouts, and reconciliation — replaces six routes. |
| Payout | page | `/payouts/:payoutId` | Confirm, edit, preview, or resolve a block on one payout. |
| Offers & sell list | page | `/offers` | Review offers awaiting response; build the sell list as a card grid with a comparison drawer. |
| Seller settings | page (utility) | `/settings` | Payout account setup, storage locations, seller policies — visited rarely. |
| Resolution drawer | drawer | — | Resolve a blocking task over the current page — import-row resolution, packing, offer response. |
| Activity & evidence drawer | drawer | — | Trace history, evidence, and audit for any entity, over the current page. |

## Entities own behavior, not pages

Actions attach to **entities**, so the same action renders wherever its entity appears —
a Desk-queue card, a list row, or a detail header. Eight entities, each with one home
surface: inventory item, import batch (resolves in the drawer), listing, sale order,
shipment, offer, payout, and wallet adjustment.

## Per-entity action vocabulary

The target vocabulary that replaces today's seller form intents. Every current intent
maps to exactly one entity-scoped action (enforced by the contract's tests); several
collapse — `pause`/`bulk-pause-listings` are one listing lifecycle transition, the
payout-setup intents are one manage-account flow, and the shipment dispatch verbs are one
transition. Permissions follow the existing binary seller policy: reads need
`<domain>.view`, mutations need `<domain>.manage` or a scoped verb (`listings.price`,
`payouts.request`, `payouts.setup`, `payouts.reconcile`). No new roles.

Feedback shapes: **status-banner** (transient banner on the invoking surface),
**row-transition** (the entity's row changes state in place), **preview-panel** (a typed,
freshness-guarded preview re-confirmed before committing), **confirmation-gate** (an
inline typed confirmation for destructive actions), and **job-progress** (an async job
whose progress tracks on the entity). See `SELLER_DESK_ACTIONS` for the full table.

## Disclosure rules

1. **Inline first.** Anything that acts on an entity already visible on the current page
   renders and resolves inline — row actions, readiness banners, price previews,
   confirmation gates.
2. **Drawer for depth over the same context.** Import-row resolution, packing, offer/terms
   comparison, and evidence/activity open in a drawer over the current page and close back
   to exactly where the seller stood. A drawer never changes the route.
3. **Page only for forward navigation.** Opening an entity from the Desk queue is a forward
   step into that entity's surface — never a detour to fix a blocker.
4. **Blockers resolve inline or in a drawer.** No seller task requires navigating to another
   page to become unblocked, so there is no `returnPath` and no cross-surface detour.

## Route map — nothing silently dropped

`SELLER_ROUTE_MAP` inventories every `/account` seller-host route with its scope,
disposition, new home, and redirect. In-scope seller routes are **absorbed** (list/overview
folds into the Desk home or a Desk surface), **kept** (the capability survives as its own
re-homed surface), or become a **drawer**. Out-of-scope routes carry an explicit reason and
stay in place.

- **Absorbed → Seller Desk home:** inventory list, restock decisions, listings list, sales
  list, sale-shipments list — their overviews become the Desk queue and filtered views.
- **Kept → entity surfaces:** inventory item, listing (+ create), sale, shipment, payout,
  sell-list — re-homed under `/account/desk/*` with redirects from the old paths.
- **Drawer:** import-batch resolution, packing + packing slips, offer comparison, wallet
  adjustment, repricing and bulk reprice, and the sale review.
- **Absorbed → Money dashboard:** payouts list, settlement/wallet — the single money surface
  replacing six routes.
- **Absorbed → Seller settings:** payout account setup and storage locations.
- **Out of scope (kept):** buyer surfaces (cart, purchases, inbound shipments, submitted
  offers, payment methods, product alerts — dispute/returns UX is owned by the support
  milestone), account settings (identity, security, team, consents, addresses,
  notifications, support), and the shared reputation surfaces (which feed the Desk
  reputation KPI). The operator settlement surfaces (`money-health`, `payout-operations`)
  are admin-owned and relocated by the operator-console work, not by the Seller Desk.

## Attention-queue ordering policy

The Seller Desk home and the MCP `seller_attention_queue` tool consume the **same**
per-context sources; `compareSellerAttentionItems` is the single ordering policy they
share. Sources conform to the Deep-Module UI Machinery attention-queue item shape; this
contract owns only severity and ordering, so the read-model slice and the surfaces never
diverge.

Ordering is total and deterministic:

1. **Severity** — `critical` > `warning` > `info`.
2. **Deadline** — dated items ahead of undated; soonest `dueAt` first.
3. **Source priority** — ship-by deadlines and blocked money outrank stale listings, the
   policy this blueprint mandates (`fulfillment-ship-by` > `settlement-blocked-payout` >
   `dispute-response` > `inventory-resolution` > `offer-response` > `listing-action`).
4. **Age** — oldest `observedAt` first, then a stable id tiebreak.

Six sources feed the queue: fulfillment ship-by, blocked payouts, import resolution, offer
responses, listing actions, and — gated on the support dispute domain chain — dispute
responses. Each source is independently testable and independently degradable: one failing
source degrades with a visible marker rather than blanking the queue (the aggregation slice
owns that behavior).

## Sequencing

This is the first Seller Desk slice; it and the attention-queue read model are serial and
land before any implementation surface. The surfaces (Desk home, inventory-to-listing
one-flow, fulfillment command center, money dashboard, sell-list review) and the MCP parity
tools all reference this contract as their source of truth. The current routes stay in
place, marked here for absorption/redirect, until those surfaces land.
