import { describe, expect, it } from "vitest";
import { parseImportCsv } from "../domain/csv";
import {
  prepareInventoryImportSnapshot,
  prepareInventoryImportLegacySnapshot,
  readInventoryImportSnapshotRow,
  loadInventoryImportSnapshotPage,
  stageInventoryImportSnapshot,
} from "../api/safe-snapshot";
import { inventoryMutationFingerprint } from "../../../support/runtime-support/mutation-intent";
import type { PgQueryable } from "@chase-sets/event-core-postgres";

describe("issue-7169-ac4-safe-import-create", () => {
  it.each([
    "a,a\n1,2",
    "a,\n1,2",
    "a,b\n1,2,",
    "a,b\n1",
    'a,b\n"unfinished,2',
    'a,b\nnot"quoted,2',
    'a,b\n"closed"tail,2',
    "a,b\n\uFFFD,2",
    "a,b\n\u0000,2",
  ])("rejects malformed CSV before any staging: %s", (csv) => {
    expect(() => parseImportCsv(csv)).toThrow();
  });

  it("retains quoted cells and accepts CSV beyond the Saved List bound", () => {
    expect(parseImportCsv('a,b\n"one, two","three""four"')).toEqual([
      { rowNumber: 2, values: { a: "one, two", b: 'three"four' } },
    ]);
    expect(parseImportCsv(`a,b\n${"1,2\n".repeat(10_001)}`)).toHaveLength(10_001);
  });
});

const source = {
  accountId: "acc_c3_synthetic",
  csvText: "catalogItemId,totalQuantity\ncat_c3_synthetic,2",
};

describe("issue-7169-c3-safe-rollout", () => {
  it("legacy-input-drop: keeps accepted v0 parsing semantics without weakening new CSV admission", () => {
    const csvText = "catalogItemId,totalQuantity,totalQuantity\ncat_c3_synthetic,1,2,extra";
    expect(() => prepareInventoryImportSnapshot({ ...source, csvText })).toThrow();
    const retained = prepareInventoryImportLegacySnapshot({ ...source, csvText });
    expect(retained.rows[0].values).toMatchObject({ catalogItemId: "cat_c3_synthetic", totalQuantity: "2" });
    expect(retained.header.rowCount).toBe(1);
  });

  it("normalized-fallback-omitted: retains safe legacy normalized rows when the original input is missing", () => {
    const original = prepareInventoryImportSnapshot(source);
    expect(prepareInventoryImportLegacySnapshot({ accountId: source.accountId }, original.rows)).toEqual(original);
  });
  it("hashes normalized domain intent, not CSV bytes or JSON key order", () => {
    const original = prepareInventoryImportSnapshot(source);
    const formatted = prepareInventoryImportSnapshot({
      ...source,
      csvText: 'catalogItemId,totalQuantity\r\n"cat_c3_synthetic","2"\r\n',
    });
    const parsed = prepareInventoryImportSnapshot({
      accountId: source.accountId,
      parsedRows: [{ rowNumber: 2, values: { totalQuantity: "2", catalogItemId: "cat_c3_synthetic" } }],
    });
    expect(formatted).toEqual(original);
    expect(parsed).toEqual(original);
    expect(
      prepareInventoryImportSnapshot({ ...source, csvText: source.csvText.replace(",2", ",3") }).header.hash,
    ).not.toBe(original.header.hash);
  });

  it("never retains unknown upload cells, including credentials and URLs", () => {
    const snapshot = prepareInventoryImportSnapshot({
      ...source,
      parsedRows: [
        {
          rowNumber: 2,
          values: {
            catalogItemId: "cat_c3_synthetic",
            totalQuantity: "2",
            password: "private-synthetic-value",
            uploadUrl: "https://synthetic.invalid/source",
            sourceFilename: "private-path.csv",
          },
        },
      ],
    });
    const stored = JSON.stringify(snapshot);
    expect(stored).not.toMatch(/private-synthetic|synthetic\.invalid|private-path|password|uploadUrl|sourceFilename/);
    expect(snapshot.rows[0].values.catalogItemId).toBe("cat_c3_synthetic");
  });

  it("rejects malformed parsed-cell encoding even in a column that would be discarded", () => {
    expect(() =>
      prepareInventoryImportSnapshot({
        accountId: source.accountId,
        parsedRows: [{ rowNumber: 2, values: { ignored: "\uFFFD" } }],
      }),
    ).toThrow();
  });

  it.each(["https://synthetic.invalid/source", "C:\\private\\source.csv", "password=synthetic", "\uFFFD"])(
    "refuses unsafe text in a retained domain field",
    (rowNote) => {
      expect(() =>
        prepareInventoryImportSnapshot({ ...source, parsedRows: [{ rowNumber: 2, values: { rowNote } }] }),
      ).toThrow();
    },
  );

  it("rejects duplicate identities before staging and applies the 10k bound only to Saved Lists", () => {
    const row = { rowNumber: 1, values: { catalogItemId: "cat_c3_synthetic", totalQuantity: "1" } };
    expect(() => prepareInventoryImportSnapshot({ ...source, parsedRows: [row, row] })).toThrow();
    const rows = Array.from({ length: 10_001 }, (_, index) => ({ ...row, rowNumber: index + 1 }));
    expect(prepareInventoryImportSnapshot({ ...source, parsedRows: rows }).header.rowCount).toBe(10_001);
    expect(() => prepareInventoryImportSnapshot({ ...source, sourceKey: "saved-list", parsedRows: rows })).toThrow();
    expect(
      prepareInventoryImportSnapshot({ ...source, sourceKey: "saved-list", parsedRows: rows.slice(0, 10_000) }).header
        .rowCount,
    ).toBe(10_000);
    expect(() => prepareInventoryImportSnapshot({ ...source, sourceKey: "saved-list", parsedRows: [] })).toThrow();
  });

  it.each(["row", "values", "reference", "candidate"])(
    "closes nested %s objects even when their hash is recomputed",
    (kind) => {
      const row = structuredClone(
        prepareInventoryImportSnapshot({
          ...source,
          sourceKey: "tcgplayer-csv",
          parsedRows: [{ rowNumber: 1, values: { SKU: "123", Condition: "Near Mint", Quantity: "1" } }],
        }).rows[0],
      );
      const altered = JSON.parse(JSON.stringify(row)) as {
        unknown?: string;
        values: Record<string, string>;
        rawRow: Record<string, string>;
        externalReferences: Record<string, unknown>[];
        externalReference: Record<string, unknown>;
        selectedOptionCandidates: Record<string, unknown>[];
        rowFingerprint: string;
      };
      if (kind === "row") altered.unknown = "synthetic";
      if (kind === "values") {
        altered.values.unknown = "synthetic";
        altered.rawRow.unknown = "synthetic";
      }
      if (kind === "reference") {
        altered.externalReferences[0].unknown = "synthetic";
        altered.externalReference.unknown = "synthetic";
      }
      if (kind === "candidate") altered.selectedOptionCandidates[0].unknown = "synthetic";
      const { rowFingerprint: _, ...intent } = altered;
      altered.rowFingerprint = inventoryMutationFingerprint(intent);
      expect(() => readInventoryImportSnapshotRow(altered)).toThrow();
    },
  );

  it("checks row version, exact identity, and hash at the paged storage boundary", async () => {
    const snapshot = prepareInventoryImportSnapshot(source);
    const header = {
      account_id: source.accountId,
      snapshot_version: 1,
      snapshot_hash: snapshot.header.hash,
      row_count: 1,
      source_key: snapshot.header.sourceKey,
      adapter_version: snapshot.header.adapterVersion,
      quantity_mode: "add",
      default_storage_location_id: null,
    };
    let returned = {
      row_number: 2,
      snapshot_version: 1,
      row_hash: snapshot.rows[0].rowFingerprint,
      snapshot_row: snapshot.rows[0],
      row_index: 0,
      row_proof: [],
    };
    const calls: Array<{ sql: string; values: readonly unknown[] }> = [];
    const db: PgQueryable = {
      query: async <Row>(sql: string, values: readonly unknown[] = []) => {
        calls.push({ sql, values });
        return { rows: (sql.includes("SELECT account_id") ? [header] : [returned]) as Row[], rowCount: 1 };
      },
    };
    expect((await loadInventoryImportSnapshotPage(db, "input_synthetic", source.accountId, 0, 2)).rows).toEqual(
      snapshot.rows,
    );
    expect(calls[1].values).toEqual(["input_synthetic", 0, 2, 100]);
    returned = { ...returned, snapshot_version: 2 };
    await expect(loadInventoryImportSnapshotPage(db, "input_synthetic", source.accountId, 0, 2)).rejects.toThrow();
    returned = { ...returned, snapshot_version: 1, row_hash: "0".repeat(64) };
    await expect(loadInventoryImportSnapshotPage(db, "input_synthetic", source.accountId, 0, 2)).rejects.toThrow();
    await expect(loadInventoryImportSnapshotPage(db, "input_synthetic", source.accountId, 0, 3)).rejects.toThrow();
  });

  it("stages 10,001 parsed rows with bounded writes and no raw source parameters", async () => {
    const snapshot = prepareInventoryImportSnapshot({
      ...source,
      parsedRows: Array.from({ length: 10_001 }, (_, index) => ({
        rowNumber: index + 1,
        values: { catalogItemId: "cat_c3_synthetic", totalQuantity: "1" },
      })),
    });
    const sizes: number[] = [];
    const db: PgQueryable = {
      query: async <Row>(sql: string, values: readonly unknown[] = []) => {
        if (sql.includes("SELECT account_id"))
          return {
            rows: [
              {
                account_id: source.accountId,
                snapshot_version: 1,
                snapshot_hash: snapshot.header.hash,
                row_count: 10_001,
                source_key: "native-csv",
                adapter_version: snapshot.header.adapterVersion,
                quantity_mode: "add",
                default_storage_location_id: null,
              },
            ] as Row[],
            rowCount: 1,
          };
        expect(sql).not.toMatch(/csv_text|parsed_rows|source_filename/);
        if (sql.includes("jsonb_array_elements")) sizes.push(JSON.parse(String(values[1])).length);
        return { rows: [], rowCount: 1 };
      },
    };
    await stageInventoryImportSnapshot(db, "input_synthetic", snapshot);
    expect(sizes).toHaveLength(101);
    expect(Math.max(...sizes)).toBe(100);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(10_001);
  });
});
