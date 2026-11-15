import { describe, expect, it, vi } from "vitest";
import { buildCheckoutSessionProjectionHandlers } from "./projection";

describe("checkout session projection", () => {
  it("uses the transaction-scoped projection database when the runner provides one", async () => {
    const baseDb = {
      query: vi.fn(async (_sql: string, _values?: readonly unknown[]) => ({ rows: [] })),
    };
    const transactionDb = {
      query: vi.fn(async (_sql: string, _values?: readonly unknown[]) => ({ rows: [] })),
    };
    const handlers = buildCheckoutSessionProjectionHandlers(baseDb);

    await handlers["checkout.session.started"]?.(
      {
        data: {
          sessionId: "chk_1",
          buyerAccountId: "acc_buyer",
          sourceType: "buy-now",
          shippingOption: "standard",
          lines: [],
          createdAt: "2026-06-09T00:00:00.000Z",
        },
      } as never,
      { db: transactionDb },
    );

    expect(transactionDb.query).toHaveBeenCalledTimes(1);
    expect(String(transactionDb.query.mock.calls[0]?.[0])).toContain("INSERT INTO checkout_session_pages");
    expect(baseDb.query).not.toHaveBeenCalled();
  });

  it("persists the authenticity-check opt-in selection and clears the stale fulfillment preview", async () => {
    const db = {
      query: vi.fn(async (_sql: string, _values?: readonly unknown[]) => ({ rows: [] })),
    };
    const handlers = buildCheckoutSessionProjectionHandlers(db);

    await handlers["checkout.session.authenticity-check-opt-in-selected"]?.(
      {
        data: {
          sessionId: "chk_1",
          selected: true,
          quoteFingerprint: "authenticity-check-fee-v1|eligible|150.00|100.00|any|11.00",
          selectedAt: "2026-07-10T00:00:00.000Z",
        },
      } as never,
      {},
    );

    expect(db.query).toHaveBeenCalledTimes(1);
    const [sql, values] = db.query.mock.calls[0]!;
    expect(String(sql)).toContain("SET authenticity_check_opt_in = $2");
    expect(String(sql)).toContain("fulfillment_preview_revision = NULL");
    expect(values).toEqual([
      "chk_1",
      JSON.stringify({
        selected: true,
        quoteFingerprint: "authenticity-check-fee-v1|eligible|150.00|100.00|any|11.00",
        selectedAt: "2026-07-10T00:00:00.000Z",
      }),
      "2026-07-10T00:00:00.000Z",
    ]);
  });
  // chase-sets/chase-sets#10785: the orders keep the revision they were bound to once the preview is gone.
  it.each([
    ["keeps the revision the orders were bound to", { fulfillmentPreviewRevision: "rev_1" }, "rev_1"],
    ["leaves the revision as it was for an older event", {}, null],
  ])("records created orders and %s", async (_case, revision, value) => {
    const db = {
      query: vi.fn(async (_sql: string, _values?: readonly unknown[]) => ({ rows: [] })),
    };
    const handlers = buildCheckoutSessionProjectionHandlers(db);

    await handlers["checkout.session.orders-created"]?.(
      {
        data: {
          sessionId: "chk_1",
          orderIds: ["ord_1"],
          orderWriteCommitPositions: [],
          ...revision,
          recordedAt: "2026-11-07T00:00:00.000Z",
        },
      } as never,
      {},
    );

    expect(db.query).toHaveBeenCalledTimes(1);
    const [sql, values] = db.query.mock.calls[0]!;
    expect(String(sql)).toContain("fulfillment_preview_revision = COALESCE($5, fulfillment_preview_revision)");
    expect(String(sql)).not.toContain("fulfillment_preview_snapshot");
    expect(values).toEqual(["chk_1", JSON.stringify(["ord_1"]), JSON.stringify([]), "2026-11-07T00:00:00.000Z", value]);
  });
});
