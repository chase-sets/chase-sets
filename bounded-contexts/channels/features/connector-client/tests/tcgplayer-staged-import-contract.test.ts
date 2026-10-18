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
  preflightTcgplayerStagedImport,
} from "../domain/tcgplayer-staged-import-readback-verdict";

const row = {
  "TCGplayer Id": "1001",
  ProductConditionId: "2001",
  CategoryName: "Cards",
  "Set Name": "Synthetic Set",
  "Product Name": "Synthetic Card",
  Condition: "Near Mint",
  Number: "1",
  "Add to Quantity": "2",
  "TCG Marketplace Price": "1.25",
  ProOnlineStoreReserveQuantity: "",
  ProOnlineStorePrice: "",
};
const continuation = { stagedPricingUploadId: "upload-1", batchFileName: "batch.csv" };

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
  ])("rejects %s (bypass mutant)", (_name, value) =>
    expect(() => decodeTcgplayerStagedImportFieldClassification(value)).toThrow(),
  );

  it("requires founder-session authority when requested", () => {
    expect(() =>
      decodeTcgplayerStagedImportFieldClassification(tcgplayerStagedImportCandidateClassification, {
        requireSource: "founder-session",
      }),
    ).toThrow();
  });
});

describe("tcgplayer-staged-import-envelope-builder", () => {
  it("derives every ordered field and value from the classification (hand-list mutant)", () => {
    const envelope = buildTcgplayerStagedImportEnvelope({
      classification: tcgplayerStagedImportCandidateClassification,
      composedRows: [row],
      continuation,
    });
    expect(envelope.initialize).toBe("filename=batch.csv&type=csv");
    expect(envelope.upload).toContain("data%5B0%5D%5BId%5D=1001");
    expect(envelope.upload).toContain("data%5B0%5D%5BAddToQuantity%5D=2");
    expect(envelope.upload).toContain("stagedPricingUploadId=upload-1");
    expect(envelope.finalize).toBe("stagedPricingUploadId=upload-1&productCount=1&type=csv");
  });

  it.each([
    ["empty rows", []],
    ["non-empty provider reserve", [{ ...row, ProOnlineStorePrice: "3.00" }]],
    ["invalid price", [{ ...row, "TCG Marketplace Price": "" }]],
    ["missing id", [{ ...row, "TCGplayer Id": "" }]],
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
  it("releases once per phase and latches STOP on replay (release-twice mutant)", async () => {
    const sink = vi.fn();
    const gate = createTcgplayerStagedImportReleaseGate({
      classification: tcgplayerStagedImportCandidateClassification,
      sink,
    });
    const request = {
      phase: "initialize" as const,
      method: "POST" as const,
      path: "/staged/initialize",
      body: "x=1",
      redirect: "error" as const,
    };
    await gate.release(request, request.body);
    await expect(gate.release(request, request.body)).rejects.toThrow("phase-released");
    expect(sink).toHaveBeenCalledTimes(1);
    expect(gate.stopped()).toBe(true);
  });

  it("rejects redirects without touching the sink", async () => {
    const sink = vi.fn();
    const gate = createTcgplayerStagedImportReleaseGate({
      classification: tcgplayerStagedImportCandidateClassification,
      sink,
    });
    await expect(
      gate.release({
        phase: "upload",
        method: "POST",
        path: "/staged/upload",
        body: "x",
        redirect: "manual" as "error",
      }),
    ).rejects.toThrow("redirect-refused");
    expect(sink).not.toHaveBeenCalled();
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
      marketColumns: { "TCG Market Price": "9.00" },
    },
    {
      id: "1002",
      sellerColumns: {
        "TCGplayer Id": "1002",
        "Total Quantity": "2",
        "Add to Quantity": "0",
        "TCG Marketplace Price": "2.00",
      },
      marketColumns: {},
    },
  ];
  const members = [
    {
      id: "1001",
      basisTotalQuantity: 1,
      basisPriceAmountMinor: 100,
      csvRow: { "Add to Quantity": "2", "TCG Marketplace Price": "1.25" },
    },
  ];
  it("applies only with complete bracket and unchanged non-members (presence-as-applied mutant)", () => {
    const postRows = [
      {
        id: "1001",
        sellerColumns: {
          "TCGplayer Id": "1001",
          "Total Quantity": "3",
          "Add to Quantity": "2",
          "TCG Marketplace Price": "1.25",
        },
        marketColumns: { "TCG Market Price": "9.50" },
      },
      preRows[1]!,
    ];
    expect(
      deriveTcgplayerStagedImportReadbackVerdict({
        pre: readback(preRows),
        post: readback(postRows),
        members,
        authority,
      }),
    ).toMatchObject({ kind: "applied" });
  });

  it.each([
    ["missing completeness", readback(preRows, null), "missing-completeness-discriminator"],
    ["id set changed", readback([{ ...preRows[0]!, id: "9999" }, preRows[1]!]), "id-set-changed"],
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
          ...preRows[0]!,
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
  ])("returns closed reason for %s (fail-open mutant)", (_name, post, reason) => {
    expect(
      deriveTcgplayerStagedImportReadbackVerdict({ pre: readback(preRows), post, members, authority }),
    ).toMatchObject({ kind: "outcome-unknown", reason });
  });

  it("preflight rejects pending basis delta and never exposes raw bytes (second-basis-predicate mutant)", () => {
    const pre = readback(preRows);
    expect(preflightTcgplayerStagedImport(pre, [{ ...members[0]!, pendingQuantityDelta: 1 }])).toMatchObject({
      kind: "basis-diverged",
    });
    expect(JSON.stringify(pre)).not.toContain("SENTINEL");
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
