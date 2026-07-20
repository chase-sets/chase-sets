import { describe, expect, it, vi } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import { createCheckoutCartRuntime } from "./runtime";

describe("checkout cart runtime", () => {
  it("marks the Cart handler set as Inline Apply eligible", () => {
    const { eventStore } = createInMemoryEventStore();
    const runtime = createCheckoutCartRuntime({
      eventStore,
      checkpointStore: {} as never,
      db: {
        query: vi.fn(async () => ({ rows: [] })),
      },
    });

    expect(runtime.projectors).toEqual([
      expect.objectContaining({
        projectionName: "checkout.cart-projection",
        inlineApply: true,
      }),
    ]);
  });
});
