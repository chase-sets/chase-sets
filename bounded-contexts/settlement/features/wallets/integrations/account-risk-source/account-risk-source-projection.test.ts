import { describe, expect, it, vi } from "vitest";
import type { TransportEvent } from "@chase-sets/event-core/transport";
import {
  buildSettlementIdentityAccountRiskSourceProjectionHandlers,
  buildSettlementReputationAccountRiskSourceProjectionHandlers,
} from "./account-risk-source-projection";

function event(type: string, data: Record<string, unknown>, streamId = "identity.account-acc_seller"): TransportEvent {
  return {
    id: "evt_1" as never,
    type,
    streamId: streamId as never,
    streamVersion: 1 as never,
    globalPosition: 1 as never,
    tenantId: "tnt_test" as never,
    data: data as never,
    metadata: {},
    audit: {
      performedByUserId: "usr_test" as never,
      forAccountId: "acc_seller" as never,
    },
    trace: {},
    timing: {
      occurredAt: "2026-05-01T00:00:00.000Z" as never,
      recordedAt: "2026-05-01T00:00:00.000Z" as never,
    },
  };
}

describe("settlement account risk source projection", () => {
  it("projects trusted seller badges and reputation reviews into payout release inputs", async () => {
    const db = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("RETURNING subject_account_id")) {
          return { rows: [{ subject_account_id: "acc_seller" }] };
        }
        return { rows: [] };
      }),
    };
    const identityHandlers = buildSettlementIdentityAccountRiskSourceProjectionHandlers(db as never);
    const reputationHandlers = buildSettlementReputationAccountRiskSourceProjectionHandlers(db as never);

    await identityHandlers["identity.account.badge-assigned"]!(
      event("identity.account.badge-assigned", { badgeKey: "trusted-seller" }),
    );
    await reputationHandlers["reputation.review.submitted"]!(
      event(
        "reputation.review.submitted",
        {
          reviewId: "rev_1",
          subjectAccountId: "acc_seller",
          rating: 5,
          submittedAt: "2026-05-03T00:00:00.000Z",
        },
        "reputation.review-rev_1",
      ),
    );

    expect(db.query).toHaveBeenNthCalledWith(1, expect.stringContaining("trusted_seller"), [
      "acc_seller",
      true,
      "2026-05-01T00:00:00.000Z",
    ]);
    expect(db.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("INSERT INTO settlement_account_review_sources"),
      ["rev_1", "acc_seller", 5, "2026-05-03T00:00:00.000Z"],
    );
    expect(db.query).toHaveBeenNthCalledWith(3, expect.stringContaining("review_count"), [
      "acc_seller",
      "2026-05-03T00:00:00.000Z",
    ]);
  });
});
