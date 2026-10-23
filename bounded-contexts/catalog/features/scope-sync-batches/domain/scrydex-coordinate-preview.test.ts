import { describe, expect, it } from "vitest";
import {
  buildScrydexCoordinatePreviewReceipt,
  classifyScrydexCoordinatePreviewRequest,
  deriveScrydexCoordinatePreviewReasons,
  scrydexCoordinatePreviewUnits,
  type ScrydexCoordinatePreviewReceipt,
  validateScrydexCoordinatePreviewReceipt,
} from "./scrydex-coordinate-preview";

const origin = "https://admin.staging.chasesets.com";

function validReceipt(): ScrydexCoordinatePreviewReceipt {
  const sha = "a".repeat(40);
  const fingerprint = "b".repeat(64);
  const generation = {
    runId: "900",
    runAttempt: 1,
    jobId: "901",
    jobCompletedAt: "2026-10-20T15:00:00Z",
    deployedHead: sha,
    imageDigest: `sha256:${"c".repeat(64)}`,
  };
  const startedAt = "2026-10-20T16:00:00Z";
  const finishedAt = "2026-10-20T16:01:00Z";
  const scopes = ["scope-one", "scope-two"];
  const rows = scrydexCoordinatePreviewUnits.map((unit, index) => {
    const scopeRecordId = index < 3 ? scopes[0] : scopes[1];
    const setId = `SET-${index}`;
    return {
      scopeRecordId,
      productDomain: unit.productDomain,
      previewFingerprint: fingerprint,
      resolvedAt: "2026-10-20T16:00:30Z",
      previewRevision: "scope-sync-batch-preview-v1",
      unitKey: unit.unitKey,
      mapping: {
        mappingId: `mapping-${index}`,
        unitKey: unit.unitKey,
        version: "2026-10-19T00:00:00Z",
        reviewStatus: "accepted" as const,
        setId,
        setName: `Set ${index}`,
        coordinate: setId,
        membership: "member" as const,
      },
      profileKey: `profile-${index}`,
      profileVersion: "profile-v1",
      setId,
      setName: `Set ${index}`,
      cacheKey: `sha256:${String(index + 1).padStart(64, "0")}`,
      cacheFetchedAt: "2026-10-20T15:00:00Z",
      cacheExpiresAt: "2026-10-20T15:30:00Z",
      cacheStaleUntil: "2026-10-20T17:00:00Z",
    };
  });
  const samples = scopes.map((scopeRecordId) => ({
    scopeRecordId,
    mappingVersions: rows
      .filter((row) => row.scopeRecordId === scopeRecordId)
      .map((row) => ({
        mappingId: row.mapping.mappingId,
        version: row.mapping.version,
        reviewStatus: row.mapping.reviewStatus,
      })),
    profileVersions: rows
      .filter((row) => row.scopeRecordId === scopeRecordId)
      .map((row) => ({
        providerKey: "scrydex",
        unitKey: row.unitKey,
        profileKey: row.profileKey,
        profileVersion: row.profileVersion,
      })),
  }));
  return {
    schemaVersion: "scrydex-coordinate-preview/v1" as const,
    outcome: "complete" as const,
    reasons: [],
    runner: {
      sha,
      runId: "123",
      runAttempt: "1",
      journeyScope: "scrydex-coordinate-preview" as const,
      origin: "admin.staging.chasesets.com" as const,
    },
    deployment: { before: generation, after: { ...generation } },
    startedAt,
    finishedAt,
    preview: {
      fingerprint,
      resolvedAt: "2026-10-20T16:00:30Z",
      revision: "scope-sync-batch-preview-v1",
      status: "ready" as const,
      confirmAllowed: true,
      blockers: [],
      samples,
    },
    rows,
    phases: [
      "deployment-before",
      "sign-in",
      "readiness",
      "coverage",
      "cache",
      "preview",
      "coverage",
      "cache",
      "pre-confirm",
    ],
    requests: {
      signIn: 1,
      profileReads: 1,
      scopeInventoryReads: 2,
      coverageReads: 2,
      cacheOptionReads: 5,
      usageReads: 1,
      previewPosts: 1,
      forbidden: 0,
    },
    forbiddenCalls: [],
    usageRead: { count: 1, allowed: true },
  };
}
type CandidateReceipt = ScrydexCoordinatePreviewReceipt;

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
    expect(errors).toEqual(expect.arrayContaining(["reasons: missing rows-not-exactly-five", "reasons: missing rows-unit-membership"]));
  });

  it("accepts a complete five-row receipt and derives no refusal", () => {
    const receipt = buildScrydexCoordinatePreviewReceipt(validReceipt());
    expect(receipt.outcome).toBe("complete");
    expect(deriveScrydexCoordinatePreviewReasons(receipt)).toEqual([]);
    expect(validateScrydexCoordinatePreviewReceipt(receipt)).toEqual([]);
  });

  it.each([
    ["deployment-head-mismatch", (r: CandidateReceipt) => { r.deployment.before!.deployedHead = "d".repeat(40); }],
    ["deployment-generation-changed", (r: CandidateReceipt) => { r.deployment.after!.jobId = "902"; }],
    ["preview-not-confirmable", (r: CandidateReceipt) => { r.preview!.confirmAllowed = false; r.preview!.blockers = []; }],
    ["scrydex-scope-planning-blocked", (r: CandidateReceipt) => { r.preview!.blockers = [{ code: "scope-planning-blocked", scopeRecordId: "scope-one", providerKey: "scrydex" }]; }],
    ["preview-post-count", (r: CandidateReceipt) => { r.requests.previewPosts = 0; }],
    ["phases-incomplete", (r: CandidateReceipt) => { r.phases = []; }],
    ["cache-stale:scrydex:one-piece:set:reference-data", (r: CandidateReceipt) => { r.rows[0].cacheStaleUntil = "2026-10-20T16:00:30Z"; }],
    ["cache-fetched-after-preview:scrydex:one-piece:set:reference-data", (r: CandidateReceipt) => { r.rows[0].cacheFetchedAt = "2026-10-20T16:00:31Z"; }],
    ["mapping-sample-missing:scrydex:one-piece:set:reference-data", (r: CandidateReceipt) => { r.preview!.samples[0].mappingVersions = []; }],
    ["profile-sample-missing:scrydex:one-piece:set:reference-data", (r: CandidateReceipt) => { r.preview!.samples[0].profileVersions = []; }],
    ["preview-join-mismatch", (r: CandidateReceipt) => { r.rows[0].previewFingerprint = "e".repeat(64); }],
  ])("rejects one-variable mutant %s", (reason, mutate) => {
    const candidate = validReceipt();
    mutate(candidate);
    candidate.outcome = "complete";
    candidate.reasons = [];
    const built = buildScrydexCoordinatePreviewReceipt(candidate);
    expect(built.outcome).toBe("governed-unknown");
    expect(built.reasons).toContain(reason);
    expect(validateScrydexCoordinatePreviewReceipt({ ...built, outcome: "complete", reasons: [] })).toContain(
      "outcome: not derived from evidence",
    );
  });

  it("accepts non-coordinate blockers while preserving them", () => {
    const candidate = validReceipt();
    candidate.preview!.blockers = [{ code: "credited-provider-estimate-unavailable", scopeRecordId: null, providerKey: "scrydex" }];
    candidate.preview!.status = "blocked";
    candidate.preview!.confirmAllowed = false;
    const built = buildScrydexCoordinatePreviewReceipt(candidate);
    expect(built.outcome).toBe("complete");
    expect(built.preview?.blockers[0].code).toBe("credited-provider-estimate-unavailable");
  });

  it("rejects malformed bounded fields and relabelled diagnostics", () => {
    const tooLarge = validReceipt();
    tooLarge.preview!.samples[0].mappingVersions[0].reviewStatus = "x".repeat(301);
    expect(validateScrydexCoordinatePreviewReceipt(tooLarge)).toEqual(expect.arrayContaining(["preview.samples.0.mappingVersions.0.reviewStatus: too_big"]));
    const diagnostic = buildScrydexCoordinatePreviewReceipt(validReceipt());
    diagnostic.reasons = ["forbidden-call"];
    diagnostic.outcome = "complete";
    expect(validateScrydexCoordinatePreviewReceipt(diagnostic)).toContain("outcome: not derived from evidence");
  });
});
