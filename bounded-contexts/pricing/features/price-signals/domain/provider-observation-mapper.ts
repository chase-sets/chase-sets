import { createHash } from "node:crypto";
import type { SecondaryProduct, TcgplayerMarketObservationPosture } from "@chase-sets/tcgplayer-market-observations";
import type { ProviderObservationPolicyRevision } from "./provider-observation-policy";
import type { PriceSignalPolicyRevision } from "./price-signal-policy";

type SalesMetadata = Omit<SecondaryProduct["sales"], "rows" | "credentialsMode">;
type ListingsMetadata = Omit<SecondaryProduct["listings"], "rows" | "credentialsMode"> & {
  ownSellerExclusionApplied: false;
};
type HistoryMetadata = Omit<SecondaryProduct["history"], "rows" | "credentialsMode">;
export type ExecutedMarketObservationPosture = Omit<TcgplayerMarketObservationPosture, "timeoutMs">;

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
  requestPosture: ExecutedMarketObservationPosture | null;
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
  coverage: SecondaryProduct["listings"]["coverage"];
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
  recordedSignalCount: number;
  unresolvedSignalCount: number;
  executedPosture: TcgplayerMarketObservationPosture;
  observation: SecondaryProduct;
}>;

export function mapProviderObservationCapture(input: ProviderObservationMappingInput): ProviderObservationCapture {
  const observation = input.observation;
  const executedPosture = input.executedPosture;
  const adaptedInput = input;
  const captureId = providerCaptureId(
    input.providerKey,
    input.catalogItemId,
    input.productExternalKey,
    input.captureStartedAt,
  );
  const sales = mapSales(captureId, adaptedInput);
  const weekly = mapWeekly(captureId, adaptedInput);
  const { snapshots, askDepth } = mapListings(captureId, adaptedInput);
  const rejectedRowCount =
    observation.sales.rejectedRows + observation.listings.rejectedRows + observation.history.rejectedRows;
  const statuses = [observation.sales.status, observation.listings.status, observation.history.status];
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
      authenticatedRequest: authenticatedRequest(observation),
      recordedSignalCount: input.recordedSignalCount,
      unresolvedSignalCount: input.unresolvedSignalCount,
      outcomeKind,
      reasonCode: null,
      rejectedRowCount,
      requestPosture: withoutTimeout(executedPosture),
      sales: endpointMetadata(observation.sales),
      listings: {
        ...endpointMetadata(observation.listings),
        ownSellerExclusionApplied: false,
      },
      history: endpointMetadata(observation.history),
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

function endpointMetadata<T extends Readonly<{ rows: readonly unknown[]; credentialsMode: unknown }>>(
  value: T,
): Omit<T, "rows" | "credentialsMode"> {
  const { rows: _rows, credentialsMode: _credentialsMode, ...metadata } = value;
  return metadata;
}

function mapSales(captureId: string, input: ProviderObservationMappingInput): ProviderSaleObservationRow[] {
  const grouped = new Map<string, ProviderSaleObservationRow>();
  for (const sale of input.observation.sales.rows) {
    const unitPrice = sale.purchasePrice;
    const orderShipping = sale.shippingPrice;
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
  const cheapestBySellerCondition = new Map<string, { ordinal: number; condition: string; amount: number }>();
  const cheapestBySellerSnapshotGrain = new Map<
    string,
    { ordinal: number; condition: string; amount: number; variant: string; language: string }
  >();
  for (const listing of input.observation.listings.rows) {
    const ordinal = listing.sellerOrdinal;
    const delivered = moneyToCents(listing.price) + moneyToCents(listing.sellerShippingPrice);
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
  const jointAsks = [...cheapestBySellerCondition.values()];
  const askDepth = jointAsks
    .map((ask) => ({
      captureId,
      anonymousCaptureSellerOrdinal: ask.ordinal,
      providerCondition: ask.condition,
      deliveredAmount: centsToMoney(ask.amount),
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
      cheapestDeliveredAmount: ordered[0] ? centsToMoney(ordered[0].amount) : null,
      secondCheapestDeliveredAmount: ordered[1] ? centsToMoney(ordered[1].amount) : null,
      captureId,
      observedAt: input.captureStartedAt,
    };
  });
  return { snapshots, askDepth };
}

function authenticatedRequest(observation: SecondaryProduct): boolean {
  return [observation.sales, observation.listings, observation.history].some(
    (endpoint) => endpoint.credentialsMode === "include",
  );
}

function withoutTimeout(posture: TcgplayerMarketObservationPosture): ExecutedMarketObservationPosture {
  const { timeoutMs: _timeoutMs, ...requestPosture } = posture;
  return requestPosture;
}

function moneyToCents(value: string): number {
  const [whole, fraction] = value.split(".");
  return Number(whole) * 100 + Number(fraction);
}

function centsToMoney(value: number): string {
  return `${Math.floor(value / 100)}.${String(value % 100).padStart(2, "0")}`;
}
