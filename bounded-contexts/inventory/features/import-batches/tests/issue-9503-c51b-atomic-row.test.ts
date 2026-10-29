import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../api/runtime.ts", import.meta.url), "utf8");
const outboxSource = readFileSync(new URL("../api/draft-listing-delivery.ts", import.meta.url), "utf8");

describe("issue-9503 C5.1b row authority wiring", () => {
  it("B3 pending-items-bypass mutant is rejected by recovered row-item injection", () => {
    expect(source).toContain("rowItems?: InventoryItemServices");
    expect(source).toContain("const itemServices = deps.rowItems ?? deps.items");
    expect(source).toContain('withInventoryMutationChildAttempt(activeContext, "item")');
    expect(readFileSync(new URL("../../../support/runtime-support/services.ts", import.meta.url), "utf8")).toContain(
      "rowItems: items",
    );
  });

  it("B4 terminal replay keeps the outbox insert idempotent", () => {
    expect(outboxSource).toContain("ON CONFLICT (message_id) DO NOTHING");
  });
});
