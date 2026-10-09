import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { vi } from "vitest";
import { createConnectorOperationCoordinator } from "../domain/operation-coordinator";
import {
  browserPayloadDigest,
  type ConnectorExecutor,
  type ExecutorResult,
  type OperationUnit,
} from "../domain/operation-protocol";
import { createOperationJournal } from "../integrations/connector-indexeddb";
import type { ClaimedOperationOutcome, ClaimedOperationReservation } from "../../outbound-sync/domain/contracts";

export async function coordinatorFixture(unit: "operation" | "reservation" = "operation") {
  const indexedDB = new IDBFactory();
  let now = Date.parse("2026-10-09T00:00:00.000Z");
  let authority: "paired-idle" | "report-only" | "absent" = "paired-idle";
  const fixtureTitle = "Synthetic";
  const payload = {
    kind: "draft",
    draft: {
      channelListingId: "link-1",
      listingRevision: 1,
      title: fixtureTitle,
      description: "",
      categoryKey: "card",
      conditionKey: "new",
      price: { amountMinor: 100, currency: "USD" },
      quantity: 1,
      attributes: [],
    },
  } as const;
  const claim: ClaimedOperationReservation = {
    reservationId: "reservation-1",
    connectionId: "connection-1",
    providerIdentity: { providerKey: "tcgplayer", environment: "sandbox" },
    claimant: { claimantKind: "connector", claimantId: "pairing-1" },
    reservedAt: new Date(now).toISOString(),
    leaseExpiresAt: new Date(now + 1800000).toISOString(),
    operations: [
      {
        operationId: "operation-1",
        attemptId: "attempt-1",
        claimGeneration: 1,
        connectionId: "connection-1",
        providerIdentity: { providerKey: "tcgplayer", environment: "sandbox" },
        channelListingId: "link-1",
        listingId: "listing-1",
        operationKind: "publish",
        listingRevision: 1,
        desiredStateSequence: 1,
        payload,
        payloadDigest: await browserPayloadDigest(payload),
        sourceOccurredAt: new Date(now).toISOString(),
        enqueuedAt: new Date(now).toISOString(),
      },
    ],
  };
  const claims: unknown[] = [claim];
  const reports: string[] = [];
  const settlement = {
    runId: "synthetic-run",
    expectedRunRevision: 1,
    fromState: "claimed",
    toState: "applied",
    verificationSnapshotId: null,
    verificationSnapshotGeneration: null,
    uploadAttemptedAt: null,
    uploadFileName: null,
    importSummary: null,
  } as const;
  const result = (work: OperationUnit) =>
    ({
      outcomes: work.members.map((member): ClaimedOperationOutcome => {
        if (member.operationKind === "tcgplayer-order-pull") throw new Error("listing fixture received a pull");
        return {
          operationId: member.operationId,
          attemptId: member.attemptId,
          claimGeneration: member.claimGeneration,
          desiredStateSequence: member.desiredStateSequence,
          outcome: { kind: "applied", result: { kind: "succeeded", externalListingId: "synthetic-external" } },
        };
      }),
      ...(unit === "reservation" ? { runSettlement: settlement } : {}),
    }) satisfies ExecutorResult;
  const dispatchOnce = vi.fn(async (work: OperationUnit, _signal: AbortSignal) => result(work));
  const prepare = vi.fn<ConnectorExecutor["prepare"]>(async () => ({ ready: true }));
  const executor: ConnectorExecutor = {
    key: "synthetic-executor",
    accepts: [["publish", "draft"]],
    unit,
    dispatchDeadlineMs: 1000,
    prepare,
    dispatchOnce,
  };
  const request = vi.fn(async (request: Request) => {
    if (new URL(request.url).pathname.endsWith("/claim"))
      return Response.json({ reservation: claims.shift() ?? null, pollWindowSeconds: 60 });
    reports.push(await request.text());
    return new Response("{}", { status: 200 });
  });
  const ports = {
    indexedDB,
    keyRange: IDBKeyRange,
    executors: [executor],
    platformOrigin: "https://synthetic.invalid",
    request,
    clock: { now: () => now },
  };
  const input = { connectionId: claim.connectionId, accessToken: "SYNTHETIC_TOKEN", authority: async () => authority };
  return {
    indexedDB,
    claim,
    claims,
    reports,
    result,
    settlement,
    executor,
    prepare,
    dispatchOnce,
    request,
    ports,
    input,
    journal: createOperationJournal(indexedDB, IDBKeyRange),
    coordinator: () => createConnectorOperationCoordinator(ports),
    setAuthority: (value: typeof authority) => {
      authority = value;
    },
    setNow: (value: number) => {
      now = value;
    },
    now: () => now,
  };
}
