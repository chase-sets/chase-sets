import { vi } from "vitest";

const buyNowMocks = {
  mockAddCartLine: vi.fn(),
  mockCreateCheckoutSession: vi.fn(),
  mockCreateDiscoveryRequestApiClient: vi.fn(),
  mockCreateMarketplaceRequestApiClient: vi.fn(),
  mockCreateCheckoutRequestApiClient: vi.fn(),
  mockCreateInventoryRequestApiClient: vi.fn(),
  mockAddSellListLine: vi.fn(),
  mockAddGuestSellListLine: vi.fn(),
  mockCreateProductAlert: vi.fn(),
  mockCreateAnonymousProductAlertIntent: vi.fn(),
  mockClaimAnonymousProductAlertIntent: vi.fn(),
  mockRequireActorFromAuthApi: vi.fn(),
  mockResolveActorFromAuthApi: vi.fn(),
  mockCreateSubmittedOffer: vi.fn(),
  mockAddGuestCartLine: vi.fn(),
  mockAcceptOfferMatch: vi.fn(),
  mockEnsureListingStock: vi.fn(),
  mockAppendAnonymousCartCookie: vi.fn((headers: Headers, anonymousCartId: string) => {
    headers.append("Set-Cookie", `chase_sets_anonymous_cart=${anonymousCartId}`);
  }),
  mockAppendAnonymousSellListCookie: vi.fn((headers: Headers, anonymousSellListId: string) => {
    headers.append("Set-Cookie", `chase_sets_anonymous_sell_list=${anonymousSellListId}`);
  }),
  mockAppendAnonymousListingDraftCookie: vi.fn((headers: Headers, anonymousOwnerId: string) => {
    headers.append("Set-Cookie", `chase_sets_anonymous_listing_drafts=${anonymousOwnerId}`);
  }),
  mockAppendAnonymousProductAlertCookie: vi.fn((headers: Headers, anonymousOwnerId: string) => {
    headers.append("Set-Cookie", `chase_sets_anonymous_product_alerts=${anonymousOwnerId}`);
  }),
  mockEnsureAnonymousCartId: vi.fn(() => "anon_cart_1"),
  mockEnsureAnonymousSellListId: vi.fn(() => "anon_sell_1"),
  mockEnsureAnonymousListingDraftOwnerId: vi.fn(() => "anon_listing_draft_1"),
  mockEnsureAnonymousProductAlertOwnerId: vi.fn(() => "anon_watch_1"),
  mockReadAnonymousProductAlertOwnerId: vi.fn<() => string | null>(() => "anon_watch_1"),
};

export const {
  mockAddCartLine,
  mockCreateCheckoutSession,
  mockCreateDiscoveryRequestApiClient,
  mockCreateMarketplaceRequestApiClient,
  mockCreateCheckoutRequestApiClient,
  mockCreateInventoryRequestApiClient,
  mockAddSellListLine,
  mockAddGuestSellListLine,
  mockCreateProductAlert,
  mockCreateAnonymousProductAlertIntent,
  mockClaimAnonymousProductAlertIntent,
  mockRequireActorFromAuthApi,
  mockResolveActorFromAuthApi,
  mockCreateSubmittedOffer,
  mockAddGuestCartLine,
  mockAcceptOfferMatch,
  mockEnsureListingStock,
  mockAppendAnonymousCartCookie,
  mockAppendAnonymousSellListCookie,
  mockAppendAnonymousListingDraftCookie,
  mockAppendAnonymousProductAlertCookie,
  mockEnsureAnonymousCartId,
  mockEnsureAnonymousSellListId,
  mockEnsureAnonymousListingDraftOwnerId,
  mockEnsureAnonymousProductAlertOwnerId,
  mockReadAnonymousProductAlertOwnerId,
} = buyNowMocks;
