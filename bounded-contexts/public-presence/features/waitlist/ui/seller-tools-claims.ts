/**
 * Public seller-tools claim gates.
 *
 * These are the prelaunch composition-edge flags until the platform rollout
 * provider from m114 is available. A capability stays off until its owning
 * slice has passed staging UAT; landing copy must not turn an issue's intent
 * into a live-product claim by itself.
 */
export const sellerToolsClaimFlags = {
  repricing: false,
  marketAnalytics: false,
  sellerScale: false,
} as const;

export type SellerToolsClaimCapability = keyof typeof sellerToolsClaimFlags;
export type SellerToolsClaimStatus = "coming-to-beta" | "live";

export function sellerToolsClaimStatus(capability: SellerToolsClaimCapability): SellerToolsClaimStatus {
  return sellerToolsClaimFlags[capability] ? "live" : "coming-to-beta";
}
