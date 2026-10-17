import { createHash } from "node:crypto";
import type { OutboundOperationPayload } from "../domain/contracts";
import type { OrderPullPayload } from "../domain/order-pull";
import type { LiveExportPayload } from "../domain/live-export-codec";
import { canonicalJson } from "../domain/validation";

export function payloadDigest(payload: OutboundOperationPayload | OrderPullPayload | LiveExportPayload): string {
  return createHash("sha256").update(canonicalJson(payload), "utf8").digest("hex");
}
