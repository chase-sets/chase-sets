// Deployable-facing Review presentation surface. Discovery composes this
// Marketplace-owned browser UI without duplicating review policy or actions.
export { ReviewReportAction, type ReviewReportResult } from "../../features/reviews/ui/review-report-action";
export {
  ReviewScoringContext,
  type PublicReviewScoringContext,
} from "../../features/reviews/ui/review-scoring-context";
export {
  SellerDeskRouteShell,
  resolveSellerDeskLegacyRoute,
  resolveSellerDeskNavigation,
  type SellerDeskNavigationItem,
  type SellerDeskShellActor,
} from "../../features/seller-desk/ui/seller-desk-route-shell";
