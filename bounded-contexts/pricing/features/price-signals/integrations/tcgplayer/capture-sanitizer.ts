import type { ProviderObservationCapture } from "../../domain/provider-observation-mapper";
import type { TcgplayerResponseFieldSummaryV1 } from "./response-receipt";

export type TcgplayerMarketCaptureReceiptV1 = Readonly<{
  kind: "tcgplayer-market-capture-v1";
  captureId: string;
  lifecycle: Readonly<{
    fieldSummaryCapturedAt: "response-receipt-before-decode";
    retainedAt: "after-immutable-capture-commit";
  }>;
  requestPosture: Readonly<{
    authenticated: boolean;
    salesPages: number;
    listingPages: number;
    ownSellerExclusionApplied: boolean;
    historyRange: "annual";
  }>;
  responseSummary: Readonly<{
    fieldPresenceAndTypes: TcgplayerResponseFieldSummaryV1;
    salesStatus: string;
    listingsStatus: string;
    historyStatus: string;
    salesReturned: number;
    listingReturned: number;
    historyResults: number;
    historyBuckets: number;
    salesCoverage: string;
    listingsCoverage: string;
    historyCoverage: string;
    maximumTupleMultiplicity: number;
    captureLocalJointRows: number;
    typedRows: number;
  }>;
}>;

export type TcgplayerMarketCaptureReceiptSink = Readonly<{
  retain: (receipt: TcgplayerMarketCaptureReceiptV1) => Promise<void>;
}>;

export type TcgplayerMarketCaptureReceiptSinkCapability =
  | TcgplayerMarketCaptureReceiptSink
  | Readonly<{ kind: "not-mounted" }>;

export function isTcgplayerMarketCaptureReceiptSink(
  capability: TcgplayerMarketCaptureReceiptSinkCapability,
): capability is TcgplayerMarketCaptureReceiptSink {
  return !("kind" in capability);
}

/** Combines pre-decode shape facts with post-reduction counts; raw values are unrepresentable. */
export function sanitizeTcgplayerMarketCaptureReceipt(
  capture: ProviderObservationCapture,
  fieldPresenceAndTypes: TcgplayerResponseFieldSummaryV1,
): TcgplayerMarketCaptureReceiptV1 {
  const header = capture.header;
  return {
    kind: "tcgplayer-market-capture-v1",
    captureId: header.captureId,
    lifecycle: {
      fieldSummaryCapturedAt: "response-receipt-before-decode",
      retainedAt: "after-immutable-capture-commit",
    },
    requestPosture: {
      authenticated: header.authenticatedRequest,
      salesPages: header.sales?.pagesFetched ?? 0,
      listingPages: header.listings?.pagesFetched ?? 0,
      ownSellerExclusionApplied: header.listings?.ownSellerExclusionApplied ?? false,
      historyRange: "annual",
    },
    responseSummary: {
      fieldPresenceAndTypes,
      salesStatus: header.sales?.status ?? "not-requested",
      listingsStatus: header.listings?.status ?? "not-requested",
      historyStatus: header.history?.status ?? "not-requested",
      salesReturned: header.sales?.returnedCount ?? 0,
      listingReturned: header.listings?.returnedCount ?? 0,
      historyResults: header.history?.resultCount ?? 0,
      historyBuckets: header.history?.bucketCount ?? 0,
      salesCoverage: header.sales?.coverage ?? "unknown",
      listingsCoverage: header.listings?.coverage ?? "unknown",
      historyCoverage: header.history?.coverage ?? "unknown",
      maximumTupleMultiplicity: Math.max(0, ...capture.sales.map((row) => row.observedOccurrenceCount)),
      captureLocalJointRows: capture.askDepth.length,
      typedRows: capture.sales.length + capture.weekly.length + capture.snapshots.length + capture.askDepth.length,
    },
  };
}
