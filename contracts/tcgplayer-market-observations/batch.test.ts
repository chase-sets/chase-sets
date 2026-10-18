import { describe, expect, it } from "vitest";
import {
  parseTcgplayerMarketObservationBatch,
  parseTcgplayerMarketObservationRequest,
  TcgplayerMarketObservationContractError,
} from "./index";
import { sourceMutant } from "./mutants";

const posture = {
  salesOffset: 0,
  salesLimit: 2,
  salesPageSize: 1,
  salesPageBudget: 2,
  salesConditions: [],
  salesLanguages: [],
  salesVariants: [],
  salesListingType: "ListingWithoutPhotos" as const,
  listingsVerifiedOnly: true,
  listingsPageSize: 2,
  listingsPageBudget: 1,
  listingsDeliveredCeiling: "1000.00",
  historyRange: "annual" as const,
  timeoutMs: 1000,
};
const request = parseTcgplayerMarketObservationRequest({
  contractVersion: 1,
  requestId: "123e4567-e89b-12d3-a456-426614174000",
  phase: "secondary",
  issuedAt: "2026-10-17T00:00:00.000Z",
  products: [{ productId: 1, skuIds: [1, 2], skuTargetCount: 2 }],
  posture,
});
const endpoint = (
  kind: "sales" | "listings" | "history",
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  status: "unavailable",
  httpStatusClass: "4xx",
  credentialsMode: "omit",
  requestedAt: "2026-10-17T00:00:00.000Z",
  responseObservedAt: null,
  rejectedRows: 0,
  rows: [],
  ...(kind === "sales"
    ? {
        coverage: "unknown",
        pagesFetched: 0,
        returnedCount: 0,
        firstReportedTotal: null,
        lastReportedTotal: null,
        firstResultCount: null,
        lastResultCount: null,
        lastNextPage: null,
      }
    : kind === "listings"
      ? { coverage: "unknown", pagesFetched: 0, returnedCount: 0, reportedTotal: null }
      : { coverage: "unknown", resultCount: 0, bucketCount: 0 }),
  ...overrides,
});
const batch = (
  products: readonly Record<string, unknown>[] = [
    { productId: 1, sales: endpoint("sales"), listings: endpoint("listings"), history: endpoint("history") },
  ],
) =>
  JSON.stringify({
    contractVersion: 1,
    requestId: request.requestId,
    phase: request.phase,
    posture: request.posture,
    products,
  });
const errorCode = (fn: () => unknown) => {
  try {
    fn();
    return "accepted";
  } catch (error) {
    return error instanceof TcgplayerMarketObservationContractError ? error.code : "unknown";
  }
};

describe("TCGplayer market observation batch", () => {
  it("accepts the closed non-observed matrix", () =>
    expect(parseTcgplayerMarketObservationBatch(batch(), request).products).toHaveLength(1));
  it.each([
    ["rejected rows", { rejectedRows: 1 }],
    ["sales pages", { pagesFetched: 1 }],
    ["sales returned", { returnedCount: 1 }],
    ["sales total", { firstReportedTotal: 1 }],
    ["listings total", { reportedTotal: 1 }],
    ["history count", { bucketCount: 1 }],
  ])("rejects unavailable matrix %s", (_name, change) => {
    const products = [
      { productId: 1, sales: endpoint("sales", change), listings: endpoint("listings"), history: endpoint("history") },
    ];
    expect(errorCode(() => parseTcgplayerMarketObservationBatch(batch(products), request))).toBe(
      "invalid_endpoint_matrix",
    );
  });
  it.each([
    ["ordinal gap", [2]],
    ["ordinal jump", [1, 3]],
    ["ordinal reverse", [2, 1]],
  ])("rejects listing %s with a fixed code", (_name, ordinals) => {
    const listings = endpoint("listings", {
      status: "observed",
      httpStatusClass: "none",
      credentialsMode: "omit",
      responseObservedAt: "2026-10-17T00:00:01.000Z",
      rows: ordinals.map((sellerOrdinal) => ({
        sellerOrdinal,
        condition: "Near Mint",
        printing: "Normal",
        language: "English",
        price: "1.00",
        sellerShippingPrice: "0.00",
      })),
      coverage: "complete",
      pagesFetched: 1,
      returnedCount: ordinals.length,
    });
    const products = [{ productId: 1, sales: endpoint("sales"), listings, history: endpoint("history") }];
    expect(errorCode(() => parseTcgplayerMarketObservationBatch(batch(products), request))).toBe(
      "invalid_listing_ordinal",
    );
  });
  it("rejects duplicate history SKUs and impossible dates", () => {
    const row = {
      skuId: 1,
      variant: "Normal",
      language: "English",
      condition: "Near Mint",
      buckets: [
        {
          bucketStartDate: "2026-02-30",
          marketPrice: null,
          quantitySold: 1,
          transactionCount: 1,
          lowSalePrice: null,
          lowSalePriceWithShipping: null,
          highSalePrice: null,
          highSalePriceWithShipping: null,
        },
      ],
    };
    const history = endpoint("history", {
      status: "observed",
      httpStatusClass: "none",
      credentialsMode: "omit",
      responseObservedAt: "2026-10-17T00:00:01.000Z",
      rows: [row],
      coverage: "observed",
      resultCount: 1,
      bucketCount: 1,
    });
    expect(
      errorCode(() =>
        parseTcgplayerMarketObservationBatch(
          batch([{ productId: 1, sales: endpoint("sales"), listings: endpoint("listings"), history }]),
          request,
        ),
      ),
    ).toBe("invalid_history_bucket");
    const duplicate = { ...row, buckets: [] };
    const duplicateHistory = { ...history, rows: [duplicate, { ...duplicate, skuId: 1 }], resultCount: 2 };
    expect(
      errorCode(() =>
        parseTcgplayerMarketObservationBatch(
          batch([
            { productId: 1, sales: endpoint("sales"), listings: endpoint("listings"), history: duplicateHistory },
          ]),
          request,
        ),
      ),
    ).toBe("invalid_history");
  });
  it("rejects non-canonical key order", () => {
    const value = JSON.parse(batch());
    const reversed = {
      products: value.products,
      posture: value.posture,
      phase: value.phase,
      requestId: value.requestId,
      contractVersion: value.contractVersion,
    };
    expect(errorCode(() => parseTcgplayerMarketObservationBatch(JSON.stringify(reversed), request))).toBe(
      "non_canonical_batch",
    );
  });
  it("mutant bypasses a repaired guard, proving the test is live", () => {
    const text = batch([
      {
        productId: 1,
        sales: endpoint("sales"),
        listings: endpoint("listings", {
          status: "observed",
          httpStatusClass: "none",
          credentialsMode: "omit",
          responseObservedAt: "2026-10-17T00:00:01.000Z",
          rows: [
            {
              sellerOrdinal: 2,
              condition: "Near Mint",
              printing: "Normal",
              language: "English",
              price: "1.00",
              sellerShippingPrice: "0.00",
            },
          ],
          coverage: "complete",
          pagesFetched: 1,
          returnedCount: 1,
        }),
        history: endpoint("history"),
      },
    ]);
    const mutant = sourceMutant<(text: string, req: typeof request) => unknown>(
      [['bad("invalid_listing_ordinal")', "void 0"]],
      "parseTcgplayerMarketObservationBatch",
    );
    expect(() => mutant(text, request)).not.toThrow();
    expect(errorCode(() => parseTcgplayerMarketObservationBatch(text, request))).toBe("invalid_listing_ordinal");
  });
  it("mutants for matrix, history, date, and canonical-order guards are rejected by the paired cases", () => {
    const unavailable = batch([
      {
        productId: 1,
        sales: endpoint("sales", { pagesFetched: 1 }),
        listings: endpoint("listings"),
        history: endpoint("history"),
      },
    ]);
    const matrixMutant = sourceMutant<(text: string, req: typeof request) => unknown>(
      [
        [
          `if (rejectedRows !== 0 || parsed.length !== 0 || (m as { coverage: string }).coverage !== "unknown")\n      bad("invalid_endpoint_matrix");`,
          'if (false) bad("invalid_endpoint_matrix");',
        ],
      ],
      "parseTcgplayerMarketObservationBatch",
    );
    expect(() => matrixMutant(unavailable, request)).not.toThrow();
    const duplicateHistory = batch([
      {
        productId: 1,
        sales: endpoint("sales"),
        listings: endpoint("listings"),
        history: endpoint("history", {
          status: "observed",
          httpStatusClass: "none",
          credentialsMode: "omit",
          responseObservedAt: "2026-10-17T00:00:01.000Z",
          rows: [
            { skuId: 1, variant: "N", language: "E", condition: "C", buckets: [] },
            { skuId: 1, variant: "N", language: "E", condition: "C", buckets: [] },
          ],
          coverage: "observed",
          resultCount: 2,
          bucketCount: 0,
        }),
      },
    ]);
    const historyMutant = sourceMutant<(text: string, req: typeof request) => unknown>(
      [
        [
          `if (k === "history" && new Set((parsed as HistoryRow[]).map((row) => row.skuId)).size !== parsed.length)\n    bad("invalid_history");`,
          'if (false) bad("invalid_history");',
        ],
      ],
      "parseTcgplayerMarketObservationBatch",
    );
    expect(() => historyMutant(duplicateHistory, request)).not.toThrow();
    const invalidDate = batch([
      {
        productId: 1,
        sales: endpoint("sales"),
        listings: endpoint("listings"),
        history: endpoint("history", {
          status: "observed",
          httpStatusClass: "none",
          credentialsMode: "omit",
          responseObservedAt: "2026-10-17T00:00:01.000Z",
          rows: [
            {
              skuId: 1,
              variant: "N",
              language: "E",
              condition: "C",
              buckets: [
                {
                  bucketStartDate: "2026-02-30",
                  marketPrice: null,
                  quantitySold: 1,
                  transactionCount: 1,
                  lowSalePrice: null,
                  lowSalePriceWithShipping: null,
                  highSalePrice: null,
                  highSalePriceWithShipping: null,
                },
              ],
            },
          ],
          coverage: "observed",
          resultCount: 1,
          bucketCount: 1,
        }),
      },
    ]);
    const dateMutant = sourceMutant<(text: string, req: typeof request) => unknown>(
      [["new Date(`${b.bucketStartDate}T00:00:00.000Z`).toISOString().slice(0, 10) !== b.bucketStartDate", "false"]],
      "parseTcgplayerMarketObservationBatch",
    );
    expect(() => dateMutant(invalidDate, request)).not.toThrow();
    const canonicalMutant = sourceMutant<(value: unknown) => string>(
      [
        [
          `return JSON.stringify({ contractVersion: 1, requestId: value.requestId, phase: value.phase, posture, products });`,
          "return JSON.stringify(value);",
        ],
      ],
      "canonicalizeTcgplayerMarketObservationBatch",
    );
    const reversed = {
      products: JSON.parse(batch()).products,
      posture: request.posture,
      phase: request.phase,
      requestId: request.requestId,
      contractVersion: 1,
    };
    expect(errorCode(() => parseTcgplayerMarketObservationBatch(canonicalMutant(reversed), request))).toBe(
      "non_canonical_batch",
    );
  });
});
