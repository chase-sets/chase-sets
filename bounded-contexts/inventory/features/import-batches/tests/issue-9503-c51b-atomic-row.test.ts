import { describe, expect, it } from "vitest";
import { indexInventoryImportCommitRows } from "../api/runtime";

describe("issue-9503 C5.1b row authority wiring", () => {
  it("indexes every frozen commit row by its stable row identity", () => {
    const rows = [
      { row_id: "imr_1", row_number: 1 },
      { row_id: "imr_2", row_number: 2 },
    ] as never;
    const indexed = indexInventoryImportCommitRows(rows);
    expect(indexed.get("imr_1")).toEqual(rows[0]);
    expect(indexed.get("imr_2")).toEqual(rows[1]);
    expect(indexed.get("missing")).toBeUndefined();
  });
});
