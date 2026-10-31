import { describe, expect, it, vi } from "vitest";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { createRiskAlertRuntime } from "./runtime";

const context = Object.freeze({
  tenantId: "tnt_synthetic_operator",
  audit: Object.freeze({ performedByUserId: "usr_synthetic_operator", forAccountId: "acc_synthetic_operator" }),
}) satisfies EventStoreContext;

function createDeps(options: Readonly<{ candidate?: boolean; missing?: boolean; lookupError?: Error }> = {}) {
  const appendToStream = vi.fn().mockResolvedValue([]);
  const eventStore = { appendToStream } as unknown as EventStore;
  const query = vi.fn().mockImplementation(async () => {
    if (options.lookupError) throw options.lookupError;
    return {
      rows: options.missing
        ? []
        : [
            {
              alert_id: "risk_synthetic_alert",
              manual_payout_review_candidate: options.candidate ?? false,
            },
          ],
    };
  });
  const db = { query } as unknown as PgQueryable;
  return { eventStore, db, appendToStream, query };
}

describe("risk alert action runtime", () => {
  it("risk alert action appends for an allowed action", async () => {
    for (const { action, candidate } of [
      { action: "request-manual-payout-review", candidate: true },
      { action: "acknowledge", candidate: true },
      { action: "acknowledge", candidate: false },
    ] as const) {
      const deps = createDeps({ candidate });
      const result = await createRiskAlertRuntime(deps).recordRiskAlertAction(
        {
          alertId: "risk_synthetic_alert",
          action,
          note: "Synthetic operator evidence",
          operatorUserId: "usr_synthetic_operator",
        },
        context,
      );

      expect(deps.query).toHaveBeenCalledTimes(1);
      expect(deps.appendToStream).toHaveBeenCalledTimes(1);
      expect(deps.appendToStream.mock.calls[0]![0]).toMatchObject({
        streamId: "platform-operations.risk-alert-risk_synthetic_alert",
        expectedVersion: "any",
        context,
        events: [
          {
            eventType: "platform-operations.risk-alert.action-recorded",
            payload: {
              actionId: result.actionId,
              alertId: "risk_synthetic_alert",
              action,
              note: "Synthetic operator evidence",
              operatorUserId: "usr_synthetic_operator",
              recordedAt: result.recordedAt,
            },
          },
        ],
      });
    }
  });

  it("risk alert action refuses a non-candidate payout review", async () => {
    const deps = createDeps({ candidate: false });

    await expect(
      createRiskAlertRuntime(deps).recordRiskAlertAction(
        {
          alertId: "risk_synthetic_alert",
          action: "request-manual-payout-review",
          note: null,
          operatorUserId: "usr_synthetic_operator",
        },
        context,
      ),
    ).rejects.toMatchObject({ name: "RiskAlertActionRejectedError", code: "action-not-allowed" });
    expect(deps.appendToStream).not.toHaveBeenCalled();
  });

  it("risk alert action refuses an unknown alert", async () => {
    for (const action of ["request-manual-payout-review", "acknowledge"] as const) {
      const deps = createDeps({ missing: true });

      await expect(
        createRiskAlertRuntime(deps).recordRiskAlertAction(
          {
            alertId: "risk_missing_alert",
            action,
            note: null,
            operatorUserId: "usr_synthetic_operator",
          },
          context,
        ),
      ).rejects.toMatchObject({ name: "RiskAlertActionRejectedError", code: "alert-not-found" });
      expect(deps.appendToStream).not.toHaveBeenCalled();
    }
  });

  it("risk alert action appends nothing when the alert lookup fails", async () => {
    const lookupError = new Error("synthetic lookup failure");
    const deps = createDeps({ lookupError });

    await expect(
      createRiskAlertRuntime(deps).recordRiskAlertAction(
        {
          alertId: "risk_synthetic_alert",
          action: "acknowledge",
          note: null,
          operatorUserId: "usr_synthetic_operator",
        },
        context,
      ),
    ).rejects.toBe(lookupError);
    expect(deps.appendToStream).not.toHaveBeenCalled();
  });
});
