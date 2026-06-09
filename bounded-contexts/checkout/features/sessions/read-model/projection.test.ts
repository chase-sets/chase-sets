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
});
