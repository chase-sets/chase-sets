import { describe, expect, it, vi } from "vitest";
import { tcgplayerStagedImportCandidateClassification } from "../domain/tcgplayer-staged-import-classification";
import { buildTcgplayerStagedImportEnvelope } from "../domain/tcgplayer-staged-import-envelope";
import { createTcgplayerStagedImportReleaseGate } from "../domain/tcgplayer-staged-import-release-gate";
import {
  decodeTcgplayerStagedImportReadback,
  deriveTcgplayerStagedImportReadbackVerdict,
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
const authority = {
  origin: "worker" as const,
  method: "GET" as const,
  path: "/Admin/Pricing/DownloadStagedInventoryExportCSV",
  status: 200,
  contentType: "text/csv",
};
const readback = (rows: unknown[]) =>
  decodeTcgplayerStagedImportReadback({ rows, completeness: { kind: "complete", expectedRows: rows.length } });

describe("tcgplayer-staged-import-builder-isolation refusal messages", () => {
  const sentinel = "SENTINEL-refusal-7d1";
  it.each([
    ["a control character in the upload id", { ...continuation, stagedPricingUploadId: `${sentinel}\u0001` }],
    ["whitespace in the batch file name", { ...continuation, batchFileName: `${sentinel} batch.csv` }],
  ])("refuses %s with invalid-composed-value", (_name, value) => {
    let refusal: unknown;
    try {
      buildTcgplayerStagedImportEnvelope({
        classification: tcgplayerStagedImportCandidateClassification,
        composedRows: [row],
        continuation: value,
      });
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toMatchObject({
      code: "invalid-composed-value",
      message: "staged-import-envelope-invalid-composed-value",
    });
    expect(String(refusal)).not.toContain(sentinel);
  });

  it("refuses an empty composed Add to Quantity with invalid-composed-value", () => {
    let refusal: unknown;
    try {
      buildTcgplayerStagedImportEnvelope({
        classification: tcgplayerStagedImportCandidateClassification,
        composedRows: [{ ...row, "Add to Quantity": "" }],
        continuation,
      });
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toMatchObject({
      code: "invalid-composed-value",
      message: "staged-import-envelope-invalid-composed-value",
    });
  });
});

describe("tcgplayer-staged-import-builder-isolation non-member readback", () => {
  it("scans preflight, applied and non-member-drift results", () => {
    const sentinel = "SENTINEL-nonmember-7d1";
    const memberPre = {
      id: "1001",
      sellerColumns: {
        "TCGplayer Id": "1001",
        "Total Quantity": "1",
        "Add to Quantity": "0",
        "TCG Marketplace Price": "1.00",
      },
    };
    const memberPost = {
      id: "1001",
      sellerColumns: {
        ...memberPre.sellerColumns,
        "Total Quantity": "3",
        "Add to Quantity": "2",
        "TCG Marketplace Price": "1.25",
      },
    };
    const other = {
      id: "1002",
      sellerColumns: {
        "TCGplayer Id": "1002",
        "Total Quantity": "2",
        "Add to Quantity": "0",
        "TCG Marketplace Price": "2.00",
        Title: sentinel,
      },
    };
    const pre = readback([memberPre, other]);
    const preflight = preflightTcgplayerStagedImport(pre, [member]);
    expect(preflight.kind).toBe("proceed");
    expect(JSON.stringify(preflight)).not.toContain(sentinel);
    const applied = deriveTcgplayerStagedImportReadbackVerdict({
      pre,
      post: readback([memberPost, other]),
      members: [member],
      authority,
    });
    expect(applied.kind).toBe("applied");
    expect(JSON.stringify(applied)).not.toContain(sentinel);
    const drifted = deriveTcgplayerStagedImportReadbackVerdict({
      pre,
      post: readback([memberPost, { ...other, sellerColumns: { ...other.sellerColumns, Title: `${sentinel}-drift` } }]),
      members: [member],
      authority,
    });
    expect(drifted).toMatchObject({ kind: "outcome-unknown", reason: "non-member-drift" });
    expect(JSON.stringify(drifted)).not.toContain(sentinel);
  });
});

describe("tcgplayer-staged-import-release-gate sink failure latch", () => {
  it("refuses a valid upload with stopped after the initialize sink fails", async () => {
    const sink = vi.fn(async () => {
      throw new Error("synthetic sink failure");
    });
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
    await expect(
      gate.release({
        phase: "initialize",
        method: "POST",
        path: "/admin/pricing/initializeexportcsv",
        body: envelope.initialize,
        redirect: "error",
      }),
    ).rejects.toThrow("staged-import-release-sink-failed");
    expect(gate.stopped()).toBe(true);
    await expect(
      gate.release({
        phase: "upload",
        method: "POST",
        path: "/admin/pricing/uploadexportcsv",
        body: envelope.upload,
        redirect: "error",
      }),
    ).rejects.toThrow("staged-import-release-stopped");
    expect(sink).toHaveBeenCalledTimes(1);
  });
});
