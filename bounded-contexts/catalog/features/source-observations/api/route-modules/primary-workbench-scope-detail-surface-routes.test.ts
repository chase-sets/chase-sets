import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SourceObservationRouteServices } from "../route";
import { buildApp, manageActor, mutableProfileStore } from "./route-test-harness";
import {
  catalogScopeDetailDailyLocation,
  type CatalogScopeDetailWorkbenchScope,
} from "../admin/scope-detail-workbench-location";
import {
  controlPlaneOverview,
  sourceObservationListItem,
  sourceObservationScope,
} from "../../ui/primary-workbench-test-fixtures";

// https://github.com/chase-sets/chase-sets/issues/11131: Scope Detail sends its own address, and the daily
// surface derives the working set from the Scope Record that address names.
const NOW = "2026-07-14T12:00:00.000Z";
const SCOPE_PATH = "/catalog/scopes/scope_expansion_paldean_fates?languageCode=ja&jobId=sync_1";

const paldeanFates: CatalogScopeDetailWorkbenchScope = {
  scopeRecordId: "scope_expansion_paldean_fates",
  productDomain: "pokemon",
  scopeKind: "expansion",
  name: "Paldean Fates",
  productLineScopeRecordId: "scope_product_line_pokemon",
  seriesScopeRecordId: "scope_series_scarlet_violet",
  languageEditions: ["en", "ja"],
};

function services() {
  return {
    listIntegrationScopes: vi.fn(async () => [sourceObservationScope({ provider_key: "tcgdex" })]),
    getCatalogIntegrationControlPlaneReadiness: vi.fn(async () => ({
      ...controlPlaneOverview().readiness,
      generatedAt: NOW,
      providerUsage: [],
    })),
    listRecentIntegrationJobs: vi.fn(async () => []),
    listActiveIntegrationJobs: vi.fn(async () => []),
    listSourceObservations: vi.fn(async () => ({ items: [sourceObservationListItem()], total: 1 })),
    listCatalogMergeCandidates: vi.fn(async () => ({ items: [], total: 0, count: 0 })),
  } as unknown as SourceObservationRouteServices;
}

function app(getScopeRecord?: (id: string) => Promise<CatalogScopeDetailWorkbenchScope | null>) {
  return buildApp(services(), mutableProfileStore(), manageActor, undefined, getScopeRecord);
}

function surfacePath(path: string, location: string): string {
  return `/source-observations/workbench-surfaces/${path}?${new URLSearchParams({ location })}`;
}

function dailyLocationFor(scopePath: string): string {
  const url = catalogScopeDetailDailyLocation(new URL(scopePath, "https://admin.example"), paldeanFates);
  return `${url.pathname}${url.search}`;
}

async function read(target: ReturnType<typeof app>, path: string) {
  const response = await target.request(path);
  return { status: response.status, body: await response.json() };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Catalog daily surface for a Scope Detail location", () => {
  it("reads one daily overview per verified Scope and isolates two same-provider journeys", async () => {
    const source = services();
    const readiness: Awaited<ReturnType<SourceObservationRouteServices["getCatalogIntegrationControlPlaneReadiness"]>> =
      {
        ...controlPlaneOverview().readiness,
        rolloutControls: { generatedAt: NOW, controls: [] },
        providerUsage: [],
      };
    vi.mocked(source.getCatalogIntegrationControlPlaneReadiness).mockResolvedValue({
      ...readiness,
      units: [
        ...readiness.units,
        {
          ...readiness.units[0]!,
          unitKey: "other:magic:card:import",
          providerKey: "other",
          productDomain: "magic",
          displayName: "Foreign health facts",
        },
      ],
    });
    vi.mocked(source.listIntegrationScopes).mockResolvedValue([
      sourceObservationScope(),
      sourceObservationScope({ expansion_id: "base2", expansion_name: "Base Set 2" }),
    ]);
    const job: Awaited<ReturnType<SourceObservationRouteServices["listRecentIntegrationJobs"]>>[number] = {
      jobId: "scope-one-job",
      syncRunId: null,
      action: "import",
      scope: {
        provider: "tcgdex",
        ingestionUnitKey: "tcgdex:pokemon:card:import",
        language: "en",
        productLineId: "3",
        seriesId: "base",
        setId: "base1",
      },
      profileSnapshot: null,
      reapplyProfileMode: null,
      status: "failed",
      operatorStatus: "failed",
      consistency: {
        duplicateSubmissionPolicy: "reuse-active-job",
        profileSnapshotPolicy: "snapshotted-at-enqueue",
        retryResumePolicy: "skip-completed-outcomes",
        partialFailurePolicy: "mixed-outcomes",
        workUnitClaimPolicy: "leased-job-turns",
      },
      progress: { phase: "failed", completed: 7, total: 24, currentName: null, status: null },
      result: null,
      errorMessage: null,
      createdAt: NOW,
      startedAt: NOW,
      completedAt: NOW,
      updatedAt: NOW,
    };
    vi.mocked(source.listRecentIntegrationJobs).mockResolvedValue([
      job,
      { ...job, jobId: "scope-two-job", scope: { ...job.scope, setId: "base2" } },
    ]);
    const getScopeRecord = vi.fn(async (id: string) => ({
      ...paldeanFates,
      scopeRecordId: id,
      name: id === "base1" ? "Base Set" : "Base Set 2",
      productLineScopeRecordId: "3",
      seriesScopeRecordId: "base",
    }));
    const target = buildApp(source, mutableProfileStore([]), manageActor, undefined, getScopeRecord);
    for (const [scopeId, ownJob, foreignJob] of [
      ["base1", "scope-one-job", "scope-two-job"],
      ["base2", "scope-two-job", "scope-one-job"],
    ]) {
      const { status, body } = await read(
        target,
        surfacePath("daily", `/catalog/scopes/${scopeId}?jobId=${foreignJob}`),
      );
      expect(status).toBe(200);
      expect(body.readModel.healthTriage.units.map((unit: { unitKey: string }) => unit.unitKey)).toEqual([
        "tcgdex:pokemon:card:import",
      ]);
      expect(body.readModel.healthTriage.recentJobs.map((row: { jobId: string }) => row.jobId)).toEqual([ownJob]);
      expect(body.readModel.healthTriage.providers).toEqual([]);
      expect(body.readModel.healthTriage.auditPreview.entries).toEqual([]);
      expect(body.readModel.healthTriage.readModels.map((row: { queryKey: string }) => row.queryKey)).toEqual([
        "integration-health-summary",
        "import-job-progress-summary",
      ]);
    }
    expect(source.getCatalogIntegrationControlPlaneReadiness).toHaveBeenCalledTimes(2);
    expect(source.listRecentIntegrationJobs).toHaveBeenCalledTimes(2);
    expect(source.listActiveIntegrationJobs).toHaveBeenCalledTimes(2);
    expect(getScopeRecord).toHaveBeenCalledTimes(2);
  });
  it("keeps failed Scope health unavailable with request-time provenance and no second overview", async () => {
    const source = services();
    vi.mocked(source.getCatalogIntegrationControlPlaneReadiness).mockRejectedValue(
      new Error("synthetic overview failure"),
    );
    const target = buildApp(source, mutableProfileStore([]), manageActor, undefined, async () => paldeanFates);
    const { status, body } = await read(target, surfacePath("daily", SCOPE_PATH));
    expect(status).toBe(200);
    expect(body.readModel.healthTriage).toMatchObject({
      status: "unavailable",
      freshness: "partial",
      generatedAt: NOW,
      units: [],
      providers: [],
      recentJobs: [],
    });
    expect(body.readModelFailures).toContain("control-plane-overview");
    expect(source.getCatalogIntegrationControlPlaneReadiness).toHaveBeenCalledTimes(1);
  });
  it("preserves Scope identity for evidence demand and loads one full overview without widening the review page", async () => {
    const source = services();
    const getScopeRecord = vi.fn(async () => paldeanFates);
    const target = buildApp(source, mutableProfileStore(), manageActor, undefined, getScopeRecord);
    const { status, body } = await read(
      target,
      surfacePath("daily", `${SCOPE_PATH}&evidenceRef=scope/scope_expansion_paldean_fates&reviewOffset=25`),
    );
    expect(status).toBe(200);
    expect(getScopeRecord).toHaveBeenCalledTimes(1);
    expect(source.getCatalogIntegrationControlPlaneReadiness).toHaveBeenCalledTimes(1);
    expect(source.listRecentIntegrationJobs).toHaveBeenCalledTimes(1);
    expect(source.listCatalogMergeCandidates).toHaveBeenCalledTimes(1);
    expect(body.readModel.auditEvidence.projectionState.missingProjection).toBe(false);
    expect(body.readModel.healthTriage.readModels.map((row: { queryKey: string }) => row.queryKey)).toEqual([
      "integration-health-summary",
      "import-job-progress-summary",
    ]);
    expect(body.readModel.auditEvidence.selection).toMatchObject({ state: "resolved", deepLinkOpen: true });
    expect(body.readModel.sourceObservationReview.pagination).toMatchObject({ limit: 25, offset: 25 });
    expect(body.readModel.routeContext.scopeRecordId).toBe("scope_expansion_paldean_fates");
  });
  it.each(["daily", "daily/source-options"])(
    "reads %s for the Scope Record the path names, as for its daily working set",
    async (surface) => {
      const getScopeRecord = vi.fn(async () => paldeanFates);
      const target = app(getScopeRecord);

      const fromScope = await read(target, surfacePath(surface, SCOPE_PATH));
      const fromDaily = await read(target, surfacePath(surface, dailyLocationFor(SCOPE_PATH)));

      expect(fromScope.status).toBe(fromDaily.status);
      if (surface === "daily") {
        expect({
          ...fromScope.body,
          readModel: { ...fromScope.body.readModel, healthTriage: fromDaily.body.readModel.healthTriage },
        }).toEqual(fromDaily.body);
        expect(fromScope.body.readModel.healthTriage.providers).toEqual([]);
        expect(fromScope.body.readModel.healthTriage.auditPreview.entries).toEqual([]);
        expect(fromDaily.body.readModel.healthTriage.units).toEqual([]);
      } else {
        expect(fromScope.body).toEqual(fromDaily.body);
      }
      expect(getScopeRecord).toHaveBeenCalledWith("scope_expansion_paldean_fates");
      expect(getScopeRecord).toHaveBeenCalledTimes(1);
    },
  );

  it("names the record's hierarchy and keeps the address's language and job in the route context", async () => {
    const { status, body } = await read(
      app(async () => paldeanFates),
      surfacePath("daily", SCOPE_PATH),
    );

    expect(status).toBe(200);
    expect(body.readModel.routeContext).toMatchObject({
      jobId: "sync_1",
      scopeRecordId: "scope_expansion_paldean_fates",
      scope: expect.objectContaining({
        languageCode: "ja",
        expansionId: "scope_expansion_paldean_fates",
        seriesId: "scope_series_scarlet_violet",
      }),
    });
  });

  it("carries the address's provider, unit and profile and keeps its import scope inside the record", async () => {
    const selection = {
      providerKey: "tcgdex",
      unitKey: "tcgdex:pokemon:card:import",
      importScope: "en:3:base:base1",
      profileVersion: "2026.06.04",
    };
    const address = `/catalog/scopes/scope_expansion_paldean_fates?${new URLSearchParams({
      ...selection,
      languageCode: "ja",
      seriesId: "submitted-series",
      expansionId: "submitted-expansion",
      expansionName: "Submitted expansion",
    })}`;

    const { status, body } = await read(
      app(async () => paldeanFates),
      surfacePath("daily", address),
    );

    expect(status).toBe(200);
    expect(body.readModel.routeContext).toMatchObject({
      providerKey: selection.providerKey,
      unitKey: selection.unitKey,
      profileVersion: selection.profileVersion,
      // An import scope outside the record's hierarchy yields to the record's own.
      importScope: "ja:scope_product_line_pokemon:scope_series_scarlet_violet:scope_expansion_paldean_fates",
      scopeRecordId: "scope_expansion_paldean_fates",
      scope: expect.objectContaining({
        languageCode: "ja",
        expansionId: "scope_expansion_paldean_fates",
        expansionName: "Paldean Fates",
        seriesId: "scope_series_scarlet_violet",
      }),
    });
  });

  it("keeps the record's hierarchy when the address restates it as a set alias or review filter", async () => {
    const source = services();
    const target = buildApp(source, mutableProfileStore(), manageActor, undefined, async () => paldeanFates);
    const address = `/catalog/scopes/scope_expansion_paldean_fates?${new URLSearchParams({
      providerKey: "tcgdex",
      setId: "base1",
      setName: "Base Set",
      "filter.expansionId": "base1",
      "filter.setId": "base1",
      "filter.seriesId": "base",
      "filter.status": "eligible",
    })}`;

    const { status, body } = await read(target, surfacePath("daily", address));

    expect(status).toBe(200);
    expect(body.readModel.routeContext.scope).toMatchObject({
      expansionId: "scope_expansion_paldean_fates",
      expansionName: "Paldean Fates",
      seriesId: "scope_series_scarlet_violet",
    });
    expect(body.readModel.routeContext.sourceObservationFilters).toMatchObject({ status: "eligible" });
    for (const key of ["expansionId", "setId", "seriesId"]) {
      expect(body.readModel.routeContext.sourceObservationFilters, key).not.toHaveProperty(key);
    }
    const reviewReads = JSON.stringify(vi.mocked(source.listSourceObservations).mock.calls);
    expect(reviewReads).toContain("scope_expansion_paldean_fates");
    expect(reviewReads).not.toContain("base1");
  });

  it.each([
    ["names a Scope Record that does not exist", async () => null],
    ["cannot be read without the Scope Record read", undefined],
  ])("answers 404 for a Scope Detail location that %s", async (_case, getScopeRecord) => {
    for (const surface of ["daily", "daily/source-options"]) {
      const { status, body } = await read(app(getScopeRecord), surfacePath(surface, SCOPE_PATH));

      expect(status, surface).toBe(404);
      expect(body.error.code, surface).toBe("not_found");
    }
  });

  it("reads no Scope Record for another surface or a daily workbench location", async () => {
    const getScopeRecord = vi.fn(async () => paldeanFates);
    const target = app(getScopeRecord);

    expect((await read(target, surfacePath("health", SCOPE_PATH))).status).toBe(200);
    expect((await read(target, surfacePath("daily", "/catalog/integrations?languageCode=en"))).status).toBe(200);
    expect(getScopeRecord).not.toHaveBeenCalled();
  });
});
