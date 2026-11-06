import { describe, expect, it, vi } from "vitest";
import type { SourceObservationPromotionPreview } from "../../read-model/queries";
import type { SourceObservationRouteServices } from "../route";
import { bulkJobFixture, buildApp, context, promotionPreviewFixture } from "./route-test-harness";

// A bulk promotion presents the token its preview returned. The API recomputes
// it from a fresh preview and refuses a missing or stale one before enqueueing.
describe("source observation routes: bulk promotion preview token", () => {
  const scope = { search: "", status: "", provider: "tcgdex", language: "en", setId: "base1" };

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

  function harness(next: { current: SourceObservationPromotionPreview }) {
    const previewPromoteObservations = vi.fn(async () => next.current);
    const previewPromoteObservationScope = vi.fn(async () => next.current);
    const enqueueBulkReviewJob = vi.fn(async () =>
      bulkJobFixture({ jobId: "job_promote", action: "promote", observationIds: ["obs_1", "obs_2"] }),
    );
    const app = buildApp({
      previewPromoteObservations,
      previewPromoteObservationScope,
      enqueueBulkReviewJob,
    } as unknown as SourceObservationRouteServices);
    return { app, enqueueBulkReviewJob, previewPromoteObservations, previewPromoteObservationScope };
  }

  async function post(app: ReturnType<typeof buildApp>, path: string, body: unknown) {
    return app.request(path, {
      method: "POST",
      body: JSON.stringify(body),
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

  it.each(["/source-observations/bulk-promote/jobs", "/source-observations/bulk-promote"])(
    "%s enqueues when the token matches a fresh preview of the same selection",
    async (path) => {
      const next = { current: preview() };
      const { app, enqueueBulkReviewJob, previewPromoteObservations } = harness(next);
      const token = await previewToken(app, { observationIds: ["obs_2", "obs_1"] });

      const response = await post(app, path, { observationIds: ["obs_1", "obs_2"], previewToken: token });

      expect(response.status).toBe(202);
      expect(previewPromoteObservations).toHaveBeenLastCalledWith({
        observationIds: ["obs_1", "obs_2"],
        promoteAsDraft: false,
        validationAfter: null,
      });
      expect(enqueueBulkReviewJob).toHaveBeenCalledWith({
        action: "promote",
        observationIds: ["obs_1", "obs_2"],
        scope: undefined,
        promoteAsDraft: false,
        context,
      });
    },
  );

  it("enqueues a scope promotion confirmed by its scope preview", async () => {
    const next = { current: preview() };
    const { app, enqueueBulkReviewJob } = harness(next);
    const body = { scope: { source: "tcgdex", language: "en", setId: "base1" } };
    const token = await previewToken(app, body);

    const response = await post(app, "/source-observations/bulk-promote/jobs", { ...body, previewToken: token });

    expect(response.status).toBe(202);
    expect(enqueueBulkReviewJob).toHaveBeenCalledWith(
      expect.objectContaining({ action: "promote", observationIds: [], promoteAsDraft: false }),
    );
  });

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
    const { app, enqueueBulkReviewJob } = harness(next);
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
    expect(enqueueBulkReviewJob).not.toHaveBeenCalled();
  });

  it("refuses a promotion whose draft choice differs from the previewed one", async () => {
    const next = { current: preview() };
    const { app, enqueueBulkReviewJob } = harness(next);
    const token = await previewToken(app, { observationIds: ["obs_1", "obs_2"] });
    next.current = preview({ validation: { promoteAsDraft: true } });

    const response = await post(app, "/source-observations/bulk-promote/jobs", {
      observationIds: ["obs_1", "obs_2"],
      promoteAsDraft: true,
      previewToken: token,
    });

    expect(response.status).toBe(409);
    expect(enqueueBulkReviewJob).not.toHaveBeenCalled();
  });

  it("refuses a token previewed for a different selection", async () => {
    const next = { current: preview() };
    const { app, enqueueBulkReviewJob } = harness(next);
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
    expect(enqueueBulkReviewJob).not.toHaveBeenCalled();
  });

  it.each([
    ["no token", {}],
    ["an empty token", { previewToken: " " }],
    ["a non-string token", { previewToken: 1 }],
    ["a made-up token", { previewToken: "spp1.not-a-preview" }],
  ])("refuses a promotion with %s without previewing or enqueueing", async (_name, extra) => {
    const next = { current: preview() };
    const { app, enqueueBulkReviewJob } = harness(next);

    for (const path of ["/source-observations/bulk-promote/jobs", "/source-observations/bulk-promote"]) {
      const response = await post(app, path, { observationIds: ["obs_1", "obs_2"], ...extra });
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({ error: { code: "stale_promotion_preview" } });
    }
    expect(enqueueBulkReviewJob).not.toHaveBeenCalled();
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
