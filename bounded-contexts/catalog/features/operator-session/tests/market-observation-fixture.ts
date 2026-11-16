import { vi } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import type { EventStore } from "@chase-sets/event-core/event-store";
import {
  canonicalizeTcgplayerMarketObservationBatch,
  digestTcgplayerMarketObservationBatchText,
  splitTcgplayerMarketObservationBatchText,
  type TcgplayerMarketObservationRequest,
  type TcgplayerMarketObservationRequestSource,
} from "@chase-sets/tcgplayer-market-observations";
import { createMarketObservationRoutes } from "../api/market-observations";
import { operatorSessionPublicRoutes } from "../api/route";
export const provenance = {
  grantId: "00000000-0000-0000-0000-0000000000a1",
  creatorUserId: "usr_market_creator",
  creatorMembershipId: "mbr_market_creator",
};
export const batchId = "123e4567-e89b-12d3-a456-426614174001";
export const requestId = "123e4567-e89b-12d3-a456-426614174000";
export const now = "2026-11-15T00:00:00.000Z";
export const streamId = `catalog.operator-observation-batch-${batchId}`;
export const current: TcgplayerMarketObservationRequest = {
  contractVersion: 1,
  requestId,
  phase: "price-points",
  issuedAt: now,
  products: [{ productId: 1, skuIds: [1], skuTargetCount: 1 }],
  posture: null,
};
export const text = canonicalizeTcgplayerMarketObservationBatch({
  contractVersion: 1,
  requestId,
  phase: "price-points",
  posture: null,
  products: [{ productId: 1, pricePoints: [] }],
});
export const partBody = (partText = text, request = current) => ({
  requestId: request.requestId,
  phase: request.phase,
  text: partText,
});
export const completionBody = async (batchText = text, request = current) => ({
  requestId: request.requestId,
  phase: request.phase,
  partCount: splitTcgplayerMarketObservationBatchText(batchText).length,
  textBytes: batchText.length,
  digest: await digestTcgplayerMarketObservationBatchText(batchText),
});
export function input(body?: unknown, method = "PUT", headers?: HeadersInit) {
  const raw = body instanceof ReadableStream ? body : body === undefined ? undefined : JSON.stringify(body);
  return new Request("https://synthetic.invalid/", {
    method,
    headers,
    body: raw,
    ...(raw instanceof ReadableStream ? { duplex: "half" } : {}),
  });
}
export function harness(
  factory = createMarketObservationRoutes,
  store: EventStore = createInMemoryEventStore().eventStore,
) {
  const authorize = vi.fn(async (_request: Request) => provenance);
  const currentRequest = vi.fn<TcgplayerMarketObservationRequestSource["currentRequest"]>(async () => current);
  const readStream = vi.fn(store.readStream);
  const appendToStream = vi.fn(store.appendToStream);
  const databaseNow = vi.fn(async () => now);
  const deps = {
    authorizeObservationGrant: authorize,
    requestSource: { currentRequest },
    store: { ...store, readStream, appendToStream },
    databaseNow,
  };
  const routes = factory(deps);
  const unused = async () => Response.json({ code: "unused-test-route" });
  const app = operatorSessionPublicRoutes({
    authorizeObservationGrant: authorize,
    execute: unused,
    recordTcgplayerSetNameObservations: unused,
    recordTcgplayerSealedProductObservations: unused,
    marketObservations: routes,
  });
  const send = (path: string, body?: unknown, method = "PUT") =>
    app.request(new Request(`https://synthetic.invalid${path}`, input(body, method)));
  return { deps, routes, authorize, currentRequest, readStream, appendToStream, databaseNow, app, send, store };
}
export const partPath = (id = batchId, index: string | number = 0) => `/observation-batches/${id}/parts/${index}`;
export const completePath = (id = batchId) => `/observation-batches/${id}/complete`;

export function secondaryRequest(): TcgplayerMarketObservationRequest {
  return {
    ...current,
    phase: "secondary",
    products: Array.from({ length: 5 }, (_, i) => ({
      productId: i + 1,
      skuIds: Array.from({ length: 250 }, (_, j) => j + 1),
      skuTargetCount: 250,
    })),
    posture: {
      salesOffset: 0,
      salesLimit: 100,
      salesPageSize: 25,
      salesPageBudget: 4,
      salesConditions: [],
      salesLanguages: [],
      salesVariants: [],
      salesListingType: "ListingWithoutPhotos",
      listingsVerifiedOnly: true,
      listingsPageSize: 50,
      listingsPageBudget: 10,
      listingsDeliveredCeiling: "1000.00",
      historyRange: "annual",
      timeoutMs: 15000,
    },
  };
}

export function smallSecondaryBatch(request = secondaryRequest()) {
  const envelope = {
    status: "observed",
    httpStatusClass: "none",
    credentialsMode: "include",
    requestedAt: request.issuedAt,
    responseObservedAt: request.issuedAt,
    rejectedRows: 0,
    rows: [],
  };
  return {
    contractVersion: 1,
    requestId: request.requestId,
    phase: "secondary",
    posture: request.posture,
    products: request.products.map((product) => ({
      productId: product.productId,
      sales: {
        ...envelope,
        coverage: "complete",
        pagesFetched: 0,
        returnedCount: 0,
        firstReportedTotal: 0,
        lastReportedTotal: 0,
        firstResultCount: 0,
        lastResultCount: 0,
        lastNextPage: "",
      },
      listings: { ...envelope, coverage: "complete", pagesFetched: 0, returnedCount: 0, reportedTotal: 0 },
      history: { ...envelope, coverage: "observed", resultCount: 0, bucketCount: 0 },
    })),
  };
}

// Same maximal launch shape as C0 parts.test.ts, with endpoint instants inside the admission window.
export function maximalLaunchBatch(request = secondaryRequest()) {
  const label = "A".repeat(64),
    money = "9999999.99",
    count = Number.MAX_SAFE_INTEGER;
  const envelope = (rows: unknown[]) => ({
    status: "observed",
    httpStatusClass: "none",
    credentialsMode: "include",
    requestedAt: request.issuedAt,
    responseObservedAt: request.issuedAt,
    rejectedRows: rows.length,
    rows,
  });
  return {
    contractVersion: 1,
    requestId: request.requestId,
    phase: "secondary",
    posture: request.posture,
    products: request.products.map((product) => ({
      productId: product.productId,
      sales: {
        ...envelope(
          Array.from({ length: 100 }, () => ({
            condition: label,
            variant: label,
            language: label,
            listingType: label,
            quantity: count,
            purchasePrice: money,
            shippingPrice: money,
            orderDate: "9999-12-31T23:59:59.999Z",
          })),
        ),
        coverage: "request-cap-truncated",
        pagesFetched: request.posture!.salesPageBudget,
        returnedCount: 100,
        firstReportedTotal: count,
        lastReportedTotal: count,
        firstResultCount: count,
        lastResultCount: count,
        lastNextPage: "Yes",
      },
      listings: {
        ...envelope(
          Array.from({ length: 500 }, (_, i) => ({
            sellerOrdinal: i + 1,
            condition: label,
            printing: label,
            language: label,
            price: money,
            sellerShippingPrice: money,
          })),
        ),
        coverage: "page-budget-truncated",
        pagesFetched: request.posture!.listingsPageBudget,
        returnedCount: 500,
        reportedTotal: count,
      },
      history: {
        ...envelope(
          product.skuIds.map((skuId) => ({
            skuId,
            variant: label,
            language: label,
            condition: label,
            buckets: Array.from({ length: 53 }, (_, i) => ({
              bucketStartDate: new Date(Date.UTC(2020, 0, i + 1)).toISOString().slice(0, 10),
              marketPrice: money,
              quantitySold: count,
              transactionCount: count,
              lowSalePrice: money,
              lowSalePriceWithShipping: money,
              highSalePrice: money,
              highSalePriceWithShipping: money,
            })),
          })),
        ),
        coverage: "inconsistent",
        resultCount: 250,
        bucketCount: 13250,
      },
    })),
  };
}
