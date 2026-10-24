import type { ClaimedSubjectOutcome } from "./contracts";
import { assertClaimedOrderPullOutcome, isClaimedOrderPullOutcome } from "./order-pull";
import { assertClaimedOperationOutcome } from "./validation";
import { assertClaimedLiveExportOutcome, isClaimedLiveExportOutcome } from "./live-export-codec";

/** Pull validation remains server-only until the pull journal owns its browser contract. */
export function assertClaimedSubjectOutcome(value: unknown): asserts value is ClaimedSubjectOutcome {
  if (typeof value === "object" && value !== null && !Array.isArray(value) && isClaimedLiveExportOutcome(value)) {
    assertClaimedLiveExportOutcome(value);
    return;
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value) && isClaimedOrderPullOutcome(value)) {
    assertClaimedOrderPullOutcome(value);
    return;
  }
  assertClaimedOperationOutcome(value);
}
