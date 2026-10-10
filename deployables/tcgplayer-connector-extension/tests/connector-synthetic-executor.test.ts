import type { OperationUnit } from "@chase-sets/channels/client";
import { afterEach, expect, it, vi } from "vitest";
import { syntheticExecutor } from "../__tests__/harness/executors.harness";

type OperationAttempt = OperationUnit["members"][number];

afterEach(() => vi.unstubAllGlobals());

it.each(["operation", "reservation"] as const)(
  "synthetic %s executor refuses order-pull before transport",
  async (unit) => {
    const request = vi.fn();
    vi.stubGlobal("fetch", request);
    const at = "2026-10-09T00:00:00.000Z";
    const selector = {
      identity: "synthetic-selector",
      version: 1,
      pageSize: 10,
      traversal: "snapshot-cursor",
    } as const;
    const attempt: OperationAttempt = {
      schemaVersion: 1,
      connectionId: "connection_synthetic",
      revision: 1,
      operationId: "synthetic-order-pull",
      attemptId: "synthetic-attempt",
      claimGeneration: 1,
      reservationId: "synthetic-reservation",
      leaseExpiresAt: "2026-10-09T00:30:00.000Z",
      payloadDigest: "0".repeat(64),
      state: "prepared",
      preparedAt: at,
      operationKind: "tcgplayer-order-pull",
      scheduleGeneration: 1,
      payload: {
        kind: "order-pull",
        version: 2,
        connectionId: "connection_synthetic",
        pullId: `copl_${"0".repeat(40)}`,
        policyRevision: 1,
        lawVersion: "ready-to-ship-intake/v2",
        selector,
        bounds: {
          nIntakeReadMax: 8,
          nListReadMax: 2,
          fMax: 5,
          plan: { listReads: 2, intakeReads: 8, followUpReads: 0 },
          providerCalls: 10,
          providerCadenceMs: 10_000,
          maxObservationPosts: 32,
          budgetMs: 600_000,
        },
        followUpReferences: [],
        checkpoint: {
          burstId: `copl_${"0".repeat(40)}`,
          policyRevision: 1,
          selector,
          traversal: null,
          gapCount: 0,
          drained: false,
          followUpTail: false,
        },
        checkpointDigest: "0".repeat(64),
        work: { chunkId: null, references: [], postedReferences: [], acceptedReferences: [] },
        predecessor: null,
        providerNotBefore: at,
      },
    };
    const executor = syntheticExecutor(unit);
    const work: OperationUnit = {
      members: [attempt],
      reservation: {
        schemaVersion: 1,
        connectionId: attempt.connectionId,
        revision: 1,
        reservationId: attempt.reservationId,
        executorKey: executor.key,
        reservedAt: at,
        leaseExpiresAt: attempt.leaseExpiresAt,
        memberOperationIds: [attempt.operationId],
        phase: "prepared",
      },
    };
    await expect(executor.prepare(work)).rejects.toThrow("synthetic-executor-unsupported-operation");
    await expect(executor.dispatchOnce(work, new AbortController().signal)).rejects.toThrow(
      "synthetic-executor-unsupported-operation",
    );
    for (const proof of [false, true]) {
      vi.stubGlobal("__connectorSyntheticProof", proof);
      await expect(executor.reconcileAmbiguous!(work)).rejects.toThrow("synthetic-executor-unsupported-operation");
    }
    expect(request).not.toHaveBeenCalled();
  },
);
