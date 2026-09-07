import type { ProviderObservationPolicyValue } from "../../domain/provider-observation-policy";
import {
  decodeLatestSales,
  decodeListings,
  decodePriceHistory,
  decodePricePoints,
  type DecodedHistoryResult,
  type DecodedListing,
  type DecodedPricePoint,
  type DecodedSale,
} from "./response-decoders";
import type { TcgplayerMarketTransport } from "./transport-port";
import {
  summarizeHistoryResponseAtReceipt,
  summarizeListingsResponseAtReceipt,
  summarizeSalesResponseAtReceipt,
  type TcgplayerResponseFieldSummaryV1,
} from "./response-receipt";

export type EndpointStatus = "observed" | "unavailable" | "disabled" | "not-requested";
export type SalesCoverage = "complete" | "request-cap-truncated" | "page-budget-truncated" | "inconsistent" | "unknown";
export type ListingsCoverage = "complete" | "ceiling-truncated" | "page-budget-truncated" | "inconsistent" | "unknown";
export type HistoryCoverage = "observed" | "inconsistent" | "unknown";

export type SafeHttpStatusClass = "none" | "4xx" | "5xx" | "other";

export type SalesObservation = Readonly<{
  status: EndpointStatus;
  requestedAt: string;
  responseObservedAt: string | null;
  rows: readonly DecodedSale[];
  rejectedRows: number;
  coverage: SalesCoverage;
  pagesFetched: number;
  returnedCount: number;
  firstReportedTotal: number | null;
  lastReportedTotal: number | null;
  firstResultCount: number | null;
  lastResultCount: number | null;
  lastNextPage: "Yes" | "" | null;
  httpStatusClass: SafeHttpStatusClass;
}>;

export type ListingsObservation = Readonly<{
  status: EndpointStatus;
  requestedAt: string;
  responseObservedAt: string | null;
  rows: readonly DecodedListing[];
  rejectedRows: number;
  coverage: ListingsCoverage;
  pagesFetched: number;
  returnedCount: number;
  reportedTotal: number | null;
  ownSellerExclusionApplied: boolean;
  httpStatusClass: SafeHttpStatusClass;
}>;

export type HistoryObservation = Readonly<{
  status: EndpointStatus;
  requestedAt: string;
  responseObservedAt: string | null;
  rows: readonly DecodedHistoryResult[];
  rejectedRows: number;
  coverage: HistoryCoverage;
  resultCount: number;
  bucketCount: number;
  httpStatusClass: SafeHttpStatusClass;
}>;

export type TcgplayerSecondaryObservation = Readonly<{
  sales: SalesObservation;
  listings: ListingsObservation;
  history: HistoryObservation;
}>;

export type TcgplayerSecondaryFetch = Readonly<{
  observation: TcgplayerSecondaryObservation;
  responseFieldSummary: TcgplayerResponseFieldSummaryV1;
}>;

export type TcgplayerMarketClient = Readonly<{
  fetchPricePoints: (skuIds: readonly number[]) => Promise<ReadonlyMap<number, DecodedPricePoint>>;
  fetchSecondary: (
    input: Readonly<{
      productId: number;
      policy: ProviderObservationPolicyValue;
      now: () => string;
      ownSellerKey?: string;
    }>,
  ) => Promise<TcgplayerSecondaryFetch>;
}>;

export function createTcgplayerMarketClient(transport: TcgplayerMarketTransport): TcgplayerMarketClient {
  return {
    async fetchPricePoints(skuIds) {
      const points = new Map<number, DecodedPricePoint>();
      const unique = [...new Set(skuIds)];
      for (let offset = 0; offset < unique.length; offset += 250) {
        const body = await transport.mpGateway.post<unknown>("/v1/pricepoints/marketprice/skus/search", {
          skuIds: unique.slice(offset, offset + 250),
        });
        for (const point of decodePricePoints(body)) points.set(point.skuId, point);
      }
      return points;
    },
    async fetchSecondary(input) {
      // Endpoints are independent: a timeout/shape failure in one never suppresses another.
      const [sales, listings, history] = await Promise.all([
        fetchSales(transport, input),
        fetchListings(transport, input),
        fetchHistory(transport, input),
      ]);
      return {
        observation: {
          sales: sales.observation,
          listings: listings.observation,
          history: history.observation,
        },
        responseFieldSummary: {
          salesPages: sales.responseSummaries,
          listingPages: listings.responseSummaries,
          history: history.responseSummary,
        },
      };
    },
  };
}

async function fetchSales(
  transport: TcgplayerMarketTransport,
  input: Parameters<TcgplayerMarketClient["fetchSecondary"]>[0],
): Promise<
  Readonly<{ observation: SalesObservation; responseSummaries: TcgplayerResponseFieldSummaryV1["salesPages"] }>
> {
  const requestedAt = input.now();
  const rows: DecodedSale[] = [];
  let rejectedRows = 0;
  let pagesFetched = 0;
  let firstReportedTotal: number | null = null;
  let lastReportedTotal: number | null = null;
  let firstResultCount: number | null = null;
  let lastResultCount: number | null = null;
  let lastNextPage: "Yes" | "" | null = null;
  let rawReturnedCount = 0;
  let inconsistent = false;
  const responseSummaries: Array<TcgplayerResponseFieldSummaryV1["salesPages"][number]> = [];
  const seenContinuationBodies = new Set<string>();
  try {
    for (let page = 0; page < input.policy.sales.pageBudget && rows.length < input.policy.sales.limit; page += 1) {
      const offset = page * input.policy.sales.pageSize;
      const limit = Math.min(input.policy.sales.pageSize, input.policy.sales.limit - rows.length);
      const raw = await timed(input.policy.secondaryTimeoutMs, (signal) =>
        transport.mpApi.post<unknown>(
          `/v2/product/${input.productId}/latestsales`,
          {
            conditions: input.policy.sales.conditions,
            languages: input.policy.sales.languages,
            variants: input.policy.sales.variants,
            listingType: input.policy.sales.listingType,
            offset,
            limit,
          },
          { signal },
        ),
      );
      responseSummaries.push(summarizeSalesResponseAtReceipt(raw));
      const continuationBody = JSON.stringify(raw);
      if (seenContinuationBodies.has(continuationBody)) inconsistent = true;
      seenContinuationBodies.add(continuationBody);
      const decoded = decodeLatestSales(raw);
      const pageRowCount = decoded.data.length + decoded.rejectedRows;
      const expectedPreviousPage = page === 0 ? "" : "Yes";
      if (
        decoded.previousPage !== expectedPreviousPage ||
        decoded.resultCount !== pageRowCount ||
        pageRowCount > limit ||
        decoded.totalResults < offset + pageRowCount ||
        (decoded.nextPage === "Yes" &&
          (pageRowCount === 0 || pageRowCount !== limit || offset + pageRowCount >= decoded.totalResults)) ||
        (decoded.nextPage === "" && offset + pageRowCount !== decoded.totalResults)
      ) {
        inconsistent = true;
      }
      pagesFetched += 1;
      rejectedRows += decoded.rejectedRows;
      rawReturnedCount += pageRowCount;
      if (rawReturnedCount > input.policy.sales.limit) inconsistent = true;
      firstReportedTotal ??= decoded.totalResults;
      firstResultCount ??= decoded.resultCount;
      lastReportedTotal = decoded.totalResults;
      lastResultCount = decoded.resultCount;
      lastNextPage = decoded.nextPage;
      rows.push(...decoded.data.slice(0, input.policy.sales.limit - rows.length));
      if (inconsistent || decoded.nextPage !== "Yes") break;
    }
    const totalsConsistent = firstReportedTotal === lastReportedTotal;
    const terminal = lastNextPage === "";
    const coverage: SalesCoverage =
      inconsistent || !totalsConsistent
        ? "inconsistent"
        : rawReturnedCount >= input.policy.sales.limit && (lastReportedTotal ?? rawReturnedCount) > rawReturnedCount
          ? "request-cap-truncated"
          : !terminal && pagesFetched >= input.policy.sales.pageBudget
            ? "page-budget-truncated"
            : terminal &&
                rejectedRows === 0 &&
                rawReturnedCount === lastReportedTotal &&
                rows.length === rawReturnedCount
              ? "complete"
              : "unknown";
    return {
      observation: {
        status: "observed",
        requestedAt,
        responseObservedAt: input.now(),
        rows,
        rejectedRows,
        coverage,
        pagesFetched,
        returnedCount: rows.length,
        firstReportedTotal,
        lastReportedTotal,
        firstResultCount,
        lastResultCount,
        lastNextPage,
        httpStatusClass: "none",
      },
      responseSummaries,
    };
  } catch (error) {
    return { observation: unavailableSales(requestedAt, statusClass(error)), responseSummaries };
  }
}

async function fetchListings(
  transport: TcgplayerMarketTransport,
  input: Parameters<TcgplayerMarketClient["fetchSecondary"]>[0],
): Promise<
  Readonly<{ observation: ListingsObservation; responseSummaries: TcgplayerResponseFieldSummaryV1["listingPages"] }>
> {
  const requestedAt = input.now();
  const rows: DecodedListing[] = [];
  let rejectedRows = 0;
  let pagesFetched = 0;
  let reportedTotal: number | null = null;
  let ceilingReached = false;
  let inconsistent = false;
  const responseSummaries: Array<TcgplayerResponseFieldSummaryV1["listingPages"][number]> = [];
  try {
    for (let page = 0; page < input.policy.listings.pageBudget; page += 1) {
      const raw = await timed(input.policy.secondaryTimeoutMs, (signal) =>
        transport.mpSearchApi.post<unknown>(
          `/v1/product/${input.productId}/listings`,
          {
            aggregations: ["condition", "language", "listingType", "printing"],
            context: { shippingCountry: "US" },
            filters: {
              term: { "verified-seller": input.policy.listings.verifiedSellersOnly },
            },
            from: page * input.policy.listings.pageSize,
            size: input.policy.listings.pageSize,
            sort: { field: "price+shipping", order: "asc" },
          },
          { signal },
        ),
      );
      responseSummaries.push(summarizeListingsResponseAtReceipt(raw));
      const decoded = decodeListings(raw);
      pagesFetched += 1;
      rejectedRows += decoded.rejectedRows;
      if (reportedTotal !== null && reportedTotal !== decoded.totalResults) inconsistent = true;
      reportedTotal ??= decoded.totalResults;
      const filtered = decoded.results.filter(
        (row) => !input.policy.listings.excludeOwnSeller || !input.ownSellerKey || row.sellerKey !== input.ownSellerKey,
      );
      rows.push(...filtered);
      const ceiling = Number(input.policy.listings.deliveredCeiling);
      ceilingReached = decoded.results.some((row) => row.price + row.sellerShippingPrice > ceiling);
      if (ceilingReached || rows.length >= decoded.totalResults || decoded.results.length === 0) break;
    }
    const coverage: ListingsCoverage = inconsistent
      ? "inconsistent"
      : ceilingReached
        ? "ceiling-truncated"
        : reportedTotal !== null && rows.length === reportedTotal && rejectedRows === 0
          ? "complete"
          : pagesFetched >= input.policy.listings.pageBudget
            ? "page-budget-truncated"
            : "unknown";
    return {
      observation: {
        status: "observed",
        requestedAt,
        responseObservedAt: input.now(),
        rows,
        rejectedRows,
        coverage,
        pagesFetched,
        returnedCount: rows.length,
        reportedTotal,
        ownSellerExclusionApplied: Boolean(input.ownSellerKey && input.policy.listings.excludeOwnSeller),
        httpStatusClass: "none",
      },
      responseSummaries,
    };
  } catch (error) {
    return { observation: unavailableListings(requestedAt, statusClass(error)), responseSummaries };
  }
}

async function fetchHistory(
  transport: TcgplayerMarketTransport,
  input: Parameters<TcgplayerMarketClient["fetchSecondary"]>[0],
): Promise<
  Readonly<{
    observation: HistoryObservation;
    responseSummary: TcgplayerResponseFieldSummaryV1["history"];
  }>
> {
  const requestedAt = input.now();
  let responseSummary: TcgplayerResponseFieldSummaryV1["history"] = null;
  try {
    const raw = await timed(input.policy.secondaryTimeoutMs, (signal) =>
      transport.infiniteApi.get<unknown>(`/price/history/${input.productId}/detailed`, { range: "annual" }, { signal }),
    );
    responseSummary = summarizeHistoryResponseAtReceipt(raw);
    const decoded = decodePriceHistory(raw);
    const bucketCount = decoded.result.reduce((sum, row) => sum + row.buckets.length, 0);
    return {
      observation: {
        status: "observed",
        requestedAt,
        responseObservedAt: input.now(),
        rows: decoded.result,
        rejectedRows: decoded.rejectedRows,
        coverage: decoded.count === decoded.result.length && decoded.rejectedRows === 0 ? "observed" : "inconsistent",
        resultCount: decoded.result.length,
        bucketCount,
        httpStatusClass: "none",
      },
      responseSummary,
    };
  } catch (error) {
    return { observation: unavailableHistory(requestedAt, statusClass(error)), responseSummary };
  }
}

async function timed<T>(timeoutMs: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await work(controller.signal);
  } finally {
    clearTimeout(timeout);
  }
}

function statusClass(error: unknown): SafeHttpStatusClass {
  if (typeof error !== "object" || error === null || !("status" in error)) return "other";
  const status = (error as { status?: unknown }).status;
  if (typeof status !== "number") return "other";
  if (status >= 400 && status < 500) return "4xx";
  if (status >= 500 && status < 600) return "5xx";
  return "other";
}

function unavailableSales(requestedAt: string, httpStatusClass: SafeHttpStatusClass): SalesObservation {
  return {
    status: "unavailable",
    requestedAt,
    responseObservedAt: null,
    rows: [],
    rejectedRows: 0,
    coverage: "unknown",
    pagesFetched: 0,
    returnedCount: 0,
    firstReportedTotal: null,
    lastReportedTotal: null,
    firstResultCount: null,
    lastResultCount: null,
    lastNextPage: null,
    httpStatusClass,
  };
}

function unavailableListings(requestedAt: string, httpStatusClass: SafeHttpStatusClass): ListingsObservation {
  return {
    status: "unavailable",
    requestedAt,
    responseObservedAt: null,
    rows: [],
    rejectedRows: 0,
    coverage: "unknown",
    pagesFetched: 0,
    returnedCount: 0,
    reportedTotal: null,
    ownSellerExclusionApplied: false,
    httpStatusClass,
  };
}

function unavailableHistory(requestedAt: string, httpStatusClass: SafeHttpStatusClass): HistoryObservation {
  return {
    status: "unavailable",
    requestedAt,
    responseObservedAt: null,
    rows: [],
    rejectedRows: 0,
    coverage: "unknown",
    resultCount: 0,
    bucketCount: 0,
    httpStatusClass,
  };
}
