import { createHash } from "node:crypto";
import { OutboundSyncError } from "./contracts";
import { assertOrderPullPayloadStructure, orderPullOperationKind, type OrderPullPayload } from "./order-pull-codec";
import { orderPullCheckpointDigest } from "./order-pull-progress";

export * from "./order-pull-codec";

export function assertOrderPullPayload(value: unknown): asserts value is OrderPullPayload {
  assertOrderPullPayloadStructure(value);
  if (value.checkpointDigest !== orderPullCheckpointDigest(value.checkpoint))
    throw new OutboundSyncError("invalid-input", "Checkpoint binding mismatch.");
}

export function deriveOrderPullId(connectionId: string, scheduleGeneration: number): string {
  return `copl_${sha256(`order-pull\0${connectionId}\0${scheduleGeneration}`).slice(0, 40)}`;
}

export function deriveOrderPullOperationId(connectionId: string, pullId: string): string {
  return `cop_${sha256(`${orderPullOperationKind}\0${connectionId}\0${pullId}`).slice(0, 40)}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
