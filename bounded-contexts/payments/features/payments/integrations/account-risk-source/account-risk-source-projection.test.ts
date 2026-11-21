import { payoutReviewHoldFactTypes } from "@chase-sets/event-core/payout-review-hold-facts";
import { buildTransportEvent } from "@chase-sets/event-core/test-support";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { expect, it, vi } from "vitest";
import { module as paymentsModule } from "../../../../index";
import type { PaymentsServices } from "../../../../support/runtime-support/services";

it("payments risk source follows payout review hold facts", async () => {
  const rows = new Map<string, { hold: boolean; updatedAt: string }>();
  const query = vi.fn(async (_sql: string, [accountId, hold, updatedAt]: [string, boolean, string]) => {
    rows.set(accountId, { hold, updatedAt });
    return { rows: [], rowCount: 1 };
  });
  const services = { db: { query } as unknown as PgQueryable } as PaymentsServices;
  const subscriptions = (paymentsModule.buildSubscriptions?.(services) ?? []).filter(
    (subscription) => subscription.projectionName === "payments-account-risk-source-projection",
  );
  expect(subscriptions.map((subscription) => subscription.sourceContextName).sort()).toEqual([
    "payments",
    "settlement",
  ]);
  const settlement = subscriptions.find((subscription) => subscription.sourceContextName === "settlement")!;
  expect(settlement.eventTypes).toEqual(Object.values(payoutReviewHoldFactTypes));

  const accountId = "acc_synthetic_hold";
  const placedAt = "2026-11-20T10:00:00.000Z";
  const releasedAt = "2026-11-20T11:00:00.000Z";
  const payload = {
    accountId,
    factSchemaVersion: 1,
    reason: "Synthetic review",
    source: "operator",
    sourceReference: null,
  };
  const events = [
    buildTransportEvent(payoutReviewHoldFactTypes.placed, payload, {
      timing: { occurredAt: placedAt, recordedAt: placedAt },
    }),
    buildTransportEvent(payoutReviewHoldFactTypes.released, payload, {
      timing: { occurredAt: releasedAt, recordedAt: releasedAt },
    }),
    buildTransportEvent(payoutReviewHoldFactTypes.placed, { ...payload, accountId: "acc_synthetic_still_held" }),
  ];
  async function replay() {
    for (const [index, event] of events.entries()) {
      await settlement.handlers[event.type]!(event);
      if (index === 0) expect(rows.get(accountId)).toEqual({ hold: true, updatedAt: placedAt });
    }
    expect(rows.get(accountId)).toEqual({ hold: false, updatedAt: releasedAt });
    expect(rows.get("acc_synthetic_still_held")?.hold).toBe(true);
  }
  await replay();
  const firstPass = new Map(rows);
  await replay();
  expect(rows).toEqual(firstPass);
  expect(query).toHaveBeenCalledTimes(6);
  expect(query.mock.calls[0]?.[0]).toContain("manual_payout_review = EXCLUDED.manual_payout_review");
});
