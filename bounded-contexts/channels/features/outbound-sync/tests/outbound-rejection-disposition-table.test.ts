import { describe, expect, it } from "vitest";
import { channelPublicationRejectionCodes } from "../../publication-port/domain/contracts";
import { OUTBOUND_OPERATION_BUDGET_FALLBACK } from "../domain/policy";
import { resolveInlineRejectionDisposition } from "../domain/rejection";

describe("outbound-rejection-disposition-table", () => {
  it("derives and covers the six canonical provider codes exactly", () => {
    expect(
      channelPublicationRejectionCodes.map((code) =>
        resolveInlineRejectionDisposition(code, 1, OUTBOUND_OPERATION_BUDGET_FALLBACK),
      ),
    ).toEqual([
      { kind: "terminal", reason: "validation" },
      { kind: "terminal", reason: "authorization" },
      { kind: "retry", delayMs: 2_000, throttleProvider: true },
      { kind: "retry", delayMs: 2_000, throttleProvider: false },
      { kind: "terminal", reason: "conflict" },
      { kind: "terminal", reason: "not-found" },
    ]);
  });

  it("fails unknown codes closed and exhausts retryable responses", () => {
    expect(resolveInlineRejectionDisposition("future-code", 1, OUTBOUND_OPERATION_BUDGET_FALLBACK)).toEqual({
      kind: "indeterminate",
      reason: "outcome-unknown",
    });
    expect(
      resolveInlineRejectionDisposition(
        "rate-limited",
        OUTBOUND_OPERATION_BUDGET_FALLBACK.maxAttempts,
        OUTBOUND_OPERATION_BUDGET_FALLBACK,
      ),
    ).toEqual({ kind: "terminal", reason: "attempts-exhausted" });
  });
});
