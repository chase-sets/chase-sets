import { describe, expect, it } from "vitest";

import {
  WholeGameRehearsalRefusal,
  assertPublishPreviewGuard,
  defaultWholeGameBudget,
  parseProviderParticipation,
  parseWholeGameBudget,
  parseWholeGameSettleInput,
  parseWholeGameStartInput,
  planScopePromotion,
  planWholeGameSettle,
  promotedCatalogItems,
  publishFilters,
  readAllCompletedPromoteJobs,
  startConfirmationRefusal,
  validateWholeGameReceipt,
  wholeGameReceiptSchemaVersion,
} from "../deployables/admin-web/e2e/support/whole-game-rehearsal.ts";

// Pure decisions behind the #9220 whole-game staging rehearsal journeys in
// deployables/admin-web/e2e/catalog-staging-provider-sync.uat.spec.ts.

function refusalCode(action) {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(WholeGameRehearsalRefusal);
    return error.code;
  }
  throw new Error("expected a whole-game refusal");
}

const preview = (overrides = {}) => ({
  planFingerprint: "sha256:fixture-plan",
  scopeCount: 3,
  confirmAllowed: true,
  providers: [{ providerKey: "tcgdex", units: 3, plannedRequests: 120 }],
  ...overrides,
});

const batch = (status, units, overrides = {}) => ({
  batchId: "batch-requested",
  status,
  circuitOpenProviders: [],
  units,
  ...overrides,
});
const unit = (scopeRecordId, state) => ({ scopeRecordId, state, providerKeys: ["scrydex"] });
const settleInput = (overrides = {}) => ({
  batchId: "batch-requested",
  retryFailed: false,
  resumeCancelled: false,
  ...overrides,
});

const promoteJob = (jobId, outcomes, overrides = {}) => ({
  jobId,
  kind: "merge-candidate-promote",
  scopeRecordId: "scope-1",
  status: "completed",
  result: { promoted: outcomes.length, outcomes },
  ...overrides,
});

function receipt(overrides = {}) {
  return {
    schemaVersion: wholeGameReceiptSchemaVersion,
    journeyScope: "full-game-settle",
    sha: "a".repeat(40),
    runId: "9220",
    runAttempt: "1",
    batchId: "batch-requested",
    state: "settled",
    preview: null,
    settle: {
      batchStatus: "completed",
      units: { queued: 0, running: 0, completed: 2, failed: 0, cancelled: 0 },
      resumed: false,
      retriedUnits: 0,
      scopesPromoted: 1,
      promoteJobsSubmitted: 1,
      promoteJobsAdopted: 0,
      promotedThisDispatch: 4,
      promotedOutcomes: 4,
      promotedWithoutCatalogItem: 0,
      blueprints: 1,
      publishFilters: 1,
      publishPreviewed: 1,
      published: 4,
      readyRemaining: 0,
      draftsRemaining: 0,
    },
    ...overrides,
  };
}

describe("whole-game rehearsal inputs", () => {
  it("parses start and settle inputs and refuses malformed dispatch values", () => {
    expect(
      parseWholeGameStartInput({
        CATALOG_WHOLE_GAME_PRODUCT_DOMAIN: "one-piece",
        CATALOG_WHOLE_GAME_LANGUAGE_CODE: "ja",
        CATALOG_WHOLE_GAME_BUDGET: "scrydexRequestLimit=40, maxScopesPerTurn=2",
      }),
    ).toEqual({
      productDomain: "one-piece",
      languageCode: "ja",
      budget: { ...defaultWholeGameBudget, scrydexRequestLimit: 40, maxScopesPerTurn: 2 },
    });
    expect(parseWholeGameStartInput({ CATALOG_WHOLE_GAME_PRODUCT_DOMAIN: "pokemon" })).toMatchObject({
      languageCode: null,
      budget: defaultWholeGameBudget,
    });
    expect(refusalCode(() => parseWholeGameStartInput({}))).toBe("product-domain-required");
    expect(refusalCode(() => parseWholeGameBudget("scrydexRequestLimit=-1"))).toBe("budget-invalid");
    expect(refusalCode(() => parseWholeGameBudget("unknownLimit=1"))).toBe("budget-invalid");
    expect(
      parseWholeGameSettleInput({ CATALOG_WHOLE_GAME_BATCH_ID: "batch-1", CATALOG_WHOLE_GAME_RETRY_FAILED: "true" }),
    ).toEqual({ batchId: "batch-1", retryFailed: true, resumeCancelled: false });
    expect(refusalCode(() => parseWholeGameSettleInput({}))).toBe("batch-id-required");
    expect(
      refusalCode(() =>
        parseWholeGameSettleInput({
          CATALOG_WHOLE_GAME_BATCH_ID: "batch-1",
          CATALOG_WHOLE_GAME_RESUME_CANCELLED: "yes",
        }),
      ),
    ).toBe("boolean-input-invalid");
  });
});

describe("AC1 whole-game start confirmation", () => {
  it("reads rendered participation rows and refuses confirmation when Scrydex participates with a zero limit", () => {
    expect(parseProviderParticipation("scrydex", "2 / 40")).toEqual({
      providerKey: "scrydex",
      units: 2,
      plannedRequests: 40,
    });
    expect(parseProviderParticipation("tcgdex", "3 / Unavailable").plannedRequests).toBeNull();
    expect(refusalCode(() => parseProviderParticipation("tcgdex", "three"))).toBe("preview-participation-unreadable");

    const scrydex = { providerKey: "scrydex", units: 2, plannedRequests: 40 };
    expect(startConfirmationRefusal(preview(), defaultWholeGameBudget)).toBeNull();
    expect(startConfirmationRefusal(preview({ providers: [scrydex] }), defaultWholeGameBudget)).toBe(
      "scrydex-credit-limit-zero",
    );
    expect(
      startConfirmationRefusal(preview({ providers: [scrydex] }), {
        ...defaultWholeGameBudget,
        scrydexRequestLimit: 40,
      }),
    ).toBeNull();
    expect(
      startConfirmationRefusal(preview({ providers: [{ ...scrydex, units: 0 }] }), defaultWholeGameBudget),
    ).toBeNull();
    expect(startConfirmationRefusal(preview({ confirmAllowed: false }), defaultWholeGameBudget)).toBe(
      "preview-not-confirmable",
    );
    expect(startConfirmationRefusal(preview({ scopeCount: 0 }), defaultWholeGameBudget)).toBe("preview-empty");
    expect(startConfirmationRefusal(preview({ scopeCount: Number.NaN }), defaultWholeGameBudget)).toBe(
      "preview-scope-count-unreadable",
    );
    expect(startConfirmationRefusal(preview({ planFingerprint: "" }), defaultWholeGameBudget)).toBe(
      "preview-fingerprint-unreadable",
    );
  });
});

describe("AC2 whole-game settle per batch state", () => {
  const completedAndFailed = [unit("scope-1", "completed"), unit("scope-2", "failed")];

  it.each([
    ["queued", {}, settleInput(), { kind: "exit-running", reason: "in-progress" }],
    ["running", {}, settleInput({ retryFailed: true }), { kind: "exit-running", reason: "in-progress" }],
    [
      "running",
      { circuitOpenProviders: ["scrydex"] },
      settleInput({ retryFailed: true }),
      { kind: "retry-failed-units", scopeRecordIds: ["scope-2"] },
    ],
    [
      "running",
      { circuitOpenProviders: ["scrydex"] },
      settleInput(),
      { kind: "promote-and-publish", scopeRecordIds: ["scope-1"], failedUnits: 1 },
    ],
    ["partial", {}, settleInput({ retryFailed: true }), { kind: "retry-failed-units", scopeRecordIds: ["scope-2"] }],
    ["partial", {}, settleInput(), { kind: "promote-and-publish", scopeRecordIds: ["scope-1"], failedUnits: 1 }],
    ["failed", {}, settleInput({ retryFailed: true }), { kind: "retry-failed-units", scopeRecordIds: ["scope-2"] }],
    ["failed", {}, settleInput(), { kind: "promote-and-publish", scopeRecordIds: ["scope-1"], failedUnits: 1 }],
    ["cancelled", {}, settleInput(), { kind: "exit-cancelled" }],
    ["cancelled", {}, settleInput({ resumeCancelled: true }), { kind: "resume" }],
  ])("%s batch %j with %j", (status, overrides, input, expected) => {
    expect(planWholeGameSettle(batch(status, completedAndFailed, overrides), input)).toEqual(expected);
  });

  it("promotes a completed batch even when retry was requested, and never treats running as failure", () => {
    expect(
      planWholeGameSettle(batch("completed", [unit("scope-1", "completed")]), settleInput({ retryFailed: true })),
    ).toEqual({ kind: "promote-and-publish", scopeRecordIds: ["scope-1"], failedUnits: 0 });
    expect(
      planWholeGameSettle(batch("running", [unit("scope-1", "failed")]), settleInput({ retryFailed: true })).kind,
    ).toBe("exit-running");
  });

  it("refuses a snapshot for any batch other than the requested batch_id", () => {
    expect(
      refusalCode(() =>
        planWholeGameSettle(
          batch("completed", [unit("scope-1", "completed")], { batchId: "batch-newer" }),
          settleInput(),
        ),
      ),
    ).toBe("batch-id-mismatch");
  });
});

describe("AC3 idempotent promotion and publication", () => {
  it("adopts a job a killed dispatch left running instead of submitting a second promotion", () => {
    const running = promoteJob("job-killed", [], { status: "running", result: null });
    expect(planScopePromotion("scope-1", [running], 5)).toEqual({ kind: "adopt-active-job", jobIds: ["job-killed"] });
    expect(planScopePromotion("scope-1", [{ ...running, kind: "merge-candidate-defer" }], 5)).toEqual({
      kind: "submit-promote-all-ready",
    });
    expect(planScopePromotion("scope-1", [{ ...running, scopeRecordId: "scope-2" }], 0)).toEqual({
      kind: "none-ready",
    });
  });

  it("follows the completed-job cursor to the last page and fails closed on scope drift or a repeated cursor", async () => {
    const pages = {
      "": { items: [promoteJob("job-3", [{ status: "promoted", catalogItemId: "item-3" }])], cursor: "c1" },
      c1: {
        items: [
          promoteJob("job-2", [{ status: "promoted", catalogItemId: "item-2" }]),
          promoteJob("job-defer", [], { kind: "merge-candidate-defer" }),
        ],
        cursor: "c2",
      },
      c2: { items: [promoteJob("job-1", [{ status: "promoted", catalogItemId: "item-1" }])] },
    };
    const requested = [];
    const jobs = await readAllCompletedPromoteJobs("scope-1", async (cursor) => {
      requested.push(cursor);
      return pages[cursor ?? ""];
    });
    expect(requested).toEqual([null, "c1", "c2"]);
    expect(jobs.map((job) => job.jobId)).toEqual(["job-3", "job-2", "job-1"]);

    await expect(
      readAllCompletedPromoteJobs("scope-1", async () => ({
        items: [promoteJob("job-x", [], { scopeRecordId: "scope-9" })],
      })),
    ).rejects.toMatchObject({ code: "job-scope-mismatch" });
    await expect(
      readAllCompletedPromoteJobs("scope-1", async () => ({ items: [], cursor: "same" })),
    ).rejects.toMatchObject({ code: "job-cursor-repeated" });
  });

  it("collects distinct promoted Catalog Items and counts promoted outcomes it cannot map", () => {
    expect(
      promotedCatalogItems([
        promoteJob("job-1", [
          { status: "promoted", catalogItemId: "item-2" },
          { status: "promoted", catalogItemId: "item-1" },
          { status: "skipped-not-eligible", catalogItemId: null },
        ]),
        promoteJob("job-2", [
          { status: "promoted", catalogItemId: "item-1" },
          { status: "promoted", catalogItemId: null },
        ]),
      ]),
    ).toEqual({ catalogItemIds: ["item-1", "item-2"], promotedOutcomes: 4, promotedWithoutCatalogItem: 1 });
  });

  it("plans one draft filter per blueprint x batch provider source x language", () => {
    expect(
      publishFilters(
        [
          { blueprintId: "bp-2", languageCode: "en" },
          { blueprintId: "bp-1", languageCode: "ja" },
          { blueprintId: "bp-1", languageCode: "ja" },
          { blueprintId: null, languageCode: "en" },
        ],
        ["tcgdex", "scrydex", "tcgdex"],
      ),
    ).toEqual([
      { blueprintId: "bp-1", source: "scrydex", language: "ja", status: "draft" },
      { blueprintId: "bp-1", source: "tcgdex", language: "ja", status: "draft" },
      { blueprintId: "bp-2", source: "scrydex", language: "en", status: "draft" },
      { blueprintId: "bp-2", source: "tcgdex", language: "en", status: "draft" },
    ]);
  });
});

describe("AC4 publish preview guard", () => {
  const filter = { blueprintId: "bp-1", source: "scrydex", language: "en", status: "draft" };
  const previewOf = (count, mutate = () => ({})) => {
    const candidates = Array.from({ length: count }, (_, index) => ({
      catalog_item_id: `item-${index + 1}`,
      blueprint_id: "bp-1",
      source_providers: ["scrydex", "tcgdex"],
      ...mutate(index),
    }));
    return { item_ids: candidates.map((candidate) => candidate.catalog_item_id), total: count, candidates };
  };
  const guard = (value, blueprints = new Set(["bp-1"])) =>
    refusalCode(() => {
      assertPublishPreviewGuard(value, filter, blueprints);
      throw new WholeGameRehearsalRefusal("passed");
    });

  it("reads every candidate beyond the 20 rendered rows", () => {
    expect(guard(previewOf(25))).toBe("passed");
    expect(guard(previewOf(25, (index) => (index === 22 ? { source_providers: ["tcgdex"] } : {})))).toBe(
      "publish-preview-row-23-missing-provider-source",
    );
    expect(guard(previewOf(25, (index) => (index === 21 ? { blueprint_id: "bp-other-game" } : {})))).toBe(
      "publish-preview-row-22-foreign-blueprint",
    );
    expect(guard(previewOf(25), new Set(["bp-other-game"]))).toBe("publish-preview-row-1-foreign-blueprint");
  });

  it("refuses a preview response that is not complete", () => {
    expect(guard({ ...previewOf(25), total: 40 })).toBe("publish-preview-incomplete");
    expect(guard({ ...previewOf(25), item_ids: previewOf(24).item_ids })).toBe("publish-preview-incomplete");
  });
});

describe("AC5 support-safe receipt schema", () => {
  it("accepts complete start and settle receipts", () => {
    expect(validateWholeGameReceipt(receipt())).toEqual([]);
    expect(
      validateWholeGameReceipt(
        receipt({
          journeyScope: "full-game-start",
          state: "confirmed",
          settle: null,
          preview: {
            planFingerprint: "sha256:fixture-plan",
            scopeCount: 3,
            providers: [{ providerKey: "scrydex", units: 2, plannedRequests: null }],
          },
        }),
      ),
    ).toEqual([]);
  });

  it("rejects unsafe text, unknown fields and a settled claim with remaining work", () => {
    expect(validateWholeGameReceipt(receipt({ batchId: "https://admin.example/batch" }))).toEqual(
      expect.arrayContaining(["batchId", "support-unsafe-text"]),
    );
    expect(validateWholeGameReceipt({ ...receipt(), rawPayload: {} })).toContain("receipt.keys");
    expect(validateWholeGameReceipt(receipt({ settle: { ...receipt().settle, title: "Card" } }))).toContain(
      "settle.keys",
    );
    expect(validateWholeGameReceipt(receipt({ settle: { ...receipt().settle, draftsRemaining: 2 } }))).toContain(
      "settled-with-remaining-work",
    );
    expect(
      validateWholeGameReceipt(receipt({ settle: { ...receipt().settle, promotedWithoutCatalogItem: 1 } })),
    ).toContain("settled-with-remaining-work");
    expect(validateWholeGameReceipt(receipt({ sha: "main" }))).toContain("sha");
    expect(validateWholeGameReceipt(receipt({ state: "refused" }))).toContain("state");
  });
});
