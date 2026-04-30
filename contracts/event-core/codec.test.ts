import { describe, expect, it } from "vitest";
import { createPassthroughDomainEventCodec } from "./codec";

describe("passthrough domain event codec", () => {
  it("maps event type and data to storage records and back", () => {
    const codec = createPassthroughDomainEventCodec<{
      type: "catalog.item.created";
      data: { itemId: string };
    }>();
    const encoded = codec.encode({
      type: "catalog.item.created",
      data: { itemId: "cat_1" },
    });

    expect(encoded).toEqual({
      eventType: "catalog.item.created",
      payload: { itemId: "cat_1" },
    });
    expect(codec.decode(encoded)).toEqual({
      type: "catalog.item.created",
      data: { itemId: "cat_1" },
    });
  });
});
