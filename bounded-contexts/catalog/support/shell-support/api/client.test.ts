import { describe, expect, it, vi } from "vitest";
import { ApiError, CatalogItemPublicationApiError, createCatalogApiClient } from "./client";

describe("catalog API durable job client", () => {
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

    const error = await client.publishCatalogItem("cat_1", true, []).catch((caught) => caught);

    expect(error).toBeInstanceOf(CatalogItemPublicationApiError);
    expect(error).toMatchObject({
      code: "display-identity-outdated",
      readiness: "outdated",
      missingTokens: [],
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
