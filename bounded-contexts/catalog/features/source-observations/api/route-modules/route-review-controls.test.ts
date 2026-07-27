import { describe, expect, it, vi } from "vitest";
import type { SourceObservationRouteServices } from "../route";
import type { CatalogProviderIntegrationProfileVersionStore } from "../providers/provider-integration-profile-store";
import { buildApp, context, profileVersion, viewOnlyActor } from "./route-test-harness";

describe("source observation routes: review and control-plane reads", () => {
  it("requires catalog.view for control-plane reads", async () => {
    const listSourceObservations = vi.fn(async () => ({ items: [], total: 0 }));
    const app = buildApp({ listSourceObservations } as unknown as SourceObservationRouteServices, undefined, null);

    const response = await app.request("/source-observations?source=tcgdex");

    expect(response.status).toBe(401);
    expect(listSourceObservations).not.toHaveBeenCalled();
  });

  it("allows catalog.view actors to inspect control-plane read endpoints", async () => {
    const getCatalogIntegrationControlPlaneReadiness = vi.fn(async () => ({
      generatedAt: "2026-06-08T00:00:00.000Z",
      overallStatus: "ready",
      providerReadiness: [],
      diagnostics: [],
    }));
    const app = buildApp(
      { getCatalogIntegrationControlPlaneReadiness } as unknown as SourceObservationRouteServices,
      undefined,
      viewOnlyActor,
    );

    const response = await app.request("/source-observations/integration-control-plane/readiness");

    expect(response.status).toBe(200);
    expect(getCatalogIntegrationControlPlaneReadiness).toHaveBeenCalledOnce();
  });

  it("allows catalog.view actors to record redaction-safe control-plane telemetry events", async () => {
    const recordControlPlaneTelemetry = vi.fn();
    const app = buildApp(
      { recordControlPlaneTelemetry } as unknown as SourceObservationRouteServices,
      undefined,
      viewOnlyActor,
    );

    const response = await app.request("/source-observations/control-plane-events", {
      method: "POST",
      body: JSON.stringify({
        eventName: "catalog_control_plane.primary_workbench_viewed",
        providerKey: "tcgdex",
        unitKey: "tcgdex:pokemon:single-card:source-observation-import",
        scopeId: "en:3:base:base1",
        profileRef: "pokemon-tcg:2026.06.04",
        roleBucket: "view-only",
      }),
      headers: { "content-type": "application/json" },
    });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ status: "recorded" });
    expect(recordControlPlaneTelemetry).toHaveBeenCalledWith({
      eventName: "catalog_control_plane.primary_workbench_viewed",
      providerKey: "tcgdex",
      unitKey: "tcgdex:pokemon:single-card:source-observation-import",
      scopeId: "en:3:base:base1",
      profileRef: "pokemon-tcg:2026.06.04",
      jobRefState: null,
      observationStatus: null,
      observationCount: null,
      promotionResult: null,
      promotionCount: null,
      blockerCategory: null,
      detourTarget: null,
      detourOutcome: null,
      roleBucket: "view-only",
      readModelFreshness: null,
    });
  });

  it("rejects unknown control-plane telemetry events before recording metrics", async () => {
    const recordControlPlaneTelemetry = vi.fn();
    const app = buildApp({ recordControlPlaneTelemetry } as unknown as SourceObservationRouteServices);

    const response = await app.request("/source-observations/control-plane-events", {
      method: "POST",
      body: JSON.stringify({
        eventName: "catalog_control_plane.raw_json_opened",
        providerKey: "tcgdex",
      }),
      headers: { "content-type": "application/json" },
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "invalid_control_plane_event",
        message: "Unknown Catalog control plane telemetry event.",
      },
    });
    expect(recordControlPlaneTelemetry).not.toHaveBeenCalled();
  });

  it("requires catalog.manage for destructive control-plane actions", async () => {
    const services = {
      enqueueIntegrationJob: vi.fn(),
      enqueueBulkReviewJob: vi.fn(),
      promoteObservation: vi.fn(),
      rejectObservation: vi.fn(),
      promoteCatalogMergeCandidate: vi.fn(),
      splitCatalogMergeCandidate: vi.fn(),
      updateCatalogMergeCandidate: vi.fn(),
      ignoreCatalogMergeCandidate: vi.fn(),
      deferCatalogMergeCandidate: vi.fn(),
    } as unknown as SourceObservationRouteServices;
    const app = buildApp(services, undefined, viewOnlyActor);
    const requests: Array<readonly [string, RequestInit | undefined]> = [
      ["/source-observations/provider-profiles", { method: "POST", body: "{}" }],
      ["/source-observations/provider-profiles/tcgdex/v1/sections/basics", { method: "PATCH", body: "{}" }],
      ["/source-observations/provider-profiles/tcgdex/v1/dry-run", { method: "POST", body: "{}" }],
      ["/source-observations/provider-profiles/tcgdex/v1/activate", { method: "POST" }],
      ["/source-observations/provider-profiles/tcgdex/v1/clone", { method: "POST", body: "{}" }],
      ["/source-observations/provider-profiles/tcgdex/v1/rollback", { method: "POST" }],
      ["/source-observations/provider-profiles/tcgdex/v1/retire", { method: "POST" }],
      ["/source-observations/provider-profiles/tcgdex/v1/deprecate", { method: "POST" }],
      ["/source-observations/integration-jobs", { method: "POST", body: "{}" }],
      ["/source-observations/bulk-promote/preview", { method: "POST", body: "{}" }],
      ["/source-observations/reapply/preview", { method: "POST", body: "{}" }],
      ["/source-observations/reapply/impact", { method: "POST", body: "{}" }],
      ["/source-observations/reapply", { method: "POST", body: "{}" }],
      ["/source-observations/bulk-promote", { method: "POST", body: "{}" }],
      ["/source-observations/bulk-reject", { method: "POST", body: '{"reason":"duplicate"}' }],
      ["/source-observations/bulk-defer/jobs", { method: "POST", body: "{}" }],
      ["/source-observations/admin/merge-candidates/cand_1/promote", { method: "POST", body: "{}" }],
      ["/source-observations/admin/merge-candidates/cand_1/split", { method: "POST", body: "{}" }],
      ["/source-observations/admin/merge-candidates/cand_1/update", { method: "POST", body: "{}" }],
      ["/source-observations/admin/merge-candidates/cand_1/ignore", { method: "POST", body: "{}" }],
      ["/source-observations/admin/merge-candidates/cand_1/defer", { method: "POST", body: "{}" }],
      ["/source-observations/obs_1/promote", { method: "POST" }],
      ["/source-observations/obs_1/reject", { method: "POST", body: "{}" }],
    ];

    const responses = await Promise.all(
      requests.map(async ([path, init]) => ({ path, response: await app.request(path, init) })),
    );
    for (const { path, response } of responses) {
      expect(response.status, path).toBe(403);
    }
    expect(services.enqueueIntegrationJob).not.toHaveBeenCalled();
    expect(services.enqueueBulkReviewJob).not.toHaveBeenCalled();
    expect(services.promoteObservation).not.toHaveBeenCalled();
    expect(services.rejectObservation).not.toHaveBeenCalled();
    expect(services.promoteCatalogMergeCandidate).not.toHaveBeenCalled();
    expect(services.splitCatalogMergeCandidate).not.toHaveBeenCalled();
    expect(services.updateCatalogMergeCandidate).not.toHaveBeenCalled();
    expect(services.ignoreCatalogMergeCandidate).not.toHaveBeenCalled();
    expect(services.deferCatalogMergeCandidate).not.toHaveBeenCalled();
  });

  it("requires a reason for single Source Observation rejection", async () => {
    const services = {
      rejectObservation: vi.fn(),
    } as unknown as SourceObservationRouteServices;
    const app = buildApp(services);

    const response = await app.request("/source-observations/obs_1/reject", {
      method: "POST",
      body: JSON.stringify({ reason: " " }),
      headers: { "content-type": "application/json" },
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Rejection requires a reason.",
    });
    expect(services.rejectObservation).not.toHaveBeenCalled();
  });

  it("passes trimmed reasons through single Source Observation rejection", async () => {
    const result = { status: "rejected", observationId: "obs_1" };
    const rejectObservation = vi.fn(async () => result);
    const services = {
      rejectObservation,
    } as unknown as SourceObservationRouteServices;
    const app = buildApp(services);

    const response = await app.request("/source-observations/obs_1/reject", {
      method: "POST",
      body: JSON.stringify({ reason: " Duplicate provider row. " }),
      headers: { "content-type": "application/json" },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(result);
    expect(rejectObservation).toHaveBeenCalledWith({
      observationId: "obs_1",
      reason: "Duplicate provider row.",
      context,
    });
  });

  it("passes candidate review actions through with audit context and safe ignore language", async () => {
    const result = {
      candidateId: "cand_1",
      action: "ignore",
      version: 2,
      status: "rejected",
      statusReason: "Candidate ignored: Not a Catalog Item.",
      snapshot: null,
    };
    const ignoreCatalogMergeCandidate = vi.fn(async () => result);
    const services = {
      ignoreCatalogMergeCandidate,
    } as unknown as SourceObservationRouteServices;
    const app = buildApp(services);

    const response = await app.request("/source-observations/admin/merge-candidates/cand_1/ignore", {
      method: "POST",
      body: JSON.stringify({
        reason: " Not a Catalog Item. ",
        conflictResolutions: [
          {
            conflictCode: "provider-disagreement",
            fieldPath: null,
            chosenValue: "ignore",
            reason: "Grouping is unsafe.",
            observationIds: ["obs_1"],
          },
        ],
      }),
      headers: { "content-type": "application/json" },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(result);
    expect(ignoreCatalogMergeCandidate).toHaveBeenCalledWith({
      candidateId: "cand_1",
      reason: "Not a Catalog Item.",
      conflictResolutions: [
        {
          conflictCode: "provider-disagreement",
          fieldPath: null,
          chosenValue: "ignore",
          reason: "Grouping is unsafe.",
          observationIds: ["obs_1"],
        },
      ],
      context,
    });
  });

  it("requires candidate action reasons and snapshots where needed", async () => {
    const services = {
      promoteCatalogMergeCandidate: vi.fn(),
      updateCatalogMergeCandidate: vi.fn(),
      splitCatalogMergeCandidate: vi.fn(),
    } as unknown as SourceObservationRouteServices;
    const app = buildApp(services);

    const promoteResponse = await app.request("/source-observations/admin/merge-candidates/cand_1/promote", {
      method: "POST",
      body: JSON.stringify({ reason: " " }),
      headers: { "content-type": "application/json" },
    });
    const updateResponse = await app.request("/source-observations/admin/merge-candidates/cand_1/update", {
      method: "POST",
      body: JSON.stringify({ reason: "Correct identity." }),
      headers: { "content-type": "application/json" },
    });
    const splitResponse = await app.request("/source-observations/admin/merge-candidates/cand_1/split", {
      method: "POST",
      body: JSON.stringify({ reason: "Separate variants." }),
      headers: { "content-type": "application/json" },
    });

    expect(promoteResponse.status).toBe(400);
    await expect(promoteResponse.json()).resolves.toEqual({ error: "Promotion requires a reason." });
    expect(updateResponse.status).toBe(400);
    await expect(updateResponse.json()).resolves.toEqual({ error: "Update requires a candidate snapshot." });
    expect(splitResponse.status).toBe(400);
    await expect(splitResponse.json()).resolves.toEqual({
      error: "Split requires remainingSnapshot, splitCandidateId, and splitSnapshot.",
    });
    expect(services.promoteCatalogMergeCandidate).not.toHaveBeenCalled();
    expect(services.updateCatalogMergeCandidate).not.toHaveBeenCalled();
    expect(services.splitCatalogMergeCandidate).not.toHaveBeenCalled();
  });

  it("lists observations using the shared source query param as provider scope", async () => {
    const listSourceObservations = vi.fn(async () => ({
      items: [],
      total: 0,
    }));
    const services = {
      listSourceObservations,
    } as unknown as SourceObservationRouteServices;
    const app = buildApp(services);

    const response = await app.request("/source-observations?source=tcgdex&language=en&setId=base1&limit=50&offset=0");

    expect(response.status).toBe(200);
    expect(listSourceObservations).toHaveBeenCalledWith({
      search: undefined,
      status: undefined,
      limit: 50,
      offset: undefined,
      provider: "tcgdex",
      language: "en",
      setId: "base1",
    });
  });

  it("redacts governed provider payload fields on Source Observation detail reads", async () => {
    const getSourceObservationDetail = vi.fn(async () => ({
      observation_id: "obs_1",
      provider_key: "tcgplayer",
      external_key: "product:123",
      source_url: "https://provider.test/product/123",
      language_code: "en",
      source_record_hash: "sha256:abc",
      source_updated_at: null,
      observed_at: "2026-06-06T00:00:00.000Z",
      source_profile_key: "pokemon-tcg",
      source_profile_version: "2026.06.04",
      source_mapping_fingerprint: "fingerprint",
      normalized: { kind: "provider-product", name: "Furret" },
      status: "observed",
      status_reason: null,
      promoted_catalog_item_id: null,
      promoted_reference_record_id: null,
      promoted_at: null,
      promotion_profile_key: null,
      promotion_profile_version: null,
      promotion_plan_fingerprint: null,
      updated_at: "2026-06-06T00:00:00.000Z",
      source_payload: {
        id: 123,
        name: "Furret",
        authorization: "Bearer secret",
        sellerName: "Seller Name",
        price: 1.23,
        inventoryQuantity: 7,
      },
    }));
    const services = {
      getSourceObservationDetail,
    } as unknown as SourceObservationRouteServices;
    const app = buildApp(services);

    const response = await app.request("/source-observations/obs_1");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      observation_id: "obs_1",
      source_payload: {
        id: 123,
        name: "Furret",
        authorization: "<redacted>",
        sellerName: "<redacted>",
        price: "<redacted>",
        inventoryQuantity: "<redacted>",
      },
    });
    expect(getSourceObservationDetail).toHaveBeenCalledWith("obs_1");
  });

  it("returns replay/reapply impact previews from the control-plane impact service", async () => {
    const previewReplayReapplyImpact = vi.fn(async () => ({
      generatedAt: "2026-06-08T00:00:00.000Z",
      unitKey: "tcgdex:pokemon:single-card:source-observation-import",
      profile: {
        schemaVersion: "catalog-provider-profile-version-v1",
        compatibilityPolicy: "provider-profile-version",
        providerKey: "tcgdex",
        profileKey: "pokemon-tcg",
        profileVersion: "v2",
        lifecycle: "test",
        active: false,
        connectorKind: "tcgdex-json",
        connectorSourceVersion: null,
        sourceMappingFingerprint: null,
      },
      matchedObservations: 4,
      eligibleObservations: 3,
      blockedObservations: 1,
      impactedCatalogItemCount: 2,
      impactedCatalogItemIds: ["cat_1"],
      externalReferenceCount: 2,
      externalReferenceSamples: [],
      sampleObservationIds: ["obs_1"],
      activeJobCount: 0,
      activeJobSamples: [],
      diagnostics: [],
    }));
    const app = buildApp({ previewReplayReapplyImpact } as unknown as SourceObservationRouteServices);

    const response = await app.request("/source-observations/reapply/impact", {
      method: "POST",
      body: JSON.stringify({
        providerKey: "tcgdex",
        profileVersion: "v2",
        scope: { provider: "tcgdex", language: "en", setId: "base1" },
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      matchedObservations: 4,
      impactedCatalogItemCount: 2,
    });
    expect(previewReplayReapplyImpact).toHaveBeenCalledWith({
      providerKey: "tcgdex",
      profileVersion: "v2",
      scope: { provider: "tcgdex", language: "en", setId: "base1", search: undefined, status: undefined },
      context,
    });
  });

  it("returns lifecycle impact previews before profile lifecycle actions", async () => {
    const previewProviderProfileLifecycleImpact = vi.fn(async () => ({
      generatedAt: "2026-06-08T00:00:00.000Z",
      unitKey: "tcgdex:pokemon:single-card:source-observation-import",
      profile: {
        schemaVersion: "catalog-provider-profile-version-v1",
        compatibilityPolicy: "provider-profile-version",
        providerKey: "tcgdex",
        profileKey: "pokemon-tcg",
        profileVersion: "v2",
        lifecycle: "test",
        active: false,
        connectorKind: "tcgdex-json",
        connectorSourceVersion: null,
        sourceMappingFingerprint: null,
      },
      operation: "retire",
      referencedObservationCount: 2,
      sourceProfileReferenceCount: 1,
      promotionProfileReferenceCount: 1,
      impactedCatalogItemCount: 1,
      impactedCatalogItemIds: ["cat_1"],
      externalReferenceCount: 1,
      externalReferenceSamples: [],
      sampleObservationIds: ["obs_1"],
      impactedJobCount: 0,
      allowed: false,
      blockers: [],
    }));
    const app = buildApp({ previewProviderProfileLifecycleImpact } as unknown as SourceObservationRouteServices);

    const response = await app.request(
      "/source-observations/provider-profiles/tcgdex/v2/lifecycle-impact?operation=retire",
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      operation: "retire",
      referencedObservationCount: 2,
      allowed: false,
    });
    expect(previewProviderProfileLifecycleImpact).toHaveBeenCalledWith({
      providerKey: "tcgdex",
      profileVersion: "v2",
      operation: "retire",
      context,
    });
  });

  it("returns a structured error when a provider profile section command fails shared contract parsing", async () => {
    const app = buildApp({} as SourceObservationRouteServices, {} as CatalogProviderIntegrationProfileVersionStore);

    const response = await app.request(
      "/source-observations/provider-profiles/tcgdex/2026.06.04/sections/provider-options",
      {
        method: "PATCH",
        body: JSON.stringify({
          command: {
            optionQueries: {},
          },
        }),
      },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "invalid_profile_section_command",
        message: "optionQueries must be an array.",
      },
    });
  });

  it("previews filter-scoped bulk promotion", async () => {
    const previewPromoteObservationScope = vi.fn(async () => ({
      matched: 102,
      eligible: 100,
      terminal: 2,
      scope: {
        search: "",
        status: "observed",
        provider: "",
        language: "en",
        setId: "base1",
      },
    }));
    const services = {
      previewPromoteObservationScope,
    } as unknown as SourceObservationRouteServices;
    const app = buildApp(services);

    const response = await app.request("/source-observations/bulk-promote/preview", {
      method: "POST",
      body: JSON.stringify({
        scope: { status: "observed", source: "tcgdex", language: "en", setId: "base1" },
      }),
      headers: { "content-type": "application/json" },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      matched: 102,
      eligible: 100,
      terminal: 2,
    });
    expect(previewPromoteObservationScope).toHaveBeenCalledWith({
      scope: {
        search: undefined,
        status: "observed",
        provider: "tcgdex",
        language: "en",
        setId: "base1",
      },
    });
  });

  it("previews selected Source Observation promotion without using the filter scope", async () => {
    const previewPromoteObservations = vi.fn(async () => ({
      matched: 2,
      eligible: 1,
      terminal: 1,
      scope: {
        search: "",
        status: "",
        provider: "",
        language: "",
        setId: "",
      },
    }));
    const previewPromoteObservationScope = vi.fn();
    const services = {
      previewPromoteObservations,
      previewPromoteObservationScope,
    } as unknown as SourceObservationRouteServices;
    const app = buildApp(services);

    const response = await app.request("/source-observations/bulk-promote/preview", {
      method: "POST",
      body: JSON.stringify({
        observationIds: [" obs_1 ", "obs_2", "obs_1", " "],
        scope: { status: "observed", source: "tcgdex", language: "en", setId: "base1" },
      }),
      headers: { "content-type": "application/json" },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      matched: 2,
      eligible: 1,
      terminal: 1,
    });
    expect(previewPromoteObservations).toHaveBeenCalledWith({ observationIds: ["obs_1", "obs_2"] });
    expect(previewPromoteObservationScope).not.toHaveBeenCalled();
  });
});
