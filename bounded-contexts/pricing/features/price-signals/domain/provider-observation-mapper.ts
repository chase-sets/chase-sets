import { createHash } from "node:crypto";
import type { ProviderObservationPolicyRevision } from "./provider-observation-policy";
import type { PriceSignalPolicyRevision } from "./price-signal-policy";
import type {
  HistoryObservation,
  ListingsCoverage,
  ListingsObservation,
  SalesObservation,
  TcgplayerSecondaryObservation,
} from "../integrations/tcgplayer/market-client";

type SalesMetadata = Omit<SalesObservation, "rows">;
type ListingsMetadata = Omit<ListingsObservation, "rows">;
type HistoryMetadata = Omit<HistoryObservation, "rows">;

export type ProviderMarketCaptureOutcome =
  | "recorded"
  | "recorded-with-rejections"
  | "no-secondary-observations"
  | "mapping-unresolved"
  | "provider-unavailable"
  | "configuration-invalid"
  | "disabled";

export type ProviderMarketCaptureHeader = Readonly<{
  captureId: string;
  providerKey: string;
  catalogItemId: string;
  externalKey: string;
  signalPassStartedAt: string;
  signalPolicyRevisionId: string;
  productsPerPass: number;
  captureStartedAt: string;
  captureCompletedAt: string;
  observationPolicyRevisionId: string | null;
  statHygienePolicyRevisionId: string | null;
  capturesPerPass: number | null;
  currency: string | null;
  authenticatedRequest: boolean;
  recordedSignalCount: number;
  unresolvedSignalCount: number;
  outcomeKind: ProviderMarketCaptureOutcome;
  reasonCode: string | null;
  rejectedRowCount: number;
  requestPosture: Readonly<{
    salesOffset: 0;
    salesLimit: number;
    salesPageSize: number;
    salesPageBudget: number;
    salesConditions: readonly number[];
    salesLanguages: readonly number[];
    salesVariants: readonly number[];
    salesListingType: string;
    listingsVerifiedOnly: boolean;
    listingsPageSize: number;
    listingsPageBudget: number;
    listingsDeliveredCeiling: string;
    historyRange: "annual";
  }> | null;
  sales: SalesMetadata | null;
  listings: ListingsMetadata | null;
  history: HistoryMetadata | null;
}>;

export type ProviderSaleObservationRow = Readonly<{
  captureId: string;
  saleFingerprint: string;
  observedOccurrenceCount: number;
  providerCondition: string;
  providerVariant: string;
  providerLanguage: string;
  listingType: string;
  soldAt: string;
  quantity: number;
  unitPrice: string;
  orderShipping: string;
}>;

export type ProviderWeeklySaleBucketRow = Readonly<{
  providerKey: string;
  externalKey: string;
  catalogItemId: string;
  catalogProductKey: string | null;
  weekStart: string;
  providerCondition: string;
  providerVariant: string;
  providerLanguage: string;
  transactionCount: number;
  quantitySold: number;
  lowSaleAmount: string | null;
  highSaleAmount: string | null;
  lowDeliveredAmount: string | null;
  highDeliveredAmount: string | null;
  providerMarketAmount: string | null;
  captureId: string;
  observedAt: string;
}>;

export type ProviderListingSnapshotRow = Readonly<{
  providerKey: string;
  catalogItemId: string;
  providerVariant: string;
  providerLanguage: string;
  providerCondition: string;
  observedOn: string;
  distinctSellerCount: number;
  cheapestDeliveredAmount: string | null;
  secondCheapestDeliveredAmount: string | null;
  captureId: string;
  observedAt: string;
}>;

export type ProviderListingAskDepthRow = Readonly<{
  captureId: string;
  anonymousCaptureSellerOrdinal: number;
  providerCondition: string;
  deliveredAmount: string;
  coverage: ListingsCoverage;
}>;

export type ProviderObservationCapture = Readonly<{
  header: ProviderMarketCaptureHeader;
  sales: readonly ProviderSaleObservationRow[];
  weekly: readonly ProviderWeeklySaleBucketRow[];
  snapshots: readonly ProviderListingSnapshotRow[];
  askDepth: readonly ProviderListingAskDepthRow[];
}>;

export type ProviderObservationMappingInput = Readonly<{
  providerKey: string;
  catalogItemId: string;
  productExternalKey: string;
  catalogProductKeysBySku: ReadonlyMap<number, string>;
  signalPassStartedAt: string;
  signalPolicy: PriceSignalPolicyRevision;
  captureStartedAt: string;
  captureCompletedAt: string;
  observationPolicy: ProviderObservationPolicyRevision;
  statHygienePolicyRevisionId: string;
  authenticatedRequest: boolean;
  recordedSignalCount: number;
  unresolvedSignalCount: number;
  observation: TcgplayerSecondaryObservation;
}>;

export function mapProviderObservationCapture(input: ProviderObservationMappingInput): ProviderObservationCapture {
  const captureId = providerCaptureId(
    input.providerKey,
    input.catalogItemId,
    input.productExternalKey,
    input.captureStartedAt,
  );
  const sales = mapSales(captureId, input);
  const weekly = mapWeekly(captureId, input);
  const { snapshots, askDepth } = mapListings(captureId, input);
  const rejectedRowCount =
    input.observation.sales.rejectedRows +
    input.observation.listings.rejectedRows +
    input.observation.history.rejectedRows;
  const statuses = [
    input.observation.sales.status,
    input.observation.listings.status,
    input.observation.history.status,
  ];
  const outcomeKind: ProviderMarketCaptureOutcome = statuses.every((status) => status === "unavailable")
    ? "provider-unavailable"
    : statuses.every((status) => status !== "observed")
      ? "no-secondary-observations"
      : rejectedRowCount > 0
        ? "recorded-with-rejections"
        : "recorded";
  return {
    header: {
      captureId,
      providerKey: input.providerKey,
      catalogItemId: input.catalogItemId,
      externalKey: input.productExternalKey,
      signalPassStartedAt: input.signalPassStartedAt,
      signalPolicyRevisionId: input.signalPolicy.revisionId,
      productsPerPass: input.signalPolicy.value.productsPerPass,
      captureStartedAt: input.captureStartedAt,
      captureCompletedAt: input.captureCompletedAt,
      observationPolicyRevisionId: input.observationPolicy.revisionId,
      statHygienePolicyRevisionId: input.statHygienePolicyRevisionId,
      capturesPerPass: input.observationPolicy.value.capturesPerPass,
      currency: input.observationPolicy.value.currency,
      authenticatedRequest: input.authenticatedRequest,
      recordedSignalCount: input.recordedSignalCount,
      unresolvedSignalCount: input.unresolvedSignalCount,
      outcomeKind,
      reasonCode: null,
      rejectedRowCount,
      requestPosture: {
        salesOffset: 0,
        salesLimit: input.observationPolicy.value.sales.limit,
        salesPageSize: input.observationPolicy.value.sales.pageSize,
        salesPageBudget: input.observationPolicy.value.sales.pageBudget,
        salesConditions: input.observationPolicy.value.sales.conditions,
        salesLanguages: input.observationPolicy.value.sales.languages,
        salesVariants: input.observationPolicy.value.sales.variants,
        salesListingType: input.observationPolicy.value.sales.listingType,
        listingsVerifiedOnly: input.observationPolicy.value.listings.verifiedSellersOnly,
        listingsPageSize: input.observationPolicy.value.listings.pageSize,
        listingsPageBudget: input.observationPolicy.value.listings.pageBudget,
        listingsDeliveredCeiling: input.observationPolicy.value.listings.deliveredCeiling,
        historyRange: "annual",
      },
      sales: withoutRows(input.observation.sales),
      listings: withoutRows(input.observation.listings),
      history: withoutRows(input.observation.history),
    },
    sales,
    weekly,
    snapshots,
    askDepth,
  };
}

export function configurationInvalidCapture(
  input: Readonly<{
    providerKey: string;
    catalogItemId: string;
    productExternalKey: string;
    signalPassStartedAt: string;
    signalPolicy: PriceSignalPolicyRevision;
    captureStartedAt: string;
    completedAt: string;
    observationPolicyRevisionId: string | null;
    statHygienePolicyRevisionId: string | null;
    capturesPerPass: number | null;
    currency: string | null;
    recordedSignalCount: number;
    unresolvedSignalCount: number;
    reasonCode: "observation-policy-invalid" | "stat-hygiene-policy-invalid";
  }>,
): ProviderObservationCapture {
  return {
    header: {
      captureId: providerCaptureId(
        input.providerKey,
        input.catalogItemId,
        input.productExternalKey,
        input.captureStartedAt,
      ),
      providerKey: input.providerKey,
      catalogItemId: input.catalogItemId,
      externalKey: input.productExternalKey,
      signalPassStartedAt: input.signalPassStartedAt,
      signalPolicyRevisionId: input.signalPolicy.revisionId,
      productsPerPass: input.signalPolicy.value.productsPerPass,
      captureStartedAt: input.captureStartedAt,
      captureCompletedAt: input.completedAt,
      observationPolicyRevisionId: input.observationPolicyRevisionId,
      statHygienePolicyRevisionId: input.statHygienePolicyRevisionId,
      capturesPerPass: input.capturesPerPass,
      currency: input.currency,
      authenticatedRequest: false,
      recordedSignalCount: input.recordedSignalCount,
      unresolvedSignalCount: input.unresolvedSignalCount,
      outcomeKind: "configuration-invalid",
      reasonCode: input.reasonCode,
      rejectedRowCount: 0,
      requestPosture: null,
      sales: null,
      listings: null,
      history: null,
    },
    sales: [],
    weekly: [],
    snapshots: [],
    askDepth: [],
  };
}

export function providerCaptureId(
  providerKey: string,
  catalogItemId: string,
  productExternalKey: string,
  captureStartedAt: string,
): string {
  return createHash("sha256")
    .update([providerKey, catalogItemId, productExternalKey, captureStartedAt].join("\u001f"))
    .digest("hex");
}

function withoutRows<T extends Readonly<{ rows: readonly unknown[] }>>(value: T): Omit<T, "rows"> {
  const { rows: _discarded, ...metadata } = value;
  return metadata;
}

function mapSales(captureId: string, input: ProviderObservationMappingInput): ProviderSaleObservationRow[] {
  const grouped = new Map<string, ProviderSaleObservationRow>();
  for (const sale of input.observation.sales.rows) {
    const unitPrice = sale.purchasePrice.toFixed(2);
    const orderShipping = sale.shippingPrice.toFixed(2);
    const fingerprint = createHash("sha256")
      .update(
        [
          input.providerKey,
          input.catalogItemId,
          sale.condition,
          sale.variant,
          sale.language,
          sale.orderDate,
          String(sale.quantity),
          unitPrice,
          orderShipping,
          sale.listingType,
        ].join("\u001f"),
      )
      .digest("hex");
    const existing = grouped.get(fingerprint);
    grouped.set(
      fingerprint,
      existing
        ? { ...existing, observedOccurrenceCount: existing.observedOccurrenceCount + 1 }
        : {
            captureId,
            saleFingerprint: fingerprint,
            observedOccurrenceCount: 1,
            providerCondition: sale.condition,
            providerVariant: sale.variant,
            providerLanguage: sale.language,
            listingType: sale.listingType,
            soldAt: sale.orderDate,
            quantity: sale.quantity,
            unitPrice,
            orderShipping,
          },
    );
  }
  return [...grouped.values()].sort((a, b) => a.saleFingerprint.localeCompare(b.saleFingerprint));
}

function mapWeekly(captureId: string, input: ProviderObservationMappingInput): ProviderWeeklySaleBucketRow[] {
  const rows: ProviderWeeklySaleBucketRow[] = [];
  for (const history of input.observation.history.rows) {
    for (const bucket of history.buckets) {
      if (bucket.transactionCount <= 0) continue;
      rows.push({
        providerKey: input.providerKey,
        externalKey: `sku:${history.skuId}`,
        catalogItemId: input.catalogItemId,
        catalogProductKey: input.catalogProductKeysBySku.get(history.skuId) ?? null,
        weekStart: bucket.bucketStartDate.slice(0, 10),
        providerCondition: history.condition,
        providerVariant: history.variant,
        providerLanguage: history.language,
        transactionCount: bucket.transactionCount,
        quantitySold: bucket.quantitySold,
        lowSaleAmount: bucket.lowSalePrice,
        highSaleAmount: bucket.highSalePrice,
        lowDeliveredAmount: bucket.lowSalePriceWithShipping,
        highDeliveredAmount: bucket.highSalePriceWithShipping,
        providerMarketAmount: bucket.marketPrice,
        captureId,
        observedAt: input.captureStartedAt,
      });
    }
  }
  return rows;
}

function mapListings(
  captureId: string,
  input: ProviderObservationMappingInput,
): {
  snapshots: ProviderListingSnapshotRow[];
  askDepth: ProviderListingAskDepthRow[];
} {
  const sellerOrdinals = new Map<string, number>();
  const cheapestBySellerCondition = new Map<string, { ordinal: number; condition: string; amount: number }>();
  const cheapestBySellerSnapshotGrain = new Map<
    string,
    { ordinal: number; condition: string; amount: number; variant: string; language: string }
  >();
  for (const listing of input.observation.listings.rows) {
    // Provider identity is used only inside this reduction and never leaves it.
    const transientSellerIdentity = listing.sellerKey || listing.sellerId || listing.sellerName;
    if (!transientSellerIdentity) continue;
    let ordinal = sellerOrdinals.get(transientSellerIdentity);
    if (ordinal === undefined) {
      ordinal = sellerOrdinals.size + 1;
      sellerOrdinals.set(transientSellerIdentity, ordinal);
    }
    const delivered = listing.price + listing.sellerShippingPrice;
    const key = `${ordinal}\u001f${listing.condition}`;
    const existing = cheapestBySellerCondition.get(key);
    if (!existing || delivered < existing.amount) {
      cheapestBySellerCondition.set(key, {
        ordinal,
        condition: listing.condition,
        amount: delivered,
      });
    }
    const snapshotKey = [ordinal, listing.printing, listing.language, listing.condition].join("\u001f");
    const existingSnapshotAsk = cheapestBySellerSnapshotGrain.get(snapshotKey);
    if (!existingSnapshotAsk || delivered < existingSnapshotAsk.amount) {
      cheapestBySellerSnapshotGrain.set(snapshotKey, {
        ordinal,
        condition: listing.condition,
        amount: delivered,
        variant: listing.printing,
        language: listing.language,
      });
    }
  }
  sellerOrdinals.clear();

  const jointAsks = [...cheapestBySellerCondition.values()];
  const askDepth = jointAsks
    .map((ask) => ({
      captureId,
      anonymousCaptureSellerOrdinal: ask.ordinal,
      providerCondition: ask.condition,
      deliveredAmount: ask.amount.toFixed(2),
      coverage: input.observation.listings.coverage,
    }))
    .sort(
      (a, b) =>
        a.providerCondition.localeCompare(b.providerCondition) ||
        Number(a.deliveredAmount) - Number(b.deliveredAmount) ||
        a.anonymousCaptureSellerOrdinal - b.anonymousCaptureSellerOrdinal,
    );

  const snapshotAsks = [...cheapestBySellerSnapshotGrain.values()];
  const groups = new Map<string, typeof snapshotAsks>();
  for (const ask of snapshotAsks) {
    const key = `${ask.variant}\u001f${ask.language}\u001f${ask.condition}`;
    const group = groups.get(key) ?? [];
    group.push(ask);
    groups.set(key, group);
  }
  const snapshots = [...groups.values()].map((group) => {
    const ordered = [...group].sort((a, b) => a.amount - b.amount || a.ordinal - b.ordinal);
    const first = ordered[0]!;
    return {
      providerKey: input.providerKey,
      catalogItemId: input.catalogItemId,
      providerVariant: first.variant,
      providerLanguage: first.language,
      providerCondition: first.condition,
      observedOn: input.captureStartedAt.slice(0, 10),
      distinctSellerCount: new Set(ordered.map((entry) => entry.ordinal)).size,
      cheapestDeliveredAmount: ordered[0]?.amount.toFixed(2) ?? null,
      secondCheapestDeliveredAmount: ordered[1]?.amount.toFixed(2) ?? null,
      captureId,
      observedAt: input.captureStartedAt,
    };
  });
  return { snapshots, askDepth };
}
