// Seller Desk home view models — the presentation-facing shapes the Desk home
// page renders. The attention queue is consumed directly from the read-model
// contract (`SellerAttentionQueue`); the KPI band is a small, server-computed
// view model so the tiles never aggregate over a truncated client page.

// The KPI band. Each metric is nullable: a value the loader could not compute
// (a cross-context read that failed, or a surface not yet wired) degrades that
// one tile to "unavailable" rather than failing the whole Desk home.
export type SellerDeskKpis = Readonly<{
  // Count of the seller's currently active (published, available) listings.
  activeListings: number | null;
  // Open orders still owed a shipment — the seller's outstanding fulfillment.
  openOrdersToShip: number | null;
  // The next payout amount, pre-formatted for display, or null when none is due.
  nextPayoutAmount: string | null;
  // The seller's current wallet balance, pre-formatted for display.
  walletBalanceAmount: string | null;
}>;
