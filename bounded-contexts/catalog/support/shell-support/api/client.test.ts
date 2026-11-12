import { describe, expect, it, vi } from "vitest";
import { ApiError, CatalogItemPublicationApiError, createCatalogApiClient } from "./client";

// Issue #11130: only the location, not a web-authored preview scope, crosses the read boundary.
it("forwards the selected import preview location and request transport unchanged", async () => {
  const answer = { status: "unavailable" };
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(answer));
  const client = createCatalogApiClient({
    baseUrl: "/api/catalog/",
    fetch,
    headers: { "x-test": "synthetic" },
    credentials: "same-origin",
  });
  const location = "/catalog/integrations?productId=synthetic+A&languageCode=en";
  await expect(client.getCatalogPrimaryWorkbenchDeferredImportPreview(location)).resolves.toEqual(answer);
  expect(fetch).toHaveBeenCalledExactlyOnceWith(
    `/api/catalog/source-observations/workbench-surfaces/daily/import-preview?${new URLSearchParams({ location })}`,
    { method: "GET", headers: { "x-test": "synthetic" }, credentials: "same-origin" },
  );
});

describe("provider profile lifecycle confirmation serialization", () => {
  it.each([
    ["rollback", "rollbackSourceObservationProviderProfile"],
    ["deprecate", "deprecateSourceObservationProviderProfile"],
    ["retire", "retireSourceObservationProviderProfile"],
  ] as const)("forwards caller input unchanged for %s", async (operation, method) => {
    const result = { providerKey: "synthetic provider", profileVersion: "synthetic/version" };
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => Response.json(result));
    const client = createCatalogApiClient({
      baseUrl: "/api/catalog/",
      fetch,
      headers: { "x-test": "synthetic" },
      credentials: "same-origin",
    });
    for (const lifecycleConfirmation of [
      null,
      "",
      " mismatched caller input ",
      `confirm:provider-profile.${operation}:synthetic provider:synthetic/version`,
    ]) {
      await expect(client[method](result.providerKey, result.profileVersion, lifecycleConfirmation)).resolves.toEqual(
        result,
      );
      expect(fetch).toHaveBeenLastCalledWith(
        `/api/catalog/source-observations/provider-profiles/synthetic%20provider/synthetic%2Fversion/${operation}`,
        {
          method: "POST",
          headers: { "x-test": "synthetic", "content-type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ lifecycleConfirmation }),
        },
      );
    }
  });
});

describe("catalog API durable job client", () => {
  it("C1: posts bulk removal preview selection and parses the response", async () => {
    const selection = { mode: "ids", ids: ["cat_1", "cat_2"] };
    const result = { item_ids: selection.ids, ready_count: 1, blocked_count: 1, total: 2, candidates: [] };
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(result));
    const client = createCatalogApiClient({ baseUrl: "/api/catalog", fetch });
    expect(await client.previewBulkRemoveDrafts(selection)).toEqual(result);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0]![0])).toBe("/api/catalog/items/bulk-remove-drafts/preview");
    expect(fetch.mock.calls[0]![1]).toMatchObject({ method: "POST", body: JSON.stringify({ selection }) });
  });

  it("C2: confirms one removal job, streams progress and reconnects to its retained result", async () => {
    const selection = { mode: "filter", query: { language: "en" } };
    const result = {
      item_ids: ["cat_1", "cat_2"],
      total: 2,
      succeeded_count: 1,
      skipped_count: 1,
      failed_count: 0,
      candidates: [{ catalog_item_id: "cat_2", outcome: "skipped", reason: "Only draft items can be removed." }],
    };
    const snapshot = (status: "queued" | "running" | "completed") => ({
      jobId: "job_removal",
      kind: "catalog.authoring.items.remove-drafts",
      status,
      progress: { phase: status, completed: status === "completed" ? 2 : 0, total: 2, currentName: null, status: null },
      result: status === "completed" ? result : null,
      errorMessage: null,
    });
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json(snapshot("queued"), { status: 202 }))
      .mockResolvedValueOnce(sseResponse(`id: 7\nevent: status\ndata: ${JSON.stringify(snapshot("running"))}\n\n`))
      .mockResolvedValueOnce(sseResponse(`id: 8\nevent: status\ndata: ${JSON.stringify(snapshot("completed"))}\n\n`));
    const progress = vi.fn();
    const client = createCatalogApiClient({ baseUrl: "/api/catalog", fetch });
    expect(await client.confirmBulkRemoveDrafts(selection, { onProgress: progress })).toEqual(result);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(String(fetch.mock.calls[0]![0])).toBe("/api/catalog/items/bulk-remove-drafts/confirm");
    expect(fetch.mock.calls[0]![1]).toMatchObject({ method: "POST", body: JSON.stringify({ selection }) });
    expect(fetch.mock.calls.slice(1).map(([url]) => String(url))).toEqual([
      "/api/catalog/bulk-authoring-jobs/job_removal/events",
      "/api/catalog/bulk-authoring-jobs/job_removal/events",
    ]);
    expect(fetch.mock.calls[2]![1]?.headers).toMatchObject({ "last-event-id": "7" });
    expect(progress.mock.calls.map(([value]) => value.phase)).toEqual(["queued", "running", "completed"]);
  });

  it.each(["merge-candidate-promote", "merge-candidate-defer"] as const)(
    "posts %s with the scope, headers and configured credentials",
    async (kind) => {
      const response = { jobId: "job_synthetic", status: "queued" };
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(response, { status: 202 }));
      const client = createCatalogApiClient({
        baseUrl: "https://catalog.test/api/catalog/",
        fetch,
        headers: { "x-test": "synthetic" },
        credentials: "same-origin",
      });
      await expect(
        client.enqueueCatalogMergeCandidateBulkJob(kind, "scope / synthetic", "Review later."),
      ).resolves.toEqual(response);
      expect(fetch).toHaveBeenCalledWith(
        "https://catalog.test/api/catalog/source-observations/merge-candidate-bulk-jobs",
        {
          method: "POST",
          headers: { "content-type": "application/json", "x-test": "synthetic" },
          credentials: "same-origin",
          body: JSON.stringify({ kind, scopeRecordId: "scope / synthetic", reason: "Review later." }),
        },
      );
    },
  );

  it("retains active observation compatibility and encodes active/completed candidate filters", async () => {
    const page = { items: [{ jobId: "job_synthetic" }], cursor: "next_synthetic" };
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => Response.json(page));
    const client = createCatalogApiClient({ baseUrl: "/api/catalog/", fetch, headers: { "x-test": "synthetic" } });
    await expect(client.listActiveSourceObservationBulkJobs()).resolves.toEqual(page);
    await expect(
      client.listCatalogMergeCandidateBulkJobs({ scopeRecordId: "scope / synthetic", status: "active" }),
    ).resolves.toEqual(page);
    await expect(
      client.listCatalogMergeCandidateBulkJobs({
        scopeRecordId: "scope / synthetic",
        status: "completed",
        cursor: "cursor+/= &?",
      }),
    ).resolves.toEqual(page);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      "/api/catalog/source-observations/bulk-jobs/active",
      "/api/catalog/source-observations/bulk-jobs/active?scopeRecordId=scope+%2F+synthetic",
      "/api/catalog/source-observations/bulk-jobs/active?scopeRecordId=scope+%2F+synthetic&status=completed&cursor=cursor%2B%2F%3D+%26%3F",
    ]);
    for (const [, init] of fetch.mock.calls) {
      expect(init).toEqual({ method: "GET", headers: { "x-test": "synthetic" }, credentials: "include" });
    }
  });

  it("reads failed candidate jobs from a separate scope-filtered surface", async () => {
    const page = { items: [{ jobId: "job_failed", status: "failed", errorMessage: "Missing units." }], count: 1 };
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(page));
    const client = createCatalogApiClient({ baseUrl: "/api/catalog", fetch });
    await expect(client.listFailedCatalogMergeCandidateBulkJobs("scope / synthetic")).resolves.toEqual(page);
    expect(fetch).toHaveBeenCalledWith(
      "/api/catalog/source-observations/merge-candidate-bulk-jobs/failed?scopeRecordId=scope+%2F+synthetic",
      {
        method: "GET",
        headers: {},
        credentials: "include",
      },
    );
  });

  it.each(["promote", "defer", "active", "completed", "failed"] as const)(
    "preserves API errors for candidate %s requests",
    async (operation) => {
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(Response.json({ error: "Synthetic rejection." }, { status: 400 }));
      const client = createCatalogApiClient({ baseUrl: "/api/catalog", fetch });
      const request =
        operation === "promote" || operation === "defer"
          ? client.enqueueCatalogMergeCandidateBulkJob(
              operation === "promote" ? "merge-candidate-promote" : "merge-candidate-defer",
              "scope_synthetic",
              null,
            )
          : operation === "failed"
            ? client.listFailedCatalogMergeCandidateBulkJobs("scope_synthetic")
            : client.listCatalogMergeCandidateBulkJobs({
                scopeRecordId: "scope_synthetic",
                status: operation,
                ...(operation === "completed" ? { cursor: "synthetic_cursor" } : {}),
              });
      await expect(request).rejects.toMatchObject({ status: 400, message: "Synthetic rejection." });
    },
  );

  it("preserves nested API error messages", () => {
    const error = new ApiError(400, {
      error: {
        code: "invalid_product_contents",
        message: "Required selected option is missing.",
      },
    });

    expect(error.message).toBe("Required selected option is missing.");
  });

  it("preserves string API error messages", () => {
    const error = new ApiError(400, { error: "Required selected option is missing." });

    expect(error.message).toBe("Required selected option is missing.");
  });

  it("parses only the closed publication-readiness error shape", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            code: "display-identity-outdated",
            message: "Display identity is outdated. Recheck and retry publication.",
            readiness: "outdated",
            missingTokens: [],
          },
        }),
        { status: 409, headers: { "content-type": "application/json" } },
      ),
    );
    const client = createCatalogApiClient({ baseUrl: "http://catalog.test/api/catalog", fetch });

    const error = await client.publishCatalogItem("cat_1").catch((caught) => caught);

    expect(error).toBeInstanceOf(CatalogItemPublicationApiError);
    expect(error).toMatchObject({
      code: "display-identity-outdated",
      readiness: "outdated",
      missingTokens: [],
    });
  });

  it("parses publication-precondition refusals with missing field IDs", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            code: "publication-precondition",
            reason_code: "publication-precondition",
            message: "Missing required field values: fld_name, fld_set.",
            missingFieldIds: ["fld_name", "fld_set"],
          },
        }),
        { status: 409, headers: { "content-type": "application/json" } },
      ),
    );
    const client = createCatalogApiClient({ baseUrl: "http://catalog.test/api/catalog", fetch });

    const error = await client.publishCatalogItem("cat_1").catch((caught) => caught);

    expect(error).toBeInstanceOf(CatalogItemPublicationApiError);
    expect(error).toMatchObject({
      code: "publication-precondition",
      readiness: "precondition",
      missingFieldIds: ["fld_name", "fld_set"],
      message: "Missing required field values: fld_name, fld_set.",
    });
  });

  it("reconnects job event streams with the last durable event id", async () => {
    const completedResult = {
      requested: 1,
      imported: 1,
      observed: 204,
      reapplied: 0,
      skipped: 0,
      failed: 0,
      outcomes: [],
    };
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        sseResponse(
          `id: 1
event: status
data: ${JSON.stringify(jobSnapshot({ status: "running", result: null }))}

`,
        ),
      )
      .mockResolvedValueOnce(
        sseResponse(
          `id: 2
event: status
data: ${JSON.stringify(jobSnapshot({ status: "completed", result: completedResult }))}

`,
        ),
      );
    const progress = vi.fn();
    const client = createCatalogApiClient({ baseUrl: "/api/catalog", fetch });

    await expect(
      client.watchSourceObservationIntegrationJob("job_1", {
        onProgress: progress,
      }),
    ).resolves.toEqual(completedResult);

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1][1]?.headers).toMatchObject({
      "last-event-id": "1",
    });
    expect(progress).toHaveBeenCalledTimes(2);
  });

  it("uses sync.required snapshots as durable job correction when replay falls behind", async () => {
    const completedResult = {
      requested: 1,
      imported: 1,
      observed: 204,
      reapplied: 0,
      skipped: 0,
      failed: 0,
      outcomes: [],
    };
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(
      sseResponse(
        `id: 3
event: sync.required
data: ${JSON.stringify({ kind: "sync.required", snapshot: jobSnapshot({ status: "completed", result: completedResult }) })}

`,
      ),
    );
    const progress = vi.fn();
    const client = createCatalogApiClient({ baseUrl: "/api/catalog", fetch });

    await expect(
      client.watchSourceObservationIntegrationJob("job_1", {
        onProgress: progress,
      }),
    ).resolves.toEqual(completedResult);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(progress).toHaveBeenCalledWith(expect.objectContaining({ phase: "completed" }));
  });

  it("posts original-profile replay mode for selected Source Observations", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(jsonResponse({ jobId: "job_replay" }));
    const client = createCatalogApiClient({ baseUrl: "/api/catalog", fetch });

    await expect(client.replaySourceObservations<{ jobId: string }>(["obs_1", "obs_2"])).resolves.toEqual({
      jobId: "job_replay",
    });

    expect(String(fetch.mock.calls[0][0])).toBe("/api/catalog/source-observations/reapply");
    expect(fetch.mock.calls[0][1]?.body).toBe(
      JSON.stringify({
        observationIds: ["obs_1", "obs_2"],
        reapplyProfileMode: "original-source-profile",
      }),
    );
  });

  it("sends each count-capture step with the explicit marker, and only those steps", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => jsonResponse({ ok: true }));
    const client = createCatalogApiClient({
      baseUrl: "/api/catalog",
      fetch,
      headers: { origin: "https://admin.example" },
    });
    const input = { scopeRecordId: "scope-synthetic-op01", authority: { dispatchId: "synthetic-dispatch" } };
    await client.captureScopeSyncCountBaseline(input);
    await client.captureScopeSyncCountInitialNotice();
    await client.captureScopeSyncCountUsage();
    await client.quoteScopeSyncCounts({ selection: { mode: "ids", scopeRecordIds: ["scope-synthetic-op01"] } });
    const sent = fetch.mock.calls.map(([url, init]) => ({
      url: String(url),
      method: init?.method,
      body: init?.body,
      marker: new Headers(init?.headers).get("x-catalog-count-capture"),
      origin: new Headers(init?.headers).get("origin"),
    }));
    expect(sent).toEqual([
      {
        url: "/api/catalog/scope-sync-batches/count-capture/baseline",
        method: "POST",
        body: JSON.stringify(input),
        marker: "1",
        origin: "https://admin.example",
      },
      {
        url: "/api/catalog/scope-sync-batches/count-capture/initial-notice",
        method: "POST",
        body: "{}",
        marker: "1",
        origin: "https://admin.example",
      },
      {
        url: "/api/catalog/scope-sync-batches/count-capture/usage",
        method: "POST",
        body: "{}",
        marker: "1",
        origin: "https://admin.example",
      },
      {
        url: "/api/catalog/scope-sync-batches/counts/quote",
        method: "POST",
        body: JSON.stringify({ selection: { mode: "ids", scopeRecordIds: ["scope-synthetic-op01"] } }),
        marker: null,
        origin: "https://admin.example",
      },
    ]);
  });
  it("marks every capture spend/read/seal/complete call without marking ordinary preview or confirm", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => jsonResponse({ retained: true }));
    const client = createCatalogApiClient({
      baseUrl: "/api/catalog",
      fetch,
      headers: { origin: "https://admin.staging.chasesets.com" },
    });
    const planner = {
      selection: { mode: "ids" as const, scopeRecordIds: ["scope-synthetic-op01"] },
      budget: { creditedProviderRequestLimits: { scrydex: 10 } },
    };
    const acquisition = { quoteId: "00000000-0000-4000-8000-000000000001", fingerprint: "a".repeat(64) };
    const preConfirm = { ...planner, planFingerprint: "b".repeat(64) };
    const freeze = { dispatchId: "synthetic-dispatch", runnerRunId: "300", runnerRunAttempt: 1 };
    const complete = {
      ...freeze,
      runId: "00000000-0000-4000-8000-0000000000aa",
      collection: {
        collectedAt: "2026-10-13T08:06:00.000Z",
        outcome: "unknown" as const,
        reason: "inventory-truncated" as const,
        binding: null,
        createdFrom: "2026-09-08T07:40:00.000Z",
        runCount: 0,
        attemptCount: 0,
        jobCount: 0,
        pageCount: 1,
        definitionCount: 0,
        nonMutatingJobCount: 0,
      },
    };
    await client.quoteScopeSyncCaptureCounts(planner);
    await client.readBackScopeSyncCaptureQuote();
    await client.recordScopeSyncCaptureFinalNotice();
    await client.acquireScopeSyncCaptureCounts(acquisition);
    await client.previewScopeSyncCountCapture(planner);
    await client.preConfirmScopeSyncCountCapture(preConfirm);
    await client.freezeScopeSyncCountCapture(freeze);
    await client.completeScopeSyncCountCapture(complete);
    await client.previewScopeSyncBatch(planner);
    await client.confirmScopeSyncBatch(preConfirm);
    expect(
      fetch.mock.calls.map(([url, init]) => ({
        path: String(url).replace("/api/catalog/scope-sync-batches", ""),
        marker: new Headers(init?.headers).get("x-catalog-count-capture"),
        body: JSON.parse(String(init?.body)),
      })),
    ).toEqual([
      { path: "/counts/quote", marker: "1", body: planner },
      { path: "/count-capture/quote-readback", marker: "1", body: {} },
      { path: "/count-capture/final-notice", marker: "1", body: {} },
      { path: "/counts/acquire", marker: "1", body: acquisition },
      { path: "/preview", marker: "1", body: planner },
      { path: "/count-capture/pre-confirm", marker: "1", body: preConfirm },
      { path: "/count-capture/freeze", marker: "1", body: freeze },
      { path: "/count-capture/complete", marker: "1", body: complete },
      { path: "/preview", marker: null, body: planner },
      { path: "/confirm", marker: null, body: preConfirm },
    ]);
  });
  it("previews source observation integration imports without enqueueing a job", async () => {
    const preview = {
      action: "import",
      providerKey: "scrydex",
      targetCount: 1,
      targets: [],
    };
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(jsonResponse(preview));
    const client = createCatalogApiClient({ baseUrl: "/api/catalog", fetch });

    await expect(
      client.previewSourceObservationIntegrationImport<typeof preview>({
        provider: "scrydex",
        ingestionUnitKey: "scrydex:one-piece:single-card:source-observation-import",
        language: "en",
        setId: "op-01",
      }),
    ).resolves.toEqual(preview);

    expect(String(fetch.mock.calls[0][0])).toBe("/api/catalog/source-observations/integration-jobs/preview");
    expect(fetch.mock.calls[0][1]?.body).toBe(
      JSON.stringify({
        action: "import",
        scope: {
          provider: "scrydex",
          ingestionUnitKey: "scrydex:one-piece:single-card:source-observation-import",
          language: "en",
          setId: "op-01",
        },
      }),
    );
  });

  it("posts bulk deferral decisions with the shared operator reason", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(jsonResponse({ jobId: "job_defer" }));
    const client = createCatalogApiClient({ baseUrl: "/api/catalog", fetch });

    await expect(
      client.deferSourceObservations<{ jobId: string }>(["obs_1"], "Needs better provider evidence."),
    ).resolves.toEqual({ jobId: "job_defer" });

    expect(String(fetch.mock.calls[0][0])).toBe("/api/catalog/source-observations/bulk-defer/jobs");
    expect(fetch.mock.calls[0][1]?.body).toBe(
      JSON.stringify({
        observationIds: ["obs_1"],
        reason: "Needs better provider evidence.",
      }),
    );
  });

  it("posts merge candidate review actions with safe ignore wording", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(jsonResponse({ action: "ignore" }));
    const client = createCatalogApiClient({ baseUrl: "/api/catalog", fetch });

    await expect(
      client.ignoreCatalogMergeCandidate<{ action: string }>("cand_1", {
        reason: "Provider grouping is not a Catalog Item.",
        conflictResolutions: [
          {
            conflictCode: "provider-disagreement",
            fieldPath: null,
            chosenValue: "ignore",
            reason: "Unsafe grouping.",
            observationIds: ["obs_1"],
          },
        ],
      }),
    ).resolves.toEqual({ action: "ignore" });

    expect(String(fetch.mock.calls[0][0])).toBe(
      "/api/catalog/source-observations/admin/merge-candidates/cand_1/ignore",
    );
    expect(fetch.mock.calls[0][1]?.body).toBe(
      JSON.stringify({
        reason: "Provider grouping is not a Catalog Item.",
        conflictResolutions: [
          {
            conflictCode: "provider-disagreement",
            fieldPath: null,
            chosenValue: "ignore",
            reason: "Unsafe grouping.",
            observationIds: ["obs_1"],
          },
        ],
      }),
    );
  });

  it("streams scoped replay jobs with original source profile mode", async () => {
    const completedResult = {
      requested: 1,
      imported: 0,
      observed: 0,
      reapplied: 1,
      skipped: 0,
      failed: 0,
      outcomes: [],
    };
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(jsonResponse(jobSnapshot({ status: "queued", result: null })))
      .mockResolvedValueOnce(
        sseResponse(
          `id: 1
event: status
data: ${JSON.stringify(jobSnapshot({ status: "completed", result: completedResult }))}

`,
        ),
      );
    const progress = vi.fn();
    const client = createCatalogApiClient({ baseUrl: "/api/catalog", fetch });

    await expect(
      client.replaySourceObservationsByScope<typeof completedResult>(
        { provider: "tcgdex", language: "en", setId: "base1" },
        { onProgress: progress },
      ),
    ).resolves.toEqual(completedResult);

    expect(String(fetch.mock.calls[0][0])).toBe("/api/catalog/source-observations/integration-jobs");
    expect(fetch.mock.calls[0][1]?.body).toBe(
      JSON.stringify({
        action: "reapply",
        scope: { provider: "tcgdex", language: "en", setId: "base1" },
        reapplyProfileMode: "original-source-profile",
      }),
    );
    expect(progress).toHaveBeenCalled();
  });

  it("updates source observation provider profile sections through the typed admin route", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(
      new Response(JSON.stringify({ providerKey: "tcgdex", profileVersion: "2026.06.04" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const client = createCatalogApiClient({ baseUrl: "/api/catalog", fetch });

    await expect(
      client.updateSourceObservationProviderProfileSection("tcgdex", "2026.06.04", "basics", {
        displayName: "TCGdex Admin Candidate",
      }),
    ).resolves.toEqual({ providerKey: "tcgdex", profileVersion: "2026.06.04" });

    expect(String(fetch.mock.calls[0][0])).toBe(
      "/api/catalog/source-observations/provider-profiles/tcgdex/2026.06.04/sections/basics",
    );
    expect(fetch.mock.calls[0][1]?.method).toBe("PATCH");
    expect(fetch.mock.calls[0][1]?.body).toBe(
      JSON.stringify({
        command: {
          displayName: "TCGdex Admin Candidate",
        },
      }),
    );
  });

  it("loads source observation provider profile authoring models through the typed admin route", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(
      new Response(JSON.stringify({ review: { providerKey: "tcgdex", profileVersion: "2026.06.04" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const client = createCatalogApiClient({ baseUrl: "/api/catalog", fetch });

    await expect(client.getSourceObservationProviderProfileAuthoringModel("tcgdex", "2026.06.04")).resolves.toEqual({
      review: { providerKey: "tcgdex", profileVersion: "2026.06.04" },
    });

    expect(String(fetch.mock.calls[0][0])).toBe(
      "/api/catalog/source-observations/provider-profiles/tcgdex/2026.06.04/authoring",
    );
    expect(fetch.mock.calls[0][1]?.method).toBe("GET");
  });

  it("loads source observation provider profile lifecycle impact summaries through the typed admin route", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(
      new Response(JSON.stringify({ operation: "retire", allowed: false }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const client = createCatalogApiClient({ baseUrl: "/api/catalog", fetch });

    await expect(
      client.getSourceObservationProviderProfileLifecycleImpact("tcgdex", "2026.06.04", "retire"),
    ).resolves.toEqual({
      operation: "retire",
      allowed: false,
    });

    expect(String(fetch.mock.calls[0][0])).toBe(
      "/api/catalog/source-observations/provider-profiles/tcgdex/2026.06.04/lifecycle-impact?operation=retire",
    );
    expect(fetch.mock.calls[0][1]?.method).toBe("GET");
  });

  it("retries retryable durable job stream overload responses", async () => {
    const completedResult = {
      requested: 1,
      imported: 1,
      observed: 204,
      reapplied: 0,
      skipped: 0,
      failed: 0,
      outcomes: [],
    };
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { code: "durable_job_stream_limiter_unavailable" } }), {
          status: 503,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        sseResponse(
          `id: 1
event: status
data: ${JSON.stringify(jobSnapshot({ status: "completed", result: completedResult }))}

`,
        ),
      );
    const client = createCatalogApiClient({ baseUrl: "/api/catalog", fetch });

    await expect(client.watchSourceObservationIntegrationJob("job_1")).resolves.toEqual(completedResult);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe("bulk Source Observation promotion confirms its preview", () => {
  const scope = { provider: "tcgdex", language: "ja", seriesId: "sv", setId: "sv8" };
  const confirmation = {
    unitKey: "tcgdex:pokemon:single-card:source-observation-import",
    importScope: "ja:SV:SV8",
    profileVersion: "2026.06.04",
    scope,
  };
  const promoteOptions = { promoteAsDraft: true, previewToken: "spp1.synthetic", confirmation };
  const staleBody = { error: { code: "stale_promotion_preview", message: "Preview again." } };
  type Selection = Readonly<{ observationIds: string[] } | { scope: typeof scope }>;
  const selections: ReadonlyArray<readonly [string, Selection]> = [
    ["selected ids", { observationIds: ["obs_1", "obs_2"] }],
    ["a scope", { scope }],
  ];

  function promote(
    client: ReturnType<typeof createCatalogApiClient>,
    selection: Selection,
    options: Parameters<ReturnType<typeof createCatalogApiClient>["bulkPromoteSourceObservations"]>[1],
  ) {
    return "observationIds" in selection
      ? client.bulkPromoteSourceObservations(selection.observationIds, options)
      : client.bulkPromoteSourceObservationsByScope(selection.scope, options);
  }

  it.each(selections)("sends the token, draft choice and confirmation when promoting %s", async (_name, selection) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(jsonResponse({ jobId: "job_promote" }));
    const client = createCatalogApiClient({ baseUrl: "/api/catalog", fetch });

    await expect(promote(client, selection, promoteOptions)).resolves.toEqual({ jobId: "job_promote" });

    expect(String(fetch.mock.calls[0][0])).toBe("/api/catalog/source-observations/bulk-promote");
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual({
      ...selection,
      promoteAsDraft: true,
      previewToken: "spp1.synthetic",
      confirmation,
    });
  });

  it.each(selections)(
    "sends the same body to the job route when promoting %s with progress",
    async (_name, selection) => {
      const completedResult = { requested: 2, promoted: 2, failed: 0, outcomes: [] };
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValueOnce(jsonResponse(jobSnapshot({ status: "queued", result: null })))
        .mockResolvedValueOnce(
          sseResponse(
            `id: 1
event: status
data: ${JSON.stringify(jobSnapshot({ status: "completed", result: completedResult }))}

`,
          ),
        );
      const progress = vi.fn();
      const client = createCatalogApiClient({ baseUrl: "/api/catalog", fetch });

      await expect(promote(client, selection, { ...promoteOptions, onProgress: progress })).resolves.toEqual(
        completedResult,
      );

      expect(String(fetch.mock.calls[0][0])).toBe("/api/catalog/source-observations/bulk-promote/jobs");
      expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual({
        ...selection,
        promoteAsDraft: true,
        previewToken: "spp1.synthetic",
        confirmation,
      });
      expect(String(fetch.mock.calls[1][0])).toBe("/api/catalog/source-observations/bulk-jobs/job_1/events");
      expect(progress).toHaveBeenCalled();
    },
  );

  it.each(selections)("sends null for a missing token and confirmation when promoting %s", async (_name, selection) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(jsonResponse({ jobId: "job_promote" }));
    const client = createCatalogApiClient({ baseUrl: "/api/catalog", fetch });

    await promote(client, selection, {});

    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual({
      ...selection,
      promoteAsDraft: false,
      previewToken: null,
      confirmation: null,
    });
  });

  it("sends the confirmation with both previews", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => jsonResponse({ previewToken: "spp1.synthetic" }));
    const client = createCatalogApiClient({ baseUrl: "/api/catalog", fetch });
    const previewOptions = { promoteAsDraft: true, validationAfter: "obs_9", confirmation };

    await client.previewBulkPromoteSourceObservations(scope, previewOptions);
    await client.previewBulkPromoteSourceObservationIds(["obs_1"], previewOptions);

    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
      "/api/catalog/source-observations/bulk-promote/preview",
      "/api/catalog/source-observations/bulk-promote/preview",
    ]);
    expect(fetch.mock.calls.map(([, init]) => JSON.parse(String(init?.body)))).toEqual([
      { scope, promoteAsDraft: true, validationAfter: "obs_9", confirmation },
      { observationIds: ["obs_1"], promoteAsDraft: true, validationAfter: "obs_9", confirmation },
    ]);
  });

  it.each([
    ["without progress", {}],
    ["with progress", { onProgress: () => {} }],
  ])("surfaces a stale preview refusal as an ApiError %s", async (_name, extra) => {
    for (const [, selection] of selections) {
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValueOnce(
          new Response(JSON.stringify(staleBody), { status: 409, headers: { "content-type": "application/json" } }),
        );
      const client = createCatalogApiClient({ baseUrl: "/api/catalog", fetch });

      const error = await promote(client, selection, { ...promoteOptions, ...extra }).catch(
        (caught: unknown) => caught,
      );

      expect(error).toBeInstanceOf(ApiError);
      expect(error).toMatchObject({ status: 409, body: staleBody });
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });
});

function sseResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream; charset=utf-8" },
  });
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 202,
    headers: { "content-type": "application/json" },
  });
}

function jobSnapshot(input: { status: "queued" | "running" | "completed" | "failed"; result: unknown }) {
  return {
    jobId: "job_1",
    action: "import",
    scope: { provider: "tcgdex", language: "en", setId: "base1" },
    status: input.status,
    progress: jobProgress(input.status === "completed" ? "completed" : "processing"),
    result: input.result,
    errorMessage: null,
    createdAt: "2026-05-28T00:00:00.000Z",
    startedAt: input.status === "queued" ? null : "2026-05-28T00:00:01.000Z",
    completedAt: input.status === "completed" ? "2026-05-28T00:00:02.000Z" : null,
    updatedAt: "2026-05-28T00:00:02.000Z",
  };
}

function jobProgress(phase: string) {
  return {
    phase,
    completed: phase === "queued" ? 0 : 1,
    total: 1,
    currentName: null,
    status: phase === "completed" ? "imported" : null,
  };
}
