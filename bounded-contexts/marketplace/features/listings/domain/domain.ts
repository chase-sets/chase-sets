import type {
  AggregateDecider,
  AggregateEvolver,
  DomainEvent,
} from "@chase-sets/event-core";
import type { AccountId, ListingId } from "@chase-sets/primitives/typed-ids";

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
    options.allowZero
      ? Number.parseFloat(normalized) >= 0
      : Number.parseFloat(normalized) > 0,
    `${fieldName} must be ${options.allowZero ? "zero or greater" : "greater than zero"}.`,
  );
  return normalized;
}

function normalizePercentageBps(value: number, fieldName: string): number {
  assert(Number.isInteger(value), `${fieldName} must be a whole number of basis points.`);
  assert(value >= 0, `${fieldName} must be zero or greater.`);
  return value;
}

export type ListingStatus = "draft" | "active" | "paused" | "withdrawn";

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

export type MarketplaceListingState = Readonly<{
  listingId: ListingId | null;
  accountId: AccountId | null;
  inventoryItemId: string | null;
  catalogItemId: string | null;
  productId: string | null;
  itemTitle: string | null;
  itemSubtitle: string | null;
  selectedOptions: readonly { dimensionId: string; optionId: string }[];
  productSummary: string | null;
  gradedCard: MarketplaceGradedCardDetails | null;
  storageLocationName: string | null;
  shipFromCode: string | null;
  priceAmount: string | null;
  marketplaceSalesFeeUnitAmount: string | null;
  sellerNetUnitAmount: string | null;
  shippingAllowancePercentageBps: number;
  termsScheduleId: string | null;
  termsAgreementId: string | null;
  termsResolvedAt: string | null;
  feeQuoteFingerprint: string | null;
  quantityCap: number;
  status: ListingStatus;
}>;

export const initialMarketplaceListingState: MarketplaceListingState = {
  listingId: null,
  accountId: null,
  inventoryItemId: null,
  catalogItemId: null,
  productId: null,
  itemTitle: null,
  itemSubtitle: null,
  selectedOptions: [],
  productSummary: null,
  gradedCard: null,
  storageLocationName: null,
  shipFromCode: null,
  priceAmount: null,
  marketplaceSalesFeeUnitAmount: null,
  sellerNetUnitAmount: null,
  shippingAllowancePercentageBps: 500,
  termsScheduleId: null,
  termsAgreementId: null,
  termsResolvedAt: null,
  feeQuoteFingerprint: null,
  quantityCap: 0,
  status: "draft",
};

export type CreateListingCommand = Readonly<{
  type: "CreateListing";
  listingId: ListingId;
  accountId: AccountId;
  inventoryItemId: string;
  catalogItemId: string;
  productId: string;
  itemTitle: string | null;
  itemSubtitle: string | null;
  selectedOptions: readonly { dimensionId: string; optionId: string }[];
  productSummary: string | null;
  gradedCard?: MarketplaceGradedCardDetails | null;
  storageLocationName: string | null;
  shipFromCode: string | null;
  priceAmount: string;
  marketplaceSalesFeeUnitAmount: string;
  sellerNetUnitAmount: string;
  shippingAllowancePercentageBps?: number;
  termsScheduleId?: string | null;
  termsAgreementId?: string | null;
  termsResolvedAt?: string | null;
  feeQuoteFingerprint: string;
  quantityCap: number;
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
  marketplaceSalesFeeUnitAmount: string;
  sellerNetUnitAmount: string;
  shippingAllowancePercentageBps?: number;
  termsScheduleId?: string | null;
  termsAgreementId?: string | null;
  termsResolvedAt?: string | null;
  feeQuoteFingerprint: string;
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
export type WithdrawListingCommand = Readonly<{ type: "WithdrawListing" }>;

export type MarketplaceListingCommand =
  | CreateListingCommand
  | UpdateListingPriceCommand
  | UpdateListingQuantityCapCommand
  | PublishListingCommand
  | PauseListingCommand
  | WithdrawListingCommand;

export type ListingCreatedEvent = DomainEvent<
  "marketplace.listing.created",
  Readonly<{
    listingId: ListingId;
    accountId: AccountId;
    inventoryItemId: string;
    catalogItemId: string;
    productId: string;
    itemTitle: string | null;
    itemSubtitle: string | null;
    selectedOptions: { dimensionId: string; optionId: string }[];
    productSummary: string | null;
    gradedCard: MarketplaceGradedCardDetails | null;
    storageLocationName: string | null;
    shipFromCode: string | null;
    priceAmount: string;
    marketplaceSalesFeeUnitAmount: string;
    sellerNetUnitAmount: string;
    shippingAllowancePercentageBps: number;
    termsScheduleId: string | null;
    termsAgreementId: string | null;
    termsResolvedAt: string | null;
    feeQuoteFingerprint: string;
    quantityCap: number;
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
    marketplaceSalesFeeUnitAmount: string;
    sellerNetUnitAmount: string;
    shippingAllowancePercentageBps: number;
    termsScheduleId: string | null;
    termsAgreementId: string | null;
    termsResolvedAt: string | null;
    feeQuoteFingerprint: string;
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
export type ListingPausedEvent = DomainEvent<
  "marketplace.listing.paused",
  Readonly<Record<string, never>>
>;
export type ListingWithdrawnEvent = DomainEvent<
  "marketplace.listing.withdrawn",
  Readonly<Record<string, never>>
>;

export type MarketplaceListingEvent =
  | ListingCreatedEvent
  | ListingPriceUpdatedEvent
  | ListingQuantityCapUpdatedEvent
  | ListingPublishedEvent
  | ListingPausedEvent
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
            catalogItemId: command.catalogItemId.trim(),
            productId: command.productId,
            itemTitle: command.itemTitle?.trim() ?? null,
            itemSubtitle: command.itemSubtitle?.trim() ?? null,
            selectedOptions: command.selectedOptions.map((selection) => ({
              dimensionId: selection.dimensionId.trim(),
              optionId: selection.optionId.trim(),
            })),
            productSummary: command.productSummary?.trim() ?? null,
            gradedCard: normalizeGradedCardDetails(command.gradedCard ?? null),
            storageLocationName: command.storageLocationName?.trim() ?? null,
            shipFromCode: command.shipFromCode?.trim() ?? null,
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
          },
        },
      ];
    case "UpdateListingPrice":
      assert(state.listingId !== null, "Listing must be created first.");
      assert(state.status !== "withdrawn", "Withdrawn listings cannot be updated.");
      return [
        {
          type: "marketplace.listing.price-updated",
          data: {
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
          },
        },
      ];
    case "UpdateListingQuantityCap":
      assert(state.listingId !== null, "Listing must be created first.");
      assert(state.status !== "withdrawn", "Withdrawn listings cannot be updated.");
      return [
        {
          type: "marketplace.listing.quantity-cap-updated",
          data: {
            quantityCap: ensurePositiveInteger(
              command.quantityCap,
              "Listing quantity cap must be a positive whole number.",
            ),
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
    case "PublishListing":
      assert(state.listingId !== null, "Listing must be created first.");
      assert(state.status !== "withdrawn", "Withdrawn listings cannot be published.");
      assert(state.status !== "active", "Listing is already active.");
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
    case "WithdrawListing":
      assert(state.listingId !== null, "Listing must be created first.");
      assert(state.status !== "withdrawn", "Listing has already been withdrawn.");
      return [{ type: "marketplace.listing.withdrawn", data: {} }];
    default:
      return assertNever(command);
  }
};

export const evolveMarketplaceListing: AggregateEvolver<
  MarketplaceListingState,
  MarketplaceListingEvent
> = (state, event) => {
  switch (event.type) {
    case "marketplace.listing.created":
      return {
        listingId: event.data.listingId,
        accountId: event.data.accountId,
        inventoryItemId: event.data.inventoryItemId,
        catalogItemId: event.data.catalogItemId,
        productId: event.data.productId,
        itemTitle: event.data.itemTitle,
        itemSubtitle: event.data.itemSubtitle,
        selectedOptions: event.data.selectedOptions,
        productSummary: event.data.productSummary,
        gradedCard: event.data.gradedCard,
        storageLocationName: event.data.storageLocationName,
        shipFromCode: event.data.shipFromCode,
        priceAmount: event.data.priceAmount,
        marketplaceSalesFeeUnitAmount: event.data.marketplaceSalesFeeUnitAmount,
        sellerNetUnitAmount: event.data.sellerNetUnitAmount,
        shippingAllowancePercentageBps: event.data.shippingAllowancePercentageBps,
        termsScheduleId: event.data.termsScheduleId,
        termsAgreementId: event.data.termsAgreementId,
        termsResolvedAt: event.data.termsResolvedAt,
        feeQuoteFingerprint: event.data.feeQuoteFingerprint,
        quantityCap: event.data.quantityCap,
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

function normalizeRequiredText(value: string, message: string): string {
  const normalized = value.trim();
  assert(normalized.length > 0, message);
  return normalized;
}

function normalizeGradedCardDetails(
  details: MarketplaceGradedCardDetails | null,
): MarketplaceGradedCardDetails | null {
  if (!details) {
    return null;
  }

  const gradingCompany = details.gradingCompany.trim();
  const grade = details.grade.trim();
  assert(gradingCompany.length > 0, "Graded cards require a grading company.");
  assert(grade.length > 0, "Graded cards require a grade.");

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
    gradingCompany,
    grade,
    certificationNumber: normalizeOptionalText(details.certificationNumber),
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
