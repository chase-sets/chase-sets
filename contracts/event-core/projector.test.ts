import { describe, expect, it, vi } from "vitest";
import { createTransactionalProjectorHandlerMap } from "./projector";
import type { TransportEvent } from "./transport";

const event: TransportEvent = {
  id: "evt_test" as never,
  type: "catalog.catalog-item.published",
  streamId: "catalog.item-cat_test" as never,
  streamVersion: 1 as never,
  globalPosition: "1" as never,
  tenantId: "tenant_test" as never,
  data: {},
  metadata: {},
  audit: {
    performedByUserId: "user_test" as never,
    forAccountId: "account_test" as never,
  },
  trace: {},
  timing: {
    occurredAt: "2026-05-26T00:00:00.000Z" as never,
    recordedAt: "2026-05-26T00:00:00.000Z" as never,
  },
};

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
