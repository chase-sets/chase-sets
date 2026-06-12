import { describe, expect, it } from "vitest";
import { extractIdFromStreamId } from "./stream-id";

describe("extractIdFromStreamId", () => {
  it("extracts the suffix after the expected stream prefix", () => {
    expect(extractIdFromStreamId("catalog.item-cat_9", "catalog.item-")).toBe("cat_9");
  });

  it("rejects stream ids missing the expected prefix", () => {
    expect(() => extractIdFromStreamId("ordering.order-ord_1", "catalog.item-")).toThrowError(
      'Stream ID "ordering.order-ord_1" does not start with prefix "catalog.item-".',
    );
  });
});
