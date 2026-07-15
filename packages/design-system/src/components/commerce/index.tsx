// Canonical commerce surface. These marketplace components live here, decomposed by
// concern into sibling modules (trust, listings, detail, search, account, panels,
// cart-line-item, shared). Product-option re-exports flow from data-display
// directly. Checkout surfaces live in the canonical `components/checkout` module.

export {
  type MarketplaceDensity,
  type ListingModel,
  type TrustTone,
  type StatusTone,
  formatMarketplaceNumber,
} from "./shared";

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
  type SecurePaymentIndicatorProps,
} from "./trust";

export { MarketplaceCartLineItem, type MarketplaceCartLineItemProps } from "./cart-line-item";
export { ListingCard, type ListingCardProps } from "./listings";

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
} from "./search";

// The marketplace checkout surfaces (PriceBreakdown, ListingPurchasePanel,
// OrderIntentSummary, OrderProtectionModule, MarketplaceNotice,
// PaymentRecoveryPanel, StickyCtaBar) were consolidated into the canonical
// `components/checkout` module and are re-exported from the package root there.

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
} from "./detail";

export {
  AccountProfileHeader,
  type AccountProfileHeaderProps,
  AccountCredibilityHeader,
  type AccountCredibilityHeaderProps,
  ReviewCard,
  type ReviewCardProps,
  ReviewContext,
  type ReviewContextProps,
} from "./account";

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
} from "./panels";
