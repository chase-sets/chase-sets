import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  decodeTcgplayerStagedImportReadback,
  deriveTcgplayerStagedImportReadbackVerdict,
  preflightTcgplayerStagedImport,
} from "../domain/tcgplayer-staged-import-readback-verdict";

// Synthetic readbacks only; no provider requests or captured account data.
const ids = ["1001", "1002"];
const authority = {
  origin: "worker" as const,
  method: "GET" as const,
  path: "/Admin/Pricing/DownloadStagedInventoryExportCSV",
  status: 200,
  contentType: "text/csv",
};

function readback(rows: ReadonlyArray<Readonly<{ id: string; sellerColumns: Readonly<Record<string, string>> }>>) {
  return decodeTcgplayerStagedImportReadback({
    rows,
    completeness: { kind: "complete", expectedRows: rows.length },
  });
}

function pre(pending: string) {
  return readback(
    ids.map((id) => ({
      id,
      sellerColumns: {
        "TCGplayer Id": id,
        "Total Quantity": "5",
        "Add to Quantity": pending,
        "TCG Marketplace Price": "1.01",
      },
    })),
  );
}

const compensationMembers = ids.map((externalKey) => ({
  externalKey,
  basisTotalQuantity: 5,
  basisPriceAmountMinor: 101,
  basisPendingAddToQuantity: -1,
  csvRow: { "Add to Quantity": "1", "TCG Marketplace Price": "1.00" },
}));
const compensationPost = readback(
  ids.map((id) => ({
    id,
    sellerColumns: {
      "TCGplayer Id": id,
      "Total Quantity": "6",
      "Add to Quantity": "0",
      "TCG Marketplace Price": "1.00",
    },
  })),
);
const nonMemberPre = readback([
  ...pre("-1").rows,
  {
    id: "9001",
    sellerColumns: {
      "TCGplayer Id": "9001",
      "Total Quantity": "2",
      "Add to Quantity": "0",
      "TCG Marketplace Price": "2.00",
    },
  },
]);
const nonMemberPost = readback([
  ...compensationPost.rows,
  {
    id: "9001",
    sellerColumns: {
      "TCGplayer Id": "9001",
      "Total Quantity": "2",
      "Add to Quantity": "0",
      "TCG Marketplace Price": "2.00",
    },
  },
]);

describe("tcgplayer-staged-import-compensation-basis", () => {
  it("admits the exactly-cancelled compensation basis", () => {
    expect(preflightTcgplayerStagedImport(pre("-1"), compensationMembers)).toMatchObject({ kind: "proceed" });
    expect(
      deriveTcgplayerStagedImportReadbackVerdict({
        pre: pre("-1"),
        post: compensationPost,
        members: compensationMembers,
        authority,
      }),
    ).toMatchObject({ kind: "applied" });
  });

  it.each([
    [
      "undeclared pending delta",
      pre("-1"),
      compensationMembers.map(({ basisPendingAddToQuantity: _, ...member }) => member),
      compensationPost,
      "basis-diverged",
    ],
    ["key-copied-from-R0 / clean R0", pre("0"), compensationMembers, compensationPost, "basis-diverged"],
    ["key-copied-from-R0 / different R0", pre("-2"), compensationMembers, compensationPost, "basis-diverged"],
    [
      "zero-key-accepted",
      pre("0"),
      compensationMembers.map((member) => ({
        ...member,
        basisPendingAddToQuantity: 0,
        csvRow: { ...member.csvRow, "Add to Quantity": "0" },
      })),
      compensationPost,
      "member-projection-mismatch",
    ],
    [
      "non-integer declared basis",
      pre("-1"),
      compensationMembers.map((member) => ({ ...member, basisPendingAddToQuantity: 1.5 })),
      compensationPost,
      "member-projection-mismatch",
    ],
    [
      "non-number declared basis",
      pre("-1"),
      compensationMembers.map((member) => ({ ...member, basisPendingAddToQuantity: "-1" })),
      compensationPost,
      "member-projection-mismatch",
    ],
    [
      "inverse-check-deleted / composed delta not inverse",
      pre("-1"),
      compensationMembers.map((member) => ({
        ...member,
        basisPendingAddToQuantity: -1,
        csvRow: { ...member.csvRow, "Add to Quantity": "2" },
      })),
      compensationPost,
      "member-projection-mismatch",
    ],
    [
      "compensation-projects-delta",
      pre("-1"),
      compensationMembers,
      readback(
        ids.map((id) => ({
          ...compensationPost.rows.find((row) => row.id === id)!,
          sellerColumns: {
            ...compensationPost.rows.find((row) => row.id === id)!.sellerColumns,
            "Add to Quantity": "1",
          },
        })),
      ),
      "member-projection-mismatch",
    ],
    [
      "non-member drift",
      nonMemberPre,
      compensationMembers,
      readback(
        nonMemberPost.rows.map((row, index) =>
          index === 2 ? { ...row, sellerColumns: { ...row.sellerColumns, Title: "drift" } } : row,
        ),
      ),
      "non-member-drift",
    ],
  ])("returns %s", (_name, preReadback, members, post, reason) => {
    const preflight = preflightTcgplayerStagedImport(preReadback, members);
    const verdict = deriveTcgplayerStagedImportReadbackVerdict({ pre: preReadback, post, members, authority });
    if (reason === "basis-diverged") expect(preflight).toMatchObject({ kind: reason });
    else if (reason === "member-projection-mismatch" && _name !== "compensation-projects-delta")
      expect(preflight).toMatchObject({ kind: "outcome-unknown", reason });
    else expect(preflight).toMatchObject({ kind: "proceed" });
    expect(verdict).toMatchObject(reason === "basis-diverged" ? { kind: reason } : { kind: "outcome-unknown", reason });
  });

  it.each([undefined, null, "-1", NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, -0, 1.5])(
    "rejects an explicitly present invalid pending basis %s",
    (basisPendingAddToQuantity) => {
      const members = compensationMembers.map((member) => ({ ...member, basisPendingAddToQuantity }));
      expect(preflightTcgplayerStagedImport(pre("-1"), members)).toMatchObject({
        kind: "outcome-unknown",
        reason: "member-projection-mismatch",
      });
    },
  );

  it("refuses an unsafe integer basis even with an otherwise matching inverse and R0", () => {
    const pending = Number.MAX_SAFE_INTEGER + 1;
    const members = compensationMembers.map((member) => ({
      ...member,
      basisPendingAddToQuantity: pending,
      csvRow: { ...member.csvRow, "Add to Quantity": String(-pending) },
    }));
    expect(preflightTcgplayerStagedImport(pre(String(pending)), members)).toMatchObject({
      kind: "outcome-unknown",
      reason: "member-projection-mismatch",
    });
  });

  it("does not copy an inherited pending basis into an undeclared member", () => {
    const members = compensationMembers.map(({ basisPendingAddToQuantity: _, ...member }) =>
      Object.assign(Object.create({ basisPendingAddToQuantity: -1 }), member),
    );
    expect(preflightTcgplayerStagedImport(pre("-1"), members)).toMatchObject({ kind: "basis-diverged" });
    expect(preflightTcgplayerStagedImport(pre("0"), members)).toMatchObject({ kind: "proceed" });
  });

  it.each(["01", "+1", "1.0", "-1"])("rejects a non-canonical inverse %s", (delta) => {
    const members = compensationMembers.map((member) => ({
      ...member,
      csvRow: { ...member.csvRow, "Add to Quantity": delta },
    }));
    expect(preflightTcgplayerStagedImport(pre("-1"), members)).toMatchObject({
      kind: "outcome-unknown",
      reason: "member-projection-mismatch",
    });
  });

  it("admits the opposite compensation direction and retains the closed member keys", () => {
    const members = compensationMembers.map((member) => ({
      ...member,
      basisPendingAddToQuantity: 1,
      csvRow: { ...member.csvRow, "Add to Quantity": "-1" },
    }));
    const post = readback(
      compensationPost.rows.map((row) => ({
        ...row,
        sellerColumns: { ...row.sellerColumns, "Total Quantity": "4" },
      })),
    );
    expect(preflightTcgplayerStagedImport(pre("1"), members)).toMatchObject({ kind: "proceed" });
    expect(deriveTcgplayerStagedImportReadbackVerdict({ pre: pre("1"), post, members, authority })).toMatchObject({
      kind: "applied",
    });
    expect(
      preflightTcgplayerStagedImport(
        pre("1"),
        members.map((member) => ({ ...member, unknownKey: true })),
      ),
    ).toMatchObject({
      kind: "outcome-unknown",
      reason: "member-projection-mismatch",
    });
  });

  it("keeps new-path results, errors and logs counts-only with sentinel readback bytes", () => {
    const sentinel = "SENTINEL-compensation-private-row";
    const before = readback(
      pre("-1").rows.map((row) => ({
        ...row,
        sellerColumns: { ...row.sellerColumns, Title: sentinel },
      })),
    );
    const after = readback(
      compensationPost.rows.map((row) => ({
        ...row,
        sellerColumns: { ...row.sellerColumns, Title: sentinel },
      })),
    );
    const logs = ["log", "info", "warn", "error", "debug"] as const;
    const spies = logs.map((method) => vi.spyOn(console, method).mockImplementation(() => {}));
    try {
      for (const members of [
        compensationMembers,
        compensationMembers.map(({ basisPendingAddToQuantity: _, ...member }) => member),
        compensationMembers.map((member) => ({ ...member, basisPendingAddToQuantity: sentinel })),
      ]) {
        const preflight = preflightTcgplayerStagedImport(before, members);
        const verdict = deriveTcgplayerStagedImportReadbackVerdict({ pre: before, post: after, members, authority });
        expect(Object.keys(preflight).sort()).toEqual(
          preflight.kind === "outcome-unknown" ? ["counts", "kind", "reason"] : ["counts", "kind"],
        );
        expect(Object.keys(verdict).sort()).toEqual(
          verdict.kind === "outcome-unknown" ? ["counts", "kind", "reason"] : ["counts", "kind"],
        );
        expect(JSON.stringify({ preflight, verdict })).not.toContain(sentinel);
      }
      let error: unknown;
      try {
        decodeTcgplayerStagedImportReadback({ rows: before.rows, completeness: null, unexpected: sentinel });
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).toBe("Error: staged-import-readback-invalid-record");
      expect(JSON.stringify(error)).not.toContain(sentinel);
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it("keeps the clean basis byte-for-byte and isolates sentinels", () => {
    const cleanMembers = compensationMembers.map(({ basisPendingAddToQuantity: _, ...member }) => ({
      ...member,
      csvRow: { ...member.csvRow, "Add to Quantity": "1" },
    }));
    const cleanPre = pre("0");
    const cleanPost = readback(
      cleanPre.rows.map((row) => ({
        ...row,
        sellerColumns: {
          ...row.sellerColumns,
          "Total Quantity": "6",
          "Add to Quantity": "1",
          "TCG Marketplace Price": "1.00",
        },
      })),
    );
    expect(
      deriveTcgplayerStagedImportReadbackVerdict({ pre: cleanPre, post: cleanPost, members: cleanMembers, authority }),
    ).toMatchObject({ kind: "applied" });
    const sentinel = "SENTINEL-compensation-basis";
    const drift = readback([
      ...compensationPost.rows,
      {
        id: "9001",
        sellerColumns: {
          "TCGplayer Id": "9001",
          "Total Quantity": "2",
          "Add to Quantity": "0",
          "TCG Marketplace Price": "2.00",
          Title: sentinel,
        },
      },
    ]);
    const verdict = deriveTcgplayerStagedImportReadbackVerdict({
      pre: nonMemberPre,
      post: drift,
      members: compensationMembers,
      authority,
    });
    expect(verdict).toMatchObject({ kind: "outcome-unknown", reason: "non-member-drift" });
    expect(JSON.stringify(verdict)).not.toContain(sentinel);
    expect(
      readFileSync(new URL("../domain/tcgplayer-staged-import-readback-verdict.ts", import.meta.url), "utf8"),
    ).not.toMatch(/tcgplayer\.com|chrome\.cookies/);
  });
});
