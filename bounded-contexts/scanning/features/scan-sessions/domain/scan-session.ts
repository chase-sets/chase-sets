import type { AggregateDecider, AggregateEvolver, DomainEvent } from "@chase-sets/event-core";
import type { JsonObject } from "@chase-sets/primitives/json";

export type ScanSessionStatus = "active" | "completed";
export type ScanStatus = "captured" | "identified" | "unidentified" | "confirmed" | "corrected" | "discarded";
export type CandidateSource = "top" | "alternate" | "manual";

export type CompleteProduct = Readonly<{
  catalogItemId: string;
  dimensions: Readonly<Record<string, string>>;
  selectedOptions: Readonly<Record<string, string>>;
}>;

export type ScanSessionState = Readonly<{
  sessionId: string | null;
  accountId: string | null;
  purpose: "listing-intake" | null;
  channel: "camera" | "upload" | null;
  status: ScanSessionStatus;
  scans: Readonly<Record<string, ScanState>>;
  counts: Readonly<{ confirmed: number; corrected: number; unidentified: number; discarded: number }>;
}>;

export type ScanState = Readonly<{
  scanId: string;
  assetRef: string;
  status: ScanStatus;
  candidates: readonly JsonObject[];
  product: CompleteProduct | null;
  candidateSource: CandidateSource | null;
  rejectedCandidateRef: string | null;
  reason: string | null;
}>;

export const initialScanSessionState: ScanSessionState = {
  sessionId: null,
  accountId: null,
  purpose: null,
  channel: null,
  status: "active",
  scans: {},
  counts: { confirmed: 0, corrected: 0, unidentified: 0, discarded: 0 },
};

type BaseCommand = Readonly<{ type: string }>;
export type ScanSessionCommand =
  | (BaseCommand & {
      type: "StartScanSession";
      sessionId: string;
      accountId: string;
      purpose: "listing-intake";
      channel: "camera" | "upload";
    })
  | (BaseCommand & { type: "CaptureScan"; scanId: string; assetRef: string; capturedAt: string })
  | (BaseCommand & {
      type: "IdentifyScan";
      scanId: string;
      candidates: readonly JsonObject[];
      tier?: string;
      attempt?: JsonObject;
    })
  | (BaseCommand & { type: "MarkScanUnidentified"; scanId: string; reason: string })
  | (BaseCommand & {
      type: "ConfirmMatch";
      scanId: string;
      product: CompleteProduct;
      candidateSource: CandidateSource;
      confirmedAt: string;
    })
  | (BaseCommand & {
      type: "CorrectMatch";
      scanId: string;
      product: CompleteProduct;
      rejectedCandidateRef: string;
      correctedAt: string;
    })
  | (BaseCommand & { type: "DiscardScan"; scanId: string; reason: string; discardedAt: string })
  | (BaseCommand & { type: "CompleteScanSession"; completedAt: string });

export type ScanSessionEvent =
  | DomainEvent<
      "scanning.scan-session.started",
      { sessionId: string; accountId: string; purpose: "listing-intake"; channel: "camera" | "upload" }
    >
  | DomainEvent<
      "scanning.scan-session.scan-captured",
      { sessionId: string; scanId: string; assetRef: string; capturedAt: string }
    >
  | DomainEvent<
      "scanning.scan-session.scan-identified",
      {
        sessionId: string;
        scanId: string;
        candidates: readonly JsonObject[];
        tier: string | null;
        attempt: JsonObject | null;
      }
    >
  | DomainEvent<"scanning.scan-session.scan-unidentified", { sessionId: string; scanId: string; reason: string }>
  | DomainEvent<
      "scanning.scan-session.match-confirmed",
      {
        sessionId: string;
        scanId: string;
        product: CompleteProduct;
        candidateSource: CandidateSource;
        confirmedAt: string;
      }
    >
  | DomainEvent<
      "scanning.scan-session.match-corrected",
      { sessionId: string; scanId: string; product: CompleteProduct; rejectedCandidateRef: string; correctedAt: string }
    >
  | DomainEvent<
      "scanning.scan-session.scan-discarded",
      { sessionId: string; scanId: string; reason: string; discardedAt: string }
    >
  | DomainEvent<
      "scanning.scan-session.completed",
      { sessionId: string; counts: ScanSessionState["counts"]; completedAt: string }
    >;

function fail(message: string): never {
  throw new Error(message);
}
function required(value: string, label: string): string {
  const v = value.trim();
  return v || fail(`${label} must not be blank.`);
}
function sessionRequired(state: ScanSessionState): void {
  if (!state.sessionId) fail("Scan session has not started.");
}
function scanRequired(state: ScanSessionState, id: string): ScanState {
  const scan = state.scans[id];
  return scan ?? fail("Scan does not exist.");
}
function assertProduct(product: CompleteProduct): void {
  required(product.catalogItemId, "catalogItemId");
  if (!product.dimensions || Object.keys(product.dimensions).length === 0)
    fail("Complete Product requires dimensions.");
  if (!product.selectedOptions || Object.keys(product.selectedOptions).length === 0)
    fail("Complete Product requires selectedOptions.");
}
function increment(state: ScanSessionState, key: keyof ScanSessionState["counts"]): ScanSessionState["counts"] {
  return { ...state.counts, [key]: state.counts[key] + 1 };
}
type ScanEventData = {
  sessionId: string;
  accountId?: string;
  purpose?: "listing-intake";
  channel?: "camera" | "upload";
  scanId?: string;
  assetRef?: string;
  candidates?: readonly JsonObject[];
  reason?: string;
  product?: CompleteProduct;
  candidateSource?: CandidateSource;
  rejectedCandidateRef?: string;
  counts?: ScanSessionState["counts"];
};

export const evolveScanSession: AggregateEvolver<ScanSessionState, ScanSessionEvent> = (state, event) => {
  const d = event.data as ScanEventData;
  if (state.sessionId && "sessionId" in d && d.sessionId !== state.sessionId)
    fail("Event identity does not match scan session.");
  switch (event.type) {
    case "scanning.scan-session.started":
      if (state.sessionId) fail("Poisoned history: duplicate session identity.");
      return { ...state, sessionId: d.sessionId, accountId: d.accountId!, purpose: d.purpose!, channel: d.channel! };
    case "scanning.scan-session.scan-captured":
      if (state.scans[d.scanId!]) fail("Poisoned history: duplicate scan identity.");
      return {
        ...state,
        scans: {
          ...state.scans,
          [d.scanId!]: {
            scanId: d.scanId!,
            assetRef: d.assetRef!,
            status: "captured",
            candidates: [],
            product: null,
            candidateSource: null,
            rejectedCandidateRef: null,
            reason: null,
          },
        },
      };
    case "scanning.scan-session.scan-identified": {
      const scan = scanRequired(state, d.scanId!);
      if (scan.status !== "captured") fail("Scan can only be identified once.");
      return {
        ...state,
        scans: { ...state.scans, [d.scanId!]: { ...scan, status: "identified", candidates: d.candidates! } },
      };
    }
    case "scanning.scan-session.scan-unidentified": {
      const scan = scanRequired(state, d.scanId!);
      if (scan.status !== "captured") fail("Scan can only be marked unidentified once.");
      return {
        ...state,
        scans: { ...state.scans, [d.scanId!]: { ...scan, status: "unidentified", reason: d.reason! } },
      };
    }
    case "scanning.scan-session.match-confirmed": {
      const scan = scanRequired(state, d.scanId!);
      if (!["identified", "unidentified"].includes(scan.status))
        fail("Only an identified or unidentified scan can be confirmed.");
      return {
        ...state,
        scans: {
          ...state.scans,
          [d.scanId!]: { ...scan, status: "confirmed", product: d.product!, candidateSource: d.candidateSource! },
        },
        counts: increment(state, "confirmed"),
      };
    }
    case "scanning.scan-session.match-corrected": {
      const scan = scanRequired(state, d.scanId!);
      if (!["identified", "unidentified"].includes(scan.status))
        fail("Only an identified or unidentified scan can be corrected.");
      return {
        ...state,
        scans: {
          ...state.scans,
          [d.scanId!]: {
            ...scan,
            status: "corrected",
            product: d.product!,
            candidateSource: "manual",
            rejectedCandidateRef: d.rejectedCandidateRef!,
          },
        },
        counts: increment(state, "corrected"),
      };
    }
    case "scanning.scan-session.scan-discarded": {
      const scan = scanRequired(state, d.scanId!);
      if (["confirmed", "corrected", "discarded"].includes(scan.status)) fail("Terminal scan cannot be discarded.");
      return {
        ...state,
        scans: { ...state.scans, [d.scanId!]: { ...scan, status: "discarded", reason: d.reason! } },
        counts: increment(state, "discarded"),
      };
    }
    case "scanning.scan-session.completed":
      if (state.status === "completed") fail("Scan session is already completed.");
      if (
        Object.values(state.scans).some(
          (scan) => !["confirmed", "corrected", "unidentified", "discarded"].includes(scan.status),
        )
      )
        fail("Every scan must have a terminal outcome before completion.");
      if (JSON.stringify(d.counts) !== JSON.stringify(state.counts))
        fail("Completion counts do not match authoritative state.");
      return { ...state, status: "completed" };
  }
};

export const decideScanSession: AggregateDecider<ScanSessionState, ScanSessionCommand, ScanSessionEvent> = (
  state,
  command,
) => {
  if (state.status === "completed" && command.type !== "StartScanSession")
    fail("Completed scan session cannot accept commands.");
  switch (command.type) {
    case "StartScanSession":
      if (state.sessionId) fail("Scan session has already started.");
      return [
        {
          type: "scanning.scan-session.started",
          data: {
            sessionId: required(command.sessionId, "sessionId"),
            accountId: required(command.accountId, "accountId"),
            purpose: command.purpose,
            channel: command.channel,
          },
        },
      ];
    case "CaptureScan":
      sessionRequired(state);
      if (state.scans[command.scanId]) fail("Scan already exists.");
      if (!/^asset:[A-Za-z0-9._~-]{1,128}$/.test(command.assetRef))
        fail("assetRef must be a bounded opaque reference.");
      return [
        {
          type: "scanning.scan-session.scan-captured",
          data: {
            sessionId: state.sessionId!,
            scanId: required(command.scanId, "scanId"),
            assetRef: command.assetRef,
            capturedAt: command.capturedAt,
          },
        },
      ];
    case "IdentifyScan":
      sessionRequired(state);
      scanRequired(state, command.scanId);
      if (command.candidates.length > 20) fail("Candidate list exceeds bound.");
      return [
        {
          type: "scanning.scan-session.scan-identified",
          data: {
            sessionId: state.sessionId!,
            scanId: command.scanId,
            candidates: command.candidates,
            tier: command.tier ?? null,
            attempt: command.attempt ?? null,
          },
        },
      ];
    case "MarkScanUnidentified":
      sessionRequired(state);
      return [
        {
          type: "scanning.scan-session.scan-unidentified",
          data: { sessionId: state.sessionId!, scanId: command.scanId, reason: required(command.reason, "reason") },
        },
      ];
    case "ConfirmMatch":
      sessionRequired(state);
      assertProduct(command.product);
      return [
        {
          type: "scanning.scan-session.match-confirmed",
          data: {
            sessionId: state.sessionId!,
            scanId: command.scanId,
            product: command.product,
            candidateSource: command.candidateSource,
            confirmedAt: command.confirmedAt,
          },
        },
      ];
    case "CorrectMatch":
      sessionRequired(state);
      assertProduct(command.product);
      return [
        {
          type: "scanning.scan-session.match-corrected",
          data: {
            sessionId: state.sessionId!,
            scanId: command.scanId,
            product: command.product,
            rejectedCandidateRef: required(command.rejectedCandidateRef, "rejectedCandidateRef"),
            correctedAt: command.correctedAt,
          },
        },
      ];
    case "DiscardScan":
      sessionRequired(state);
      return [
        {
          type: "scanning.scan-session.scan-discarded",
          data: {
            sessionId: state.sessionId!,
            scanId: command.scanId,
            reason: required(command.reason, "reason"),
            discardedAt: command.discardedAt,
          },
        },
      ];
    case "CompleteScanSession":
      sessionRequired(state);
      return [
        {
          type: "scanning.scan-session.completed",
          data: { sessionId: state.sessionId!, counts: state.counts, completedAt: command.completedAt },
        },
      ];
  }
};

export const scanSessionStreamId = (sessionId: string): string =>
  `scanning.scan-session-${required(sessionId, "sessionId")}`;
