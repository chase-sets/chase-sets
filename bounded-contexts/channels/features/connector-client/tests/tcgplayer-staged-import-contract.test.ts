import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  decodeTcgplayerStagedImportFieldClassification,
  tcgplayerStagedImportCandidateClassification,
} from "../domain/tcgplayer-staged-import-classification";
import { buildTcgplayerStagedImportEnvelope } from "../domain/tcgplayer-staged-import-envelope";
import { createTcgplayerStagedImportReleaseGate } from "../domain/tcgplayer-staged-import-release-gate";
import {
  decodeTcgplayerStagedImportReadback,
  deriveTcgplayerStagedImportReadbackVerdict,
  parseTcgplayerStagedImportReadback,
  preflightTcgplayerStagedImport,
} from "../domain/tcgplayer-staged-import-readback-verdict";

const row = {
  "TCGplayer Id": "1001",
  "Product Line": "Cards",
  "Set Name": "Synthetic Set",
  "Product Name": "Synthetic Card",
  Title: "Synthetic Card",
  Number: "1",
  Rarity: "C",
  Condition: "Near Mint",
  "TCG Market Price": "9.00",
  "TCG Direct Low": "",
  "TCG Low Price With Shipping": "",
  "TCG Low Price": "",
  "Total Quantity": "1",
  "Add to Quantity": "2",
  "TCG Marketplace Price": "1.25",
  "Photo URL": "",
};
const continuation = { stagedPricingUploadId: "upload-1", batchFileName: "batch.csv" };
const member = {
  externalKey: "product:1001",
  basisTotalQuantity: 1,
  basisPriceAmountMinor: 100,
  csvRow: { "Add to Quantity": "2", "TCG Marketplace Price": "1.25" },
};

describe("tcgplayer-staged-import-classification-contract", () => {
  it.each([
    ["unknown top-level", { ...tcgplayerStagedImportCandidateClassification, extra: true }],
    [
      "nested unknown",
      {
        ...tcgplayerStagedImportCandidateClassification,
        initialize: [{ ...tcgplayerStagedImportCandidateClassification.initialize[0], extra: true }],
      },
    ],
    [
      "duplicate field",
      {
        ...tcgplayerStagedImportCandidateClassification,
        initialize: [
          ...tcgplayerStagedImportCandidateClassification.initialize,
          tcgplayerStagedImportCandidateClassification.initialize[0],
        ],
      },
    ],
    [
      "credential-shaped",
      {
        ...tcgplayerStagedImportCandidateClassification,
        initialize: [{ key: "sessionToken", class: { kind: "closed-constant", value: "x" } }],
      },
    ],
    ["unclassified", { ...tcgplayerStagedImportCandidateClassification, initialize: [{ key: "x", class: null }] }],
  ])("rejects %s", (_name, value) => expect(() => decodeTcgplayerStagedImportFieldClassification(value)).toThrow());

  it("requires founder-session authority when requested", () => {
    expect(() =>
      decodeTcgplayerStagedImportFieldClassification(tcgplayerStagedImportCandidateClassification, {
        requireSource: "founder-session",
      }),
    ).toThrow("founder-session-required");
  });
});

describe("tcgplayer-staged-import-builder-isolation", () => {
  it("derives every classified field in order for repeated rows", () => {
    const rows = [row, { ...row, "TCGplayer Id": "1002" }];
    const envelope = buildTcgplayerStagedImportEnvelope({
      classification: tcgplayerStagedImportCandidateClassification,
      composedRows: rows,
      continuation,
    });
    const repeated = tcgplayerStagedImportCandidateClassification.upload.filter((field) => field.key.includes("[n]"));
    const scalar = tcgplayerStagedImportCandidateClassification.upload.filter((field) => !field.key.includes("[n]"));
    const expected = rows
      .flatMap((_, index) => repeated.map((field) => field.key.replaceAll("[n]", `[${index}]`)))
      .concat(scalar.map((field) => field.key));
    expect([...new URLSearchParams(envelope.upload).keys()]).toEqual(expected);
    expect(envelope.upload).toContain("data%5B0%5D%5BProductConditionId%5D=Near+Mint");
    expect(envelope.upload).toContain("data%5B1%5D%5BId%5D=1002");
  });

  it.each([
    ["empty rows", []],
    ["invalid price", [{ ...row, "TCG Marketplace Price": "" }]],
    ["missing id", [{ ...row, "TCGplayer Id": "" }]],
    ["missing classified reference", [{ ...row, Condition: undefined }]],
  ])("refuses %s before creating bytes", (_name, composedRows) => {
    expect(() =>
      buildTcgplayerStagedImportEnvelope({
        classification: tcgplayerStagedImportCandidateClassification,
        composedRows,
        continuation,
      }),
    ).toThrow();
  });
});

describe("tcgplayer-staged-import-release-gate", () => {
  it("checks builder bytes, path, order and releases each phase once", async () => {
    const sink = vi.fn();
    const gate = createTcgplayerStagedImportReleaseGate({
      classification: tcgplayerStagedImportCandidateClassification,
      composedRows: [row],
      continuation,
      sink,
    });
    const envelope = buildTcgplayerStagedImportEnvelope({
      classification: tcgplayerStagedImportCandidateClassification,
      composedRows: [row],
      continuation,
    });
    const request = {
      phase: "initialize" as const,
      method: "POST" as const,
      path: "/admin/pricing/initializeexportcsv",
      body: envelope.initialize,
      redirect: "error" as const,
    };
    await gate.release(request);
    await expect(gate.release(request)).rejects.toThrow("phase-released");
    expect(sink).toHaveBeenCalledTimes(1);
    expect(gate.stopped()).toBe(true);
  });

  it("rejects mismatched bytes, paths, redirects and out-of-order phases", async () => {
    const sink = vi.fn();
    const gate = createTcgplayerStagedImportReleaseGate({
      classification: tcgplayerStagedImportCandidateClassification,
      composedRows: [row],
      continuation,
      sink,
    });
    await expect(
      gate.release({
        phase: "upload",
        method: "POST",
        path: "/admin/pricing/uploadexportcsv",
        body: "x",
        redirect: "error",
      }),
    ).rejects.toThrow("invalid-request");
    expect(sink).not.toHaveBeenCalled();
  });

  it("closes a concurrent release race", async () => {
    const sink = vi.fn(async (): Promise<void> => {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    });
    const gate = createTcgplayerStagedImportReleaseGate({
      classification: tcgplayerStagedImportCandidateClassification,
      composedRows: [row],
      continuation,
      sink,
    });
    const body = buildTcgplayerStagedImportEnvelope({
      classification: tcgplayerStagedImportCandidateClassification,
      composedRows: [row],
      continuation,
    }).initialize;
    const request = {
      phase: "initialize" as const,
      method: "POST" as const,
      path: "/admin/pricing/initializeexportcsv",
      body,
      redirect: "error" as const,
    };
    const settled = await Promise.allSettled([gate.release(request), gate.release(request)]);
    expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(sink).toHaveBeenCalledTimes(1);
  });
});

function readback(rows: unknown[], completeness: unknown = { kind: "complete", expectedRows: rows.length }) {
  return decodeTcgplayerStagedImportReadback({ rows, completeness });
}
const authority = {
  origin: "worker" as const,
  method: "GET" as const,
  path: "/Admin/Pricing/DownloadStagedInventoryExportCSV",
  status: 200,
  contentType: "text/csv",
};

describe("tcgplayer-staged-import-readback-verdict", () => {
  const preRows = [
    {
      id: "1001",
      sellerColumns: {
        "TCGplayer Id": "1001",
        "Total Quantity": "1",
        "Add to Quantity": "0",
        "TCG Marketplace Price": "1.00",
      },
    },
    {
      id: "1002",
      sellerColumns: {
        "TCGplayer Id": "1002",
        "Total Quantity": "2",
        "Add to Quantity": "0",
        "TCG Marketplace Price": "2.00",
      },
    },
  ];
  it("applies only with complete bracket and unchanged non-members", () => {
    const postRows = [
      {
        id: "1001",
        sellerColumns: {
          "TCGplayer Id": "1001",
          "Total Quantity": "3",
          "Add to Quantity": "2",
          "TCG Marketplace Price": "1.25",
        },
      },
      preRows[1]!,
    ];
    expect(
      deriveTcgplayerStagedImportReadbackVerdict({
        pre: readback(preRows),
        post: readback(postRows),
        members: [member],
        authority,
      }),
    ).toMatchObject({ kind: "applied" });
  });

  it.each([
    ["missing completeness", readback(preRows, null), "missing-completeness-discriminator"],
    [
      "member projection mismatch",
      readback([
        { ...preRows[0]!, sellerColumns: { ...preRows[0]!.sellerColumns, "Total Quantity": "4" } },
        preRows[1]!,
      ]),
      "member-projection-mismatch",
    ],
    [
      "non-member drift",
      readback([
        {
          id: "1001",
          sellerColumns: {
            ...preRows[0]!.sellerColumns,
            "Total Quantity": "3",
            "Add to Quantity": "2",
            "TCG Marketplace Price": "1.25",
          },
        },
        { ...preRows[1]!, sellerColumns: { ...preRows[1]!.sellerColumns, "Total Quantity": "3" } },
      ]),
      "non-member-drift",
    ],
    ["incomplete", readback(preRows, { kind: "incomplete", reason: "partial" }), "incomplete-readback"],
  ])("returns closed reason for %s", (_name, post, reason) => {
    expect(
      deriveTcgplayerStagedImportReadbackVerdict({ pre: readback(preRows), post, members: [member], authority }),
    ).toMatchObject({ kind: "outcome-unknown", reason });
  });

  it.each(["intentless", "typo csv", "string basis", "zero members", "unknown nested key"])(
    "rejects %s member projection",
    (kind) => {
      const value =
        kind === "intentless"
          ? { id: "1001" }
          : kind === "typo csv"
            ? { ...member, csvRow: { AddToQuantity: "2", MyPrice: "1.25" } }
            : kind === "string basis"
              ? { ...member, basisPriceAmountMinor: "999" }
              : kind === "unknown nested key"
                ? { ...member, extra: "SENTINEL" }
                : null;
      const members = value === null ? [] : [value];
      expect(preflightTcgplayerStagedImport(readback(preRows), members)).toMatchObject({
        kind: "outcome-unknown",
        reason: "member-projection-mismatch",
      });
    },
  );

  it("parses quoted commas and refuses ragged rows", () => {
    const header = "TCGplayer Id,Product Name,Total Quantity,Add to Quantity,TCG Marketplace Price";
    const parsed = parseTcgplayerStagedImportReadback(`${header}\n1001,\"Synthetic, Comma Card\",1,0,2.00`);
    expect(parsed.rows[0]!.sellerColumns["TCG Marketplace Price"]).toBe("2.00");
    expect(() => parseTcgplayerStagedImportReadback(`${header}\n1001,Card,1`)).toThrow("invalid-record");
  });

  it("returns unknown rather than throwing at overflow and closes decoder keys", () => {
    const many = Array.from({ length: 513 }, (_, index) => ({ id: String(1000 + index), sellerColumns: {} }));
    const overflow = readback(many, { kind: "complete", expectedRows: 513 });
    expect(preflightTcgplayerStagedImport(overflow, [member])).toMatchObject({
      kind: "outcome-unknown",
      reason: "overflow-readback",
    });
    expect(() =>
      decodeTcgplayerStagedImportReadback({
        rows: [{ id: "1", sellerColumns: {}, SENTINEL_EXTRA: "x" }],
        completeness: null,
        extraTop: 1,
      }),
    ).toThrow("invalid-record");
  });

  it("isolates sentinel values from verdicts and source holds no provider APIs", () => {
    const sentinel = readback([
      {
        id: "1001",
        sellerColumns: {
          "TCGplayer Id": "1001",
          "Total Quantity": "1",
          "TCG Marketplace Price": "1.00",
          "Product Name": "SENTINEL-7d1",
        },
      },
    ]);
    const verdict = deriveTcgplayerStagedImportReadbackVerdict({
      pre: sentinel,
      post: sentinel,
      members: [],
      authority,
    });
    expect(JSON.stringify(verdict)).not.toContain("SENTINEL");
    for (const name of [
      "tcgplayer-staged-import-classification.ts",
      "tcgplayer-staged-import-envelope.ts",
      "tcgplayer-staged-import-release-gate.ts",
      "tcgplayer-staged-import-readback-verdict.ts",
    ])
      expect(readFileSync(new URL(`../domain/${name}`, import.meta.url), "utf8")).not.toMatch(
        /tcgplayer\.com|chrome\.cookies/,
      );
  });
});
