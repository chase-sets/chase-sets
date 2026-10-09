import { createHash } from "node:crypto";
import type { OutboundOperationPayload } from "../domain/contracts";
import type { OrderPullPayload } from "../domain/order-pull";
import { canonicalJson } from "../domain/validation";

export function payloadDigest(payload: OutboundOperationPayload | OrderPullPayload): string {
  return createHash("sha256").update(canonicalJson(payload), "utf8").digest("hex");
}
