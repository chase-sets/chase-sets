import type { ActionFunctionArgs } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError as CatalogApiError } from "../../shell-support/api/client";
import { syntheticPromotionPreviewResponse } from "../../../features/source-observations/ui/primary-workbench-test-fixtures";

const { createApi, getCatalogScopeRecord } = vi.hoisted(() => ({
  createApi: vi.fn(),
  getCatalogScopeRecord: vi.fn(),
}));

// The real dispatcher and entity handlers run; only the Catalog API is stubbed,
// with the surface reads the promotion descriptor needs composed over the stub.
// Every client reads the Scope Record the action binds its command to.
vi.mock("../../request-support/api-client", async () => {
  const { withCatalogSurfaceReads } = await vi.importActual<
    typeof import("../../../features/source-observations/tests/integrations-surface-read-test-client")
  >("../../../features/source-observations/tests/integrations-surface-read-test-client");
  return {
    createCatalogRequestApiClient: (request: Request) =>
      withCatalogSurfaceReads({ getCatalogScopeRecord, ...createApi(request) }, request),
  };
});

vi.mock("@chase-sets/platform-runtime/auth", () => ({
  resolveActorFromAuthApi: async () => ({ permissions: ["catalog.view", "catalog.manage"] }),
  isTransientAuthResolutionError: () => false,
}));

const { action } = await import("./scope-detail-action");

const SCOPE_ID = "scope_expansion_paldean_fates";
const SCOPE_RECORD = {
  scopeRecordId: SCOPE_ID,
  productDomain: "pokemon",
  scopeKind: "expansion",
  name: "Paldean Fates",
  productLineScopeRecordId: "scope_product_line_pokemon",
  seriesScopeRecordId: "scope_series_scarlet_violet",
  languageEditions: ["en", "ja"],
};
// A compact import scope that names the record's expansion: a selection inside it.
const SELECTION = {
  providerKey: "tcgdex",
  unitKey: "tcgdex:pokemon:card:import",
  importScope: `en:${SCOPE_ID}`,
  profileVersion: "2026.06.04",
};
// Scope-mounted forms post to the Scope's own address, which carries its selection.
const SCOPE_ACTION_URL = `https://admin.example/catalog/scopes/${SCOPE_ID}?${new URLSearchParams(SELECTION)}`;
const SYNC_FIELDS = {
  productDomain: "pokemon",
  productForm: "single-card",
  languageCode: "en",
  referenceKind: "expansion",
  scopeRecordId: SCOPE_ID,
  selectedUnitKeys: SELECTION.unitKey,
};

// Records that name no expansion, and an import scope from another Scope that
// would fill one.
const PRODUCT_LINE_ID = "scope_product_line_synthetic";
const NO_EXPANSION_RECORDS = [
  [
    "series",
    {
      scopeRecordId: "scope_series_synthetic",
      scopeKind: "series",
      name: "Synthetic Series",
      productLineScopeRecordId: PRODUCT_LINE_ID,
      seriesScopeRecordId: null,
    },
  ],
  [
    "product-line",
    {
      scopeRecordId: PRODUCT_LINE_ID,
      scopeKind: "product-line",
      name: "Synthetic Product Line",
      productLineScopeRecordId: null,
      seriesScopeRecordId: null,
    },
  ],
] as const;
const FOREIGN_IMPORT_SCOPE = "en:synthetic-other-series:synthetic-other-expansion";

function runAction(fields: Record<string, string>, query = "") {
  return runScopeAction(SCOPE_ID, `${SCOPE_ACTION_URL}${query}`, fields);
}

function runScopeAction(scopeRecordId: string, url: string, fields: Record<string, string>) {
  return action({
    request: new Request(url, { method: "POST", body: new URLSearchParams(fields) }),
    params: { id: scopeRecordId },
    context: {},
  } as unknown as ActionFunctionArgs);
}

function redirectTarget(response: unknown): URL {
  expect(response).toBeInstanceOf(Response);
  return new URL((response as Response).headers.get("Location") ?? "", "https://admin.example");
}

function asData(response: unknown) {
  expect(response).not.toBeInstanceOf(Response);
  return response as Exclude<Awaited<ReturnType<typeof action>>, Response>;
}

describe("Catalog scope-detail route action", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getCatalogScopeRecord.mockResolvedValue(SCOPE_RECORD);
  });

  it.each([
    ["scope.sync", SYNC_FIELDS, "", { enqueueCatalogSyncRun: async () => ({ syncRunId: "job_sync" }) }, "job_sync"],
    [
      "scope.import",
      {},
      "",
      { enqueueSourceObservationIntegrationJob: async () => ({ jobId: "job_import", status: "queued" }) },
      "job_import",
    ],
    [
      "observation.reapply",
      { selectedObservationIds: "obs_001" },
      "",
      { reapplySourceObservations: async () => ({ jobId: "job_reapply" }) },
      "job_reapply",
    ],
    [
      "observation.replay",
      { selectedObservationIds: "obs_001" },
      "",
      { replaySourceObservations: async () => ({ jobId: "job_replay" }) },
      "job_replay",
    ],
    [
      "observation.reject",
      { selectedObservationIds: "obs_001", reason: "Synthetic duplicate" },
      "",
      { bulkRejectSourceObservations: async () => ({ jobId: "job_reject" }) },
      "job_reject",
    ],
    [
      "observation.defer",
      { selectedObservationIds: "obs_001" },
      "",
      { deferSourceObservations: async () => ({ jobId: "job_defer" }) },
      "job_defer",
    ],
    [
      "job.retry",
      {},
      "&jobId=job_failed",
      { retrySourceObservationIntegrationJob: async () => ({ jobId: "job_failed" }) },
      "job_failed",
    ],
    [
      "job.resume",
      {},
      "&jobId=job_paused",
      { resumeSourceObservationIntegrationJob: async () => ({ jobId: "job_paused" }) },
      "job_paused",
    ],
  ] as const)(
    "lands a queued %s job back on its Scope with feedback and selection",
    async (intent, fields, query, api, jobId) => {
      createApi.mockReturnValue(api);

      const target = redirectTarget(await runAction({ _intent: intent, ...fields }, query));

      expect(target.pathname).toBe(`/catalog/scopes/${SCOPE_ID}`);
      expect(target.searchParams.get("commandIntent")).toBe(intent);
      expect(target.searchParams.get("commandStatus")).toBe("success");
      expect(target.searchParams.get("commandResult")).toBe("job-queued");
      expect(target.searchParams.get("jobId")).toBe(jobId);
      expect(target.searchParams.has("promotionPreviewId")).toBe(false);
      for (const [key, value] of Object.entries(SELECTION)) {
        expect(target.searchParams.get(key), key).toBe(value);
      }
    },
  );

  it("keeps the Scope's feedback on the page as data for every result that queues no job", async () => {
    const dispatchCatalogAliasReviewCommand = vi.fn().mockResolvedValue({});
    const bulkRejectSourceObservations = vi.fn();
    const cancelSourceObservationIntegrationJob = vi.fn().mockResolvedValue({ jobId: "job_running" });
    const enqueueSourceObservationIntegrationJob = vi
      .fn()
      .mockRejectedValue(new CatalogApiError(503, { error: { code: "unavailable" } }));
    createApi.mockReturnValue({
      dispatchCatalogAliasReviewCommand,
      bulkRejectSourceObservations,
      cancelSourceObservationIntegrationJob,
      enqueueSourceObservationIntegrationJob,
    });

    const cases = [
      ["alias.accept", await runAction({ _intent: "alias.accept", aliasHashes: "hash_a" }), "success"],
      [
        "reason-required",
        await runAction({ _intent: "observation.reject", selectedObservationIds: "obs_001" }),
        "error",
      ],
      ["job-cancelled", await runAction({ _intent: "job.cancel" }, "&jobId=job_running"), "success"],
      ["command-failed", await runAction({ _intent: "scope.import" }), "error"],
      ["invalid-intent", await runAction({ _intent: "not-a-real-intent" }), "error"],
    ] as const;

    for (const [label, response, status] of cases) {
      const data = asData(response);
      expect(data, label).not.toHaveProperty("section");
      expect(data.feedback.status, label).toBe(status);
      if (status === "error" || label === "job-cancelled") expect(data.feedback.result).toBe(label);
      expect(data.context.providerKey, label).toBe("tcgdex");
    }
    expect(dispatchCatalogAliasReviewCommand).toHaveBeenCalledTimes(1);
    expect(bulkRejectSourceObservations).not.toHaveBeenCalled();
  });

  it("holds a promotion preview as data and refuses a stale one instead of executing it", async () => {
    const bulkPromoteSourceObservations = vi
      .fn()
      .mockRejectedValue(new CatalogApiError(409, { error: { code: "stale_promotion_preview" } }));
    createApi.mockReturnValue({
      previewBulkPromoteSourceObservationIds: vi.fn().mockResolvedValue(syntheticPromotionPreviewResponse()),
      bulkPromoteSourceObservations,
    });
    const fields = { _intent: "observation.promote", selectedObservationIds: "obs_001" };

    const preview = asData(await runAction({ ...fields, promotionPhase: "preview" }));
    const stale = asData(
      await runAction({
        ...fields,
        promotionPhase: "execute",
        promotionPreviewId: preview.promotionReceipt?.previewId ?? "",
      }),
    );

    expect(preview.feedback.result).toBe("preview-ready");
    expect(preview.promotionReceipt?.previewId).toBeTruthy();
    expect(bulkPromoteSourceObservations).toHaveBeenCalledTimes(1);
    expect(stale.feedback).toMatchObject({ status: "error", result: "preview-required" });
    expect(stale.context.promotionPreviewId).toBeNull();
    for (const data of [preview, stale]) expect(data).not.toHaveProperty("section");
  });

  // The path's Scope Record decides the hierarchy a command runs against. An
  // address or form naming another one is refused here and reaches no API.
  it("refuses conflicting hierarchy in the address or form and runs an in-Scope command on the record", async () => {
    const enqueueSourceObservationIntegrationJob = vi.fn().mockResolvedValue({ jobId: "job_import", status: "queued" });
    createApi.mockReturnValue({ enqueueSourceObservationIntegrationJob });

    for (const [label, fields, query] of [
      ["form expansion", { expansionId: "base1" }, ""],
      ["form set alias", { setId: "base1" }, ""],
      ["form Scope Record", { scopeRecordId: "scope_expansion_base_set" }, ""],
      ["address series", {}, "&seriesId=base"],
      ["address review filter", {}, "&filter.expansionId=base1"],
    ] as const) {
      const refused = asData(await runAction({ _intent: "scope.import", ...fields }, query));
      expect(refused.feedback, label).toMatchObject({
        status: "error",
        intent: "scope.import",
        result: "invalid-intent",
      });
      expect(refused.context.providerKey, label).toBe("tcgdex");
    }
    expect(enqueueSourceObservationIntegrationJob).not.toHaveBeenCalled();

    // The page's own form restates the record's hierarchy, which binds it.
    const target = redirectTarget(
      await runAction({
        _intent: "scope.import",
        seriesId: SCOPE_RECORD.seriesScopeRecordId,
        expansionId: SCOPE_ID,
        expansionName: SCOPE_RECORD.name,
      }),
    );
    expect(target.searchParams.get("jobId")).toBe("job_import");
    expect(enqueueSourceObservationIntegrationJob).toHaveBeenCalledExactlyOnceWith(
      "import",
      expect.objectContaining({
        productLineId: SCOPE_RECORD.productLineScopeRecordId,
        seriesId: SCOPE_RECORD.seriesScopeRecordId,
        setId: SCOPE_ID,
      }),
    );
  });

  it("refuses a command for a Scope Record it cannot read", async () => {
    getCatalogScopeRecord.mockRejectedValue(new CatalogApiError(404, { error: { code: "not_found" } }));
    const enqueueSourceObservationIntegrationJob = vi.fn();
    createApi.mockReturnValue({ enqueueSourceObservationIntegrationJob });

    const refused = asData(await runAction({ _intent: "scope.import" }));

    expect(refused.feedback).toMatchObject({ status: "error", result: "invalid-intent" });
    expect(enqueueSourceObservationIntegrationJob).not.toHaveBeenCalled();
  });

  // An import scope is a selection inside the Scope and keeps the form the page
  // read it in; one that names another expansion yields to the record's own.
  it("keeps a compact in-Scope import scope and replaces an unrelated provider coordinate", async () => {
    const enqueueSourceObservationIntegrationJob = vi.fn().mockResolvedValue({ jobId: "job_import", status: "queued" });
    createApi.mockReturnValue({ enqueueSourceObservationIntegrationJob });

    const compact = redirectTarget(await runAction({ _intent: "scope.import", importScope: SELECTION.importScope }));
    const unrelated = redirectTarget(await runAction({ _intent: "scope.import", importScope: "en:3:base:base1" }));

    expect(compact.searchParams.get("importScope")).toBe(SELECTION.importScope);
    expect(unrelated.searchParams.get("importScope")).toBe(
      `en:${SCOPE_RECORD.productLineScopeRecordId}:${SCOPE_RECORD.seriesScopeRecordId}:${SCOPE_ID}`,
    );
    for (const [, scope] of enqueueSourceObservationIntegrationJob.mock.calls) {
      expect(scope).toMatchObject({ seriesId: SCOPE_RECORD.seriesScopeRecordId, setId: SCOPE_ID });
    }
  });

  // A series or product line names no expansion, so parsing another Scope's
  // import scope would fill one. It reaches no import request, and a sync that
  // submits no reference runs on the path's record.
  it.each(NO_EXPANSION_RECORDS)(
    "keeps a foreign import scope out of a %s Scope's import and syncs the path record",
    async (scopeKind, record) => {
      getCatalogScopeRecord.mockResolvedValue({ ...SCOPE_RECORD, ...record });
      const enqueueSourceObservationIntegrationJob = vi
        .fn()
        .mockResolvedValue({ jobId: "job_import", status: "queued" });
      const enqueueCatalogSyncRun = vi.fn().mockResolvedValue({ syncRunId: "job_sync" });
      createApi.mockReturnValue({ enqueueSourceObservationIntegrationJob, enqueueCatalogSyncRun });
      const path = `https://admin.example/catalog/scopes/${record.scopeRecordId}`;
      const foreignAddress = `${path}?${new URLSearchParams({ ...SELECTION, importScope: FOREIGN_IMPORT_SCOPE })}`;
      const plainAddress = `${path}?${new URLSearchParams({ ...SELECTION, importScope: "" })}`;
      const { scopeRecordId: _submittedReference, ...syncFields } = SYNC_FIELDS;

      const targets = [
        redirectTarget(await runScopeAction(record.scopeRecordId, foreignAddress, { _intent: "scope.import" })),
        redirectTarget(
          await runScopeAction(record.scopeRecordId, plainAddress, {
            _intent: "scope.import",
            importScope: FOREIGN_IMPORT_SCOPE,
          }),
        ),
        redirectTarget(
          await runScopeAction(record.scopeRecordId, foreignAddress, { _intent: "scope.sync", ...syncFields }),
        ),
      ];

      expect(enqueueSourceObservationIntegrationJob).toHaveBeenCalledTimes(2);
      for (const [, scope] of enqueueSourceObservationIntegrationJob.mock.calls) {
        expect(JSON.stringify(scope)).not.toContain("synthetic-other");
        expect(scope).toMatchObject({
          productLineId: PRODUCT_LINE_ID,
          ...(scopeKind === "series" ? { seriesId: record.scopeRecordId } : {}),
        });
      }
      expect(enqueueCatalogSyncRun).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ reference: { kind: scopeKind, scopeRecordId: record.scopeRecordId } }),
      );
      for (const target of targets) {
        expect(target.pathname).toBe(`/catalog/scopes/${record.scopeRecordId}`);
        expect(target.search).not.toContain("synthetic-other");
      }
    },
  );

  // A compact coordinate names a series for TCGdex and an expansion for Scryfall.
  // The command reads the address's import scope with the provider its form
  // submits, so the Scope checks it with that provider: a foreign expansion never
  // reaches a series Scope's import as its set.
  it.each([
    ["tcgdex", "scryfall", "scryfall:mtg:card:import"],
    ["scryfall", "tcgdex", SELECTION.unitKey],
  ] as const)(
    "reads a %s address's compact import scope with the %s provider its form submits",
    async (addressProviderKey, providerKey, unitKey) => {
      const [, record] = NO_EXPANSION_RECORDS[0];
      getCatalogScopeRecord.mockResolvedValue({ ...SCOPE_RECORD, ...record });
      const enqueueSourceObservationIntegrationJob = vi
        .fn()
        .mockResolvedValue({ jobId: "job_import", status: "queued" });
      createApi.mockReturnValue({ enqueueSourceObservationIntegrationJob });
      const address = `https://admin.example/catalog/scopes/${record.scopeRecordId}?${new URLSearchParams({
        ...SELECTION,
        providerKey: addressProviderKey,
        importScope: "en:synthetic-other-expansion",
      })}`;

      const target = redirectTarget(
        await runScopeAction(record.scopeRecordId, address, { _intent: "scope.import", providerKey, unitKey }),
      );

      expect(enqueueSourceObservationIntegrationJob).toHaveBeenCalledTimes(1);
      const [, scope] = enqueueSourceObservationIntegrationJob.mock.calls[0] ?? [];
      expect(scope).toMatchObject({
        provider: providerKey,
        ingestionUnitKey: unitKey,
        productLineId: PRODUCT_LINE_ID,
        seriesId: record.scopeRecordId,
      });
      expect(JSON.stringify(scope)).not.toContain("synthetic-other");
      expect(target.pathname).toBe(`/catalog/scopes/${record.scopeRecordId}`);
      expect(target.searchParams.get("providerKey")).toBe(providerKey);
    },
  );
});
