// Seller Desk blueprint — the target information architecture, per-entity action
// vocabulary, disclosure rules, absorbed-route map, and attention-queue ordering
// policy for the redesigned seller experience.
//
// This is a design-first contract (the seller analog of the m90 catalog
// control-plane v2 blueprint). The seller side today scatters one job across ~40
// `/account` routes whose internals are the interface. The Seller Desk inverts that
// into a deep module: one home (attention queue + KPIs), a small set of entity
// surfaces, and drawers — same capabilities, one mental model.
//
// The implementation surfaces build against this contract; the narrative rationale,
// capability crosswalk, and disclosure rules live in `blueprint.md`. Everything here
// is pure data + pure functions — no React, no fetch, no environment reads — so the
// ordering policy and the route map are unit-testable in isolation and consumable by
// both the web surfaces and the MCP seller tools (transport-agnostic parity).

// ---------------------------------------------------------------------------
// Surfaces — the target IA. Pages carry forward navigation; drawers open over the
// current page and never change the route.
// ---------------------------------------------------------------------------

export type SellerDeskSurfaceKind = "page" | "utility-page" | "drawer";

export type SellerDeskSurfaceId =
  | "seller-home"
  | "inventory-item"
  | "listing"
  | "sale"
  | "shipment"
  | "settlement-dashboard"
  | "payout"
  | "sell-list"
  | "seller-settings"
  | "resolution-drawer"
  | "activity-drawer";

export type SellerDeskSurface = Readonly<{
  id: SellerDeskSurfaceId;
  kind: SellerDeskSurfaceKind;
  // Route pattern for page surfaces; null for drawers (opened over the current page).
  routePath: string | null;
  title: string;
  // The seller job this surface completes.
  job: string;
}>;

export const SELLER_DESK_SURFACES: readonly SellerDeskSurface[] = [
  {
    id: "seller-home",
    kind: "page",
    routePath: "/account/desk",
    title: "Seller Desk",
    job: "See everything that needs you, most important first, alongside the KPIs that describe the business; open the entity that needs work.",
  },
  {
    id: "inventory-item",
    kind: "page",
    routePath: "/account/desk/inventory/:itemId",
    title: "Inventory item",
    job: "Run one item's whole life — stock, storage locations, restock decision, holds, and list-from-inventory — in place.",
  },
  {
    id: "listing",
    kind: "page",
    routePath: "/account/desk/listings/:listingId",
    title: "Listing",
    job: "Manage one listing — price and repricing, evidence and photos, availability and order capacity, pause/withdraw/publish.",
  },
  {
    id: "sale",
    kind: "page",
    routePath: "/account/desk/sales/:orderId",
    title: "Sale",
    job: "Follow one sold order from payment through fulfillment to review, with its shipment and payout in reach.",
  },
  {
    id: "shipment",
    kind: "page",
    routePath: "/account/desk/shipments/:shipmentId",
    title: "Shipment",
    job: "Complete one shipment — pack, buy the label, print the slip, dispatch, and track — ordered by ship-by deadline.",
  },
  {
    id: "settlement-dashboard",
    kind: "page",
    routePath: "/account/desk/money",
    title: "Money",
    job: "One settlement view of wallet balance, payouts, and reconciliation attention — the single money surface that replaces six routes.",
  },
  {
    id: "payout",
    kind: "page",
    routePath: "/account/desk/payouts/:payoutId",
    title: "Payout",
    job: "Inspect and act on one payout — confirm, edit, preview, or resolve a block.",
  },
  {
    id: "sell-list",
    kind: "page",
    routePath: "/account/desk/offers",
    title: "Offers & sell list",
    job: "Review offers awaiting response and build the sell list as a card grid with an offer/terms comparison drawer.",
  },
  {
    id: "seller-settings",
    kind: "utility-page",
    routePath: "/account/desk/settings",
    title: "Seller settings",
    job: "Govern the rarely-touched seller controls — payout account setup, storage locations, and seller policies.",
  },
  {
    id: "resolution-drawer",
    kind: "drawer",
    routePath: null,
    title: "Resolution drawer",
    job: "Resolve a blocking task over the current page — import-row resolution, packing, offer response — and close back to exactly where the seller stood.",
  },
  {
    id: "activity-drawer",
    kind: "drawer",
    routePath: null,
    title: "Activity & evidence drawer",
    job: "Trace history, evidence, and audit for any entity, opened over the current page — never a detour.",
  },
] as const;

// ---------------------------------------------------------------------------
// Entities own behavior, not pages. An action renders wherever its entity appears.
// ---------------------------------------------------------------------------

export type SellerEntityId =
  | "inventory-item"
  | "import-batch"
  | "listing"
  | "sale-order"
  | "shipment"
  | "offer"
  | "payout"
  | "wallet-adjustment";

export type SellerEntity = Readonly<{
  id: SellerEntityId;
  label: string;
  homeSurface: SellerDeskSurfaceId;
}>;

export const SELLER_ENTITIES: readonly SellerEntity[] = [
  { id: "inventory-item", label: "Inventory item", homeSurface: "inventory-item" },
  { id: "import-batch", label: "Import batch", homeSurface: "resolution-drawer" },
  { id: "listing", label: "Listing", homeSurface: "listing" },
  { id: "sale-order", label: "Sale order", homeSurface: "sale" },
  { id: "shipment", label: "Shipment", homeSurface: "shipment" },
  { id: "offer", label: "Offer", homeSurface: "sell-list" },
  { id: "payout", label: "Payout", homeSurface: "payout" },
  { id: "wallet-adjustment", label: "Wallet adjustment", homeSurface: "settlement-dashboard" },
] as const;

// ---------------------------------------------------------------------------
// Permissions — the existing binary seller policy (`<domain>.view` reads,
// `<domain>.manage` / scoped verbs mutate). No new roles are introduced.
// ---------------------------------------------------------------------------

export type SellerPermission =
  | "inventory.view"
  | "inventory.manage"
  | "listings.view"
  | "listings.manage"
  | "listings.price"
  | "offers.view"
  | "offers.manage"
  | "fulfillment.view"
  | "fulfillment.manage"
  | "payouts.view"
  | "payouts.manage"
  | "payouts.setup"
  | "payouts.reconcile"
  | "payouts.request"
  | "orders.view"
  | "orders.manage"
  | "pricing.view"
  | "pricing.manage";

// ---------------------------------------------------------------------------
// Action vocabulary. Every current seller form intent maps to exactly one
// entity-scoped action; several collapse (pause/withdraw are listing lifecycle
// transitions; the payout-setup intents are one manage-account flow).
// ---------------------------------------------------------------------------

// status-banner  — transient success/error banner on the invoking surface.
// row-transition — the entity's own row transitions state in place.
// preview-panel  — a typed, freshness-guarded preview renders and must be re-confirmed
//                  before the committing action runs.
// confirmation-gate — a destructive action requires an inline typed confirmation.
// job-progress   — an asynchronous job is enqueued and its progress tracks on the entity.
export type SellerActionFeedback =
  | "status-banner"
  | "row-transition"
  | "preview-panel"
  | "confirmation-gate"
  | "job-progress";

// inline  — acts on an entity visible on the current page, resolves in place.
// drawer  — depth over the same context; never changes the route.
// page    — forward navigation into an entity's own surface.
export type SellerActionDisclosure = "inline" | "drawer" | "page";

export type SellerDeskAction = Readonly<{
  id: string;
  entity: SellerEntityId;
  permission: SellerPermission;
  feedback: SellerActionFeedback;
  disclosure: SellerActionDisclosure;
  // The current form intents this action subsumes — the proof no capability is dropped.
  replaces: readonly string[];
}>;

export const SELLER_DESK_ACTIONS: readonly SellerDeskAction[] = [
  // Inventory item
  {
    id: "inventory-item.create",
    entity: "inventory-item",
    permission: "inventory.manage",
    feedback: "status-banner",
    disclosure: "drawer",
    replaces: ["create-item"],
  },
  {
    id: "inventory-item.adjust",
    entity: "inventory-item",
    permission: "inventory.manage",
    feedback: "row-transition",
    disclosure: "inline",
    replaces: ["adjust-item"],
  },
  {
    id: "inventory-item.restock",
    entity: "inventory-item",
    permission: "inventory.manage",
    feedback: "row-transition",
    disclosure: "inline",
    replaces: ["restock"],
  },
  {
    id: "inventory-item.hold",
    entity: "inventory-item",
    permission: "inventory.manage",
    feedback: "row-transition",
    disclosure: "inline",
    replaces: ["create-hold", "release-hold"],
  },
  {
    id: "inventory-item.raise-exception",
    entity: "inventory-item",
    permission: "inventory.manage",
    feedback: "status-banner",
    disclosure: "inline",
    replaces: ["raise-exception"],
  },
  {
    id: "inventory-item.list-from-inventory",
    entity: "inventory-item",
    permission: "listings.manage",
    feedback: "preview-panel",
    disclosure: "drawer",
    replaces: ["create-listing"],
  },
  // Import batch
  {
    id: "import-batch.create",
    entity: "import-batch",
    permission: "inventory.manage",
    feedback: "job-progress",
    disclosure: "drawer",
    replaces: ["create-batch"],
  },
  {
    id: "import-batch.commit",
    entity: "import-batch",
    permission: "inventory.manage",
    feedback: "job-progress",
    disclosure: "drawer",
    replaces: ["commit-batch"],
  },
  {
    id: "import-batch.resolve-row",
    entity: "import-batch",
    permission: "inventory.manage",
    feedback: "row-transition",
    disclosure: "drawer",
    replaces: ["resolve-row"],
  },
  // Storage location (a facet of inventory, edited in seller settings)
  {
    id: "inventory-item.manage-location",
    entity: "inventory-item",
    permission: "inventory.manage",
    feedback: "status-banner",
    disclosure: "drawer",
    replaces: ["create-location", "update-location", "archive-location"],
  },
  // Listing
  {
    id: "listing.publish",
    entity: "listing",
    permission: "listings.manage",
    feedback: "status-banner",
    disclosure: "inline",
    replaces: ["publish", "preview-listing"],
  },
  {
    id: "listing.update-price",
    entity: "listing",
    permission: "listings.price",
    feedback: "preview-panel",
    disclosure: "inline",
    replaces: ["update-price", "preview-price"],
  },
  {
    id: "listing.pause",
    entity: "listing",
    permission: "listings.manage",
    feedback: "row-transition",
    disclosure: "inline",
    replaces: ["pause", "bulk-pause-listings"],
  },
  {
    id: "listing.withdraw",
    entity: "listing",
    permission: "listings.manage",
    feedback: "confirmation-gate",
    disclosure: "inline",
    replaces: ["withdraw", "bulk-withdraw-listings"],
  },
  {
    id: "listing.set-availability",
    entity: "listing",
    permission: "listings.manage",
    feedback: "row-transition",
    disclosure: "inline",
    replaces: [
      "enable-listing-availability",
      "set-order-capacity",
      "clear-order-capacity",
      "update-quantity-cap",
      "update-purchase-limits",
      "cancel-away-window",
    ],
  },
  {
    id: "listing.manage-evidence",
    entity: "listing",
    permission: "listings.manage",
    feedback: "status-banner",
    disclosure: "drawer",
    replaces: [
      "add-listing-evidence",
      "classify-listing-evidence",
      "add-photos",
      "classify-photo",
      "remove-photo",
      "reorder-photos",
      "replace-photo",
    ],
  },
  {
    id: "listing.reprice",
    entity: "listing",
    permission: "pricing.manage",
    feedback: "job-progress",
    disclosure: "drawer",
    replaces: ["upload-bulk-reprice", "cancel-bulk-reprice"],
  },
  // Offer / sell list
  {
    id: "offer.decline",
    entity: "offer",
    permission: "offers.manage",
    feedback: "row-transition",
    disclosure: "inline",
    replaces: ["decline-offer"],
  },
  {
    id: "offer.mute-buyer",
    entity: "offer",
    permission: "offers.manage",
    feedback: "row-transition",
    disclosure: "inline",
    replaces: ["mute-offer-buyer", "unmute-offer-buyer"],
  },
  {
    id: "offer.manage-sell-list",
    entity: "offer",
    permission: "offers.manage",
    feedback: "row-transition",
    disclosure: "inline",
    replaces: ["add-selected-offer", "remove-sell-list-line"],
  },
  // Sale order
  {
    id: "sale-order.leave-review",
    entity: "sale-order",
    permission: "orders.manage",
    feedback: "status-banner",
    disclosure: "drawer",
    replaces: ["request"],
  },
  // Shipment
  {
    id: "shipment.pack",
    entity: "shipment",
    permission: "fulfillment.manage",
    feedback: "job-progress",
    disclosure: "drawer",
    replaces: ["start-packing"],
  },
  {
    id: "shipment.buy-label",
    entity: "shipment",
    permission: "fulfillment.manage",
    feedback: "job-progress",
    disclosure: "inline",
    replaces: ["purchase-label"],
  },
  {
    id: "shipment.void-label",
    entity: "shipment",
    permission: "fulfillment.manage",
    feedback: "confirmation-gate",
    disclosure: "inline",
    replaces: ["void-label"],
  },
  {
    id: "shipment.dispatch",
    entity: "shipment",
    permission: "fulfillment.manage",
    feedback: "row-transition",
    disclosure: "inline",
    replaces: ["dispatch-shipment", "deliver-shipment", "return-shipment"],
  },
  // Payout / settlement
  {
    id: "payout.confirm",
    entity: "payout",
    permission: "payouts.request",
    feedback: "confirmation-gate",
    disclosure: "inline",
    replaces: ["confirm-payout", "preview-payout"],
  },
  {
    id: "payout.edit",
    entity: "payout",
    permission: "payouts.manage",
    feedback: "preview-panel",
    disclosure: "drawer",
    replaces: ["edit-payout"],
  },
  {
    id: "payout.manage-account",
    entity: "payout",
    permission: "payouts.setup",
    feedback: "status-banner",
    disclosure: "page",
    replaces: ["manage-payout-account", "start-payout-setup", "refresh-payout-setup"],
  },
  {
    id: "wallet-adjustment.reconcile",
    entity: "wallet-adjustment",
    permission: "payouts.reconcile",
    feedback: "status-banner",
    disclosure: "drawer",
    replaces: ["run-reconciliation", "write-off", "reverse"],
  },
] as const;

// ---------------------------------------------------------------------------
// Route map — every `/account` seller-host route, its disposition in the new IA,
// and its redirect target. Nothing is silently dropped: in-scope routes name a new
// home; out-of-scope routes carry an explicit reason and stay in place.
// ---------------------------------------------------------------------------

// seller          — seller work the Desk absorbs or re-homes.
// shared          — reputation surfaces that feed the Desk KPIs but are kept in place.
// buyer           — buyer surfaces (out of scope; m85 owns dispute/returns UX).
// account-settings — identity/account settings kept outside the Desk.
export type SellerRouteScope = "seller" | "shared" | "buyer" | "account-settings";

// absorbed — the route's list/overview folds into the Desk home or a Desk surface.
// kept     — the capability survives as its own re-homed surface.
// drawer   — the capability becomes a drawer over a Desk surface.
// out-of-scope — deliberately unchanged by this milestone.
export type SellerRouteDisposition = "absorbed" | "kept" | "drawer" | "out-of-scope";

export type SellerRouteMapping = Readonly<{
  routeId: string;
  currentPath: string;
  sourceContext: string;
  scope: SellerRouteScope;
  disposition: SellerRouteDisposition;
  // Target Desk surface for in-scope routes; null for out-of-scope kept routes.
  newHome: SellerDeskSurfaceId | null;
  // Absolute redirect target for absorbed routes; null when the route keeps its own path.
  redirectTo: string | null;
  // What the route does today — the capability that must survive.
  capability: string;
  note?: string;
}>;

export const SELLER_ROUTE_MAP: readonly SellerRouteMapping[] = [
  // Inventory
  {
    routeId: "account-inventory",
    currentPath: "/account/inventory",
    sourceContext: "inventory",
    scope: "seller",
    disposition: "absorbed",
    newHome: "seller-home",
    redirectTo: "/account/desk",
    capability: "Inventory list with in-row stock actions.",
  },
  {
    routeId: "account-inventory-imports",
    currentPath: "/account/inventory/imports",
    sourceContext: "inventory",
    scope: "seller",
    disposition: "absorbed",
    newHome: "seller-home",
    redirectTo: "/account/desk",
    capability: "Import batch list.",
    note: "Import activity surfaces on the Desk home; batch review opens the resolution drawer.",
  },
  {
    routeId: "account-inventory-import",
    currentPath: "/account/inventory/imports/:batchId",
    sourceContext: "inventory",
    scope: "seller",
    disposition: "drawer",
    newHome: "resolution-drawer",
    redirectTo: "/account/desk",
    capability: "Import batch detail with in-cell SKU resolution forms.",
  },
  {
    routeId: "account-inventory-locations",
    currentPath: "/account/inventory/locations",
    sourceContext: "inventory",
    scope: "seller",
    disposition: "absorbed",
    newHome: "seller-settings",
    redirectTo: "/account/desk/settings",
    capability: "Storage location management.",
  },
  {
    routeId: "account-inventory-item",
    currentPath: "/account/inventory/items/:itemId",
    sourceContext: "inventory",
    scope: "seller",
    disposition: "kept",
    newHome: "inventory-item",
    redirectTo: "/account/desk/inventory/:itemId",
    capability: "Single inventory item detail.",
  },
  {
    routeId: "account-inventory-restock-decisions",
    currentPath: "/account/inventory/restock-decisions",
    sourceContext: "inventory",
    scope: "seller",
    disposition: "absorbed",
    newHome: "seller-home",
    redirectTo: "/account/desk",
    capability: "Restock decision queue.",
    note: "Restock attention is a Desk-home source; decisions resolve inline on the inventory item.",
  },
  // Listings
  {
    routeId: "account-listings",
    currentPath: "/account/listings",
    sourceContext: "marketplace",
    scope: "seller",
    disposition: "absorbed",
    newHome: "seller-home",
    redirectTo: "/account/desk",
    capability: "Listing list with filters, bulk actions, and eight row intents.",
  },
  {
    routeId: "account-listing",
    currentPath: "/account/listings/:listingId",
    sourceContext: "marketplace",
    scope: "seller",
    disposition: "kept",
    newHome: "listing",
    redirectTo: "/account/desk/listings/:listingId",
    capability: "Single listing detail.",
  },
  {
    routeId: "account-listings-new",
    currentPath: "/account/listings/new",
    sourceContext: "marketplace",
    scope: "seller",
    disposition: "kept",
    newHome: "listing",
    redirectTo: "/account/desk/listings/new",
    capability: "Listing creation flow.",
    note: "Primary path becomes list-from-inventory (drawer from the inventory item); direct create is kept as a page.",
  },
  // Offers / sell list
  {
    routeId: "account-offer-matches",
    currentPath: "/account/offers/matches",
    sourceContext: "marketplace",
    scope: "seller",
    disposition: "absorbed",
    newHome: "sell-list",
    redirectTo: "/account/desk/offers",
    capability: "Offers matched to the seller's listings.",
  },
  {
    routeId: "account-offer-match",
    currentPath: "/account/offers/matches/:offerId",
    sourceContext: "marketplace",
    scope: "seller",
    disposition: "drawer",
    newHome: "sell-list",
    redirectTo: "/account/desk/offers",
    capability: "Single matched offer with offer/terms comparison.",
  },
  {
    routeId: "account-sell-list",
    currentPath: "/account/sell-list",
    sourceContext: "checkout",
    scope: "seller",
    disposition: "kept",
    newHome: "sell-list",
    redirectTo: "/account/desk/offers",
    capability: "Sell-list builder (1,443-line multi-intent surface).",
  },
  // Sales (seller orders)
  {
    routeId: "account-sales",
    currentPath: "/account/sales",
    sourceContext: "ordering",
    scope: "seller",
    disposition: "absorbed",
    newHome: "seller-home",
    redirectTo: "/account/desk",
    capability: "Sold-order list.",
  },
  {
    routeId: "account-sale",
    currentPath: "/account/sales/:orderId",
    sourceContext: "ordering",
    scope: "seller",
    disposition: "kept",
    newHome: "sale",
    redirectTo: "/account/desk/sales/:orderId",
    capability: "Single sold order detail.",
  },
  {
    routeId: "account-sale-review",
    currentPath: "/account/sales/:orderId/review",
    sourceContext: "marketplace",
    scope: "seller",
    disposition: "drawer",
    newHome: "sale",
    redirectTo: "/account/desk/sales/:orderId",
    capability: "Leave a review for the counterparty on a sale.",
  },
  // Fulfillment (seller outbound)
  {
    routeId: "account-sale-shipments",
    currentPath: "/account/sales/shipments",
    sourceContext: "fulfillment",
    scope: "seller",
    disposition: "absorbed",
    newHome: "seller-home",
    redirectTo: "/account/desk",
    capability: "Sale-shipment list ordered by ship-by.",
  },
  {
    routeId: "account-sale-shipment",
    currentPath: "/account/sales/shipments/:shipmentId",
    sourceContext: "fulfillment",
    scope: "seller",
    disposition: "kept",
    newHome: "shipment",
    redirectTo: "/account/desk/shipments/:shipmentId",
    capability: "Single shipment detail.",
  },
  {
    routeId: "account-sale-shipment-packing",
    currentPath: "/account/sales/shipments/:shipmentId/packing",
    sourceContext: "fulfillment",
    scope: "seller",
    disposition: "drawer",
    newHome: "shipment",
    redirectTo: "/account/desk/shipments/:shipmentId",
    capability: "Packing workspace.",
  },
  {
    routeId: "account-sale-shipment-packing-slips",
    currentPath: "/account/sales/shipments/packing-slips",
    sourceContext: "fulfillment",
    scope: "seller",
    disposition: "drawer",
    newHome: "shipment",
    redirectTo: "/account/desk/shipments",
    capability: "Bulk packing-slip printing.",
  },
  // Settlement / money
  {
    routeId: "account-payouts",
    currentPath: "/account/payouts",
    sourceContext: "settlement",
    scope: "seller",
    disposition: "absorbed",
    newHome: "settlement-dashboard",
    redirectTo: "/account/desk/money",
    capability: "Payout list.",
  },
  {
    routeId: "account-payout",
    currentPath: "/account/payouts/:payoutId",
    sourceContext: "settlement",
    scope: "seller",
    disposition: "kept",
    newHome: "payout",
    redirectTo: "/account/desk/payouts/:payoutId",
    capability: "Single payout detail.",
  },
  {
    routeId: "account-payout-setup",
    currentPath: "/account/payouts/setup",
    sourceContext: "settlement",
    scope: "seller",
    disposition: "absorbed",
    newHome: "seller-settings",
    redirectTo: "/account/desk/settings",
    capability: "Payout account setup.",
  },
  {
    routeId: "account-settlement",
    currentPath: "/account/settlement",
    sourceContext: "settlement",
    scope: "seller",
    disposition: "absorbed",
    newHome: "settlement-dashboard",
    redirectTo: "/account/desk/money",
    capability: "Wallet / settlement overview.",
  },
  {
    routeId: "account-wallet-adjustment",
    currentPath: "/account/wallet/adjustments/:reference",
    sourceContext: "settlement",
    scope: "seller",
    disposition: "drawer",
    newHome: "settlement-dashboard",
    redirectTo: "/account/desk/money",
    capability: "Wallet adjustment detail.",
  },
  // Pricing
  {
    routeId: "account-repricing",
    currentPath: "/account/repricing",
    sourceContext: "pricing",
    scope: "seller",
    disposition: "drawer",
    newHome: "listing",
    redirectTo: "/account/desk",
    capability: "Repricing controls.",
    note: "Repricing becomes a drawer on the listing and a bulk action on the Desk listings view.",
  },
  {
    routeId: "account-bulk-reprice",
    currentPath: "/account/bulk-reprice",
    sourceContext: "pricing",
    scope: "seller",
    disposition: "drawer",
    newHome: "listing",
    redirectTo: "/account/desk",
    capability: "Bulk reprice upload.",
  },
  // Shared reputation — kept, feeds the Desk reputation KPI
  {
    routeId: "account-review-summary",
    currentPath: "/account/reviews",
    sourceContext: "marketplace",
    scope: "shared",
    disposition: "out-of-scope",
    newHome: null,
    redirectTo: null,
    capability: "Reputation summary.",
    note: "Shared reputation surface; seller-received reviews feed the Desk reputation KPI.",
  },
  {
    routeId: "account-received-reviews",
    currentPath: "/account/reviews/received",
    sourceContext: "marketplace",
    scope: "shared",
    disposition: "out-of-scope",
    newHome: null,
    redirectTo: null,
    capability: "Reviews received.",
    note: "Feeds the Desk reputation KPI; kept in place.",
  },
  {
    routeId: "account-written-reviews",
    currentPath: "/account/reviews/written",
    sourceContext: "marketplace",
    scope: "shared",
    disposition: "out-of-scope",
    newHome: null,
    redirectTo: null,
    capability: "Reviews written.",
  },
  {
    routeId: "account-review",
    currentPath: "/account/reviews/:reviewId",
    sourceContext: "marketplace",
    scope: "shared",
    disposition: "out-of-scope",
    newHome: null,
    redirectTo: null,
    capability: "Single review detail.",
  },
  // Buyer surfaces — out of scope (m85 owns dispute/returns; m33/m36 own the buy funnel)
  {
    routeId: "account-cart",
    currentPath: "/account/cart",
    sourceContext: "checkout",
    scope: "buyer",
    disposition: "out-of-scope",
    newHome: null,
    redirectTo: null,
    capability: "Buy cart.",
  },
  {
    routeId: "account-purchases",
    currentPath: "/account/purchases",
    sourceContext: "ordering",
    scope: "buyer",
    disposition: "out-of-scope",
    newHome: null,
    redirectTo: null,
    capability: "Purchase list.",
  },
  {
    routeId: "account-purchase",
    currentPath: "/account/purchases/:purchaseId",
    sourceContext: "ordering",
    scope: "buyer",
    disposition: "out-of-scope",
    newHome: null,
    redirectTo: null,
    capability: "Single purchase detail.",
  },
  {
    routeId: "account-purchase-review",
    currentPath: "/account/purchases/:purchaseId/review",
    sourceContext: "marketplace",
    scope: "buyer",
    disposition: "out-of-scope",
    newHome: null,
    redirectTo: null,
    capability: "Leave a review as a buyer.",
  },
  {
    routeId: "account-shipments",
    currentPath: "/account/shipments",
    sourceContext: "fulfillment",
    scope: "buyer",
    disposition: "out-of-scope",
    newHome: null,
    redirectTo: null,
    capability: "Inbound (purchased) shipment tracking.",
  },
  {
    routeId: "account-shipment",
    currentPath: "/account/shipments/:shipmentId",
    sourceContext: "fulfillment",
    scope: "buyer",
    disposition: "out-of-scope",
    newHome: null,
    redirectTo: null,
    capability: "Single inbound shipment tracking.",
  },
  {
    routeId: "account-offers-submitted",
    currentPath: "/account/offers/submitted",
    sourceContext: "marketplace",
    scope: "buyer",
    disposition: "out-of-scope",
    newHome: null,
    redirectTo: null,
    capability: "Offers the account submitted as a buyer.",
  },
  {
    routeId: "account-offer-submitted",
    currentPath: "/account/offers/submitted/:offerId",
    sourceContext: "marketplace",
    scope: "buyer",
    disposition: "out-of-scope",
    newHome: null,
    redirectTo: null,
    capability: "Single submitted (buyer) offer.",
  },
  {
    routeId: "account-payment-methods",
    currentPath: "/account/payment-methods",
    sourceContext: "payments",
    scope: "buyer",
    disposition: "out-of-scope",
    newHome: null,
    redirectTo: null,
    capability: "Buyer payment methods.",
  },
  {
    routeId: "account-product-alerts",
    currentPath: "/account/product-alerts",
    sourceContext: "discovery",
    scope: "buyer",
    disposition: "out-of-scope",
    newHome: null,
    redirectTo: null,
    capability: "Buyer product alerts.",
  },
  // Account settings — kept outside the Desk
  {
    routeId: "account",
    currentPath: "/account",
    sourceContext: "identity",
    scope: "account-settings",
    disposition: "out-of-scope",
    newHome: null,
    redirectTo: null,
    capability: "Account settings home.",
  },
  {
    routeId: "account-security",
    currentPath: "/account/security",
    sourceContext: "identity",
    scope: "account-settings",
    disposition: "out-of-scope",
    newHome: null,
    redirectTo: null,
    capability: "Security settings.",
  },
  {
    routeId: "account-team",
    currentPath: "/account/team",
    sourceContext: "identity",
    scope: "account-settings",
    disposition: "out-of-scope",
    newHome: null,
    redirectTo: null,
    capability: "Team members.",
  },
  {
    routeId: "account-consents",
    currentPath: "/account/consents",
    sourceContext: "identity",
    scope: "account-settings",
    disposition: "out-of-scope",
    newHome: null,
    redirectTo: null,
    capability: "Consent settings.",
  },
  {
    routeId: "account-shipping-addresses",
    currentPath: "/account/shipping-addresses",
    sourceContext: "identity",
    scope: "account-settings",
    disposition: "out-of-scope",
    newHome: null,
    redirectTo: null,
    capability: "Shipping addresses.",
  },
  {
    routeId: "account-notifications",
    currentPath: "/account/notifications",
    sourceContext: "notifications",
    scope: "account-settings",
    disposition: "out-of-scope",
    newHome: null,
    redirectTo: null,
    capability: "Notification settings.",
  },
  {
    routeId: "account-support",
    currentPath: "/account/support",
    sourceContext: "platform-operations",
    scope: "account-settings",
    disposition: "out-of-scope",
    newHome: null,
    redirectTo: null,
    capability: "Support cases.",
  },
] as const;

// ---------------------------------------------------------------------------
// Attention-queue ordering policy. The Seller Desk home and the MCP
// `seller_attention_queue` tool consume the same per-context sources; this is the
// single ordering policy they share. Sources conform to the Deep-Module UI Machinery
// attention-queue item shape; this module owns only severity/ordering.
// ---------------------------------------------------------------------------

export type SellerAttentionSeverity = "critical" | "warning" | "info";

// Higher rank sorts first. Explicit (not union order) so the contract is legible.
export const SELLER_ATTENTION_SEVERITY_RANK: Readonly<Record<SellerAttentionSeverity, number>> = {
  critical: 3,
  warning: 2,
  info: 1,
};

export type SellerAttentionSourceId =
  | "fulfillment-ship-by"
  | "settlement-blocked-payout"
  | "dispute-response"
  | "inventory-resolution"
  | "offer-response"
  | "listing-action";

// Tiebreak priority for items of equal severity and deadline. Ship-by deadlines and
// blocked money outrank stale listings — the policy the blueprint mandates.
export const SELLER_ATTENTION_SOURCE_PRIORITY: Readonly<Record<SellerAttentionSourceId, number>> = {
  "fulfillment-ship-by": 6,
  "settlement-blocked-payout": 5,
  "dispute-response": 4,
  "inventory-resolution": 3,
  "offer-response": 2,
  "listing-action": 1,
};

export type SellerAttentionSource = Readonly<{
  id: SellerAttentionSourceId;
  ownerContext: string;
  entity: SellerEntityId;
  // The deep-link target surface for an item from this source.
  target: SellerDeskSurfaceId;
  // The highest severity this source can raise.
  peakSeverity: SellerAttentionSeverity;
  // `live` sources ship with the read-model slice; `gated` sources wait on an upstream
  // milestone (the dispute source waits on the m85 support domain chain).
  availability: "live" | "gated";
  gatedOn?: string;
}>;

export const SELLER_ATTENTION_SOURCES: readonly SellerAttentionSource[] = [
  {
    id: "fulfillment-ship-by",
    ownerContext: "fulfillment",
    entity: "shipment",
    target: "shipment",
    peakSeverity: "critical",
    availability: "live",
  },
  {
    id: "settlement-blocked-payout",
    ownerContext: "settlement",
    entity: "payout",
    target: "payout",
    peakSeverity: "critical",
    availability: "live",
  },
  {
    id: "inventory-resolution",
    ownerContext: "inventory",
    entity: "import-batch",
    target: "resolution-drawer",
    peakSeverity: "warning",
    availability: "live",
  },
  {
    id: "offer-response",
    ownerContext: "marketplace",
    entity: "offer",
    target: "sell-list",
    peakSeverity: "warning",
    availability: "live",
  },
  {
    id: "listing-action",
    ownerContext: "marketplace",
    entity: "listing",
    target: "listing",
    peakSeverity: "info",
    availability: "live",
  },
  {
    id: "dispute-response",
    ownerContext: "platform-operations",
    entity: "sale-order",
    target: "sale",
    peakSeverity: "critical",
    availability: "gated",
    gatedOn: "m85 support dispute domain chain",
  },
] as const;

// The minimal ordering key each source item carries. Structurally compatible with the
// shared attention-queue item shape; the comparator reads only these fields.
export type SellerAttentionOrderInput = Readonly<{
  severity: SellerAttentionSeverity;
  source: SellerAttentionSourceId;
  // ISO-8601 UTC deadline; items with a deadline outrank those without.
  dueAt?: string | null;
  // ISO-8601 UTC time the work first needed attention.
  observedAt: string;
}>;

function toTime(value: string | null | undefined): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

// The canonical Seller Desk ordering. Deterministic and total:
//   1. severity rank, descending (critical first);
//   2. presence of a deadline (dated items first), then soonest deadline first;
//   3. source priority, descending (ship-by & blocked money ahead of stale listings);
//   4. oldest `observedAt` first;
//   5. source id, then a caller-provided nothing else — ties resolve stably.
export function compareSellerAttentionItems(a: SellerAttentionOrderInput, b: SellerAttentionOrderInput): number {
  const severityDelta = SELLER_ATTENTION_SEVERITY_RANK[b.severity] - SELLER_ATTENTION_SEVERITY_RANK[a.severity];
  if (severityDelta !== 0) {
    return severityDelta;
  }

  const aDue = toTime(a.dueAt);
  const bDue = toTime(b.dueAt);
  if (aDue !== bDue) {
    if (aDue === null) {
      return 1;
    }
    if (bDue === null) {
      return -1;
    }
    return aDue - bDue;
  }

  const priorityDelta = SELLER_ATTENTION_SOURCE_PRIORITY[b.source] - SELLER_ATTENTION_SOURCE_PRIORITY[a.source];
  if (priorityDelta !== 0) {
    return priorityDelta;
  }

  const aObserved = toTime(a.observedAt) ?? 0;
  const bObserved = toTime(b.observedAt) ?? 0;
  if (aObserved !== bObserved) {
    return aObserved - bObserved;
  }

  return a.source.localeCompare(b.source, "en");
}

// ---------------------------------------------------------------------------
// Disclosure rules — the design law the surfaces obey.
// ---------------------------------------------------------------------------

export const SELLER_DESK_DISCLOSURE_RULES: readonly string[] = [
  "Inline first: anything that acts on an entity already visible on the current page renders and resolves inline — row actions, readiness banners, price previews, confirmation gates.",
  "Drawer for depth over the same context: import-row resolution, packing, offer/terms comparison, and evidence/activity open in a drawer over the current page and close back to exactly where the seller stood. A drawer never changes the route.",
  "Page only for forward navigation: opening an entity from the Desk queue is a forward step into that entity's surface — never a detour to fix a blocker.",
  "Blockers resolve inline or in a drawer: no seller task requires navigating to another page to become unblocked, so there is no returnPath and no cross-surface detour.",
] as const;

// ---------------------------------------------------------------------------
// Derived helpers.
// ---------------------------------------------------------------------------

export function findSellerRouteRedirect(currentPath: string): string | null {
  const mapping = SELLER_ROUTE_MAP.find((route) => route.currentPath === currentPath);
  return mapping?.redirectTo ?? null;
}

export function sellerSurfaceById(id: SellerDeskSurfaceId): SellerDeskSurface | undefined {
  return SELLER_DESK_SURFACES.find((surface) => surface.id === id);
}
