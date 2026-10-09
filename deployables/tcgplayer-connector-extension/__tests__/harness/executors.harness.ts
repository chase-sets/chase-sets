import type { ConnectorExecutor, ExecutorResult, OperationUnit } from "@chase-sets/channels/client";
import { connectorTransport } from "../../src/adapters/connector-transport";
import { connectorHostRegistry, platformOrigin, portalOrigin, sentinel } from "./origins";

export const settlement = {
  runId: "synthetic-7940-run",
  expectedRunRevision: 1,
  fromState: "claimed",
  toState: "applied",
  verificationSnapshotId: null,
  verificationSnapshotGeneration: null,
  uploadAttemptedAt: null,
  uploadFileName: null,
  importSummary: null,
} as const;

export function syntheticExecutor(unit: ConnectorExecutor["unit"]): ConnectorExecutor {
  const request = connectorTransport({
    platformOrigin,
    hostRegistry: connectorHostRegistry,
    permissionRegistry: ["identity", "storage", "alarms"],
  });
  const result = (work: OperationUnit): ExecutorResult => ({
    outcomes: work.members.map(({ operationId, attemptId, claimGeneration, desiredStateSequence }) => ({
      operationId,
      attemptId,
      claimGeneration,
      desiredStateSequence,
      outcome: { kind: "applied", result: { kind: "succeeded", externalListingId: operationId } },
    })),
    ...(unit === "reservation" ? { runSettlement: settlement } : {}),
  });
  return {
    key: `synthetic-7940-${unit}`,
    unit,
    dispatchDeadlineMs: 5000,
    accepts: [["publish", "draft"]],
    prepare: async () => ({ ready: true }),
    async dispatchOnce(work: OperationUnit, signal): Promise<ExecutorResult> {
      const response = await request(
        new Request(`${portalOrigin}/portal/mutate`, {
          method: "POST",
          redirect: "error",
          signal,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sentinel,
            operations: work.members.map(({ operationId, attemptId }) => ({ operationId, attemptId })),
          }),
        }),
      );
      const echoed: unknown = await response.json();
      if (
        !response.ok ||
        JSON.stringify(echoed) !==
          JSON.stringify({
            sentinel,
            operations: work.members.map(({ operationId, attemptId }) => ({ operationId, attemptId })),
          })
      )
        throw new Error("synthetic-portal-sentinel-refused");
      if (Reflect.get(globalThis, "__connectorSyntheticReceiptLoss")) throw new Error("SYNTHETIC_RECEIPT_LOSS");
      return result(work);
    },
    async reconcileAmbiguous(work) {
      if (!Reflect.get(globalThis, "__connectorSyntheticProof")) return null;
      const body = {
        sentinel,
        operations: work.members.map(({ operationId, attemptId }) => ({ operationId, attemptId })),
      };
      const response = await request(
        new Request(`${portalOrigin}/portal/proof`, { method: "POST", redirect: "error", body: JSON.stringify(body) }),
      );
      return response.ok && JSON.stringify(await response.json()) === JSON.stringify(body) ? result(work) : null;
    },
  };
}

export const connectorExecutors: readonly ConnectorExecutor[] = [
  syntheticExecutor(import.meta.env.VITE_HARNESS_EXECUTOR_UNIT === "reservation" ? "reservation" : "operation"),
];
