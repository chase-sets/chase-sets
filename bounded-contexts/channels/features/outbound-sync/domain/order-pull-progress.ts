import { createHash } from "node:crypto";
import { canonicalJson } from "../../listing-composition/domain/canonical-json";
import type { OrderPullCheckpoint } from "./order-pull-progress-codec";

export * from "./order-pull-progress-codec";

export function orderPullCheckpointDigest(checkpoint: OrderPullCheckpoint): string {
  return createHash("sha256").update(canonicalJson(checkpoint)).digest("hex");
}
