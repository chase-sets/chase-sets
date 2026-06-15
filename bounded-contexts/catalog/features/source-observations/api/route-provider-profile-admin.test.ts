import { describe, expect, it, vi } from "vitest";
import type { SourceObservationRouteServices } from "./route";
import { catalogProviderIntegrationProfileVersions } from "./provider-integration-profiles";
import { CatalogProviderOptionQueryUnavailableError } from "./provider-option-query-cache";
import {
  buildApp,
  bulkJobFixture,
  context,
  integrationJobFixture,
  jobEvent,
  mutableProfileStore,
  profileVersion,
  readSseData,
  rolloutDenied,
} from "./route-test-harness";

describe("source observation routes: integration discovery and profile administration", () => {
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
      "/source-observations/integration-options?provider=tcgdex&kind=expansions&language=en&seriesId=me&cursor=offset:1&limit=1&forceRefresh=true&cacheOnly=true",
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
      cacheOnly: true,
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
        result: {
          requested: 2,
          imported: 1,
          observed: 102,
          reapplied: 0,
          skipped: 0,
          failed: 1,
          outcomes: [
            {
              providerKey: "tcgdex",
              languageCode: "en",
              expansionId: "base1",
              status: "imported",
              observed: 102,
              reapplied: 0,
              reason: null,
            },
            {
              providerKey: "tcgdex",
              languageCode: "en",
              expansionId: "jungle",
              status: "failed",
              observed: 0,
              reapplied: 0,
              reason: "Provider timeout while fetching expansion.",
            },
          ],
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
    const json = await response.json();
    expect(json).toMatchObject({
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
                result: {
                  requested: 2,
                  imported: 1,
                  observed: 102,
                  reapplied: 0,
                  skipped: 0,
                  failed: 1,
                  outcomeCount: 2,
                },
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
    expect(json.unitActivity.units[0].recentJobs[0].result).not.toHaveProperty("outcomes");
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

  it("answers the authoring-model fetch with 404 when the profile version does not resolve", async () => {
    // A deep-link can carry a stale/unknown profileVersion. The endpoint must
    // signal not-found distinctly (404) rather than a server error (500) so the
    // admin loader can recover into the absent-authoring-model state.
    const services = {
      getSelectedOptionAuthoringSchema: vi.fn(async () => ({ dimensions: [] })),
      getPromotionTargetAuthoringSchema: vi.fn(async () => ({ blueprints: [], categories: [], fields: [] })),
    } as unknown as SourceObservationRouteServices;
    const store = mutableProfileStore([...catalogProviderIntegrationProfileVersions]);
    const app = buildApp(services, store);

    const response = await app.request("/source-observations/provider-profiles/tcgdex/2099.01.01-unknown/authoring");

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "profile_version_not_found" },
    });
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
});
