import type { ProviderObservationCapture } from "../../domain/provider-observation-mapper";
import {
  sanitizeEndpointStageTrace,
  type EndpointFailurePhase,
  type SafeHttpStatusClass,
  type TcgplayerEndpointFailurePhases,
  type TcgplayerEndpointFailureClass,
  type TcgplayerEndpointStageTrace,
  type TcgplayerEndpointStageTraces,
} from "./market-client";
import type { TcgplayerResponseFieldSummaryV1 } from "./response-receipt";

type EndpointDiagnostic = Readonly<{
  failurePhase: EndpointFailurePhase;
  httpStatusClass: SafeHttpStatusClass | null;
  lastHttpStatus?: number | null;
  failureClass?: TcgplayerEndpointFailureClass;
  stageTrace?: TcgplayerEndpointStageTrace;
}>;

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
    endpointDiagnostics?: Readonly<{
      sales: EndpointDiagnostic;
      listings: EndpointDiagnostic;
      history: EndpointDiagnostic;
    }>;
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

export type TcgplayerMarketCaptureReceiptStorage = Readonly<{
  putObject: (
    input: Readonly<{
      key: string;
      body: Uint8Array;
      contentType: string;
      cacheControl: string;
      visibility: "private";
    }>,
  ) => Promise<unknown>;
}>;

export function createObjectStorageTcgplayerMarketCaptureReceiptSink(
  storage: TcgplayerMarketCaptureReceiptStorage,
): TcgplayerMarketCaptureReceiptSink {
  return {
    async retain(receipt) {
      await storage.putObject({
        key: `provider-evidence/tcgplayer-market-captures/${encodeURIComponent(receipt.captureId)}.json`,
        body: new TextEncoder().encode(`${JSON.stringify(receipt, null, 2)}\n`),
        contentType: "application/json",
        cacheControl: "no-store",
        visibility: "private",
      });
    },
  };
}

export function isTcgplayerMarketCaptureReceiptSink(
  capability: TcgplayerMarketCaptureReceiptSinkCapability,
): capability is TcgplayerMarketCaptureReceiptSink {
  return !("kind" in capability);
}

/** Combines pre-decode shape facts with post-reduction counts; raw values are unrepresentable. */
export function sanitizeTcgplayerMarketCaptureReceipt(
  capture: ProviderObservationCapture,
  fieldPresenceAndTypes: TcgplayerResponseFieldSummaryV1,
  failurePhases: TcgplayerEndpointFailurePhases,
  stageTraces?: TcgplayerEndpointStageTraces,
): TcgplayerMarketCaptureReceiptV1 {
  const header = capture.header;
  const diagnostic = (
    failurePhase: EndpointFailurePhase,
    httpStatusClass: SafeHttpStatusClass | null,
    trace: TcgplayerEndpointStageTrace | undefined,
  ): EndpointDiagnostic => {
    const stageTrace = sanitizeEndpointStageTrace(trace);
    const terminal = lastTerminal(stageTrace);
    const lastHttpStatus = terminal?.lastHttpStatus ?? null;
    return {
      failurePhase,
      httpStatusClass,
      lastHttpStatus,
      failureClass: classifyTerminal(stageTrace),
      ...(stageTrace ? { stageTrace } : {}),
    };
  };
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
      endpointDiagnostics: {
        sales: diagnostic(failurePhases.sales, header.sales?.httpStatusClass ?? null, stageTraces?.sales),
        listings: diagnostic(failurePhases.listings, header.listings?.httpStatusClass ?? null, stageTraces?.listings),
        history: diagnostic(failurePhases.history, header.history?.httpStatusClass ?? null, stageTraces?.history),
      },
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

export function readTcgplayerEndpointFailureClass(
  diagnostic: Readonly<{ lastHttpStatus?: unknown; failureClass?: unknown }> | null | undefined,
): TcgplayerEndpointFailureClass {
  if (!diagnostic) return "unknown";
  if (
    diagnostic.lastHttpStatus !== null &&
    (!Number.isInteger(diagnostic.lastHttpStatus) ||
      (diagnostic.lastHttpStatus as number) < 100 ||
      (diagnostic.lastHttpStatus as number) > 599)
  )
    return "unknown";
  if (diagnostic.failureClass === null) return null;
  if (
    typeof diagnostic.failureClass === "string" &&
    [
      "credential-unavailable",
      "auth-rejected",
      "forbidden",
      "rate-limited",
      "client-error",
      "server-error",
      "other",
      "no-response",
      "unknown",
    ].includes(diagnostic.failureClass)
  )
    return diagnostic.failureClass as TcgplayerEndpointFailureClass;
  return "unknown";
}

function classifyTerminal(trace: TcgplayerEndpointStageTrace | undefined): TcgplayerEndpointFailureClass {
  const terminal = lastTerminal(trace);
  if (
    !terminal ||
    terminal.lastHttpStatus === undefined ||
    terminal.lastHttpStatusAttempt === undefined ||
    terminal.failureCode === undefined
  )
    return "unknown";
  if (terminal.outcome === "success") return null;
  if (terminal.failureCode === "credential-unavailable") return "credential-unavailable";
  if (terminal.lastHttpStatus === null) return "no-response";
  if (terminal.lastHttpStatus === 401) return "auth-rejected";
  if (terminal.lastHttpStatus === 403) return "forbidden";
  if (terminal.lastHttpStatus === 429) return "rate-limited";
  if (terminal.lastHttpStatus >= 400 && terminal.lastHttpStatus < 500) return "client-error";
  if (terminal.lastHttpStatus >= 500 && terminal.lastHttpStatus < 600) return "server-error";
  return "other";
}

function lastTerminal(trace: TcgplayerEndpointStageTrace | undefined) {
  for (let index = (trace?.entries.length ?? 0) - 1; index >= 0; index -= 1) {
    const entry = trace?.entries[index];
    if (entry?.stage === "terminal") return entry;
  }
  return undefined;
}
