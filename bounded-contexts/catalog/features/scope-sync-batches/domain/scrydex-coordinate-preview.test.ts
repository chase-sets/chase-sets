import { describe, expect, it } from "vitest";
import {
  classifyScrydexCoordinatePreviewRequest,
  scrydexCoordinatePreviewUnits,
  validateScrydexCoordinatePreviewReceipt,
} from "./scrydex-coordinate-preview";

const origin = "https://admin.staging.chasesets.com";

describe("Scrydex coordinate preview", () => {
  it("allows only cache reads and the one pre-confirm preview", () => {
    expect(
      classifyScrydexCoordinatePreviewRequest({
        method: "GET",
        url: `${origin}/api/catalog/source-observations/provider-profiles`,
        phase: "capture",
      }).allowed,
    ).toBe(true);
    expect(
      classifyScrydexCoordinatePreviewRequest({
        method: "GET",
        url: `${origin}/api/catalog/source-observations/integration-control-plane/overview?audience=daily`,
        phase: "capture",
      }),
    ).toMatchObject({ allowed: true, requestClass: "usage-read" });
    expect(
      classifyScrydexCoordinatePreviewRequest({
        method: "POST",
        url: `${origin}/api/catalog/scope-sync-batches/preview`,
        phase: "pre-confirm",
      }),
    ).toMatchObject({ allowed: true, requestClass: "preview" });
    expect(
      classifyScrydexCoordinatePreviewRequest({
        method: "POST",
        url: `${origin}/api/catalog/scope-sync-batches/confirm`,
        phase: "pre-confirm",
      }).allowed,
    ).toBe(false);
    expect(
      classifyScrydexCoordinatePreviewRequest({
        method: "GET",
        url: "https://www.tcgplayer.com/search?q=OP01",
        phase: "capture",
      }),
    ).toMatchObject({ allowed: false, reason: "tcgplayer" });
    expect(
      classifyScrydexCoordinatePreviewRequest({
        method: "GET",
        url: `${origin}/api/catalog/source-observations/integration-options?providerKey=scrydex&queryKind=sets&limit=200&profileKey=p&ingestionUnitKey=${encodeURIComponent(scrydexCoordinatePreviewUnits[0].unitKey)}&cacheOnly=true`,
        phase: "capture",
      }).requestClass,
    ).toBe("cache-option-read");
  });

  it("rejects a generic or incomplete receipt instead of promoting it", () => {
    const errors = validateScrydexCoordinatePreviewReceipt({
      schemaVersion: "scrydex-coordinate-preview/v1",
      outcome: "complete",
      reasons: [],
      runner: {
        sha: "a".repeat(40),
        runId: "1",
        runAttempt: "1",
        journeyScope: "scrydex-coordinate-preview",
        origin: "admin.staging.chasesets.com",
      },
      deployment: { before: null, after: null },
      startedAt: "2026-10-20T00:00:00Z",
      finishedAt: "2026-10-20T00:01:00Z",
      preview: null,
      rows: [],
      phases: [],
      requests: {
        signIn: 0,
        profileReads: 0,
        scopeInventoryReads: 0,
        coverageReads: 0,
        cacheOptionReads: 0,
        usageReads: 0,
        previewPosts: 0,
        forbidden: 0,
      },
      forbiddenCalls: [],
      usageRead: { count: 1, allowed: true },
    });
    expect(errors).toEqual(expect.arrayContaining(["rows: expected exactly five", "rows: unit membership mismatch"]));
  });
});
