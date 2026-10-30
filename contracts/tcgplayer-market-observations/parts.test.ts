import { describe, expect, it } from "vitest";
import {
  PART_TEXT_MAX_BYTES,
  assembleAdmittedTcgplayerMarketObservationBatch,
  canonicalizeTcgplayerMarketObservationBatch,
  digestTcgplayerMarketObservationBatchText,
  maxPartCount,
  maxBatchTextBytes,
  parseAdmissionPayload,
  parseTcgplayerMarketObservationBatch,
  parseTcgplayerMarketObservationRequest,
  splitTcgplayerMarketObservationBatchText,
  type TcgplayerMarketObservationPosture,
  type TcgplayerMarketObservationRequest,
} from "./index";
import { sourceMutant } from "./mutants";

const RID = "123e4567-e89b-12d3-a456-426614174000";
const BID = "123e4567-e89b-12d3-a456-426614174001";
const GID = "123e4567-e89b-12d3-a456-426614174002";
const T0 = "2026-10-17T00:00:00.000Z";
const EVENT_PAYLOAD_MAX_BYTES = 65_536;
const bytes = (text: string) => new TextEncoder().encode(text).byteLength;
const request = parseTcgplayerMarketObservationRequest({
  contractVersion: 1,
  requestId: RID,
  phase: "price-points",
  issuedAt: T0,
  products: [{ productId: 1, skuIds: [1], skuTargetCount: 1 }],
  posture: null,
});
// The policy decoder maxima (provider-observation-policy.ts:66-98) and the launch
// policy values (provider-observation-policy.ts:29) are restated here because
// contracts/ cannot import a bounded context (R51).
const policyMaxPosture: TcgplayerMarketObservationPosture = {
  salesOffset: 0,
  salesLimit: 10000,
  salesPageSize: 250,
  salesPageBudget: 100,
  salesConditions: [],
  salesLanguages: [],
  salesVariants: [],
  salesListingType: "ListingWithoutPhotos",
  listingsVerifiedOnly: true,
  listingsPageSize: 250,
  listingsPageBudget: 100,
  listingsDeliveredCeiling: "1000.00",
  historyRange: "annual",
  timeoutMs: 120000,
};
const launchPosture: TcgplayerMarketObservationPosture = {
  ...policyMaxPosture,
  salesLimit: 100,
  salesPageSize: 25,
  salesPageBudget: 4,
  listingsPageSize: 50,
  listingsPageBudget: 10,
  timeoutMs: 15000,
};
const skuIds = Array.from({ length: 250 }, (_, j) => Number.MAX_SAFE_INTEGER - 249 + j);
const secondaryRequest = (posture: TcgplayerMarketObservationPosture, productCount: number) =>
  parseTcgplayerMarketObservationRequest({
    contractVersion: 1,
    requestId: RID,
    phase: "secondary",
    issuedAt: T0,
    products: Array.from({ length: productCount }, (_, i) => ({
      productId: 2147483647 - productCount + 1 + i,
      skuIds,
      skuTargetCount: 250,
    })),
    posture,
  });
const launchRequest = secondaryRequest(launchPosture, 5);
const policyMaxRequest = secondaryRequest(policyMaxPosture, 1);
const L64 = "A".repeat(64);
const MAX_MONEY = "9999999.99";
const MAX_INSTANT = "9999-12-31T23:59:59.999Z";
const MAX_COUNT = Number.MAX_SAFE_INTEGER;
const maximalSale = () => ({
  condition: L64,
  variant: L64,
  language: L64,
  listingType: L64,
  quantity: MAX_COUNT,
  purchasePrice: MAX_MONEY,
  shippingPrice: MAX_MONEY,
  orderDate: MAX_INSTANT,
});
const maximalListing = (sellerOrdinal: number) => ({
  sellerOrdinal,
  condition: L64,
  printing: L64,
  language: L64,
  price: MAX_MONEY,
  sellerShippingPrice: MAX_MONEY,
});
const maximalBucket = (index: number) => ({
  bucketStartDate: new Date(Date.UTC(2020, 0, 1 + index)).toISOString().slice(0, 10),
  marketPrice: MAX_MONEY,
  quantitySold: MAX_COUNT,
  transactionCount: MAX_COUNT,
  lowSalePrice: MAX_MONEY,
  lowSalePriceWithShipping: MAX_MONEY,
  highSalePrice: MAX_MONEY,
  highSalePriceWithShipping: MAX_MONEY,
});
const maximalHistory = (skuId: number) => ({
  skuId,
  variant: L64,
  language: L64,
  condition: L64,
  buckets: Array.from({ length: 53 }, (_, i) => maximalBucket(i)),
});
const observedEnvelope = (rows: readonly unknown[]) => ({
  status: "observed",
  httpStatusClass: "none",
  credentialsMode: "include",
  requestedAt: MAX_INSTANT,
  responseObservedAt: MAX_INSTANT,
  rejectedRows: rows.length,
  rows,
});
// The largest batch the parser accepts for a request: every row maximal, every
// cap reached, every metadata value at its widest valid digits.
const maximalBatchText = (req: TcgplayerMarketObservationRequest) => {
  const p = req.posture!;
  const salesCap = Math.min(p.salesLimit, p.salesPageSize * p.salesPageBudget);
  const listingsCap = p.listingsPageSize * p.listingsPageBudget;
  return JSON.stringify({
    contractVersion: 1,
    requestId: req.requestId,
    phase: req.phase,
    posture: req.posture,
    products: req.products.map((product) => ({
      productId: product.productId,
      sales: {
        ...observedEnvelope(Array.from({ length: salesCap }, maximalSale)),
        coverage: "request-cap-truncated",
        pagesFetched: p.salesPageBudget,
        returnedCount: salesCap,
        firstReportedTotal: MAX_COUNT,
        lastReportedTotal: MAX_COUNT,
        firstResultCount: MAX_COUNT,
        lastResultCount: MAX_COUNT,
        lastNextPage: "Yes",
      },
      listings: {
        ...observedEnvelope(Array.from({ length: listingsCap }, (_, i) => maximalListing(i + 1))),
        coverage: "page-budget-truncated",
        pagesFetched: p.listingsPageBudget,
        returnedCount: listingsCap,
        reportedTotal: MAX_COUNT,
      },
      history: {
        ...observedEnvelope(product.skuIds.map(maximalHistory)),
        coverage: "inconsistent",
        resultCount: product.skuIds.length,
        bucketCount: product.skuIds.length * 53,
      },
    })),
  });
};
const partPayload = (req: TcgplayerMarketObservationRequest, partIndex: number, text: string) => ({
  batchId: BID,
  requestId: req.requestId,
  phase: req.phase,
  partIndex,
  text,
});
// AC3 on one maximal batch: parse, cap, split, event payload size, and
// reassembly through the real assembler back to identical text and digest.
const maximalCase = async (req: TcgplayerMarketObservationRequest) => {
  const text = maximalBatchText(req);
  expect(() => parseTcgplayerMarketObservationBatch(text, req)).not.toThrow();
  const textBytes = bytes(text);
  expect(textBytes).toBeLessThanOrEqual(maxBatchTextBytes(req));
  const parts = splitTcgplayerMarketObservationBatchText(text);
  expect(parts.length).toBe(Math.ceil(textBytes / PART_TEXT_MAX_BYTES));
  expect(parts.length).toBeLessThanOrEqual(maxPartCount(req));
  let maxPayloadBytes = 0;
  for (const [index, part] of parts.entries())
    maxPayloadBytes = Math.max(maxPayloadBytes, bytes(JSON.stringify(partPayload(req, index, part))));
  expect(maxPayloadBytes).toBeLessThanOrEqual(EVENT_PAYLOAD_MAX_BYTES);
  const digest = await digestTcgplayerMarketObservationBatchText(text);
  const admission = {
    batchId: BID,
    requestId: req.requestId,
    phase: req.phase,
    contractVersion: 1,
    partCount: parts.length,
    textBytes,
    digest,
    grantId: GID,
    creatorMembershipId: "membership",
    creatorUserId: "user",
    admittedAt: T0,
  };
  expect(() => parseAdmissionPayload(admission, req)).not.toThrow();
  const history = [
    ...parts.map((part, index) => ({ streamVersion: index + 1, data: partPayload(req, index, part) })),
    { streamVersion: parts.length + 1, data: admission },
  ];
  const assembled = await assembleAdmittedTcgplayerMarketObservationBatch(history, req);
  const canonical = canonicalizeTcgplayerMarketObservationBatch(assembled);
  expect(canonical === text).toBe(true);
  expect(await digestTcgplayerMarketObservationBatchText(canonical)).toBe(digest);
  return { textBytes, partCount: parts.length, maxPayloadBytes };
};

describe("canonical batch parts (AC3)", () => {
  it("splits exact ASCII byte slices and digests in lowercase hex", async () => {
    const text = "x".repeat(PART_TEXT_MAX_BYTES + 1);
    const parts = splitTcgplayerMarketObservationBatchText(text);
    expect(parts).toEqual(["x".repeat(PART_TEXT_MAX_BYTES), "x"]);
    expect(await digestTcgplayerMarketObservationBatchText(text)).toMatch(/^[0-9a-f]{64}$/);
    expect(maxPartCount(request)).toBeGreaterThan(0);
  });
  it("derives policy caps from maximal grammar rows, not request JSON size", () => {
    const secondary = parseTcgplayerMarketObservationRequest({
      ...request,
      phase: "secondary",
      posture: policyMaxPosture,
      products: [{ productId: 1, skuIds: [1], skuTargetCount: 1 }],
    });
    expect(maxBatchTextBytes(secondary)).toBeGreaterThan(12_285_260);
    expect(maxPartCount(secondary)).toBe(Math.ceil(maxBatchTextBytes(secondary) / PART_TEXT_MAX_BYTES));
    const mutant = sourceMutant<typeof maxBatchTextBytes>(
      [["Array.from({ length: cap }, maximalSale)", "[]"]],
      "maxBatchTextBytes",
    );
    expect(mutant(secondary)).toBeLessThan(maxBatchTextBytes(secondary));
  });
  it("P01 the maximal launch-posture batch (5 products × 250 SKUs) parses, fits its caps and reassembles identically", async () => {
    expect(maxBatchTextBytes(launchRequest)).toBe(18_972_364);
    expect(maxPartCount(launchRequest)).toBe(633);
    const result = await maximalCase(launchRequest);
    expect(result.partCount).toBe(633);
    expect(result.maxPayloadBytes).toBeLessThanOrEqual(EVENT_PAYLOAD_MAX_BYTES);
  });
  it("P02 the maximal policy-maximum batch (1 product × 250 SKUs) parses, fits its caps and reassembles identically", async () => {
    expect(maxBatchTextBytes(policyMaxRequest)).toBe(15_878_146);
    expect(maxPartCount(policyMaxRequest)).toBe(530);
    const result = await maximalCase(policyMaxRequest);
    expect(result.partCount).toBe(530);
    expect(result.textBytes).toBe(15_878_146);
  });
  it("P03 derivation pin: one more row per cap moves maxBatchTextBytes by exactly that maximal row plus its separator, times products", () => {
    const salesCap50 = secondaryRequest({ ...launchPosture, salesLimit: 50 }, 5);
    const salesCap51 = secondaryRequest({ ...launchPosture, salesLimit: 51 }, 5);
    expect(maxBatchTextBytes(salesCap51) - maxBatchTextBytes(salesCap50)).toBe(
      5 * (bytes(JSON.stringify(maximalSale())) + 1),
    );
    const listingsBudget11 = secondaryRequest({ ...launchPosture, listingsPageBudget: 11 }, 5);
    const listingsDelta = maxBatchTextBytes(listingsBudget11) - maxBatchTextBytes(launchRequest);
    expect(listingsDelta).toBe(5 * 50 * (bytes(JSON.stringify(maximalListing(550))) + 1));
    expect(listingsDelta).toBe(78_250);
  });
  it("P04 derivation pin: changing only salesConditions moves maxBatchTextBytes by exactly the posture-envelope delta", () => {
    const withConditions = secondaryRequest({ ...launchPosture, salesConditions: [1, 2, 3] }, 5);
    const delta = maxBatchTextBytes(withConditions) - maxBatchTextBytes(launchRequest);
    expect(delta).toBe(bytes(JSON.stringify(withConditions.posture)) - bytes(JSON.stringify(launchRequest.posture)));
    expect(delta).toBe(5);
  });
  it("P05 the maxBatchTextBytes memo is exact: equal-but-distinct requests match, and A, B, A each return the uncached value", () => {
    const uncached = sourceMutant<typeof maxBatchTextBytes>(
      [["maxBatchTextBytesMemo.key === key", "false"]],
      "maxBatchTextBytes",
    );
    const a = launchRequest;
    const b = policyMaxRequest;
    const aCopy = parseTcgplayerMarketObservationRequest(JSON.parse(JSON.stringify(a)));
    expect(aCopy).not.toBe(a);
    expect(aCopy).toEqual(a);
    expect(maxBatchTextBytes(a)).toBe(uncached(a));
    expect(maxBatchTextBytes(b)).toBe(uncached(b));
    expect(maxBatchTextBytes(a)).toBe(uncached(a));
    expect(maxBatchTextBytes(aCopy)).toBe(uncached(a));
    expect(uncached(a)).not.toBe(uncached(b));
  });
  it("D01 the digest rejects non-ASCII text and accepts NUL-prefixed ASCII", async () => {
    await expect(digestTcgplayerMarketObservationBatchText("\x00\x00abc")).resolves.toMatch(/^[0-9a-f]{64}$/);
    await expect(digestTcgplayerMarketObservationBatchText("abcé")).rejects.toMatchObject({
      code: "invalid_batch_text",
    });
    await expect(digestTcgplayerMarketObservationBatchText(`${"\x00".repeat(10_000)}é`)).rejects.toMatchObject({
      code: "invalid_batch_text",
    });
  });
});
