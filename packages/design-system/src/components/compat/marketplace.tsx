// Compat marketplace surface. These components have no canonical design-system
// replacement yet, so they remain here, decomposed by concern into ./marketplace/*.
// Dead exports (unconsumed by any context, deployable, or test) were removed in the
// 2026-06 decomposition; product-option re-exports now flow from data-display directly.

export {
  type MarketplaceDensity,
  type ListingModel,
  type TrustTone,
  type StatusTone,
  formatMarketplaceNumber,
} from "./marketplace/shared";

export {
  TrustBadge,
  type TrustBadgeProps,
  type NamedTrustBadgeProps,
  VerifiedAccountBadge,
  OrderProtectionBadge,
  SecurePaymentCue,
  PlatformCredibilityCue,
  type PlatformCredibilityCueProps,
  RatingSummary,
  type RatingSummaryProps,
  AccountReputationSummary,
  type AccountReputationSummaryProps,
  AccountTrustCard,
  type AccountTrustCardProps,
  RatingDistribution,
  type RatingDistributionProps,
  SecurePaymentIndicator,
} from "./marketplace/trust";

export { MarketplaceCartLineItem, type MarketplaceCartLineItemProps } from "./marketplace/cart-line-item";
export { ListingCard, type ListingCardProps } from "./marketplace/listings";

export {
  SearchFilterPanel,
  type SearchFilterPanelProps,
  AppliedFilterChips,
  type AppliedFilterChipsProps,
  SavedSearchPrompt,
  type SavedSearchPromptProps,
  SearchControlBar,
  type SearchControlBarProps,
  NoResultsRecovery,
  type NoResultsRecoveryProps,
} from "./marketplace/search";

export {
  PriceBreakdown,
  type PriceBreakdownProps,
  ListingPurchasePanel,
  type ListingPurchasePanelProps,
  OrderIntentSummary,
  type OrderIntentSummaryProps,
  OrderProtectionModule,
  type OrderProtectionModuleProps,
  MarketplaceNotice,
  type MarketplaceNoticeProps,
  PaymentRecoveryPanel,
  type PaymentRecoveryPanelProps,
  StickyCtaBar,
  type StickyCtaBarProps,
} from "./marketplace/checkout";

export {
  MessageThreadPreview,
  type MessageThreadPreviewProps,
  ProductMediaModule,
  type ProductMediaModuleProps,
  DetailConfidenceModule,
  type DetailConfidenceModuleProps,
  SpecificationList,
  type SpecificationListProps,
  ComparisonModule,
  type ComparisonModuleProps,
} from "./marketplace/detail";

export {
  AccountProfileHeader,
  type AccountProfileHeaderProps,
  AccountCredibilityHeader,
  type AccountCredibilityHeaderProps,
  ReviewCard,
  type ReviewCardProps,
} from "./marketplace/account";

export {
  MarketplaceEmptyState,
  type MarketplaceEmptyStateProps,
  MarketplaceStatusTimeline,
  type MarketplaceStatusTimelineProps,
  OfferCard,
  type OfferCardProps,
  MarketplaceDashboardPanel,
  type MarketplaceDashboardPanelProps,
  MarketplaceTemplateGallery,
  type MarketplaceTemplateGalleryProps,
} from "./marketplace/panels";
