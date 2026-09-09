import { describe, expect, it } from "vitest";
import { parseTcgplayerFullExport } from "../domain/csv";

const header = "TCGplayer Id,Total Quantity,Add to Quantity,TCG Marketplace Price,Title";

describe("tcgplayer-export-parse-record-limit", () => {
  it("counts a quoted newline as one logical data record", () => {
    const result = parseTcgplayerFullExport(
      { csv: `${header}\r\n90000001,1,0,1.00,"synthetic\r\ntitle"`, surface: "staged" },
      { maxRecords: 1 },
    );
    expect(result).toMatchObject({ kind: "parsed", parsedRowCount: 1, rows: [{ rowNumber: 2 }] });
  });

  it("refuses on the first maxRecords+1 logical record", () => {
    const csv = `${header}\n90000001,1,0,1.00,a\n90000002,1,0,1.00,b`;
    expect(parseTcgplayerFullExport({ csv, surface: "staged" }, { maxRecords: 1 })).toEqual({
      kind: "refused",
      reason: "record-limit-exceeded",
    });
  });

  it("accepts the policy safety ceiling without treating it as provider capacity", () => {
    const rows = Array.from({ length: 100_000 }, (_, index) => `${9_000_000 + index},1,0,1.00,synthetic`).join("\n");
    const result = parseTcgplayerFullExport({ csv: `${header}\n${rows}`, surface: "staged" }, { maxRecords: 100_000 });
    expect(result).toMatchObject({ kind: "parsed", parsedRowCount: 100_000, completeness: "unverified" });
  });
});
