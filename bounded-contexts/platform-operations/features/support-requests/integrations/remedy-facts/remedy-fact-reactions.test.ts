import { describe, expect, it, vi } from "vitest";
import { buildSupportRemedyFactReactionHandlers } from "./remedy-fact-reactions";

function event(type: string, data: Record<string, unknown>) {
  return {
    id: "evt_01J00000000000000000000000",
    type,
    streamId: "settlement.protection-coverage-cov_1",
    streamVersion: 1,
    globalPosition: 1,
    tenantId: "tnt_1",
    data,
    metadata: {},
    audit: { performedByUserId: "usr_1", forAccountId: "acc_1" },
    trace: {},
    timing: { occurredAt: data.occurredAt, recordedAt: data.occurredAt },
  } as never;
}

const envelope = {
  factSchemaVersion: 1,
  supportRequestId: "sup_1",
  remedyId: "rmd_1",
  coverageId: "cov_1",
  idempotencyKey: "settlement-fact-1",
  causationId: "coverage-request-1",
  policyVersion: "coverage-2026-07",
  occurredAt: "2026-07-04T00:00:00.000Z",
};

describe("support remedy Settlement fact reactions", () => {
  it("records rejection and expiry as terminal actionable coverage outcomes", async () => {
    const recordRemedyEffect = vi.fn(async () => ({ supportRequestId: "sup_1", remedyId: "rmd_1", version: 1 }));
    const handlers = buildSupportRemedyFactReactionHandlers({ recordRemedyEffect });
    await handlers["settlement.protection-coverage.rejected.v1"]!(
      event("settlement.protection-coverage.rejected.v1", {
        ...envelope,
        requestedAmount: "10.00",
        currencyCode: "usd",
        reasonCode: "coverage-expired",
      }),
    );

    expect(recordRemedyEffect).toHaveBeenCalledWith(
      expect.objectContaining({
        effect: "coverage-reservation",
        outcome: "failed-terminal",
        reasonCode: "coverage-expired",
        idempotencyKey: "settlement-fact-1",
      }),
      expect.objectContaining({ tenantId: "tnt_1" }),
    );
  });

  it("records Settlement reconciliation separately from refund completion", async () => {
    const recordRemedyEffect = vi.fn(async () => ({ supportRequestId: "sup_1", remedyId: "rmd_1", version: 1 }));
    const handlers = buildSupportRemedyFactReactionHandlers({ recordRemedyEffect });
    await handlers["settlement.protection-coverage.settled.v1"]!(
      event("settlement.protection-coverage.settled.v1", {
        ...envelope,
        refundId: "rfd_1",
        allocation: {
          sellerFundedAmount: "0.00",
          platformFundedAmount: "10.00",
          currencyCode: "usd",
          fundingKind: "platform-funded",
        },
        currencyCode: "usd",
      }),
    );

    expect(recordRemedyEffect).toHaveBeenCalledWith(
      expect.objectContaining({
        effect: "settlement-reconciliation",
        refundId: "rfd_1",
        reasonCode: "coverage-settled",
      }),
      expect.anything(),
    );
  });
});
