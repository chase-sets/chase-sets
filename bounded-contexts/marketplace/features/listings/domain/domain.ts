import type { AggregateDecider, AggregateEvolver, DomainEvent } from "@chase-sets/event-core";
import { normalizeAddressSnapshot, type AddressSnapshot } from "@chase-sets/primitives/address-snapshot";
import type { ProductKey } from "@chase-sets/primitives/catalog-identity";
import { moneyToCents } from "@chase-sets/primitives/money";
import type { AccountId, CatalogItemId, ListingId } from "@chase-sets/primitives/typed-ids";
import type { ProductMeasureSnapshot } from "@chase-sets/product-measures";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled variant: ${JSON.stringify(value)}`);
}

function ensurePositiveInteger(value: number, message: string): number {
  assert(Number.isInteger(value) && value > 0, message);
  return value;
}

function normalizeMoneyAmount(
  value: string,
  options: Readonly<{ fieldName?: string; allowZero?: boolean }> = {},
): string {
  const normalized = value.trim();
  const fieldName = options.fieldName ?? "Price amount";
  assert(/^\d+(\.\d{1,2})?$/.test(normalized), `${fieldName} must be a valid decimal.`);
  assert(
    options.allowZero ? Number.parseFloat(normalized) >= 0 : Number.parseFloat(normalized) > 0,
    `${fieldName} must be ${options.allowZero ? "zero or greater" : "greater than zero"}.`,
  );
  return normalized;
}

function normalizePercentageBps(value: number, fieldName: string): number {
  assert(Number.isInteger(value), `${fieldName} must be a whole number of basis points.`);
  assert(value >= 0, `${fieldName} must be zero or greater.`);
  return value;
}

/**
 * Fields that define whether a price/terms update actually changes anything observable.
 * `termsResolvedAt` and `feeQuoteFingerprint` are deliberately excluded: `termsResolvedAt` is a
 * fresh resolution timestamp on every quote (never equal across two calls) and
 * `feeQuoteFingerprint` is a pure function of these same fields, so it adds no information.
 * Comparing this narrower surface is what makes repeat submissions of an unchanged price free.
 */
type ListingFeeTermsSurface = Readonly<{
  marketplaceSalesFeeUnitAmount: string;
  sellerNetUnitAmount: string;
  shippingAllowancePercentageBps: number;
  termsScheduleId: string | null;
  termsAgreementId: string | null;
}>;

/**
 * Money amounts are decimal strings that are not guaranteed to be in canonical form (e.g. "145.0"
 * vs "145.00" represent the same value). Compare by cents, not raw string equality, so equivalent
 * amounts are treated as unchanged regardless of how the caller formatted them.
 */
function isMoneyAmountUnchanged(current: string | null, next: string): boolean {
  return current !== null && moneyToCents(current) === moneyToCents(next);
}

function isListingFeeTermsSurfaceUnchanged(state: MarketplaceListingState, next: ListingFeeTermsSurface): boolean {
  return (
    isMoneyAmountUnchanged(state.marketplaceSalesFeeUnitAmount, next.marketplaceSalesFeeUnitAmount) &&
    isMoneyAmountUnchanged(state.sellerNetUnitAmount, next.sellerNetUnitAmount) &&
    state.shippingAllowancePercentageBps === next.shippingAllowancePercentageBps &&
    state.termsScheduleId === next.termsScheduleId &&
    state.termsAgreementId === next.termsAgreementId
  );
}

type ListingPriceSurface = ListingFeeTermsSurface & Readonly<{ priceAmount: string }>;

function isListingPriceSurfaceUnchanged(state: MarketplaceListingState, next: ListingPriceSurface): boolean {
  return isMoneyAmountUnchanged(state.priceAmount, next.priceAmount) && isListingFeeTermsSurfaceUnchanged(state, next);
}

function isPurchaseLimitsUnchanged(
  current: MarketplaceListingPurchaseLimits,
  next: MarketplaceListingPurchaseLimits,
): boolean {
  return (
    current.maxUnitsPerOrder === next.maxUnitsPerOrder &&
    current.maxUnitsPerDay === next.maxUnitsPerDay &&
    current.maxUnitsPerCustomerAccount === next.maxUnitsPerCustomerAccount
  );
}

export type ListingStatus = "draft" | "active" | "paused" | "withdrawn";

export type MarketplaceListingPurchaseLimits = Readonly<{
  maxUnitsPerOrder: number | null;
  maxUnitsPerDay: number | null;
  maxUnitsPerCustomerAccount: number | null;
}>;

export type MarketplaceListingPhotoAssetRole = "source" | "thumbnail" | "search-card" | "catalog-detail";

export type MarketplaceListingPhotoAssetVariant = Readonly<{
  role: MarketplaceListingPhotoAssetRole;
  width: number;
  height: number;
  density: 1 | 2 | null;
  mediaType: "image/webp";
  storageKey: string;
  publicUrl: string;
  byteSize: number;
  generatedAt: string;
}>;

export type MarketplaceListingPhotoAssetSet = Readonly<{
  kind: "listing-photo";
  sourceHash: string;
  source: MarketplaceListingPhotoAssetVariant;
  variants: readonly MarketplaceListingPhotoAssetVariant[];
}>;

export type MarketplaceListingPhoto = Readonly<{
  photoId: string;
  originalFilename: string | null;
  altText: string | null;
  sortOrder: number;
  uploadedAt: string;
  assetSet: MarketplaceListingPhotoAssetSet;
}>;

export type MarketplaceGradedCardDetails = Readonly<{
  gradingCompany: string;
  grade: string;
  certificationNumber: string | null;
  population: Readonly<{
    populationAtGrade: number | null;
    populationHigher: number | null;
    source: string | null;
    asOf: string | null;
  }> | null;
  conditionDescriptors: string[];
}>;

type MarketplaceGradingCompanyPolicy = Readonly<{
  gradingCompany: string;
  certificationNumberPattern: RegExp;
  certificationNumberDescription: string;
  labels: readonly string[];
}>;

export const marketplaceGradingCompanyPolicies = {
  PSA: {
    gradingCompany: "PSA",
    certificationNumberPattern: /^\d{8,10}$/,
    certificationNumberDescription: "8 to 10 digits",
    labels: ["Authentic", "Authentic Altered"],
  },
  BGS: {
    gradingCompany: "BGS",
    certificationNumberPattern: /^\d{8,10}$/,
    certificationNumberDescription: "8 to 10 digits",
    labels: ["Authentic"],
  },
  CGC: {
    gradingCompany: "CGC",
    certificationNumberPattern: /^\d{7,10}$/,
    certificationNumberDescription: "7 to 10 digits",
    labels: ["Authentic"],
  },
  SGC: {
    gradingCompany: "SGC",
    certificationNumberPattern: /^\d{6,10}$/,
    certificationNumberDescription: "6 to 10 digits",
    labels: ["Authentic"],
  },
} as const satisfies Record<string, MarketplaceGradingCompanyPolicy>;

const gradingCompanyAliases = new Map<string, keyof typeof marketplaceGradingCompanyPolicies>([
  ["BGS BECKETT", "BGS"],
  ["BECKETT", "BGS"],
]);

const numericGradeValues = new Set(
  Array.from({ length: 19 }, (_, index) => {
    const value = 1 + index * 0.5;
    return Number.isInteger(value) ? String(value) : value.toFixed(1);
  }),
);

const gradeLabelAliases = new Map(
  [
    ["pristine 10", "10"],
    ["gem mint 10", "10"],
    ["mint 9.5", "9.5"],
    ["mint 9", "9"],
    ["nm mt 8.5", "8.5"],
    ["near mint mint 8.5", "8.5"],
    ["nm mt 8", "8"],
    ["near mint mint 8", "8"],
    ["nm 7", "7"],
    ["near mint 7", "7"],
    ["ex 6", "6"],
    ["excellent 6", "6"],
    ["ex 5", "5"],
    ["excellent 5", "5"],
    ["vg 4", "4"],
    ["very good 4", "4"],
    ["good 3", "3"],
    ["good 2", "2"],
    ["poor 1", "1"],
  ].map(([label, grade]) => [normalizeGradeLabelAlias(label), grade] as const),
);

export type MarketplaceListingState = Readonly<{
  listingId: ListingId | null;
  accountId: AccountId | null;
  inventoryItemId: string | null;
  catalogItemId: CatalogItemId | null;
  productId: ProductKey | null;
  itemLanguageCode: string | null;
  itemTitle: string | null;
  itemSubtitle: string | null;
  selectedOptions: readonly { dimensionId: string; optionId: string }[];
  productSummary: string | null;
  productMeasureSnapshot: ProductMeasureSnapshot | null;
  gradedCard: MarketplaceGradedCardDetails | null;
  storageLocationName: string | null;
  shipFromCode: string | null;
  shipFromAddress: AddressSnapshot | null;
  priceAmount: string | null;
  marketplaceSalesFeeUnitAmount: string | null;
  sellerNetUnitAmount: string | null;
  shippingAllowancePercentageBps: number;
  termsScheduleId: string | null;
  termsAgreementId: string | null;
  termsResolvedAt: string | null;
  feeQuoteFingerprint: string | null;
  quantityCap: number;
  purchaseLimits: MarketplaceListingPurchaseLimits;
  listingPhotos: readonly MarketplaceListingPhoto[];
  status: ListingStatus;
}>;

export const initialMarketplaceListingState: MarketplaceListingState = {
  listingId: null,
  accountId: null,
  inventoryItemId: null,
  catalogItemId: null,
  productId: null,
  itemLanguageCode: null,
  itemTitle: null,
  itemSubtitle: null,
  selectedOptions: [],
  productSummary: null,
  productMeasureSnapshot: null,
  gradedCard: null,
  storageLocationName: null,
  shipFromCode: null,
  shipFromAddress: null,
  priceAmount: null,
  marketplaceSalesFeeUnitAmount: null,
  sellerNetUnitAmount: null,
  shippingAllowancePercentageBps: 500,
  termsScheduleId: null,
  termsAgreementId: null,
  termsResolvedAt: null,
  feeQuoteFingerprint: null,
  quantityCap: 0,
  purchaseLimits: {
    maxUnitsPerOrder: null,
    maxUnitsPerDay: null,
    maxUnitsPerCustomerAccount: null,
  },
  listingPhotos: [],
  status: "draft",
};

export type CreateListingCommand = Readonly<{
  type: "CreateListing";
  listingId: ListingId;
  accountId: AccountId;
  inventoryItemId: string;
  catalogItemId: CatalogItemId;
  productId: ProductKey;
  itemLanguageCode?: string | null;
  itemTitle: string | null;
  itemSubtitle: string | null;
  selectedOptions: readonly { dimensionId: string; optionId: string }[];
  productSummary: string | null;
  productMeasureSnapshot?: ProductMeasureSnapshot | null;
  gradedCard?: MarketplaceGradedCardDetails | null;
  storageLocationName: string | null;
  shipFromCode: string | null;
  shipFromAddress: AddressSnapshot;
  priceAmount: string;
  marketplaceSalesFeeUnitAmount: string;
  sellerNetUnitAmount: string;
  shippingAllowancePercentageBps?: number;
  termsScheduleId?: string | null;
  termsAgreementId?: string | null;
  termsResolvedAt?: string | null;
  feeQuoteFingerprint: string;
  quantityCap: number;
  purchaseLimits?: Partial<MarketplaceListingPurchaseLimits> | null;
  listingPhotos?: readonly MarketplaceListingPhoto[] | null;
}>;

export type UpdateListingPriceCommand = Readonly<{
  type: "UpdateListingPrice";
  priceAmount: string;
  marketplaceSalesFeeUnitAmount: string;
  sellerNetUnitAmount: string;
  shippingAllowancePercentageBps?: number;
  termsScheduleId?: string | null;
  termsAgreementId?: string | null;
  termsResolvedAt?: string | null;
  feeQuoteFingerprint: string;
}>;

export type UpdateListingQuantityCapCommand = Readonly<{
  type: "UpdateListingQuantityCap";
  quantityCap: number;
  purchaseLimits?: Partial<MarketplaceListingPurchaseLimits> | null;
  marketplaceSalesFeeUnitAmount: string;
  sellerNetUnitAmount: string;
  shippingAllowancePercentageBps?: number;
  termsScheduleId?: string | null;
  termsAgreementId?: string | null;
  termsResolvedAt?: string | null;
  feeQuoteFingerprint: string;
}>;

export type UpdateListingPurchaseLimitsCommand = Readonly<{
  type: "UpdateListingPurchaseLimits";
  purchaseLimits: Partial<MarketplaceListingPurchaseLimits> | null;
}>;

export type AddListingPhotosCommand = Readonly<{
  type: "AddListingPhotos";
  photos: readonly MarketplaceListingPhoto[];
}>;

export type PublishListingCommand = Readonly<{
  type: "PublishListing";
  marketplaceSalesFeeUnitAmount: string;
  sellerNetUnitAmount: string;
  shippingAllowancePercentageBps?: number;
  termsScheduleId?: string | null;
  termsAgreementId?: string | null;
  termsResolvedAt?: string | null;
  feeQuoteFingerprint: string;
}>;
export type PauseListingCommand = Readonly<{ type: "PauseListing" }>;
export type AutoUnlistListingCommand = Readonly<{
  type: "AutoUnlistListing";
  reportId: string;
  reportCount: number;
  threshold: number;
  autoUnlistedAt: string;
}>;
export type WithdrawListingCommand = Readonly<{ type: "WithdrawListing" }>;

export type MarketplaceListingCommand =
  | CreateListingCommand
  | UpdateListingPriceCommand
  | UpdateListingQuantityCapCommand
  | UpdateListingPurchaseLimitsCommand
  | AddListingPhotosCommand
  | PublishListingCommand
  | PauseListingCommand
  | AutoUnlistListingCommand
  | WithdrawListingCommand;

export type ListingCreatedEvent = DomainEvent<
  "marketplace.listing.created",
  Readonly<{
    listingId: ListingId;
    accountId: AccountId;
    inventoryItemId: string;
    catalogItemId: CatalogItemId;
    productId: ProductKey;
    itemLanguageCode: string | null;
    itemTitle: string | null;
    itemSubtitle: string | null;
    selectedOptions: { dimensionId: string; optionId: string }[];
    productSummary: string | null;
    productMeasureSnapshot: ProductMeasureSnapshot | null;
    gradedCard: MarketplaceGradedCardDetails | null;
    storageLocationName: string | null;
    shipFromCode: string | null;
    shipFromAddress: AddressSnapshot;
    priceAmount: string;
    marketplaceSalesFeeUnitAmount: string;
    sellerNetUnitAmount: string;
    shippingAllowancePercentageBps: number;
    termsScheduleId: string | null;
    termsAgreementId: string | null;
    termsResolvedAt: string | null;
    feeQuoteFingerprint: string;
    quantityCap: number;
    purchaseLimits: MarketplaceListingPurchaseLimits;
    listingPhotos: MarketplaceListingPhoto[];
  }>
>;
export type ListingPriceUpdatedEvent = DomainEvent<
  "marketplace.listing.price-updated",
  Readonly<{
    priceAmount: string;
    marketplaceSalesFeeUnitAmount: string;
    sellerNetUnitAmount: string;
    shippingAllowancePercentageBps: number;
    termsScheduleId: string | null;
    termsAgreementId: string | null;
    termsResolvedAt: string | null;
    feeQuoteFingerprint: string;
  }>
>;
export type ListingQuantityCapUpdatedEvent = DomainEvent<
  "marketplace.listing.quantity-cap-updated",
  Readonly<{
    quantityCap: number;
    purchaseLimits: MarketplaceListingPurchaseLimits;
    marketplaceSalesFeeUnitAmount: string;
    sellerNetUnitAmount: string;
    shippingAllowancePercentageBps: number;
    termsScheduleId: string | null;
    termsAgreementId: string | null;
    termsResolvedAt: string | null;
    feeQuoteFingerprint: string;
  }>
>;
export type ListingPurchaseLimitsUpdatedEvent = DomainEvent<
  "marketplace.listing.purchase-limits-updated",
  Readonly<{
    purchaseLimits: MarketplaceListingPurchaseLimits;
  }>
>;
export type ListingPhotosAddedEvent = DomainEvent<
  "marketplace.listing.photos-added",
  Readonly<{
    listingPhotos: MarketplaceListingPhoto[];
  }>
>;
export type ListingPublishedEvent = DomainEvent<
  "marketplace.listing.published",
  Readonly<{
    marketplaceSalesFeeUnitAmount: string;
    sellerNetUnitAmount: string;
    shippingAllowancePercentageBps: number;
    termsScheduleId: string | null;
    termsAgreementId: string | null;
    termsResolvedAt: string | null;
    feeQuoteFingerprint: string;
  }>
>;
export type ListingPausedEvent = DomainEvent<"marketplace.listing.paused", Readonly<Record<string, never>>>;
export type ListingAutoUnlistedEvent = DomainEvent<
  "marketplace.listing.auto-unlisted",
  Readonly<{
    reportId: string;
    reportCount: number;
    threshold: number;
    autoUnlistedAt: string;
  }>
>;
export type ListingWithdrawnEvent = DomainEvent<"marketplace.listing.withdrawn", Readonly<Record<string, never>>>;

export type MarketplaceListingEvent =
  | ListingCreatedEvent
  | ListingPriceUpdatedEvent
  | ListingQuantityCapUpdatedEvent
  | ListingPurchaseLimitsUpdatedEvent
  | ListingPhotosAddedEvent
  | ListingPublishedEvent
  | ListingPausedEvent
  | ListingAutoUnlistedEvent
  | ListingWithdrawnEvent;

export const decideMarketplaceListing: AggregateDecider<
  MarketplaceListingState,
  MarketplaceListingCommand,
  MarketplaceListingEvent
> = (state, command) => {
  switch (command.type) {
    case "CreateListing":
      assert(state.listingId === null, "Listing has already been created.");
      return [
        {
          type: "marketplace.listing.created",
          data: {
            listingId: command.listingId,
            accountId: command.accountId,
            inventoryItemId: command.inventoryItemId.trim(),
            catalogItemId: command.catalogItemId.trim() as CatalogItemId,
            productId: command.productId,
            itemLanguageCode: command.itemLanguageCode?.trim() || null,
            itemTitle: command.itemTitle?.trim() ?? null,
            itemSubtitle: command.itemSubtitle?.trim() ?? null,
            selectedOptions: command.selectedOptions.map((selection) => ({
              dimensionId: selection.dimensionId.trim(),
              optionId: selection.optionId.trim(),
            })),
            productSummary: command.productSummary?.trim() ?? null,
            productMeasureSnapshot: command.productMeasureSnapshot ?? null,
            gradedCard: normalizeGradedCardDetails(command.gradedCard ?? null),
            storageLocationName: command.storageLocationName?.trim() ?? null,
            shipFromCode: command.shipFromCode?.trim() ?? null,
            shipFromAddress: normalizeAddressSnapshot(command.shipFromAddress, "Ship-from address"),
            priceAmount: normalizeMoneyAmount(command.priceAmount),
            marketplaceSalesFeeUnitAmount: normalizeMoneyAmount(command.marketplaceSalesFeeUnitAmount, {
              fieldName: "Marketplace sales fee unit amount",
              allowZero: true,
            }),
            sellerNetUnitAmount: normalizeMoneyAmount(command.sellerNetUnitAmount, {
              fieldName: "Seller net unit amount",
              allowZero: true,
            }),
            shippingAllowancePercentageBps: normalizePercentageBps(
              command.shippingAllowancePercentageBps ?? 500,
              "Shipping allowance percentage",
            ),
            termsScheduleId: command.termsScheduleId?.trim() ?? null,
            termsAgreementId: command.termsAgreementId?.trim() ?? null,
            termsResolvedAt: command.termsResolvedAt?.trim() ?? null,
            feeQuoteFingerprint: normalizeRequiredText(
              command.feeQuoteFingerprint,
              "Fee quote fingerprint is required.",
            ),
            quantityCap: ensurePositiveInteger(
              command.quantityCap,
              "Listing quantity cap must be a positive whole number.",
            ),
            purchaseLimits: normalizePurchaseLimits(command.purchaseLimits, command.quantityCap),
            listingPhotos: normalizeListingPhotos(command.listingPhotos ?? []),
          },
        },
      ];
    case "UpdateListingPrice": {
      assert(state.listingId !== null, "Listing must be created first.");
      assert(state.status !== "withdrawn", "Withdrawn listings cannot be updated.");
      const data = {
        priceAmount: normalizeMoneyAmount(command.priceAmount),
        marketplaceSalesFeeUnitAmount: normalizeMoneyAmount(command.marketplaceSalesFeeUnitAmount, {
          fieldName: "Marketplace sales fee unit amount",
          allowZero: true,
        }),
        sellerNetUnitAmount: normalizeMoneyAmount(command.sellerNetUnitAmount, {
          fieldName: "Seller net unit amount",
          allowZero: true,
        }),
        shippingAllowancePercentageBps: normalizePercentageBps(
          command.shippingAllowancePercentageBps ?? 500,
          "Shipping allowance percentage",
        ),
        termsScheduleId: command.termsScheduleId?.trim() ?? null,
        termsAgreementId: command.termsAgreementId?.trim() ?? null,
        termsResolvedAt: command.termsResolvedAt?.trim() ?? null,
        feeQuoteFingerprint: normalizeRequiredText(command.feeQuoteFingerprint, "Fee quote fingerprint is required."),
      };

      if (isListingPriceSurfaceUnchanged(state, data)) {
        return [];
      }

      return [{ type: "marketplace.listing.price-updated", data }];
    }
    case "UpdateListingQuantityCap": {
      assert(state.listingId !== null, "Listing must be created first.");
      assert(state.status !== "withdrawn", "Withdrawn listings cannot be updated.");
      const quantityCap = ensurePositiveInteger(
        command.quantityCap,
        "Listing quantity cap must be a positive whole number.",
      );
      const purchaseLimits = normalizePurchaseLimits(command.purchaseLimits ?? state.purchaseLimits, quantityCap);
      const data = {
        quantityCap,
        purchaseLimits,
        marketplaceSalesFeeUnitAmount: normalizeMoneyAmount(command.marketplaceSalesFeeUnitAmount, {
          fieldName: "Marketplace sales fee unit amount",
          allowZero: true,
        }),
        sellerNetUnitAmount: normalizeMoneyAmount(command.sellerNetUnitAmount, {
          fieldName: "Seller net unit amount",
          allowZero: true,
        }),
        shippingAllowancePercentageBps: normalizePercentageBps(
          command.shippingAllowancePercentageBps ?? 500,
          "Shipping allowance percentage",
        ),
        termsScheduleId: command.termsScheduleId?.trim() ?? null,
        termsAgreementId: command.termsAgreementId?.trim() ?? null,
        termsResolvedAt: command.termsResolvedAt?.trim() ?? null,
        feeQuoteFingerprint: normalizeRequiredText(command.feeQuoteFingerprint, "Fee quote fingerprint is required."),
      };

      if (
        state.quantityCap === quantityCap &&
        isPurchaseLimitsUnchanged(state.purchaseLimits, purchaseLimits) &&
        isListingFeeTermsSurfaceUnchanged(state, data)
      ) {
        return [];
      }

      return [{ type: "marketplace.listing.quantity-cap-updated", data }];
    }
    case "UpdateListingPurchaseLimits": {
      assert(state.listingId !== null, "Listing must be created first.");
      assert(state.status !== "withdrawn", "Withdrawn listings cannot be updated.");
      const purchaseLimits = normalizePurchaseLimits(command.purchaseLimits, state.quantityCap);

      if (isPurchaseLimitsUnchanged(state.purchaseLimits, purchaseLimits)) {
        return [];
      }

      return [{ type: "marketplace.listing.purchase-limits-updated", data: { purchaseLimits } }];
    }
    case "AddListingPhotos":
      assert(state.listingId !== null, "Listing must be created first.");
      assert(state.status !== "withdrawn", "Withdrawn listings cannot be updated.");
      return [
        {
          type: "marketplace.listing.photos-added",
          data: {
            listingPhotos: mergeListingPhotos(state.listingPhotos, normalizeListingPhotos(command.photos)),
          },
        },
      ];
    case "PublishListing":
      assert(state.listingId !== null, "Listing must be created first.");
      assert(state.status !== "withdrawn", "Withdrawn listings cannot be published.");
      assert(state.status !== "active", "Listing is already active.");
      assert(state.productMeasureSnapshot, "Listings require a resolved shipping measure before publication.");
      assert(
        !requiresListingPhotoEvidence(state) || state.listingPhotos.length > 0,
        "Pristine, Mint, and graded-card listings require at least one listing photo before publication; graded-card listings must include a slab photo.",
      );
      return [
        {
          type: "marketplace.listing.published",
          data: {
            marketplaceSalesFeeUnitAmount: normalizeMoneyAmount(command.marketplaceSalesFeeUnitAmount, {
              fieldName: "Marketplace sales fee unit amount",
              allowZero: true,
            }),
            sellerNetUnitAmount: normalizeMoneyAmount(command.sellerNetUnitAmount, {
              fieldName: "Seller net unit amount",
              allowZero: true,
            }),
            shippingAllowancePercentageBps: normalizePercentageBps(
              command.shippingAllowancePercentageBps ?? 500,
              "Shipping allowance percentage",
            ),
            termsScheduleId: command.termsScheduleId?.trim() ?? null,
            termsAgreementId: command.termsAgreementId?.trim() ?? null,
            termsResolvedAt: command.termsResolvedAt?.trim() ?? null,
            feeQuoteFingerprint: normalizeRequiredText(
              command.feeQuoteFingerprint,
              "Fee quote fingerprint is required.",
            ),
          },
        },
      ];
    case "PauseListing":
      assert(state.listingId !== null, "Listing must be created first.");
      if (state.status === "paused") {
        return [];
      }
      assert(state.status === "active", "Only active listings can be paused.");
      return [{ type: "marketplace.listing.paused", data: {} }];
    case "AutoUnlistListing":
      assert(state.listingId !== null, "Listing must be created first.");
      if (state.status !== "active") {
        return [];
      }
      assert(Number.isInteger(command.reportCount) && command.reportCount > 0, "Report count must be positive.");
      assert(Number.isInteger(command.threshold) && command.threshold > 0, "Report threshold must be positive.");
      assert(command.reportCount >= command.threshold, "Report threshold has not been reached.");
      return [
        {
          type: "marketplace.listing.auto-unlisted",
          data: {
            reportId: normalizeRequiredText(command.reportId, "Report id is required."),
            reportCount: command.reportCount,
            threshold: command.threshold,
            autoUnlistedAt: normalizeRequiredText(command.autoUnlistedAt, "Auto-unlist timestamp is required."),
          },
        },
      ];
    case "WithdrawListing":
      assert(state.listingId !== null, "Listing must be created first.");
      assert(state.status !== "withdrawn", "Listing has already been withdrawn.");
      return [{ type: "marketplace.listing.withdrawn", data: {} }];
    default:
      return assertNever(command);
  }
};

export const evolveMarketplaceListing: AggregateEvolver<MarketplaceListingState, MarketplaceListingEvent> = (
  state,
  event,
) => {
  switch (event.type) {
    case "marketplace.listing.created":
      return {
        listingId: event.data.listingId,
        accountId: event.data.accountId,
        inventoryItemId: event.data.inventoryItemId,
        catalogItemId: event.data.catalogItemId,
        productId: event.data.productId,
        itemLanguageCode: event.data.itemLanguageCode,
        itemTitle: event.data.itemTitle,
        itemSubtitle: event.data.itemSubtitle,
        selectedOptions: event.data.selectedOptions,
        productSummary: event.data.productSummary,
        productMeasureSnapshot: event.data.productMeasureSnapshot ?? null,
        gradedCard: event.data.gradedCard,
        storageLocationName: event.data.storageLocationName,
        shipFromCode: event.data.shipFromCode,
        shipFromAddress: event.data.shipFromAddress,
        priceAmount: event.data.priceAmount,
        marketplaceSalesFeeUnitAmount: event.data.marketplaceSalesFeeUnitAmount,
        sellerNetUnitAmount: event.data.sellerNetUnitAmount,
        shippingAllowancePercentageBps: event.data.shippingAllowancePercentageBps,
        termsScheduleId: event.data.termsScheduleId,
        termsAgreementId: event.data.termsAgreementId,
        termsResolvedAt: event.data.termsResolvedAt,
        feeQuoteFingerprint: event.data.feeQuoteFingerprint,
        quantityCap: event.data.quantityCap,
        purchaseLimits: event.data.purchaseLimits ?? initialMarketplaceListingState.purchaseLimits,
        listingPhotos: event.data.listingPhotos ?? [],
        status: "draft",
      };
    case "marketplace.listing.price-updated":
      return {
        ...state,
        priceAmount: event.data.priceAmount,
        marketplaceSalesFeeUnitAmount: event.data.marketplaceSalesFeeUnitAmount,
        sellerNetUnitAmount: event.data.sellerNetUnitAmount,
        shippingAllowancePercentageBps: event.data.shippingAllowancePercentageBps,
        termsScheduleId: event.data.termsScheduleId,
        termsAgreementId: event.data.termsAgreementId,
        termsResolvedAt: event.data.termsResolvedAt,
        feeQuoteFingerprint: event.data.feeQuoteFingerprint,
      };
    case "marketplace.listing.purchase-limits-updated":
      return {
        ...state,
        purchaseLimits: event.data.purchaseLimits,
      };
    case "marketplace.listing.photos-added":
      return {
        ...state,
        listingPhotos: event.data.listingPhotos,
      };
    case "marketplace.listing.quantity-cap-updated":
      return {
        ...state,
        quantityCap: event.data.quantityCap,
        marketplaceSalesFeeUnitAmount: event.data.marketplaceSalesFeeUnitAmount,
        sellerNetUnitAmount: event.data.sellerNetUnitAmount,
        shippingAllowancePercentageBps: event.data.shippingAllowancePercentageBps,
        termsScheduleId: event.data.termsScheduleId,
        termsAgreementId: event.data.termsAgreementId,
        termsResolvedAt: event.data.termsResolvedAt,
        feeQuoteFingerprint: event.data.feeQuoteFingerprint,
      };
    case "marketplace.listing.published":
      return {
        ...state,
        marketplaceSalesFeeUnitAmount: event.data.marketplaceSalesFeeUnitAmount,
        sellerNetUnitAmount: event.data.sellerNetUnitAmount,
        shippingAllowancePercentageBps: event.data.shippingAllowancePercentageBps,
        termsScheduleId: event.data.termsScheduleId,
        termsAgreementId: event.data.termsAgreementId,
        termsResolvedAt: event.data.termsResolvedAt,
        feeQuoteFingerprint: event.data.feeQuoteFingerprint,
        status: "active",
      };
    case "marketplace.listing.paused":
      return { ...state, status: "paused" };
    case "marketplace.listing.auto-unlisted":
      return { ...state, status: "paused" };
    case "marketplace.listing.withdrawn":
      return { ...state, status: "withdrawn" };
    default:
      return assertNever(event);
  }
};

function normalizeOptionalText(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? "";
  return normalized.length > 0 ? normalized : null;
}

export function requiresListingPhotoEvidence(
  listing: Readonly<{
    selectedOptions: MarketplaceListingState["selectedOptions"];
    productSummary: MarketplaceListingState["productSummary"];
    gradedCard?: MarketplaceListingState["gradedCard"];
  }>,
): boolean {
  if (listing.gradedCard) {
    return true;
  }

  const values = [
    listing.productSummary ?? "",
    ...listing.selectedOptions.flatMap((selection) => [selection.dimensionId, selection.optionId]),
  ];

  return values.some((value) => highConditionTokenRequiresPhoto(value));
}

function normalizeRequiredText(value: string, message: string): string {
  const normalized = value.trim();
  assert(normalized.length > 0, message);
  return normalized;
}

function normalizePurchaseLimitValue(
  value: number | null | undefined,
  fieldName: string,
  quantityCap: number,
): number | null {
  if (value === null || value === undefined) {
    return null;
  }

  assert(Number.isInteger(value) && value > 0, `${fieldName} must be a positive whole number.`);
  assert(value <= quantityCap, `${fieldName} cannot exceed the listing quantity cap.`);
  return value;
}

function normalizePurchaseLimits(
  limits: Partial<MarketplaceListingPurchaseLimits> | null | undefined,
  quantityCapInput: number,
): MarketplaceListingPurchaseLimits {
  const quantityCap = ensurePositiveInteger(quantityCapInput, "Listing quantity cap must be a positive whole number.");
  const normalized = {
    maxUnitsPerOrder: normalizePurchaseLimitValue(limits?.maxUnitsPerOrder, "Maximum units per order", quantityCap),
    maxUnitsPerDay: normalizePurchaseLimitValue(limits?.maxUnitsPerDay, "Maximum units per day", quantityCap),
    maxUnitsPerCustomerAccount: normalizePurchaseLimitValue(
      limits?.maxUnitsPerCustomerAccount,
      "Maximum units per customer account",
      quantityCap,
    ),
  };

  if (normalized.maxUnitsPerOrder !== null && normalized.maxUnitsPerDay !== null) {
    assert(
      normalized.maxUnitsPerOrder <= normalized.maxUnitsPerDay,
      "Maximum units per order cannot exceed maximum units per day.",
    );
  }

  if (normalized.maxUnitsPerDay !== null && normalized.maxUnitsPerCustomerAccount !== null) {
    assert(
      normalized.maxUnitsPerDay <= normalized.maxUnitsPerCustomerAccount,
      "Maximum units per day cannot exceed maximum units per customer account.",
    );
  }

  if (normalized.maxUnitsPerOrder !== null && normalized.maxUnitsPerCustomerAccount !== null) {
    assert(
      normalized.maxUnitsPerOrder <= normalized.maxUnitsPerCustomerAccount,
      "Maximum units per order cannot exceed maximum units per customer account.",
    );
  }

  return normalized;
}

function normalizeListingPhotos(photos: readonly MarketplaceListingPhoto[]): MarketplaceListingPhoto[] {
  return photos.map((photo, index) => {
    const photoId = normalizeRequiredText(photo.photoId, "Listing photo id is required.");
    const uploadedAt = normalizeRequiredText(photo.uploadedAt, "Listing photo upload timestamp is required.");
    assert(
      Number.isInteger(photo.sortOrder) && photo.sortOrder >= 0,
      "Listing photo sort order must be zero or greater.",
    );

    return {
      photoId,
      originalFilename: normalizeOptionalText(photo.originalFilename),
      altText: normalizeOptionalText(photo.altText),
      sortOrder: photo.sortOrder ?? index,
      uploadedAt,
      assetSet: normalizeListingPhotoAssetSet(photo.assetSet),
    };
  });
}

function mergeListingPhotos(
  existing: readonly MarketplaceListingPhoto[],
  next: readonly MarketplaceListingPhoto[],
): MarketplaceListingPhoto[] {
  const byKey = new Map(existing.map((photo) => [photo.photoId, photo]));
  for (const photo of next) {
    byKey.set(photo.photoId, photo);
  }

  return [...byKey.values()].sort((left, right) =>
    left.sortOrder === right.sortOrder ? left.photoId.localeCompare(right.photoId) : left.sortOrder - right.sortOrder,
  );
}

function normalizeListingPhotoAssetSet(assetSet: MarketplaceListingPhoto["assetSet"]): MarketplaceListingPhotoAssetSet {
  assert(assetSet.kind === "listing-photo", "Listing photo asset set kind is invalid.");
  const sourceHash = normalizeRequiredText(assetSet.sourceHash, "Listing photo source hash is required.");

  return {
    kind: "listing-photo",
    sourceHash,
    source: normalizeListingPhotoAssetVariant(assetSet.source),
    variants: assetSet.variants.map(normalizeListingPhotoAssetVariant),
  };
}

function normalizeListingPhotoAssetVariant(
  variant: MarketplaceListingPhotoAssetVariant,
): MarketplaceListingPhotoAssetVariant {
  assert(
    ["source", "thumbnail", "search-card", "catalog-detail"].includes(variant.role),
    "Listing photo asset role is invalid.",
  );
  assert(variant.mediaType === "image/webp", "Listing photo assets must be stored as WebP.");
  assert(Number.isInteger(variant.width) && variant.width > 0, "Listing photo width is required.");
  assert(Number.isInteger(variant.height) && variant.height > 0, "Listing photo height is required.");
  assert(Number.isInteger(variant.byteSize) && variant.byteSize > 0, "Listing photo byte size is required.");
  assert(
    variant.density === null || variant.density === 1 || variant.density === 2,
    "Listing photo density is invalid.",
  );

  return {
    role: variant.role,
    width: variant.width,
    height: variant.height,
    density: variant.density,
    mediaType: "image/webp",
    storageKey: normalizeRequiredText(variant.storageKey, "Listing photo storage key is required."),
    publicUrl: normalizeRequiredText(variant.publicUrl, "Listing photo public URL is required."),
    byteSize: variant.byteSize,
    generatedAt: normalizeRequiredText(variant.generatedAt, "Listing photo generation timestamp is required."),
  };
}

function highConditionTokenRequiresPhoto(value: string): boolean {
  const tokens = value
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter(Boolean);

  return tokens.some((token, index) => {
    if (token === "pristine") {
      return true;
    }

    if (token !== "mint") {
      return false;
    }

    return tokens[index - 1] !== "near";
  });
}

function normalizeGradedCardDetails(details: MarketplaceGradedCardDetails | null): MarketplaceGradedCardDetails | null {
  if (!details) {
    return null;
  }

  const gradingCompany = normalizeGradingCompany(details.gradingCompany);
  const policy = marketplaceGradingCompanyPolicies[gradingCompany];
  const grade = normalizeGradedCardGrade(details.grade, policy);
  const certificationNumber = normalizeRequiredText(
    details.certificationNumber ?? "",
    "Graded cards require a certification number.",
  ).replaceAll(/\s+/g, "");
  assert(gradingCompany.length > 0, "Graded cards require a grading company.");
  assert(
    policy.certificationNumberPattern.test(certificationNumber),
    `${policy.gradingCompany} certification numbers must use ${policy.certificationNumberDescription}.`,
  );

  const population = details.population
    ? {
        populationAtGrade: details.population.populationAtGrade,
        populationHigher: details.population.populationHigher,
        source: normalizeOptionalText(details.population.source),
        asOf: normalizeOptionalText(details.population.asOf),
      }
    : null;

  if (population) {
    for (const value of [population.populationAtGrade, population.populationHigher]) {
      assert(
        value === null || (Number.isInteger(value) && value >= 0),
        "Population metadata must use whole numbers greater than or equal to zero.",
      );
    }
  }

  return {
    gradingCompany: policy.gradingCompany,
    grade,
    certificationNumber,
    population,
    conditionDescriptors: [
      ...new Set(
        details.conditionDescriptors
          .map((descriptor) => descriptor.trim())
          .filter((descriptor) => descriptor.length > 0),
      ),
    ],
  };
}

function normalizeGradingCompany(value: string): keyof typeof marketplaceGradingCompanyPolicies {
  const normalized = normalizeGradingCompanyAlias(value);
  const canonical = gradingCompanyAliases.get(normalized) ?? normalized;
  assert(normalized.length > 0, "Graded cards require a grading company.");
  assert(
    canonical in marketplaceGradingCompanyPolicies,
    `Grading company must be one of ${Object.keys(marketplaceGradingCompanyPolicies).join(", ")}.`,
  );

  return canonical as keyof typeof marketplaceGradingCompanyPolicies;
}

function normalizeGradedCardGrade(grade: string, policy: MarketplaceGradingCompanyPolicy): string {
  const normalized = grade.trim().replaceAll(/\s+/g, " ");
  assert(normalized.length > 0, "Graded cards require a grade.");

  const numeric = Number(normalized);
  if (Number.isFinite(numeric)) {
    const canonical = Number.isInteger(numeric) ? String(numeric) : numeric.toFixed(1);
    assert(
      numericGradeValues.has(canonical),
      `${policy.gradingCompany} grades must be 1 through 10 in 0.5-point steps or an allowed label.`,
    );
    return canonical;
  }

  const gradeAlias = gradeLabelAliases.get(normalizeGradeLabelAlias(normalized));
  if (gradeAlias) {
    return gradeAlias;
  }

  const label = policy.labels.find((allowed) => allowed.toLowerCase() === normalized.toLowerCase());
  assert(label, `${policy.gradingCompany} grades must be 1 through 10 in 0.5-point steps or an allowed label.`);
  return label;
}

function normalizeGradeLabelAlias(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9.]+/g, " ")
    .replaceAll(/\s+/g, " ")
    .trim();
}

function normalizeGradingCompanyAlias(value: string): string {
  return value
    .trim()
    .toUpperCase()
    .replaceAll(/[^A-Z0-9]+/g, " ")
    .replaceAll(/\s+/g, " ")
    .trim();
}
