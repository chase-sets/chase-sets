import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { CatalogAuthoringEnv } from "../../../support/authoring-support/api";
import { sourceObservationRoutes } from "./route";
import type { SourceObservationRouteServices } from "./route";
import type { CatalogProviderIntegrationProfileVersionStore } from "./provider-integration-profile-store";
import {
  catalogProviderIntegrationProfileVersions,
  type CatalogProviderIntegrationProfileVersionRecord,
} from "./provider-integration-profiles";
import {
  CatalogIntegrationRolloutControlError,
  createCatalogIntegrationRolloutControlPolicy,
} from "./catalog-integration-rollout-controls";
import { CatalogProviderOptionQueryUnavailableError } from "./provider-option-query-cache";

const context: EventStoreContext = {
  tenantId: "tnt_test" as never,
  audit: {
    performedByUserId: "usr_test" as never,
    forAccountId: "acc_test" as never,
  },
};

const manageActor: CatalogAuthoringEnv["Variables"]["actor"] = {
  permissions: ["catalog.view", "catalog.manage"],
};

const viewOnlyActor: CatalogAuthoringEnv["Variables"]["actor"] = {
  permissions: ["catalog.view"],
};

function rolloutDenied(
  input: Parameters<ReturnType<typeof createCatalogIntegrationRolloutControlPolicy>["decide"]>[0],
) {
  const policy = createCatalogIntegrationRolloutControlPolicy({
    disabledProviderAdapters: ["tcgdex"],
    disabledImports: ["tcgdex"],
    disabledPromotion: ["tcgdex"],
    disabledReapply: ["tcgdex"],
    activationMode: "disabled",
  });
  const decision = policy.decide(input);
  if (decision.allowed) {
    throw new Error("Expected rollout control policy to deny the test operation.");
  }
  return new CatalogIntegrationRolloutControlError(decision);
}

function buildApp(
  services: SourceObservationRouteServices,
  profileVersions?: CatalogProviderIntegrationProfileVersionStore,
  actor: CatalogAuthoringEnv["Variables"]["actor"] = manageActor,
) {
  const app = new Hono<CatalogAuthoringEnv>();

  app.use("/source-observations/*", async (c, next) => {
    c.set("actor", actor);
    c.set("context", context);
    await next();
  });
  app.route("/source-observations", sourceObservationRoutes(services, profileVersions));

  return app;
}

describe("source observation routes", () => {
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

  it("requires catalog.manage for destructive control-plane actions", async () => {
    const services = {
      enqueueIntegrationJob: vi.fn(),
      enqueueBulkReviewJob: vi.fn(),
      promoteObservation: vi.fn(),
      rejectObservation: vi.fn(),
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
      ["/source-observations/obs_1/promote", { method: "POST" }],
      ["/source-observations/obs_1/reject", { method: "POST", body: "{}" }],
    ];

    for (const [path, init] of requests) {
      const response = await app.request(path, init);
      expect(response.status, path).toBe(403);
    }
    expect(services.enqueueIntegrationJob).not.toHaveBeenCalled();
    expect(services.enqueueBulkReviewJob).not.toHaveBeenCalled();
    expect(services.promoteObservation).not.toHaveBeenCalled();
    expect(services.rejectObservation).not.toHaveBeenCalled();
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

  it("lists integration scopes using provider language and expansion filters", async () => {
    const listIntegrationScopes = vi.fn(async () => [
      {
        provider_key: "tcgdex",
        language_code: "en",
        expansion_id: "base1",
        expansion_name: "Base Set",
        series_id: "base",
        series_name: "Base",
        total_observations: 102,
        observed_observations: 100,
        changed_observations: 0,
        promoted_observations: 2,
        rejected_observations: 0,
        first_observed_at: "2026-05-16T00:00:00.000Z",
        latest_observed_at: "2026-05-16T00:01:00.000Z",
        latest_source_updated_at: null,
      },
    ]);
    const services = {
      listIntegrationScopes,
    } as unknown as SourceObservationRouteServices;
    const app = buildApp(services);

    const response = await app.request("/source-observations/integration-scopes?source=tcgdex&language=en&setId=base1");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      total: 1,
      count: 1,
      items: [
        {
          provider_key: "tcgdex",
          language_code: "en",
          expansion_id: "base1",
          series_name: "Base",
        },
      ],
    });
    expect(listIntegrationScopes).toHaveBeenCalledWith({
      provider: "tcgdex",
      language: "en",
      setId: "base1",
    });
  });

  it("streams TCGdex import job status events", async () => {
    const job = integrationJobFixture({
      jobId: "job_import_base1",
      action: "import",
      scope: { provider: "tcgdex", language: "en", setId: "base1" },
      status: "completed",
      progress: {
        phase: "completed",
        completed: 1,
        total: 1,
        currentName: null,
        status: "imported",
      },
      result: {
        requested: 1,
        imported: 1,
        observed: 2,
        reapplied: 0,
        skipped: 0,
        failed: 0,
        outcomes: [],
      },
    });
    const getIntegrationJob = vi.fn(async () => job);
    const listIntegrationJobEvents = vi.fn(async () => [jobEvent(job)]);
    const services = {
      getIntegrationJob,
      listIntegrationJobEvents,
    } as unknown as SourceObservationRouteServices;
    const app = buildApp(services);

    const response = await app.request("/source-observations/integration-jobs/job_import_base1/events");

    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain("id: 1");
    expect(text).toContain("event: status");
    expect(readSseData(text)).toEqual([job]);
    expect(getIntegrationJob).toHaveBeenCalledWith("job_import_base1", context);
    expect(listIntegrationJobEvents).toHaveBeenCalledWith("job_import_base1", 0);
  });

  it("lists provider-neutral integration options for Catalog import selectors", async () => {
    const listIntegrationOptions = vi.fn(async () => [
      {
        providerKey: "tcgdex",
        queryKind: "expansions",
        value: "me02.5",
        label: "Ascended Heroes",
        description: "Mega Evolution - 217 official cards",
        parentValue: "me",
        imageUrl: null,
        metadata: {
          languageCode: "en",
          expansionId: "me02.5",
        },
      },
    ]);
    const services = {
      listIntegrationOptions,
    } as unknown as SourceObservationRouteServices;
    const app = buildApp(services);

    const response = await app.request(
      "/source-observations/integration-options?provider=tcgdex&kind=expansions&language=en&seriesId=me",
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      items: [
        {
          providerKey: "tcgdex",
          queryKind: "expansions",
          value: "me02.5",
          label: "Ascended Heroes",
        },
      ],
      total: 1,
      count: 1,
    });
    expect(listIntegrationOptions).toHaveBeenCalledWith({
      providerKey: "tcgdex",
      queryKind: "expansions",
      languageCode: "en",
      parentValue: "me",
    });
  });

  it("returns cache and cursor metadata for provider-neutral integration options", async () => {
    const queryIntegrationOptions = vi.fn(async () => ({
      items: [
        {
          providerKey: "tcgdex",
          queryKind: "expansions",
          value: "me02.5",
          label: "Ascended Heroes",
          description: null,
          parentValue: "me",
          imageUrl: null,
          metadata: {},
        },
      ],
      total: 2,
      count: 1,
      page: {
        cursor: "offset:1",
        nextCursor: null,
        limit: 1,
        hasMore: false,
      },
      cache: {
        status: "stale",
        source: "cache",
        cacheKey: "sha256:test",
        fetchedAt: "2026-06-08T09:00:00.000Z",
        expiresAt: "2026-06-08T09:15:00.000Z",
        staleUntil: "2026-06-09T09:00:00.000Z",
        cacheOnly: true,
        forceRefresh: true,
        degraded: true,
        diagnostics: [
          {
            code: "provider-option-query-stale-cache-used",
            severity: "warning",
            message: "provider rate limited",
            retryAfterSeconds: null,
          },
        ],
      },
    }));
    const services = {
      queryIntegrationOptions,
    } as unknown as SourceObservationRouteServices;
    const app = buildApp(services);

    const response = await app.request(
      "/source-observations/integration-options?provider=tcgdex&kind=expansions&language=en&seriesId=me&cursor=offset:1&limit=1&forceRefresh=true",
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      items: [{ value: "me02.5" }],
      total: 2,
      count: 1,
      page: { cursor: "offset:1", limit: 1, hasMore: false },
      cache: { status: "stale", source: "cache", cacheOnly: true, degraded: true },
    });
    expect(queryIntegrationOptions).toHaveBeenCalledWith({
      providerKey: "tcgdex",
      queryKind: "expansions",
      languageCode: "en",
      parentValue: "me",
      cursor: "offset:1",
      limit: 1,
      forceRefresh: true,
    });
  });

  it("returns unavailable when cache-only provider option queries have no cached page", async () => {
    const services = {
      queryIntegrationOptions: vi.fn(async () => {
        throw new CatalogProviderOptionQueryUnavailableError(
          "Provider option query cache is empty for cache-only mode.",
        );
      }),
    } as unknown as SourceObservationRouteServices;
    const app = buildApp(services);

    const response = await app.request("/source-observations/integration-options?provider=tcgdex&kind=series");

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "catalog_provider_option_query_unavailable",
        message: "Provider option query cache is empty for cache-only mode.",
      },
    });
  });

  it("returns Catalog integration control-plane readiness grouped by ingestion unit", async () => {
    const getCatalogIntegrationControlPlaneReadiness = vi.fn(async () => ({
      generatedAt: "2026-06-05T00:00:00.000Z",
      units: [
        {
          unitKey: "reference-cards:pokemon:single-card:source-observation-proof",
          providerKey: "reference-cards",
          displayName: "Reference Pokemon single-card Source Observation proof",
          productDomain: "pokemon",
          productForm: "single-card",
          ingestionPurpose: "source-observation-proof",
          profileVersion: "reference-proof-2026.06.05",
          semanticReadiness: "ready",
          credentialReadiness: "not-required",
          credentialReadinessState: "not-required",
          credentialDiagnosticCode: null,
          transportReadiness: "ready",
          fixtureValidationStatus: "ready",
          dryRunStatus: "completed",
          observationFacts: 1,
          diagnosticCounts: { info: 1, warning: 0, error: 0 },
          latestDiagnosticText:
            "Reference provider uses fixture-backed payloads and does not require live provider transport.",
          dryRunEvidence: [
            {
              externalKey: "pokemon:abra-43",
              sourceUrl: "fixture://reference-cards/pokemon/abra-43.json",
              sourceHash: "sha256:reference-cards-abra-43",
              normalizedFacts: {
                name: "Abra",
                cardNumber: "43",
                expansionName: "Reference Proof",
                rarity: "Common",
              },
            },
          ],
        },
      ],
    }));
    const services = {
      getCatalogIntegrationControlPlaneReadiness,
    } as unknown as SourceObservationRouteServices;
    const app = buildApp(services);

    const response = await app.request("/source-observations/integration-control-plane/readiness");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      units: [
        {
          unitKey: "reference-cards:pokemon:single-card:source-observation-proof",
          semanticReadiness: "ready",
          credentialReadiness: "not-required",
          dryRunStatus: "completed",
          dryRunEvidence: [expect.objectContaining({ externalKey: "pokemon:abra-43" })],
        },
      ],
    });
    expect(getCatalogIntegrationControlPlaneReadiness).toHaveBeenCalledOnce();
  });

  it("returns the Admin Control Plane overview with adapter readiness and lifecycle audit entries", async () => {
    const getCatalogIntegrationControlPlaneReadiness = vi.fn(async () => ({
      generatedAt: "2026-06-05T00:00:00.000Z",
      units: [
        {
          unitKey: "tcgdex:pokemon:single-card:source-observation-import",
          providerKey: "tcgdex",
          displayName: "TCGdex Pokemon single-card Source Observation import",
          productDomain: "pokemon",
          productForm: "single-card",
          ingestionPurpose: "source-observation-import",
          profileVersion: "2026.06.04",
          semanticReadiness: "ready",
          credentialReadiness: "not-required",
          credentialReadinessState: "not-required",
          credentialRequirement: "not-required",
          credentialDiagnosticCode: null,
          transportReadiness: "ready",
          fixtureValidationStatus: "ready",
          dryRunStatus: "completed",
          observationFacts: 1,
          diagnosticCounts: { info: 1, warning: 0, error: 0 },
          diagnostics: [
            {
              code: "tcgdex-payload-fetch-ready",
              severity: "info",
              message: "TCGdex payload acquisition is ready.",
              unitKey: "tcgdex:pokemon:single-card:source-observation-import",
              retryAfterSeconds: null,
              source: "provider-adapter",
            },
          ],
          latestDiagnosticText: "TCGdex payload acquisition is ready.",
          dryRunEvidence: [],
        },
      ],
    }));
    const listActiveIntegrationJobs = vi.fn(async () => [
      integrationJobFixture({
        jobId: "job_import_base",
        action: "import",
        scope: { provider: "tcgdex", language: "en", setId: "base1" },
        profileSnapshot: {
          providerKey: "tcgdex",
          profileKey: "pokemon-tcg",
          profileVersion: "2026.06.04",
          lifecycle: "active",
          connectorKind: "tcgdex-json",
          connectorSourceVersion: null,
          sourceMappingFingerprint: "fingerprint",
        },
        operatorStatus: "running",
        progress: {
          phase: "processing",
          completed: 1,
          total: 2,
          currentName: "Base Set",
          status: "imported",
        },
        startedAt: "2026-06-05T00:01:00.000Z",
      }),
    ]);
    const services = {
      getCatalogIntegrationControlPlaneReadiness,
      listActiveIntegrationJobs,
    } as unknown as SourceObservationRouteServices;
    const store = mutableProfileStore([
      profileVersion("tcgdex", {
        profileVersion: "2026.06.04",
        lifecycle: "active",
        active: true,
        authoringAudit: {
          createdAt: "2026-06-05T00:00:00.000Z",
          createdByUserId: "usr_test",
          createdForAccountId: "acc_test",
        },
      }),
    ]);
    const app = buildApp(services, store);

    const response = await app.request("/source-observations/integration-control-plane/overview");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      readiness: {
        units: [
          {
            unitKey: "tcgdex:pokemon:single-card:source-observation-import",
            semanticReadiness: "ready",
          },
        ],
      },
      unitActivity: {
        units: [
          {
            unitKey: "tcgdex:pokemon:single-card:source-observation-import",
            recentJobs: [
              {
                jobId: "job_import_base",
                action: "import",
                operatorStatus: "running",
                completed: 1,
                total: 2,
              },
            ],
          },
        ],
      },
      providerReadiness: {
        providers: [
          {
            providerKey: "tcgdex",
            readiness: "ready",
            payloadAcquisition: {
              status: "ready",
              diagnosticCodes: ["tcgdex-payload-fetch-ready"],
            },
          },
        ],
      },
      auditLifecycle: {
        projectionStatus: "partial",
        entries: expect.arrayContaining([
          expect.objectContaining({
            eventName: "profile-created",
            unitKey: "tcgdex:pokemon:single-card:source-observation-import",
            profileVersion: "2026.06.04",
          }),
          expect.objectContaining({
            eventName: "import-job-started",
            relatedJobId: "job_import_base",
          }),
        ]),
      },
    });
    expect(listActiveIntegrationJobs).toHaveBeenCalledWith({ context });
  });

  it("clones provider profile versions through the admin API", async () => {
    const services = {} as SourceObservationRouteServices;
    const store = mutableProfileStore();
    const app = buildApp(services, store);

    const response = await app.request("/source-observations/provider-profiles/tcgdex/2026.06.03/clone", {
      method: "POST",
      body: JSON.stringify({ targetProfileVersion: "2026.06.04" }),
      headers: { "content-type": "application/json" },
    });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      providerKey: "tcgdex",
      profileVersion: "2026.06.04",
      lifecycle: "draft",
      active: false,
      authoringAudit: {
        createdByUserId: "usr_test",
        createdForAccountId: "acc_test",
      },
    });
    await expect(store.getProfileVersion("tcgdex", "2026.06.04")).resolves.toMatchObject({
      executableMappingContract: {
        profileVersion: "2026.06.04",
        lifecycle: "draft",
      },
    });
  });

  it("updates provider profile sections through typed admin commands", async () => {
    const services = {} as SourceObservationRouteServices;
    const store = mutableProfileStore([
      ...catalogProviderIntegrationProfileVersions,
      profileVersion("tcgdex", {
        profileVersion: "2026.06.04",
        lifecycle: "draft",
        active: false,
      }),
    ]);
    const app = buildApp(services, store);

    const response = await app.request("/source-observations/provider-profiles/tcgdex/2026.06.04/sections/basics", {
      method: "PATCH",
      body: JSON.stringify({
        command: {
          displayName: "TCGdex Admin Candidate",
          lifecycle: "test",
          languageOptions: ["en", "fr"],
        },
      }),
      headers: { "content-type": "application/json" },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      displayName: "TCGdex Admin Candidate",
      lifecycle: "test",
      languageOptions: ["en", "fr"],
      authoringAudit: {
        updatedByUserId: "usr_test",
        updatedForAccountId: "acc_test",
      },
    });
  });

  it("returns a typed provider profile authoring model through the admin API", async () => {
    const getSelectedOptionAuthoringSchema = vi.fn(async () => ({
      dimensions: [
        {
          dimensionId: "dim_condition",
          dimensionKey: "condition",
          dimensionName: "Condition",
          status: "active",
          options: [
            {
              optionId: "opt_near_mint",
              optionKey: "near-mint",
              optionLabel: "Near Mint",
              status: "active",
            },
          ],
        },
      ],
    }));
    const getPromotionTargetAuthoringSchema = vi.fn(async () => ({
      blueprints: [{ id: "bp_pokemon", key: "pokemon-card-single", name: "Pokemon Card", status: "active" }],
      categories: [{ id: "cat_singles", key: "trading-card-singles", name: "Singles", status: "active" }],
      fields: [{ id: "fld_name", key: "card-name", name: "Card Name", status: "active" }],
    }));
    const services = {
      getSelectedOptionAuthoringSchema,
      getPromotionTargetAuthoringSchema,
    } as unknown as SourceObservationRouteServices;
    const store = mutableProfileStore([
      ...catalogProviderIntegrationProfileVersions,
      profileVersion("tcgdex", {
        profileVersion: "2026.06.04",
        lifecycle: "draft",
        active: false,
      }),
    ]);
    const app = buildApp(services, store);

    const response = await app.request("/source-observations/provider-profiles/tcgdex/2026.06.04/authoring");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      review: {
        providerKey: "tcgdex",
        profileVersion: "2026.06.04",
      },
      editableSections: expect.arrayContaining([
        expect.objectContaining({
          section: "provider-options",
          rawJsonBacked: false,
        }),
      ]),
      dryRunInputTemplate: {
        defaultFlow: "normal",
      },
      activationReadiness: {
        status: "blocked",
      },
      selectedOptionSchema: {
        dimensions: [
          expect.objectContaining({
            dimensionKey: "condition",
            options: [expect.objectContaining({ optionKey: "near-mint" })],
          }),
        ],
      },
      promotionTargetSchema: {
        blueprints: [expect.objectContaining({ key: "pokemon-card-single" })],
        categories: [expect.objectContaining({ key: "trading-card-singles" })],
        fields: [expect.objectContaining({ key: "card-name" })],
      },
    });
    expect(getSelectedOptionAuthoringSchema).toHaveBeenCalledOnce();
    expect(getPromotionTargetAuthoringSchema).toHaveBeenCalledOnce();
  });

  it("enriches provider profile dry-runs with duplicate-prevention candidate previews", async () => {
    const previewDuplicatePreventionCandidates = vi.fn(async () => ({
      status: "blocked" as const,
      ruleKey: "deterministic-card",
      candidateCount: 2,
      candidateCatalogItemIds: ["cat_existing_1", "cat_existing_2"],
      diagnosticText: "Duplicate-prevention rule produced multiple reusable candidates.",
      evidenceSummary: {
        ruleKey: "deterministic-card",
        matchKind: "deterministic-pokemon-card-field-match",
        evidenceText: "deterministic Pokemon card field identity",
        candidateCatalogItemIds: ["cat_existing_1", "cat_existing_2"],
      },
      evidenceSummaries: [],
    }));
    const services = { previewDuplicatePreventionCandidates } as unknown as SourceObservationRouteServices;
    const store = mutableProfileStore([
      ...catalogProviderIntegrationProfileVersions,
      profileVersion("tcgdex", {
        profileVersion: "2026.06.04",
        lifecycle: "draft",
        active: false,
      }),
    ]);
    const app = buildApp(services, store);

    const response = await app.request("/source-observations/provider-profiles/tcgdex/2026.06.04/dry-run", {
      method: "POST",
      body: JSON.stringify({ payload: { id: "fixture_1" } }),
      headers: { "content-type": "application/json" },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      duplicatePreventionCandidatePreview: {
        status: "blocked",
        ruleKey: "deterministic-card",
        candidateCount: 2,
        candidateCatalogItemIds: ["cat_existing_1", "cat_existing_2"],
      },
    });
    expect(previewDuplicatePreventionCandidates).toHaveBeenCalledWith({
      providerKey: "tcgdex",
      profileVersion: "2026.06.04",
      payload: { id: "fixture_1" },
      observedAt: "1970-01-01T00:00:00.000Z",
    });
  });

  it("returns structured bad requests for invalid profile section commands", async () => {
    const services = {} as SourceObservationRouteServices;
    const store = mutableProfileStore([
      profileVersion("tcgdex", {
        profileVersion: "2026.06.04",
        lifecycle: "draft",
        active: false,
      }),
    ]);
    const app = buildApp(services, store);

    const response = await app.request("/source-observations/provider-profiles/tcgdex/2026.06.04/sections/fixtures", {
      method: "PATCH",
      body: JSON.stringify({
        fixtures: {
          fixtureRoot: "bounded-contexts/catalog/fixtures/source-observations/tcgdex",
          coveredFlows: ["normal"],
          liveProviderCallsAllowed: true,
        },
      }),
      headers: { "content-type": "application/json" },
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "invalid_profile_section_command",
        message: "fixtures.liveProviderCallsAllowed must remain false.",
      },
    });
  });

  it("returns structured bad requests for empty deep profile section commands", async () => {
    const services = {} as SourceObservationRouteServices;
    const store = mutableProfileStore([
      profileVersion("tcgdex", {
        profileVersion: "2026.06.04",
        lifecycle: "draft",
        active: false,
      }),
    ]);
    const app = buildApp(services, store);

    const response = await app.request(
      "/source-observations/provider-profiles/tcgdex/2026.06.04/sections/normalized-observation",
      {
        method: "PATCH",
        body: JSON.stringify({ command: {} }),
        headers: { "content-type": "application/json" },
      },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "invalid_profile_section_command",
        message: "Profile section 'normalized-observation' must include at least one editable field.",
      },
    });
  });

  it("returns a structured bad request for invalid provider profile authoring JSON", async () => {
    const services = {} as SourceObservationRouteServices;
    const app = buildApp(services, mutableProfileStore());

    const response = await app.request("/source-observations/provider-profiles/tcgdex/2026.06.03/clone", {
      method: "POST",
      body: "{",
      headers: { "content-type": "application/json" },
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "invalid_json_body",
        message: "Expected a valid JSON object request body.",
      },
    });
  });

  it("returns structured diagnostics when provider profile activation is blocked", async () => {
    const services = {} as SourceObservationRouteServices;
    const store = mutableProfileStore();
    const app = buildApp(services, store);
    await app.request("/source-observations/provider-profiles/tcgdex/2026.06.03/clone", {
      method: "POST",
      body: JSON.stringify({ targetProfileVersion: "2026.06.04" }),
      headers: { "content-type": "application/json" },
    });

    const response = await app.request("/source-observations/provider-profiles/tcgdex/2026.06.04/activate", {
      method: "POST",
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "profile_activation_blocked",
        diagnostics: expect.arrayContaining([
          expect.objectContaining({
            code: "fixture-harness-failure",
            path: "fixtures.coveredFlows.normal",
            severity: "error",
          }),
        ]),
      },
    });
  });

  it("returns a conflict when provider profile activation races active provider jobs", async () => {
    const listActiveIntegrationJobs = vi.fn(async () => [
      integrationJobFixture({
        jobId: "job_import_tcgdex",
        action: "import",
        status: "running",
        scope: { provider: "tcgdex", language: "en" },
        profileSnapshot: {
          providerKey: "tcgdex",
          profileKey: "pokemon-tcg",
          profileVersion: "2026.06.03",
          lifecycle: "active",
          connectorKind: "tcgdex-json",
          connectorSourceVersion: null,
          sourceMappingFingerprint: "sha256:before",
        },
      }),
    ]);
    const listActiveBulkReviewJobs = vi.fn(async () => [
      bulkJobFixture({
        jobId: "job_promote_selected",
        action: "promote",
        status: "queued",
        scope: { provider: "tcgdex" },
      }),
    ]);
    const services = {
      listActiveIntegrationJobs,
      listActiveBulkReviewJobs,
    } as unknown as SourceObservationRouteServices;
    const store = mutableProfileStore();
    const app = buildApp(services, store);
    await app.request("/source-observations/provider-profiles/tcgdex/2026.06.03/clone", {
      method: "POST",
      body: JSON.stringify({ targetProfileVersion: "2026.06.04" }),
      headers: { "content-type": "application/json" },
    });

    const response = await app.request("/source-observations/provider-profiles/tcgdex/2026.06.04/activate", {
      method: "POST",
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "profile_lifecycle_job_conflict",
        blockingJobs: [
          expect.objectContaining({
            jobId: "job_import_tcgdex",
            jobKind: "integration",
            action: "import",
            profileVersion: "2026.06.03",
          }),
          expect.objectContaining({
            jobId: "job_promote_selected",
            jobKind: "bulk-review",
            action: "promote",
          }),
        ],
      },
    });
    expect(listActiveIntegrationJobs).toHaveBeenCalledWith({ context });
    expect(listActiveBulkReviewJobs).toHaveBeenCalledWith({ context });
  });

  it("returns rollout evidence when provider profile activation is disabled", async () => {
    const assertCatalogIntegrationRolloutAllowed = vi.fn(() => {
      throw rolloutDenied({ capability: "activation", providerKey: "tcgdex", profileLifecycle: "test" });
    });
    const services = {
      assertCatalogIntegrationRolloutAllowed,
    } as unknown as SourceObservationRouteServices;
    const store = mutableProfileStore();
    const app = buildApp(services, store);

    const response = await app.request("/source-observations/provider-profiles/tcgdex/2026.06.03/activate", {
      method: "POST",
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "catalog_integration_rollout_control_denied",
        capability: "activation",
        controlId: "activation-disabled",
      },
    });
    expect(assertCatalogIntegrationRolloutAllowed).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: "activation",
        providerKey: "tcgdex",
        profileLifecycle: "active",
      }),
    );
  });

  it("enqueues provider integration jobs with normalized scope aliases", async () => {
    const job = integrationJob({ status: "queued" });
    const enqueueIntegrationJob = vi.fn(async () => job);
    const services = {
      enqueueIntegrationJob,
    } as unknown as SourceObservationRouteServices;
    const app = buildApp(services);

    const response = await app.request("/source-observations/integration-jobs", {
      method: "POST",
      body: JSON.stringify({
        action: "import",
        scope: { source: "tcgdex", languageCode: "en", expansionId: "base1", seriesId: "base" },
      }),
      headers: { "content-type": "application/json" },
    });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({ jobId: "job_integration", action: "import" });
    expect(enqueueIntegrationJob).toHaveBeenCalledWith({
      action: "import",
      scope: {
        provider: "tcgdex",
        language: "en",
        seriesId: "base",
        setId: "base1",
      },
      context,
    });
  });

  it("enqueues TCGplayer integration jobs with provider-product scope aliases", async () => {
    const job = integrationJob({ status: "queued" });
    const enqueueIntegrationJob = vi.fn(async () => job);
    const services = {
      enqueueIntegrationJob,
    } as unknown as SourceObservationRouteServices;
    const app = buildApp(services);

    const response = await app.request("/source-observations/integration-jobs", {
      method: "POST",
      body: JSON.stringify({
        action: "import",
        scope: {
          source: "tcgplayer",
          languageCode: "en",
          categoryId: "3",
          cleanSetName: "Base Set",
          tcgplayerProductId: "12345",
        },
      }),
      headers: { "content-type": "application/json" },
    });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({ jobId: "job_integration", action: "import" });
    expect(enqueueIntegrationJob).toHaveBeenCalledWith({
      action: "import",
      scope: {
        provider: "tcgplayer",
        language: "en",
        productLineId: "3",
        setName: "Base Set",
        productId: "12345",
      },
      context,
    });
  });

  it("returns a validation error when a provider integration job is not importable", async () => {
    const enqueueIntegrationJob = vi.fn(async () => {
      throw new Error("Provider 'tcgplayer' does not support background import.");
    });
    const services = {
      enqueueIntegrationJob,
    } as unknown as SourceObservationRouteServices;
    const app = buildApp(services);

    const response = await app.request("/source-observations/integration-jobs", {
      method: "POST",
      body: JSON.stringify({
        action: "import",
        scope: { source: "tcgplayer", categoryId: "3", cleanSetName: "Base Set" },
      }),
      headers: { "content-type": "application/json" },
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "invalid_scope",
        message: "Provider 'tcgplayer' does not support background import.",
      },
    });
    expect(enqueueIntegrationJob).toHaveBeenCalledWith({
      action: "import",
      scope: {
        provider: "tcgplayer",
        productLineId: "3",
        setName: "Base Set",
      },
      context,
    });
  });

  it("lists active provider integration jobs for the current request context", async () => {
    const activeJob = integrationJob({ status: "running" });
    const listActiveIntegrationJobs = vi.fn(async () => [activeJob]);
    const services = {
      listActiveIntegrationJobs,
    } as unknown as SourceObservationRouteServices;
    const app = buildApp(services);

    const response = await app.request("/source-observations/integration-jobs/active");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      total: 1,
      count: 1,
      items: [{ jobId: "job_integration", action: "import", status: "running" }],
    });
    expect(listActiveIntegrationJobs).toHaveBeenCalledWith({ context });
  });

  it("streams provider integration job status events until completion", async () => {
    const completedJob = integrationJob({ status: "completed" });
    const getIntegrationJob = vi.fn(async () => completedJob);
    const listIntegrationJobEvents = vi.fn(async () => [jobEvent(completedJob)]);
    const services = {
      getIntegrationJob,
      listIntegrationJobEvents,
    } as unknown as SourceObservationRouteServices;
    const app = buildApp(services);

    const response = await app.request("/source-observations/integration-jobs/job_integration/events");

    expect(response.status).toBe(200);
    const events = await response.text();
    expect(events).toContain("id: 1");
    expect(events).toContain("event: status");
    expect(events).toContain('"jobId":"job_integration"');
    expect(events).toContain('"status":"completed"');
    expect(getIntegrationJob).toHaveBeenCalledWith("job_integration", context);
    expect(listIntegrationJobEvents).toHaveBeenCalledWith("job_integration", 0);
  });

  it("enqueues bulk promotion jobs for observations matching an explicit filter scope", async () => {
    const job = bulkJobFixture({
      jobId: "job_promote_scope",
      action: "promote",
      selectionMode: "filter",
      scope: { status: "observed", language: "en", setId: "base1" },
    });
    const enqueueBulkReviewJob = vi.fn(async () => job);
    const services = {
      enqueueBulkReviewJob,
    } as unknown as SourceObservationRouteServices;
    const app = buildApp(services);

    const response = await app.request("/source-observations/bulk-promote", {
      method: "POST",
      body: JSON.stringify({
        scope: { status: "observed", language: "en", setId: "base1" },
      }),
      headers: { "content-type": "application/json" },
    });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      jobId: "job_promote_scope",
      action: "promote",
      status: "queued",
    });
    expect(enqueueBulkReviewJob).toHaveBeenCalledWith({
      action: "promote",
      observationIds: [],
      scope: {
        search: undefined,
        status: "observed",
        provider: undefined,
        language: "en",
        setId: "base1",
      },
      context,
    });
  });

  it("returns rollout evidence when bulk promotion is disabled", async () => {
    const enqueueBulkReviewJob = vi.fn(async () => {
      throw rolloutDenied({ capability: "promotion", providerKey: "tcgdex" });
    });
    const services = {
      enqueueBulkReviewJob,
    } as unknown as SourceObservationRouteServices;
    const app = buildApp(services);

    const response = await app.request("/source-observations/bulk-promote", {
      method: "POST",
      body: JSON.stringify({
        scope: { source: "tcgdex", status: "observed", language: "en", setId: "base1" },
      }),
      headers: { "content-type": "application/json" },
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "catalog_integration_rollout_control_denied",
        capability: "promotion",
        controlId: "promotion-disabled",
      },
    });
  });

  it("previews filter-scoped reapply for promoted observations", async () => {
    const previewReapplyObservationScope = vi.fn(async () => ({
      matched: 102,
      eligible: 88,
      ineligible: 14,
      scope: {
        search: "",
        status: "",
        provider: "tcgdex",
        language: "en",
        setId: "base1",
      },
    }));
    const services = {
      previewReapplyObservationScope,
    } as unknown as SourceObservationRouteServices;
    const app = buildApp(services);

    const response = await app.request("/source-observations/reapply/preview", {
      method: "POST",
      body: JSON.stringify({
        scope: { source: "tcgdex", language: "en", setId: "base1" },
      }),
      headers: { "content-type": "application/json" },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      matched: 102,
      eligible: 88,
      ineligible: 14,
    });
    expect(previewReapplyObservationScope).toHaveBeenCalledWith({
      scope: {
        search: undefined,
        status: undefined,
        provider: "tcgdex",
        language: "en",
        setId: "base1",
      },
    });
  });

  it("enqueues reapply jobs for promoted observations matching an explicit filter scope", async () => {
    const job = integrationJobFixture({
      jobId: "job_reapply_scope",
      action: "reapply",
      scope: { provider: "tcgdex", language: "en", setId: "base1" },
    });
    const enqueueIntegrationJob = vi.fn(async () => job);
    const services = {
      enqueueIntegrationJob,
    } as unknown as SourceObservationRouteServices;
    const app = buildApp(services);

    const response = await app.request("/source-observations/reapply", {
      method: "POST",
      body: JSON.stringify({
        scope: { source: "tcgdex", language: "en", setId: "base1" },
      }),
      headers: { "content-type": "application/json" },
    });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      jobId: "job_reapply_scope",
      action: "reapply",
      status: "queued",
    });
    expect(enqueueIntegrationJob).toHaveBeenCalledWith({
      action: "reapply",
      scope: {
        provider: "tcgdex",
        language: "en",
        setId: "base1",
      },
      context,
    });
  });

  it("returns rollout evidence when reapply is disabled", async () => {
    const enqueueIntegrationJob = vi.fn(async () => {
      throw rolloutDenied({ capability: "reapply", providerKey: "tcgdex" });
    });
    const services = {
      enqueueIntegrationJob,
    } as unknown as SourceObservationRouteServices;
    const app = buildApp(services);

    const response = await app.request("/source-observations/reapply", {
      method: "POST",
      body: JSON.stringify({
        scope: { source: "tcgdex", language: "en", setId: "base1" },
      }),
      headers: { "content-type": "application/json" },
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "catalog_integration_rollout_control_denied",
        capability: "reapply",
        controlId: "reapply-disabled",
      },
    });
  });

  it("streams durable reapply job status events", async () => {
    const job = integrationJobFixture({
      jobId: "job_reapply_progress",
      action: "reapply",
      scope: { provider: "tcgdex", language: "en", setId: "base1" },
      status: "completed",
      progress: {
        phase: "processing",
        completed: 1,
        total: 2,
        currentName: "Bulbasaur",
        status: "reapplied",
      },
      result: {
        requested: 2,
        imported: 0,
        observed: 0,
        reapplied: 1,
        skipped: 1,
        failed: 0,
        outcomes: [],
      },
    });
    const getIntegrationJob = vi.fn(async () => job);
    const listIntegrationJobEvents = vi.fn(async () => [jobEvent(job)]);
    const services = {
      getIntegrationJob,
      listIntegrationJobEvents,
    } as unknown as SourceObservationRouteServices;
    const app = buildApp(services);

    const response = await app.request("/source-observations/integration-jobs/job_reapply_progress/events");

    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain("id: 1");
    expect(readSseData(text)).toEqual([job]);
    expect(listIntegrationJobEvents).toHaveBeenCalledWith("job_reapply_progress", 0);
  });

  it("enqueues bulk promotion jobs for explicit observation ids from the request body", async () => {
    const job = bulkJobFixture({
      jobId: "job_promote_ids",
      action: "promote",
      observationIds: ["obs_1", "obs_2"],
    });
    const enqueueBulkReviewJob = vi.fn(async () => job);
    const services = {
      enqueueBulkReviewJob,
    } as unknown as SourceObservationRouteServices;
    const app = buildApp(services);

    const response = await app.request("/source-observations/bulk-promote", {
      method: "POST",
      body: JSON.stringify({ observationIds: ["obs_1", "obs_2"] }),
      headers: { "content-type": "application/json" },
    });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      jobId: "job_promote_ids",
      action: "promote",
      status: "queued",
    });
    expect(enqueueBulkReviewJob).toHaveBeenCalledWith({
      action: "promote",
      observationIds: ["obs_1", "obs_2"],
      scope: undefined,
      context,
    });
  });

  it("streams bulk promotion job status events", async () => {
    const job = {
      jobId: "job_1",
      action: "promote",
      selectionMode: "filter",
      observationIds: [],
      scope: {},
      reason: null,
      status: "completed",
      progress: {
        phase: "processing",
        completed: 1,
        total: 2,
        currentName: "Bulbasaur",
        status: "promoted",
      },
      result: {
        requested: 2,
        promoted: 1,
        skipped: 1,
        failed: 0,
        outcomes: [],
      },
      errorMessage: null,
      createdAt: "2026-05-21T00:00:00.000Z",
      startedAt: "2026-05-21T00:00:01.000Z",
      completedAt: "2026-05-21T00:00:02.000Z",
      updatedAt: "2026-05-21T00:00:02.000Z",
    } as const;
    const getBulkReviewJob = vi.fn(async () => job);
    const listBulkReviewJobEvents = vi.fn(async () => [jobEvent(job)]);
    const services = {
      getBulkReviewJob,
      listBulkReviewJobEvents,
    } as unknown as SourceObservationRouteServices;
    const app = buildApp(services);

    const response = await app.request("/source-observations/bulk-jobs/job_1/events");

    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain("id: 1");
    expect(readSseData(text)).toEqual([job]);
    expect(getBulkReviewJob).toHaveBeenCalledWith("job_1", context);
    expect(listBulkReviewJobEvents).toHaveBeenCalledWith("job_1", 0);
  });

  it("requires a reason for bulk rejection", async () => {
    const services = {
      rejectObservations: vi.fn(),
    } as unknown as SourceObservationRouteServices;
    const app = buildApp(services);

    const response = await app.request("/source-observations/bulk-reject", {
      method: "POST",
      body: JSON.stringify({ observationIds: ["obs_1"], reason: " " }),
      headers: { "content-type": "application/json" },
    });

    expect(response.status).toBe(400);
    expect(services.rejectObservations).not.toHaveBeenCalled();
  });

  it("enqueues bulk rejection jobs for explicit observation ids with the shared reason", async () => {
    const job = bulkJobFixture({
      jobId: "job_reject_ids",
      action: "reject",
      observationIds: ["obs_1", "obs_2"],
      reason: "Duplicate provider row.",
    });
    const enqueueBulkReviewJob = vi.fn(async () => job);
    const services = {
      enqueueBulkReviewJob,
    } as unknown as SourceObservationRouteServices;
    const app = buildApp(services);

    const response = await app.request("/source-observations/bulk-reject", {
      method: "POST",
      body: JSON.stringify({
        observationIds: ["obs_1", "obs_2"],
        reason: "Duplicate provider row.",
      }),
      headers: { "content-type": "application/json" },
    });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      jobId: "job_reject_ids",
      action: "reject",
      status: "queued",
    });
    expect(enqueueBulkReviewJob).toHaveBeenCalledWith({
      action: "reject",
      observationIds: ["obs_1", "obs_2"],
      scope: undefined,
      reason: "Duplicate provider row.",
      context,
    });
  });

  it("enqueues bulk rejection jobs for observations matching an explicit filter scope", async () => {
    const job = bulkJobFixture({
      jobId: "job_reject_scope",
      action: "reject",
      scope: { status: "observed", provider: "tcgdex", language: "en", setId: "base1" },
      reason: "Out of scope.",
    });
    const enqueueBulkReviewJob = vi.fn(async () => job);
    const services = {
      enqueueBulkReviewJob,
    } as unknown as SourceObservationRouteServices;
    const app = buildApp(services);

    const response = await app.request("/source-observations/bulk-reject", {
      method: "POST",
      body: JSON.stringify({
        scope: { status: "observed", source: "tcgdex", language: "en", setId: "base1" },
        reason: "Out of scope.",
      }),
      headers: { "content-type": "application/json" },
    });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      jobId: "job_reject_scope",
      action: "reject",
      status: "queued",
    });
    expect(enqueueBulkReviewJob).toHaveBeenCalledWith({
      action: "reject",
      observationIds: [],
      scope: {
        search: undefined,
        status: "observed",
        provider: "tcgdex",
        language: "en",
        setId: "base1",
      },
      reason: "Out of scope.",
      context,
    });
  });

  it("streams bulk rejection job status events", async () => {
    const job = {
      jobId: "job_2",
      action: "reject",
      selectionMode: "ids",
      observationIds: ["obs_1"],
      scope: {},
      reason: "Duplicate provider row.",
      status: "completed",
      progress: {
        phase: "processing",
        completed: 1,
        total: 1,
        currentName: "Ivysaur",
        status: "rejected",
      },
      result: {
        requested: 1,
        promoted: 0,
        rejected: 1,
        skipped: 0,
        failed: 0,
        outcomes: [],
      },
      errorMessage: null,
      createdAt: "2026-05-21T00:00:00.000Z",
      startedAt: "2026-05-21T00:00:01.000Z",
      completedAt: "2026-05-21T00:00:02.000Z",
      updatedAt: "2026-05-21T00:00:02.000Z",
    } as const;
    const getBulkReviewJob = vi.fn(async () => job);
    const listBulkReviewJobEvents = vi.fn(async () => [jobEvent(job)]);
    const services = {
      getBulkReviewJob,
      listBulkReviewJobEvents,
    } as unknown as SourceObservationRouteServices;
    const app = buildApp(services);

    const response = await app.request("/source-observations/bulk-jobs/job_2/events");

    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain("id: 1");
    expect(readSseData(text)).toEqual([job]);
    expect(listBulkReviewJobEvents).toHaveBeenCalledWith("job_2", 0);
  });

  it("lists active bulk review jobs for the current request context", async () => {
    const activeJob = {
      jobId: "job_active",
      action: "promote",
      selectionMode: "filter",
      observationIds: [],
      scope: { status: "observed" },
      reason: null,
      status: "running",
      progress: {
        phase: "processing",
        completed: 12,
        total: 100,
        currentName: "Pikachu",
        status: "promoted",
      },
      result: null,
      errorMessage: null,
      createdAt: "2026-05-21T00:00:00.000Z",
      startedAt: "2026-05-21T00:00:01.000Z",
      completedAt: null,
      updatedAt: "2026-05-21T00:00:02.000Z",
    } as const;
    const listActiveBulkReviewJobs = vi.fn(async () => [activeJob]);
    const services = {
      listActiveBulkReviewJobs,
    } as unknown as SourceObservationRouteServices;
    const app = buildApp(services);

    const response = await app.request("/source-observations/bulk-jobs/active");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      items: [
        {
          jobId: "job_active",
          action: "promote",
          selectionMode: "filter",
          status: "running",
          progress: {
            completed: 12,
            total: 100,
          },
        },
      ],
      total: 1,
      count: 1,
    });
    expect(listActiveBulkReviewJobs).toHaveBeenCalledWith({ context });
  });
});

function mutableProfileStore(
  initialRecords: readonly CatalogProviderIntegrationProfileVersionRecord[] = catalogProviderIntegrationProfileVersions,
): CatalogProviderIntegrationProfileVersionStore {
  let records: CatalogProviderIntegrationProfileVersionRecord[] = [...initialRecords];
  return {
    seedProfileVersions: async () => records,
    upsertProfileVersion: async (version) => {
      records = records.filter(
        (candidate) =>
          !(
            candidate.providerKey === version.providerKey &&
            candidate.profileKey === version.profileKey &&
            candidate.profileVersion === version.profileVersion
          ),
      );
      records = [...records, version];
      return version;
    },
    listProfileVersions: async (providerKey) =>
      records.filter((version) => !providerKey || version.providerKey === providerKey),
    getProfileVersion: async (providerKey, profileVersion) =>
      records.find((version) => version.providerKey === providerKey && version.profileVersion === profileVersion) ??
      null,
    getActiveProfileVersion: async (providerKey) =>
      records.find(
        (version) => version.providerKey === providerKey && version.active && version.lifecycle === "active",
      ) ?? null,
    activateProfileVersion: async (providerKey, profileVersion) =>
      updateProfileVersion(records, providerKey, profileVersion, "active", true),
    deprecateProfileVersion: async (providerKey, profileVersion) =>
      updateProfileVersion(records, providerKey, profileVersion, "deprecated", false),
    rollbackProfileVersion: async (providerKey, profileVersion) =>
      updateProfileVersion(records, providerKey, profileVersion, "active", true),
    countProfileVersionReferences: async () => 0,
  };

  function updateProfileVersion(
    current: CatalogProviderIntegrationProfileVersionRecord[],
    providerKey: string,
    profileVersion: string,
    lifecycle: CatalogProviderIntegrationProfileVersionRecord["lifecycle"],
    active: boolean,
  ): CatalogProviderIntegrationProfileVersionRecord {
    const version = current.find(
      (candidate) => candidate.providerKey === providerKey && candidate.profileVersion === profileVersion,
    );
    if (!version) {
      throw new Error("Profile version not found.");
    }
    const updated = {
      ...version,
      lifecycle,
      active,
      executableMappingContract: version.executableMappingContract
        ? { ...version.executableMappingContract, lifecycle }
        : undefined,
    };
    records = current.map((candidate) => (candidate === version ? updated : candidate));
    return updated;
  }
}

function profileVersion(
  providerKey: string,
  overrides: Partial<CatalogProviderIntegrationProfileVersionRecord>,
): CatalogProviderIntegrationProfileVersionRecord {
  const base = catalogProviderIntegrationProfileVersions.find((version) => version.providerKey === providerKey);
  if (!base) {
    throw new Error(`Expected seeded ${providerKey} provider profile version.`);
  }

  const nextProfileVersion = overrides.profileVersion ?? base.profileVersion;
  const nextLifecycle = overrides.lifecycle ?? base.lifecycle;

  return {
    ...base,
    ...overrides,
    profileVersion: nextProfileVersion,
    lifecycle: nextLifecycle,
    executableMappingContract: base.executableMappingContract
      ? {
          ...base.executableMappingContract,
          profileVersion: nextProfileVersion,
          lifecycle: nextLifecycle,
        }
      : undefined,
  };
}

function jobEvent<TJob>(job: TJob, sequence = 1) {
  return {
    sequence,
    eventName: "status" as const,
    job,
    createdAt: "2026-05-28T00:00:00.000Z",
  };
}

function readSseData(text: string): unknown[] {
  return text
    .split("\n\n")
    .map((frame) => frame.trim())
    .filter(Boolean)
    .map((frame) => frame.split("\n").find((line) => line.startsWith("data:")))
    .filter((line): line is string => Boolean(line))
    .map((line) => JSON.parse(line.slice("data:".length).trim()));
}

function integrationJob(input: { status: "queued" | "running" | "completed" | "failed" }) {
  return integrationJobFixture({
    jobId: "job_integration",
    action: "import",
    scope: { provider: "tcgdex", language: "en", seriesId: "base" },
    status: input.status,
    progress: {
      phase: input.status === "completed" ? "completed" : "processing",
      completed: input.status === "completed" ? 1 : 0,
      total: 1,
      currentName: "Base Set",
      status: input.status === "completed" ? "imported" : null,
    },
    result:
      input.status === "completed"
        ? {
            requested: 1,
            imported: 1,
            observed: 102,
            reapplied: 0,
            skipped: 0,
            failed: 0,
            outcomes: [],
          }
        : null,
    errorMessage: null,
    createdAt: "2026-05-23T00:00:00.000Z",
    startedAt: input.status === "queued" ? null : "2026-05-23T00:00:01.000Z",
    completedAt: input.status === "completed" ? "2026-05-23T00:00:02.000Z" : null,
    updatedAt: "2026-05-23T00:00:02.000Z",
  });
}

function integrationJobFixture(
  input: Record<string, unknown> & {
    jobId?: string;
    action?: "import" | "reapply";
  },
) {
  return {
    ...baseIntegrationJob(),
    ...input,
  } as const;
}

function baseIntegrationJob() {
  return {
    jobId: "job_integration",
    action: "import" as const,
    scope: { provider: "tcgdex", language: "en", seriesId: "base" },
    status: "queued" as const,
    progress: {
      phase: "queued" as const,
      completed: 0,
      total: 0,
      currentName: null,
      status: null,
    },
    result: null as null | Record<string, unknown>,
    errorMessage: null,
    createdAt: "2026-05-23T00:00:00.000Z",
    startedAt: null as string | null,
    completedAt: null as string | null,
    updatedAt: "2026-05-23T00:00:02.000Z",
  };
}

function bulkJobFixture(
  input: Record<string, unknown> & {
    jobId?: string;
    action?: "promote" | "reject" | "reapply";
  },
) {
  return {
    ...baseBulkJob(),
    ...input,
  } as const;
}

function baseBulkJob() {
  return {
    jobId: "job_bulk",
    action: "promote" as const,
    selectionMode: "ids" as const,
    observationIds: [] as readonly string[],
    scope: {},
    reason: null as string | null,
    status: "queued" as const,
    progress: {
      phase: "queued" as const,
      completed: 0,
      total: 0,
      currentName: null,
      status: null,
    },
    result: null as null | Record<string, unknown>,
    errorMessage: null,
    createdAt: "2026-05-21T00:00:00.000Z",
    startedAt: null as string | null,
    completedAt: null as string | null,
    updatedAt: "2026-05-21T00:00:00.000Z",
  };
}
