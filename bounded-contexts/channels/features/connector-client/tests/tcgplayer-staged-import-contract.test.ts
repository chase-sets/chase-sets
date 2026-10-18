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
  ])("rejects %s", (_name, value) =>
    expect(() => decodeTcgplayerStagedImportFieldClassification(value)).toThrow(
      /staged-import-classification-(invalid-record|duplicate-field|credential-shaped-field|unclassified-field)/,
    ),
  );

  it("requires founder-session authority when requested", () => {
    expect(() =>
      decodeTcgplayerStagedImportFieldClassification(tcgplayerStagedImportCandidateClassification, {
        requireSource: "founder-session",
      }),
    ).toThrow("staged-import-classification-founder-session-required");
  });
});

describe("tcgplayer-staged-import-builder-isolation", () => {
  it("derives every classified field and value for every hop and repeated row", () => {
    const rows = [row, { ...row, "TCGplayer Id": "1002", "Product Name": "Second Card" }];
    const classifications = [
      tcgplayerStagedImportCandidateClassification,
      {
        ...tcgplayerStagedImportCandidateClassification,
        initialize: [...tcgplayerStagedImportCandidateClassification.initialize].reverse(),
        upload: tcgplayerStagedImportCandidateClassification.upload.map((field) =>
          field.key === "data[n][ProductName]" ? { ...field, key: "data[n][RenamedProduct]" } : field,
        ),
        finalize: [...tcgplayerStagedImportCandidateClassification.finalize].reverse(),
      },
    ];
    for (const classification of classifications) {
      const envelope = buildTcgplayerStagedImportEnvelope({ classification, composedRows: rows, continuation });
      for (const hop of ["initialize", "upload", "finalize"] as const) {
        const fields = classification[hop];
        const repeated = fields.filter((field) => field.key.includes("[n]"));
        const scalar = fields.filter((field) => !field.key.includes("[n]"));
        const expected: [string, string][] = [];
        const valueFor = (field: (typeof fields)[number], source: (typeof rows)[number]) => {
          switch (field.class.kind) {
            case "closed-constant":
              return field.class.value;
            case "verbatim-reference-column":
            case "composed-column":
              return String((source as Readonly<Record<string, unknown>>)[field.class.column]);
            case "closed-derivation":
              return field.class.derivation === "prior-hop-continuation"
                ? continuation.stagedPricingUploadId
                : field.class.derivation === "batch-file-name"
                  ? continuation.batchFileName
                  : String(rows.length);
          }
        };
        for (const [index, source] of rows.entries())
          for (const field of repeated)
            expected.push([field.key.replaceAll("[n]", `[${index}]`), valueFor(field, source)]);
        for (const field of scalar) expected.push([field.key, valueFor(field, rows[0]!)]);
        expect([...new URLSearchParams(envelope[hop])]).toEqual(expected);
      }
    }
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
    ).toThrow(
      /staged-import-envelope-(zero-composed-rows|row-outside-observed-input-classes|missing-reference-column|invalid-composed-value)/,
    );
  });

  it("keeps sentinel values out of DTOs and refusal messages", () => {
    const sentinel = "SENTINEL-builder-7d1\u0001";
    let refusal: unknown;
    try {
      buildTcgplayerStagedImportEnvelope({
        classification: tcgplayerStagedImportCandidateClassification,
        composedRows: [{ ...row, "Product Name": sentinel }],
        continuation: { stagedPricingUploadId: sentinel, batchFileName: sentinel },
      });
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toMatchObject({ code: "invalid-composed-value" });
    expect(String((refusal as Error).message)).not.toContain("SENTINEL");
    expect(JSON.stringify(tcgplayerStagedImportCandidateClassification)).not.toContain(sentinel);
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
    await expect(gate.release(request)).rejects.toThrow("staged-import-release-phase-released");
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
    ).rejects.toThrow("staged-import-release-invalid-request");
    expect(sink).not.toHaveBeenCalled();
  });

  it("rejects mismatched bodies without invoking the sink", async () => {
    const sink = vi.fn();
    const gate = createTcgplayerStagedImportReleaseGate({
      classification: tcgplayerStagedImportCandidateClassification,
      composedRows: [row],
      continuation,
      sink,
    });
    await expect(
      gate.release({
        phase: "initialize",
        method: "POST",
        path: "/admin/pricing/initializeexportcsv",
        body: "body-mismatch",
        redirect: "error",
      }),
    ).rejects.toThrow("staged-import-release-body-mismatch");
    expect(sink).not.toHaveBeenCalled();
    expect(gate.stopped()).toBe(true);
  });

  it("rejects redirects without touching the sink and latches STOP", async () => {
    const sink = vi.fn();
    const gate = createTcgplayerStagedImportReleaseGate({
      classification: tcgplayerStagedImportCandidateClassification,
      composedRows: [row],
      continuation,
      sink,
    });
    await expect(
      gate.release({
        phase: "initialize",
        method: "POST",
        path: "/admin/pricing/initializeexportcsv",
        body: "x",
        redirect: "manual" as "error",
      }),
    ).rejects.toThrow("staged-import-release-redirect-refused");
    expect(sink).not.toHaveBeenCalled();
    expect(gate.stopped()).toBe(true);
    await expect(
      gate.release({
        phase: "initialize",
        method: "POST",
        path: "/admin/pricing/initializeexportcsv",
        body: "x",
        redirect: "error",
      }),
    ).rejects.toThrow("staged-import-release-stopped");
  });

  it("rejects sink failures with an exact code", async () => {
    const gate = createTcgplayerStagedImportReleaseGate({
      classification: tcgplayerStagedImportCandidateClassification,
      composedRows: [row],
      continuation,
      sink: vi.fn(async () => {
        throw new Error("synthetic sink failure");
      }),
    });
    const body = buildTcgplayerStagedImportEnvelope({
      classification: tcgplayerStagedImportCandidateClassification,
      composedRows: [row],
      continuation,
    }).initialize;
    await expect(
      gate.release({
        phase: "initialize",
        method: "POST",
        path: "/admin/pricing/initializeexportcsv",
        body,
        redirect: "error",
      }),
    ).rejects.toThrow("staged-import-release-sink-failed");
    expect(gate.stopped()).toBe(true);
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
    ["authority unavailable", readback(preRows), "authority-unavailable"],
  ])("returns closed reason for %s", (_name, post, reason) => {
    const verdictAuthority = reason === "authority-unavailable" ? { ...authority, origin: "page" as const } : authority;
    expect(
      deriveTcgplayerStagedImportReadbackVerdict({
        pre: readback(preRows),
        post,
        members: [member],
        authority: verdictAuthority,
      }),
    ).toMatchObject({ kind: "outcome-unknown", reason });
  });

  it.each([
    ["overflow", readback([], { kind: "overflow" }), "overflow-readback"],
    ["partial rows", readback([preRows[0]!], { kind: "complete", expectedRows: 2 }), "incomplete-readback"],
  ])("refuses %s through the verdict", (_name, pre, reason) => {
    expect(
      deriveTcgplayerStagedImportReadbackVerdict({ pre, post: readback(preRows), members: [member], authority }),
    ).toMatchObject({ kind: "outcome-unknown", reason });
  });

  it("rejects a pending pre-import delta in both preflight and verdict", () => {
    const pending = readback([
      { ...preRows[0]!, sellerColumns: { ...preRows[0]!.sellerColumns, "Add to Quantity": "3" } },
      preRows[1]!,
    ]);
    expect(preflightTcgplayerStagedImport(pending, [member])).toMatchObject({ kind: "basis-diverged" });
    expect(
      deriveTcgplayerStagedImportReadbackVerdict({
        pre: pending,
        post: pending,
        members: [member],
        authority,
      }),
    ).toMatchObject({ kind: "basis-diverged" });
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

  it("parses quoted commas, all-quoted rows and quoted final fields, and refuses ragged rows", () => {
    const header = "TCGplayer Id,Product Name,Total Quantity,Add to Quantity,TCG Marketplace Price";
    const parsed = parseTcgplayerStagedImportReadback(`${header}\n1001,\"Synthetic, Comma Card\",1,0,2.00`);
    expect(parsed.rows[0]!.sellerColumns["TCG Marketplace Price"]).toBe("2.00");
    const quotedHeader = '"TCGplayer Id","Product Name","Total Quantity","Add to Quantity","TCG Marketplace Price"';
    const quotedRows = '"1001","Synthetic Card","1","0","2.00"\r\n"1002","Second Card","2","0","3.00"\r\n';
    expect(parseTcgplayerStagedImportReadback(`${quotedHeader}\r\n${quotedRows}`).rows).toHaveLength(2);
    expect(
      parseTcgplayerStagedImportReadback(`${quotedHeader}\r\n1001,Card,1,0,"2.00"\r\n1002,Card,2,0,"3.00"`).rows,
    ).toHaveLength(2);
    expect(parseTcgplayerStagedImportReadback(quotedHeader).completeness).toMatchObject({
      kind: "incomplete",
      reason: "missing",
    });
    expect(parseTcgplayerStagedImportReadback("").completeness).toMatchObject({
      kind: "incomplete",
      reason: "missing",
    });
    expect(() => parseTcgplayerStagedImportReadback(`${header}\r\n1001,Card,1,0,"2.00`)).toThrow(
      "staged-import-readback-invalid-record",
    );
    expect(() => parseTcgplayerStagedImportReadback(`${header}\n1001,Card,1`)).toThrow(
      "staged-import-readback-invalid-record",
    );
    expect(parseTcgplayerStagedImportReadback("x".repeat(1_048_577)).completeness).toMatchObject({ kind: "overflow" });
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
