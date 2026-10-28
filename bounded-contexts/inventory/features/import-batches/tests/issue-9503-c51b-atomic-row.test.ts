import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../api/runtime.ts", import.meta.url), "utf8");
const outboxSource = readFileSync(new URL("../api/draft-listing-delivery.ts", import.meta.url), "utf8");

describe("issue-9503 C5.1b row authority wiring", () => {
  it("B1 split-transaction mutant is rejected by the single row transaction seam", () => {
    expect(source).toContain('"import-commit-row"');
    expect(source).toContain("commit_claimed_until");
    expect(source).toContain("commit_claim_token = $6");
    expect(source).toContain("commit_claim_token = $3");
    expect(source).toContain("enqueueInventoryDraftListingMessage(");
  });

  it("B2 generation-guard-removed mutant is rejected by the claim generation update", () => {
    expect(source).toContain("commit_generation = commit_generation + 1");
    expect(source).toContain("commit_claim_token = $3");
    expect(source).toContain("commit_claimed_until <= clock_timestamp()");
    expect(source).toContain("Import row claim was lost or replaced.");
  });

  it("B3 pending-items-bypass mutant is rejected by recovered row-item injection", () => {
    expect(source).toContain("rowItems?: InventoryItemServices");
    expect(source).toContain("const itemServices = deps.rowItems ?? deps.items");
    expect(source).toContain('withInventoryMutationChildAttempt(activeContext, "item")');
    expect(readFileSync(new URL("../../../support/runtime-support/services.ts", import.meta.url), "utf8")).toContain(
      "rowItems: items",
    );
  });

  it("B4 terminal replay returns the immutable row result without another effect path", () => {
    expect(source).toContain('if (claimedRow.status === "committed")');
    expect(source).toContain('state: "completed"');
    expect(source).toContain('rowId: row.row_id, status: "committed"');
    expect(outboxSource).toContain("ON CONFLICT (message_id) DO NOTHING");
  });
});
