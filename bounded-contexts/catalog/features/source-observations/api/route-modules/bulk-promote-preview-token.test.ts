import { describe, expect, it, vi } from "vitest";
import type { SourceObservationPromotionPreview } from "../../read-model/queries";
import type { SourceObservationRouteServices } from "../route";
import { promotionAdmissionHarness, type PromotionAdmissionHarnessOptions } from "./promotion-admission-test-harness";
import { buildApp, promotionPreviewFixture } from "./route-test-harness";

// A bulk promotion presents the token its preview returned. The API admits it
// in one transaction: it locks the selected rows, previews them again,
// compares the token, and enqueues; a missing or stale token enqueues nothing.
describe("source observation routes: bulk promotion preview token", () => {
  const scope = { search: "", status: "", provider: "tcgdex", language: "en", setId: "base1" };
  const page = {
    unitKey: "tcgdex:pokemon:card:import",
    importScope: "en:3:base:base1",
    profileVersion: "2026.06.04",
    scope: { provider: "tcgdex", language: "en", setId: "base1" },
  };
  const paths = ["/source-observations/bulk-promote/jobs", "/source-observations/bulk-promote"];

  function preview(overrides: Parameters<typeof promotionPreviewFixture>[0] = {}): SourceObservationPromotionPreview {
    return promotionPreviewFixture({
      matched: 2,
      eligible: 2,
      scope,
      ...overrides,
      validation: { coveredObservationIds: ["obs_1", "obs_2"], ...overrides.validation },
    });
  }

  function blocked(observationId: string) {
    return {
      observationId,
      code: "display-identity-unresolvable",
      path: "displayIdentity",
      diagnosticText: "No display template targets this item.",
      blocking: true,
    };
  }

  function harness(
    next: { current: SourceObservationPromotionPreview },
    onQuery?: (sql: string) => void,
    rows?: PromotionAdmissionHarnessOptions["rows"],
  ) {
    const admission = promotionAdmissionHarness(next, { onQuery, rows });
    const app = buildApp({
      previewPromoteObservations: vi.fn(async () => next.current),
      previewPromoteObservationScope: vi.fn(async () => next.current),
      admitBulkPromotionJob: admission.admitBulkPromotionJob,
    } as unknown as SourceObservationRouteServices);
    return { app, ...admission };
  }

  async function post(app: ReturnType<typeof buildApp>, path: string, body: unknown) {
    return app.request(path, {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
      headers: { "content-type": "application/json" },
    });
  }

  async function previewToken(app: ReturnType<typeof buildApp>, body: unknown): Promise<string> {
    const response = await post(app, "/source-observations/bulk-promote/preview", body);
    expect(response.status).toBe(200);
    const json = (await response.json()) as { previewToken: unknown };
    expect(json.previewToken).toEqual(expect.stringMatching(/^spp1\./));
    return json.previewToken as string;
  }

  it.each(paths)("%s admits a token that matches a fresh preview, in one transaction", async (path) => {
    const next = { current: preview() };
    const { app, enqueueJob, enqueueUnits, previewPromotionSelection, transaction, statements } = harness(next);
    const token = await previewToken(app, { observationIds: ["obs_2", "obs_1"], confirmation: page });

    const response = await post(app, path, {
      observationIds: ["obs_1", "obs_2"],
      previewToken: token,
      confirmation: page,
    });

    expect(response.status).toBe(202);
    expect(previewPromotionSelection).toHaveBeenCalledWith(
      { observationIds: ["obs_1", "obs_2"] },
      { promoteAsDraft: false, validationAfter: null },
      transaction,
    );
    expect(enqueueJob).toHaveBeenCalledWith(
      expect.objectContaining({
        jobKind: "promote",
        payload: expect.objectContaining({
          selectionMode: "ids",
          observationIds: ["obs_1", "obs_2"],
          promoteAsDraft: false,
        }),
      }),
    );
    expect(enqueueUnits).toHaveBeenCalledWith(
      expect.objectContaining({
        units: [expect.objectContaining({ unitId: "obs_1" }), expect.objectContaining({ unitId: "obs_2" })],
      }),
    );
    // Locked first, so the preview reads one snapshot of rows no one can change before the commit.
    const sql = statements.map((statement) => statement.sql);
    expect(sql[0]).toBe("BEGIN ISOLATION LEVEL REPEATABLE READ");
    expect(sql[1]).toMatch(/FOR SHARE/);
    expect(sql.at(-1)).toBe("COMMIT");
    expect(statements.every((statement) => statement.client === "transaction")).toBe(true);
  });

  it("admits a scope promotion confirmed by its scope preview", async () => {
    const next = { current: preview() };
    const { app, enqueueJob } = harness(next);
    const body = { scope: { source: "tcgdex", language: "en", setId: "base1" }, confirmation: page };
    const token = await previewToken(app, body);

    const response = await post(app, "/source-observations/bulk-promote/jobs", { ...body, previewToken: token });

    expect(response.status).toBe(202);
    expect(enqueueJob).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ selectionMode: "filter", observationIds: [], promoteAsDraft: false }),
      }),
    );
  });

  // Synthetic rows sharing provider and language: one inside the confirmed
  // coordinate, one outside it. The scope selection answers like the table.
  it.each([
    ["product line", { productLineId: "synthetic-line" }, "productLineId"],
    ["series", { seriesId: "synthetic-series" }, "seriesId"],
  ] as const)(
    "enqueues only the confirmed %s, not every row in the provider and language",
    async (_name, coordinate, field) => {
      const rowsInTable = [
        { observation_id: "synthetic-in-scope", productLineId: "synthetic-line", seriesId: "synthetic-series" },
        {
          observation_id: "synthetic-outside",
          productLineId: "synthetic-other-line",
          seriesId: "synthetic-other-series",
        },
      ];
      const selectScope = (sql: string, values: readonly unknown[]) =>
        sql.includes("FOR SHARE")
          ? []
          : rowsInTable
              .filter((row) => !sql.includes(`normalized->>'${field}'`) || values.includes(row[field]))
              .map(({ observation_id }) => ({ observation_id }));
      const narrowScope = { provider: "tcgdex", language: "en", ...coordinate };
      const next = { current: preview({ matched: 1, eligible: 1, scope: { ...scope, ...coordinate } }) };
      const { app, enqueueJob, enqueueUnits } = harness(next, undefined, selectScope);
      const body = { scope: narrowScope, confirmation: { ...page, scope: narrowScope } };
      const token = await previewToken(app, body);

      for (const path of paths) {
        enqueueJob.mockClear();
        enqueueUnits.mockClear();
        const response = await post(app, path, { ...body, previewToken: token });

        expect(response.status).toBe(202);
        expect(enqueueJob).toHaveBeenCalledWith(
          expect.objectContaining({ payload: expect.objectContaining({ scope: expect.objectContaining(coordinate) }) }),
        );
        expect(enqueueUnits).toHaveBeenCalledWith(
          expect.objectContaining({ units: [expect.objectContaining({ unitId: "synthetic-in-scope" })] }),
        );
      }
    },
  );

  it.each([
    ["the eligible count", preview({ eligible: 1 })],
    ["the matched count", preview({ matched: 3 })],
    ["the content fingerprint", preview({ fingerprint: "content-b" })],
    [
      "a newly blocked observation",
      preview({
        validation: { diagnostics: [blocked("obs_2")] },
      }),
    ],
    ["the validation coverage", preview({ validation: { coverage: "partial" } })],
  ])("refuses a promotion after %s changed since the preview", async (_change, changed) => {
    const next = { current: preview() };
    const { app, enqueueJob } = harness(next);
    const token = await previewToken(app, { observationIds: ["obs_1", "obs_2"] });
    next.current = changed;

    const response = await post(app, "/source-observations/bulk-promote/jobs", {
      observationIds: ["obs_1", "obs_2"],
      previewToken: token,
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: { code: "stale_promotion_preview", message: expect.any(String) },
    });
    expect(enqueueJob).not.toHaveBeenCalled();
  });

  it("refuses a promotion whose draft choice differs from the previewed one", async () => {
    const next = { current: preview() };
    const { app, enqueueJob } = harness(next);
    const token = await previewToken(app, { observationIds: ["obs_1", "obs_2"] });
    next.current = preview({ validation: { promoteAsDraft: true } });

    const response = await post(app, "/source-observations/bulk-promote/jobs", {
      observationIds: ["obs_1", "obs_2"],
      promoteAsDraft: true,
      previewToken: token,
    });

    expect(response.status).toBe(409);
    expect(enqueueJob).not.toHaveBeenCalled();
  });

  it("refuses a token previewed for a different selection", async () => {
    const next = { current: preview() };
    const { app, enqueueJob } = harness(next);
    const token = await previewToken(app, { observationIds: ["obs_1", "obs_2"] });

    const scoped = await post(app, "/source-observations/bulk-promote/jobs", {
      scope: { source: "tcgdex", language: "en", setId: "base1" },
      previewToken: token,
    });
    const otherIds = await post(app, "/source-observations/bulk-promote/jobs", {
      observationIds: ["obs_1"],
      previewToken: token,
    });

    expect(scoped.status).toBe(409);
    expect(otherIds.status).toBe(409);
    expect(enqueueJob).not.toHaveBeenCalled();
  });

  // The page the preview was taken on is part of what it confirms, as admin-web's
  // token bound it before the check moved here.
  it.each([
    ["another ingestion unit", { ...page, unitKey: "tcgdex:pokemon:sealed:import" }],
    ["another import scope", { ...page, importScope: "en:3:base:base2" }],
    ["another profile version", { ...page, profileVersion: "2026.06.05" }],
    ["another page scope", { ...page, scope: { ...page.scope, status: "changed" } }],
    ["no page", undefined],
  ])("refuses a token previewed on another page: %s", async (_name, confirmation) => {
    const next = { current: preview() };
    const { app, enqueueJob } = harness(next);
    const token = await previewToken(app, { observationIds: ["obs_1", "obs_2"], confirmation: page });

    for (const path of paths) {
      const response = await post(app, path, { observationIds: ["obs_1", "obs_2"], previewToken: token, confirmation });
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({ error: { code: "stale_promotion_preview" } });
    }
    expect(enqueueJob).not.toHaveBeenCalled();
  });

  it.each([
    ["no token", {}],
    ["an empty token", { previewToken: " " }],
    ["a non-string token", { previewToken: 1 }],
    ["a made-up token", { previewToken: "spp1.not-a-preview" }],
  ])("refuses a promotion with %s and enqueues nothing", async (_name, extra) => {
    const next = { current: preview() };
    const { app, enqueueJob } = harness(next);

    for (const path of paths) {
      const response = await post(app, path, { observationIds: ["obs_1", "obs_2"], ...extra });
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({ error: { code: "stale_promotion_preview" } });
    }
    expect(enqueueJob).not.toHaveBeenCalled();
  });

  it.each([
    ["JSON null", "null"],
    ["an array", "[]"],
    ["a string", '"spp1.token"'],
    ["malformed JSON", "{"],
  ])("refuses a body that is %s as a missing confirmation, before any read", async (_name, body) => {
    const next = { current: preview() };
    const { app, enqueueJob, previewPromotionSelection, statements } = harness(next);

    for (const path of paths) {
      const response = await post(app, path, body);
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({ error: { code: "stale_promotion_preview" } });
    }
    expect(previewPromotionSelection).not.toHaveBeenCalled();
    expect(statements).toEqual([]);
    expect(enqueueJob).not.toHaveBeenCalled();
  });

  it.each([
    ["changed a selected row after the admission's snapshot", "40001"],
    ["deadlocked with the admission", "40P01"],
  ])("refuses a promotion when another transaction %s, and enqueues nothing", async (_name, code) => {
    const next = { current: preview() };
    const { app, enqueueJob, statements } = harness(next, (sql) => {
      if (sql.includes("FOR SHARE")) {
        throw Object.assign(new Error("could not serialize access due to concurrent update"), { code });
      }
    });
    const token = await previewToken(app, { observationIds: ["obs_1", "obs_2"] });

    const response = await post(app, "/source-observations/bulk-promote/jobs", {
      observationIds: ["obs_1", "obs_2"],
      previewToken: token,
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "stale_promotion_preview" } });
    expect(enqueueJob).not.toHaveBeenCalled();
    expect(statements.map((statement) => statement.sql).at(-1)).toBe("ROLLBACK");
  });

  it("returns no token for a continuation validation page", async () => {
    const next = { current: preview() };
    const { app } = harness(next);

    const response = await post(app, "/source-observations/bulk-promote/preview", {
      observationIds: ["obs_1", "obs_2"],
      validationAfter: "obs_1",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ previewToken: null });
  });
});
