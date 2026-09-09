import { describe, expect, it } from "vitest";
import { formatTcgplayerMinorUnits, parseTcgplayerFullExport, parseTcgplayerMoneyToMinorUnits } from "../domain/csv";
import { tcgplayerLiveExportHeader } from "../domain/profile";
import { tcgplayerRowRefusalReasons } from "../domain/contracts";

const stagedHeader = ["TCGplayer Id", "Condition", "Total Quantity", "Add to Quantity", "TCG Marketplace Price"];

describe("tcgplayer-export-parse-fail-closed", () => {
  it("derives the complete refusal grammar from one exported array", () => {
    expect(tcgplayerRowRefusalReasons).toEqual([
      "invalid-input",
      "header-mismatch",
      "header-missing-required-column",
      "header-duplicate-column",
      "row-width-mismatch",
      "unterminated-quoted-field",
      "empty-export",
      "duplicate-row-identity",
      "invalid-integer",
      "record-limit-exceeded",
    ]);
  });
  it("pins the exact P2 Live header and preserves provider price text while deriving exact cents", () => {
    const csv = `${tcgplayerLiveExportHeader.join(",")}\r\nsynthetic-row`;
    const fields = tcgplayerLiveExportHeader.map((column) => {
      if (column === "TCGplayer Id") return "90000001";
      if (column === "Condition") return "Near Mint";
      if (column === "Total Quantity") return "5";
      if (column === "Add to Quantity") return "0";
      if (column === "TCG Marketplace Price") return "0.2600";
      return `synthetic-${column}`;
    });
    const result = parseTcgplayerFullExport(
      { csv: csv.replace("synthetic-row", fields.join(",")), surface: "live" },
      { maxRecords: 1 },
    );
    expect(result).toMatchObject({
      kind: "parsed",
      completeness: "unverified",
      parsedRowCount: 1,
      rows: [{ externalKey: "product:90000001", priceAmountText: "0.2600", priceAmountMinor: 26 }],
    });
  });

  it.each([
    ["0.2000", 20],
    ["0.2600", 26],
    ["2.5900", 259],
    ["1.46", 146],
    ["0.2001", null],
    ["-0.20", null],
    ["1e2", null],
    ["90071992547409.92", null],
  ])("parses %s without rounding", (text, expected) => {
    expect(parseTcgplayerMoneyToMinorUnits(text)).toBe(expected);
  });

  it("refuses a later Staged header drift without re-pinning", () => {
    const csv = `${stagedHeader.join(",")}\n90000001,Near Mint,1,0,1.00`;
    expect(
      parseTcgplayerFullExport(
        {
          csv,
          surface: "staged",
          pinnedSchema: {
            connectionId: "connection-synthetic",
            providerKey: "tcgplayer",
            surface: "staged",
            header: ["TCGplayer Id", "Total Quantity", "Add to Quantity", "TCG Marketplace Price"],
            conditionColumn: "absent",
            pinnedFromSnapshotId: "snapshot-synthetic",
            pinnedAt: "2026-09-09T00:00:00Z",
          },
        },
        { maxRecords: 1 },
      ),
    ).toEqual({ kind: "refused", reason: "header-mismatch" });
  });

  it("renders outbound cents canonically", () => {
    expect(formatTcgplayerMinorUnits(0)).toBe("0.00");
    expect(formatTcgplayerMinorUnits(26)).toBe("0.26");
    expect(formatTcgplayerMinorUnits(259)).toBe("2.59");
  });

  it.each([
    [
      "duplicate header",
      "TCGplayer Id,TCGplayer Id,Total Quantity,Add to Quantity,TCG Marketplace Price\n1,1,1,0,1.00",
      "header-duplicate-column",
    ],
    ["missing header", "TCGplayer Id,Total Quantity,Add to Quantity\n1,1,0", "header-missing-required-column"],
    ["wrong width", `${stagedHeader.join(",")}\n1,Near Mint,1,0`, "row-width-mismatch"],
    ["unterminated quote", `${stagedHeader.join(",")}\n1,"Near Mint,1,0,1.00`, "unterminated-quoted-field"],
    ["empty", stagedHeader.join(","), "empty-export"],
    ["bad integer", `${stagedHeader.join(",")}\n1,Near Mint,1.5,0,1.00`, "invalid-integer"],
    [
      "duplicate identity",
      `${stagedHeader.join(",")}\n1,Near Mint,1,0,1.00\n1,Near Mint,2,0,2.00`,
      "duplicate-row-identity",
    ],
  ])("refuses %s with zero partial rows", (_name, csv, reason) => {
    expect(parseTcgplayerFullExport({ csv, surface: "staged" }, { maxRecords: 10 })).toEqual({
      kind: "refused",
      reason,
    });
  });

  it("requires explicit recursively closed limits", () => {
    const malformedLimits = { maxRecords: 1, extra: true };
    expect(
      parseTcgplayerFullExport(
        { csv: `${stagedHeader.join(",")}\n1,Near Mint,1,0,1.00`, surface: "staged" },
        { maxRecords: 0 },
      ),
    ).toEqual({ kind: "refused", reason: "invalid-input" });
    expect(
      parseTcgplayerFullExport(
        { csv: `${stagedHeader.join(",")}\n1,Near Mint,1,0,1.00`, surface: "staged" },
        malformedLimits,
      ),
    ).toEqual({ kind: "refused", reason: "invalid-input" });
  });
});
