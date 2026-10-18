import { vi } from "vitest";
import { coordinatorFixture } from "./coordinator-test-support";
import type { ConnectorExecutor, ExecutorResult, OperationUnit } from "../domain/operation-protocol";
import { stagedImportMembershipDigest } from "../domain/staged-import-dispatch";
import type { StagedImportCapturePlan } from "../domain/staged-import-fit";
import { deriveClaimedOperationOutcomes } from "../../tcgplayer-csv/domain/lifecycle";
import type { ChannelSyncRun } from "../../tcgplayer-csv/domain/contracts";

type RequestKind = StagedImportCapturePlan["requests"][number]["kind"];

/** A synthetic claimed -> validation-rejected settlement whose member outcomes come from the run law. */
export function validationRejectedResult(
  unit: OperationUnit,
  settlement: NonNullable<ExecutorResult["runSettlement"]>,
  alreadySatisfied: ReadonlySet<string> = new Set(),
): ExecutorResult {
  const at = "2026-10-09T00:00:00.000Z";
  const run: ChannelSyncRun = {
    runId: settlement.runId,
    revision: settlement.expectedRunRevision + 1,
    sequence: 1,
    connectionId: unit.reservation.connectionId,
    providerKey: "tcgplayer",
    reservationId: unit.reservation.reservationId,
    claimant: { claimantKind: "connector", claimantId: "pairing-1" },
    leaseExpiresAt: unit.reservation.leaseExpiresAt,
    manualClaimLeasePolicySnapshot: null,
    state: "validation-rejected",
    basisSnapshotId: "synthetic-basis",
    basisSnapshotGeneration: 1,
    verificationSnapshotId: null,
    verificationSnapshotGeneration: null,
    uploadAttemptedAt: null,
    uploadFileName: null,
    importSummary: null,
    createdAt: at,
    updatedAt: at,
    membershipCompleteness: { kind: "complete", total: unit.members.length },
    members: unit.members.map((member, ordinal) => {
      if (!("desiredStateSequence" in member) || member.payload.kind !== "draft")
        throw new Error("synthetic-listing-only");
      const common = {
        operationId: member.operationId,
        attemptId: member.attemptId,
        claimGeneration: member.claimGeneration,
        reservationId: unit.reservation.reservationId,
        channelListingId: member.payload.draft.channelListingId,
        listingId: `synthetic-listing-${ordinal}`,
        desiredStateSequence: member.desiredStateSequence,
        listingRevision: member.payload.draft.listingRevision,
        payloadDigest: member.payloadDigest,
        ordinal,
        externalKey: `synthetic-${ordinal}`,
        conditionText: null,
        basisSnapshotId: "synthetic-basis",
        basisSnapshotGeneration: 1,
        basisTotalQuantity: 1,
        basisPriceAmountMinor: 100,
        targetQuantity: 1,
        targetPriceAmountMinor: 100,
        refusalReason: null,
        mappingDimension: null,
        mappingSourceKey: null,
      } as const;
      return alreadySatisfied.has(member.operationId)
        ? {
            ...common,
            memberKind: "already-satisfied",
            csvRow: null,
            providerAction: "not-attempted-already-satisfied",
          }
        : { ...common, memberKind: "composed", csvRow: { "TCGplayer Id": common.externalKey } };
    }),
  };
  return {
    outcomes: deriveClaimedOperationOutcomes(run),
    runSettlement: { ...settlement, toState: "validation-rejected", uploadAttemptedAt: null },
  };
}

export async function floorFixture(
  durations = [1000, 1000, 1000],
  kinds: readonly RequestKind[] = durations.map((_, index) => (index === 0 ? "read" : "mutation")),
) {
  const f = await coordinatorFixture("reservation");
  let monotonic = 0;
  const initial = f.now();
  const starts: number[] = [];
  const completions: number[] = [];
  const policyReads: string[] = [];
  let revision = "b".repeat(64);
  let plan: StagedImportCapturePlan | null;
  const request = vi.fn(async (request: Request) => {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/tcgplayer-staged-import-dispatch-policy")) {
      policyReads.push(url.searchParams.get("requestNonce")!);
      return Response.json({
        schemaVersion: 1,
        policyKey: "channels.tcgplayer-staged-import-dispatch",
        unit: "seconds",
        applicability: "founder-staged-import-all-provider-requests",
        connectionId: f.input.connectionId,
        pairingId: "pairing-1",
        reservationId: url.searchParams.get("reservationId"),
        requestNonce: url.searchParams.get("requestNonce"),
        policy: {
          source: "policy",
          documentId: "synthetic-policy",
          effectiveFrom: "2026-01-01T00:00:00Z",
          effectiveUntil: null,
          resolvedAt: new Date(f.now()).toISOString(),
          value: { minimumRequestStartIntervalSeconds: 60 },
          revision,
        },
      });
    }
    if (url.origin === "https://synthetic-provider.invalid") {
      starts.push(monotonic);
      advance(durations[starts.length - 1] ?? 1000);
      completions.push(monotonic);
      return new Response("synthetic");
    }
    return f.request(request);
  });
  function advance(ms: number) {
    monotonic += ms;
    f.setNow(initial + monotonic);
  }
  const prepare: ConnectorExecutor["prepare"] = async (unit) => {
    plan = {
      schemaVersion: 1,
      source: "capture-derived",
      captureDigest: "c".repeat(64),
      complete: true,
      polling: false,
      connectionId: unit.reservation.connectionId,
      pairingId: "pairing-1",
      reservationId: unit.reservation.reservationId,
      executorKey: f.executor.key,
      membershipDigest: await stagedImportMembershipDigest(unit),
      batchDigest: "d".repeat(64),
      composedRows: 1,
      requests: durations.map((duration, index) => ({
        requestId: `synthetic-hop-${index}`,
        kind: kinds[index]!,
        maximumDurationMs: duration,
      })),
      platformReadMs: 1,
      parsingMs: 1,
      reportMs: 1,
    };
    return { ready: true, stagedImport: { plan, batchDigest: "d".repeat(64), composedRows: 1 } };
  };
  const dispatch = vi.fn<ConnectorExecutor["dispatchOnce"]>(async (unit, _signal, _pull, stagedImport) => {
    if (!stagedImport) throw new Error("missing-guarded-port");
    for (let i = 0; i < durations.length; i++)
      await stagedImport.send(
        `synthetic-hop-${i}`,
        new Request("https://synthetic-provider.invalid/hop", { redirect: "error" }),
      );
    return f.result(unit);
  });
  const executor: ConnectorExecutor = {
    ...f.executor,
    providerRequests: "tcgplayer-staged-import",
    dispatchDeadlineMs: 600000,
    prepare,
    dispatchOnce: dispatch,
  };
  const ports = {
    ...f.ports,
    executors: [executor],
    request: (value: Request) => request(value),
    clock: { now: f.now, monotonic: () => monotonic },
    wait: async (ms: number) => {
      advance(ms);
    },
  };
  return {
    ...f,
    ports,
    executor,
    request,
    dispatch,
    starts,
    completions,
    policyReads,
    advance,
    setRevision: (value: string) => {
      revision = value;
    },
    setMonotonic: (value: number) => {
      monotonic = value;
    },
    get plan() {
      return plan;
    },
  };
}
