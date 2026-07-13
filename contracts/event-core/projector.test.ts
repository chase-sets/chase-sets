import { describe, expect, it, vi } from "vitest";
import { createTransactionalProjectorHandlerMap } from "./projector";
import { buildTransportEvent } from "./test-support";
import type { TransportEvent } from "./transport";

const event: TransportEvent = buildTransportEvent(
  "catalog.catalog-item.published",
  {},
  {
    id: "evt_test",
    streamId: "catalog.item-cat_test",
    tenantId: "tnt_test",
    audit: { performedByUserId: "user_test", forAccountId: "account_test" },
    timing: { occurredAt: "2026-05-26T00:00:00.000Z", recordedAt: "2026-05-26T00:00:00.000Z" },
  },
);

describe("transactional projection handlers", () => {
  it("requires the transaction-scoped projection database", async () => {
    const handler = vi.fn(async () => undefined);
    const handlers = createTransactionalProjectorHandlerMap({
      "catalog.catalog-item.published": handler,
    });

    await expect(handlers["catalog.catalog-item.published"]?.(event)).rejects.toThrow(
      "requires the transaction-scoped projection database",
    );

    const db = {
      query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
    };
    const throwIfLeaseLost = vi.fn();
    await handlers["catalog.catalog-item.published"]?.(event, { db, throwIfLeaseLost });

    expect(handler).toHaveBeenCalledWith(event, { db, throwIfLeaseLost });
  });
});
