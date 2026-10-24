import { createHash } from "node:crypto";
import { OutboundSyncError } from "../domain/contracts";
import { assertLiveExportPayloadStructure, type LiveExportPayload } from "../domain/live-export-codec";

export function deriveLiveExportId(connectionId: string, scheduleGeneration: number): string {
  return `cxpl_${identityDigest(connectionId, scheduleGeneration)}`;
}
export function deriveLiveExportOperationId(connectionId: string, scheduleGeneration: number): string {
  return `cxp_${identityDigest(connectionId, scheduleGeneration)}`;
}
function identityDigest(connectionId: string, scheduleGeneration: number): string {
  return createHash("sha256")
    .update(`live-export\0${connectionId}\0${scheduleGeneration}`, "utf8")
    .digest("hex")
    .slice(0, 40);
}
export function assertLiveExportPayload(value: unknown, leaseMs?: number): asserts value is LiveExportPayload {
  assertLiveExportPayloadStructure(value, leaseMs);
  if (value.exportId !== deriveLiveExportId(value.connectionId, value.scheduleGeneration))
    throw new OutboundSyncError("invalid-input", "Live-export exportId binding mismatch.");
}
