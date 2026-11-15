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
  it.each(["daily", "daily/source-options"])(
    "reads %s for the Scope Record the path names, as for its daily working set",
    async (surface) => {
      const getScopeRecord = vi.fn(async () => paldeanFates);
      const target = app(getScopeRecord);

      const fromScope = await read(target, surfacePath(surface, SCOPE_PATH));
      const fromDaily = await read(target, surfacePath(surface, dailyLocationFor(SCOPE_PATH)));

      expect(fromScope.status).toBe(fromDaily.status);
      expect(fromScope.body).toEqual(fromDaily.body);
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
