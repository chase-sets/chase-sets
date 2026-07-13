import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { CatalogAuthoringEnv } from "../../../support/authoring-support/api";
import { catalogScopeRegistryRoutes, scopeRecordDetailFromRow, type CatalogScopeRegistryRouteServices } from "./route";
import type { CatalogScopeRecordRow } from "../read-model/queries";

const viewActor: CatalogAuthoringEnv["Variables"]["actor"] = { permissions: ["catalog.view"] };

function paldeanFatesRow(overrides: Partial<CatalogScopeRecordRow> = {}): CatalogScopeRecordRow {
  return {
    scope_record_id: "ref_expansion_paldean_fates",
    product_domain: "pokemon",
    scope_kind: "expansion",
    reference_type_key: "expansion",
    reference_record_id: "ref_expansion_paldean_fates",
    reference_record_key: "paldean-fates",
    name_i18n: {},
    name: "Paldean Fates",
    parent_scope_record_id: "ref_series_scarlet_violet",
    product_line_scope_record_id: "ref_product_line_pokemon",
    series_scope_record_id: "ref_series_scarlet_violet",
    release_date: "2024-01-26",
    official_set_code: "PAF",
    language_editions: ["en", "ja"],
    attributes: {},
    relationships: [],
    lifecycle_status: "active",
    updated_at: "2026-07-03T12:00:00.000Z",
    ...overrides,
  };
}

function buildApp(
  services: CatalogScopeRegistryRouteServices,
  actor: CatalogAuthoringEnv["Variables"]["actor"] | null,
) {
  const app = new Hono<CatalogAuthoringEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", actor);
    await next();
  });
  app.route("/scope-records", catalogScopeRegistryRoutes(services));
  return app;
}

describe("scopeRecordDetailFromRow", () => {
  it("maps the DB row to the camelCase client contract, including language editions", () => {
    expect(scopeRecordDetailFromRow(paldeanFatesRow())).toEqual({
      scopeRecordId: "ref_expansion_paldean_fates",
      productDomain: "pokemon",
      scopeKind: "expansion",
      referenceTypeKey: "expansion",
      referenceRecordId: "ref_expansion_paldean_fates",
      referenceRecordKey: "paldean-fates",
      name: "Paldean Fates",
      parentScopeRecordId: "ref_series_scarlet_violet",
      productLineScopeRecordId: "ref_product_line_pokemon",
      seriesScopeRecordId: "ref_series_scarlet_violet",
      releaseDate: "2024-01-26",
      officialSetCode: "PAF",
      languageEditions: ["en", "ja"],
      lifecycleStatus: "active",
      updatedAt: "2026-07-03T12:00:00.000Z",
    });
  });

  it("normalizes a non-array language_editions column to an empty list", () => {
    expect(scopeRecordDetailFromRow(paldeanFatesRow({ language_editions: null })).languageEditions).toEqual([]);
  });
});

describe("Catalog scope registry route", () => {
  it("returns the scope record for catalog.view operators", async () => {
    const getScopeRecord = vi.fn().mockResolvedValue(paldeanFatesRow());
    const app = buildApp({ getScopeRecord, listScopeRecords: vi.fn() }, viewActor);

    const response = await app.request("/scope-records/ref_expansion_paldean_fates");

    expect(response.status).toBe(200);
    expect(getScopeRecord).toHaveBeenCalledWith("ref_expansion_paldean_fates");
    const body = await response.json();
    expect(body.languageEditions).toEqual(["en", "ja"]);
  });

  it("returns 404 when the scope record does not exist", async () => {
    const getScopeRecord = vi.fn().mockResolvedValue(null);
    const app = buildApp({ getScopeRecord, listScopeRecords: vi.fn() }, viewActor);

    const response = await app.request("/scope-records/ref_missing");

    expect(response.status).toBe(404);
  });

  it("returns 401 when no actor is present", async () => {
    const getScopeRecord = vi.fn();
    const app = buildApp({ getScopeRecord, listScopeRecords: vi.fn() }, null);

    const response = await app.request("/scope-records/ref_expansion_paldean_fates");

    expect(response.status).toBe(401);
    expect(getScopeRecord).not.toHaveBeenCalled();
  });

  it("returns 403 when the actor lacks catalog.view", async () => {
    const getScopeRecord = vi.fn();
    const app = buildApp({ getScopeRecord, listScopeRecords: vi.fn() }, { permissions: [] });

    const response = await app.request("/scope-records/ref_expansion_paldean_fates");

    expect(response.status).toBe(403);
    expect(getScopeRecord).not.toHaveBeenCalled();
  });
});

describe("Catalog scope registry list route", () => {
  it("returns the canonical scope record list for catalog.view operators", async () => {
    const listScopeRecords = vi.fn().mockResolvedValue({ items: [paldeanFatesRow()], total: 1 });
    const app = buildApp({ getScopeRecord: vi.fn(), listScopeRecords }, viewActor);

    const response = await app.request("/scope-records");

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.total).toBe(1);
    expect(body.count).toBe(1);
    expect(body.items[0].officialSetCode).toBe("PAF");
    expect(body.items[0].languageEditions).toEqual(["en", "ja"]);
  });

  it("parses product domain / scope kind / status / search / pagination into the query params", async () => {
    const listScopeRecords = vi.fn().mockResolvedValue({ items: [], total: 0 });
    const app = buildApp({ getScopeRecord: vi.fn(), listScopeRecords }, viewActor);

    await app.request(
      "/scope-records?productDomain=pokemon&scopeKind=expansion&status=active&search=paldean&limit=25&offset=50",
    );

    expect(listScopeRecords).toHaveBeenCalledWith({
      productDomain: "pokemon",
      scopeKind: "expansion",
      lifecycleStatus: "active",
      search: "paldean",
      limit: 25,
      offset: 50,
    });
  });

  it("ignores unknown enum filter values rather than forwarding them", async () => {
    const listScopeRecords = vi.fn().mockResolvedValue({ items: [], total: 0 });
    const app = buildApp({ getScopeRecord: vi.fn(), listScopeRecords }, viewActor);

    await app.request("/scope-records?productDomain=not-a-domain&status=not-a-status");

    expect(listScopeRecords).toHaveBeenCalledWith({ limit: 50, offset: 0 });
  });

  it("clamps the page limit to the maximum", async () => {
    const listScopeRecords = vi.fn().mockResolvedValue({ items: [], total: 0 });
    const app = buildApp({ getScopeRecord: vi.fn(), listScopeRecords }, viewActor);

    await app.request("/scope-records?limit=100000");

    expect(listScopeRecords.mock.calls[0]?.[0].limit).toBe(200);
  });

  it("returns 401 when no actor is present", async () => {
    const listScopeRecords = vi.fn();
    const app = buildApp({ getScopeRecord: vi.fn(), listScopeRecords }, null);

    const response = await app.request("/scope-records");

    expect(response.status).toBe(401);
    expect(listScopeRecords).not.toHaveBeenCalled();
  });

  it("returns 403 when the actor lacks catalog.view", async () => {
    const listScopeRecords = vi.fn();
    const app = buildApp({ getScopeRecord: vi.fn(), listScopeRecords }, { permissions: [] });

    const response = await app.request("/scope-records");

    expect(response.status).toBe(403);
    expect(listScopeRecords).not.toHaveBeenCalled();
  });
});
