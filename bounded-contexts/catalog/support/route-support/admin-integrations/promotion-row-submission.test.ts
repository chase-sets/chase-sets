import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SourceObservationRouteServices } from "../../../features/source-observations/api/route";
import {
  buildApp,
  mutableProfileStore,
} from "../../../features/source-observations/api/route-modules/route-test-harness";
import { serializeCatalogPrimaryWorkbenchRouteContext } from "../../../features/source-observations/ui/primary-workbench-route-context";
import {
  controlPlaneOverview,
  sourceObservationListItem,
  sourceObservationScope,
} from "../../../features/source-observations/ui/primary-workbench-test-fixtures";
import { commandContextFromFormData } from "./integrations-command-context";
import type { CatalogPrimaryWorkbenchReadModel } from "../../../features/source-observations/api/primary-workbench-admin-contracts";
import {
  catalogProviderProfileVersionIngestionUnitKey,
  listCatalogProviderIntegrationProfileVersions,
} from "../../../features/source-observations/api/providers/registry";
import { createCatalogApiClient } from "../../../support/request-support/api-client";
import { handleObservationCommand } from "./observation-command-handler";
import { handleScopeCommand } from "./scope-command-handler";

const NOW = "2026-07-14T12:00:00.000Z";
const TCGDEX_UNIT = "tcgdex:pokemon:single-card:source-observation-import";
const SCRYDEX_CARD_UNIT = "scrydex:one-piece:single-card:source-observation-import";
const SCRYDEX_SEALED_UNIT = "scrydex:one-piece:sealed-product:source-observation-import";

function readinessUnit(unitKey: string, providerKey: string, profileVersion: string) {
  return {
    unitKey,
    providerKey,
    displayName: unitKey,
    productDomain: unitKey.split(":")[1],
    productForm: unitKey.split(":")[2],
    ingestionPurpose: "source-observation-import",
    profileVersion,
    semanticReadiness: "ready",
    credentialReadiness: "ready",
    credentialReadinessState: "configured",
    credentialRequirement: "required",
    credentialDiagnosticCode: null,
    transportReadiness: "ready",
    fixtureValidationStatus: "ready",
    dryRunStatus: "completed",
    observationFacts: 1,
    diagnosticCounts: { info: 0, warning: 0, error: 0 },
    diagnostics: [],
    latestDiagnosticText: null,
    dryRunEvidence: [],
  };
}

function readiness(units: readonly ReturnType<typeof readinessUnit>[]) {
  const base = controlPlaneOverview().readiness;
  return {
    ...base,
    generatedAt: NOW,
    providerUsage: [],
    rolloutControls: { ...base.rolloutControls, generatedAt: NOW },
    units,
  };
}

function surfaceServices(overrides: Partial<Record<keyof SourceObservationRouteServices, unknown>> = {}) {
  return {
    listIntegrationScopes: vi.fn(async () => [sourceObservationScope({ provider_key: "tcgdex" })]),
    getCatalogIntegrationControlPlaneReadiness: vi.fn(async () =>
      readiness([readinessUnit(TCGDEX_UNIT, "tcgdex", "2026.06.03")]),
    ),
    listRecentIntegrationJobs: vi.fn(async () => []),
    listActiveIntegrationJobs: vi.fn(async () => []),
    listSourceObservations: vi.fn(async () => ({ items: [sourceObservationListItem()], total: 1 })),
    listCatalogMergeCandidates: vi.fn(async () => ({ items: [], total: 0, count: 0 })),
    ...overrides,
  } as unknown as SourceObservationRouteServices;
}

function surfacePath(surface: string, location: string): string {
  return `/source-observations/workbench-surfaces/${surface}?${new URLSearchParams({ location })}`;
}

async function getJson(app: ReturnType<typeof buildApp>, path: string) {
  const response = await app.request(path);
  expect(response.status, path).toBe(200);
  return response.json();
}

function rowForm(row: CatalogPrimaryWorkbenchReadModel["sourceScopeWorkset"]["units"][number]) {
  const form = new FormData();
  for (const [key, value] of Object.entries(row.commandContext)) form.set(key, String(value ?? ""));
  form.set("selectedObservationIds", "");
  form.set("promotionPreviewId", "");
  return form;
}

function recordingApi() {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ jobId: "synthetic-job" }));
  const api = createCatalogApiClient({ baseUrl: "https://catalog.example/api/catalog", fetch });
  const importCall = vi.spyOn(api, "enqueueSourceObservationIntegrationJob");
  const reapplyCall = vi.spyOn(api, "reapplySourceObservationsByScope");
  const selectedReapplyCall = vi.spyOn(api, "reapplySourceObservations");
  return { api, fetch, importCall, reapplyCall, selectedReapplyCall };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Catalog row promotion submission", () => {
  // Issue #11142: a row descriptor must match the row form, not its selected sibling.
  it.each([
    ["review filters", "&filter.status=changed&filter.search=synthetic-search"],
    ["top-level status", "&status=changed"],
  ])(
    "matches every row promotion descriptor to its submitted daily read without page filters (%s)",
    async (_, pageFilters) => {
      const app = buildApp(surfaceServices(), mutableProfileStore());
      const body = await getJson(
        app,
        surfacePath(
          "daily",
          `/catalog/integrations?providerKey=tcgdex&unitKey=${TCGDEX_UNIT}&importScope=en:3:base:base1&profileVersion=synthetic-profile${pageFilters}`,
        ),
      );
      expect(body.readModel.sourceScopeWorkset.units.length).toBeGreaterThan(0);
      expect(
        body.readModel.sourceScopeWorkset.units.some((row: { importScope: string | null }) => row.importScope !== null),
      ).toBe(true);
      for (const row of body.readModel.sourceScopeWorkset.units) {
        const form = new FormData();
        for (const [key, value] of Object.entries(row.commandContext)) form.set(key, String(value ?? ""));
        form.set("_intent", "observation.promote");
        form.set("selectedObservationIds", "");
        form.set("promotionPreviewId", "");
        const context = commandContextFromFormData(`https://admin.example${row.currentWorkbenchHref}`, form);
        const query = serializeCatalogPrimaryWorkbenchRouteContext({
          ...context,
          promotionPreviewId: null,
          jobId: null,
        });
        if (context.scope?.status) query.set("status", context.scope.status);
        const submitted = await getJson(app, surfacePath("daily", `/catalog/integrations?${query}`));
        const selected = submitted.readModel.actions.find(
          (entry: { key: string }) => entry.key === "observation.promote",
        ).commandPreview;
        expect(row.actions.previewPromotion.commandPreview, row.unitKey).toEqual(selected);
        expect(selected.confirmation).toMatchObject({
          unitKey: row.unitKey,
          importScope: row.importScope,
          profileVersion: row.profileVersion,
        });
        expect(selected.scope).not.toHaveProperty("status");
        expect(selected.scope).not.toHaveProperty("search");
      }
      if (pageFilters === "&status=changed") {
        expect(
          body.readModel.actions.find((entry: { key: string }) => entry.key === "observation.promote").commandPreview
            .scope.status,
        ).toBe("changed");
        // Issue #11152: the row reapply body omits status, unlike the selected promotion command above.
        expect(
          body.readModel.sourceScopeWorkset.units.find((row: { unitKey: string }) => row.unitKey === TCGDEX_UNIT)
            ?.commandScopes?.reapply,
        ).toEqual({
          provider: "tcgdex",
          ingestionUnitKey: TCGDEX_UNIT,
          language: "en",
          productLineId: "3",
          seriesId: "base",
          expansionId: "base1",
          setId: "base1",
        });
      }
    },
  );
});

describe("Catalog row import and reapply submission", () => {
  const identities = [
    { providerKey: "tcgdex", unitKey: TCGDEX_UNIT, profileVersion: "2026.06.03", importScope: "en:3:base:base1" },
    {
      providerKey: "scrydex",
      unitKey: SCRYDEX_CARD_UNIT,
      profileVersion: "2026.06.22",
      importScope: "en:one-piece:OP16",
    },
    {
      providerKey: "scrydex",
      unitKey: SCRYDEX_SEALED_UNIT,
      profileVersion: "2026.06.22",
      importScope: "en:one-piece:OP16",
    },
  ];

  function rowApp(incomplete = false) {
    const profiles = listCatalogProviderIntegrationProfileVersions().filter((profile) =>
      identities.some((identity) => identity.unitKey === catalogProviderProfileVersionIngestionUnitKey(profile)),
    );
    expect(profiles).toHaveLength(3);
    return buildApp(
      surfaceServices({
        listIntegrationScopes: vi.fn(async () =>
          incomplete
            ? []
            : [
                sourceObservationScope(),
                sourceObservationScope({
                  provider_key: "scrydex",
                  product_line_id: "one-piece",
                  product_line_name: "One Piece Card Game",
                  series_id: "",
                  series_name: "",
                  expansion_id: "OP16",
                  expansion_name: "The Time Of Battle",
                }),
              ],
        ),
        getCatalogIntegrationControlPlaneReadiness: vi.fn(async () =>
          readiness(
            identities.map((identity) =>
              readinessUnit(identity.unitKey, identity.providerKey, identity.profileVersion),
            ),
          ),
        ),
      }),
      mutableProfileStore(profiles),
    );
  }

  // Issue #11152: literal bodies and real handlers are independent of the row composer.
  it.each(
    ["tcgdex", "scrydex"].flatMap((provider) => [
      [`${provider}: review filters and setId alias`, provider, "expansionId", "filter.setId=page-set", ""],
      [`${provider}: review filters and expansionId alias`, provider, "setId", "filter.expansionId=page-expansion", ""],
      [`${provider}: top-level status`, provider, "expansionId", "", "&status=changed"],
    ]),
  )(
    "matches all daily row bodies to actual form submissions without page context (%s)",
    async (_, provider, coordinate, setFilter, status) => {
      const filters = setFilter
        ? `&filter.language=ja&filter.productLineId=page-line&filter.seriesId=page-series&${setFilter}&filter.status=changed&filter.search=synthetic-search`
        : "";
      const pageIdentities = identities.filter((identity) => identity.providerKey === provider);
      const pageCoordinate =
        provider === "tcgdex"
          ? `productLineId=3&seriesId=base&${coordinate}=base1`
          : `productLineId=one-piece&${coordinate}=OP16`;
      const { readModel }: { readModel: CatalogPrimaryWorkbenchReadModel } = await getJson(
        rowApp(),
        surfacePath(
          "daily",
          `/catalog/integrations?providerKey=${provider}&unitKey=${pageIdentities[0]!.unitKey}&languageCode=en&${pageCoordinate}&profileVersion=synthetic-page-profile${filters}${status}`,
        ),
      );
      const rows = readModel.sourceScopeWorkset.units;
      expect(rows).toHaveLength(pageIdentities.length);
      expect(rows.length).toBeGreaterThan(0);
      expect(new Set(rows.map((row) => row.unitKey)).size).toBe(pageIdentities.length);
      const recorder = recordingApi();
      for (const identity of pageIdentities) {
        const row = rows.find((candidate) => candidate.unitKey === identity.unitKey)!;
        expect(row).toBeDefined();
        expect(row).toMatchObject(identity);
        expect(row.commandContext).toMatchObject(identity);
        expect(row.commandScopes).not.toBeNull();
        const form = rowForm(row);
        const context = commandContextFromFormData(`https://admin.example${row.currentWorkbenchHref}`, form);
        expect(context.selectedObservationIds).toEqual([]);
        expect(context.sourceObservationFilters).toEqual({});
        expect(context.scope?.status).toBeNull();
        expect(context).toMatchObject(identity);
        recorder.importCall.mockClear();
        recorder.reapplyCall.mockClear();
        recorder.fetch.mockClear();
        form.set("_intent", "scope.import");
        const imported = await handleScopeCommand({
          api: recorder.api,
          intent: "scope.import",
          context,
          formData: form,
        });
        form.set("_intent", "observation.reapply");
        await handleObservationCommand({
          api: recorder.api,
          intent: "observation.reapply",
          context,
          formData: form,
          selectedObservationIds: context.selectedObservationIds,
        });
        const isPokemon = identity.providerKey === "tcgdex";
        const expectedImport = isPokemon
          ? {
              provider: "tcgdex",
              ingestionUnitKey: TCGDEX_UNIT,
              language: "en",
              productLineId: "3",
              seriesId: "base",
              setId: "base1",
              setName: "Base Set",
            }
          : {
              provider: "scrydex",
              ingestionUnitKey: identity.unitKey,
              language: "en",
              productLineId: "one-piece",
              setId: "OP16",
              setName: "The Time Of Battle",
            };
        const expectedReapply = isPokemon
          ? {
              provider: "tcgdex",
              ingestionUnitKey: TCGDEX_UNIT,
              language: "en",
              productLineId: "3",
              seriesId: "base",
              expansionId: "base1",
              setId: "base1",
            }
          : {
              provider: "scrydex",
              ingestionUnitKey: identity.unitKey,
              language: "en",
              productLineId: "one-piece",
              expansionId: "OP16",
              setId: "OP16",
            };
        expect(imported.feedback.status).toBe("success");
        expect(recorder.importCall).toHaveBeenCalledExactlyOnceWith("import", expectedImport);
        expect(recorder.reapplyCall).toHaveBeenCalledExactlyOnceWith(expectedReapply);
        expect(recorder.selectedReapplyCall).not.toHaveBeenCalled();
        expect(recorder.fetch).toHaveBeenCalledTimes(2);
        expect.soft(row.commandScopes?.import, `${identity.unitKey} import`).toEqual(expectedImport);
        expect.soft(row.commandScopes?.reapply, `${identity.unitKey} reapply`).toEqual(expectedReapply);
        expect.soft(row.commandScopes?.import).toEqual(recorder.importCall.mock.calls[0]?.[1]);
        expect.soft(row.commandScopes?.reapply).toEqual(recorder.reapplyCall.mock.calls[0]?.[0]);
      }
    },
  );

  it("preserves incomplete row scope and refuses explicit-empty imports without a broader fallback", async () => {
    const { readModel }: { readModel: CatalogPrimaryWorkbenchReadModel } = await getJson(
      rowApp(true),
      surfacePath(
        "daily",
        `/catalog/integrations?providerKey=tcgdex&unitKey=${TCGDEX_UNIT}&profileVersion=synthetic-page-profile`,
      ),
    );
    expect(readModel.sourceScopeWorkset.units).toHaveLength(1);
    const recorder = recordingApi();
    for (const row of readModel.sourceScopeWorkset.units) {
      expect(row.importScope).toBeNull();
      expect(row.commandScopes).toBeNull();
      expect(row.actions.import.state).toBe("disabled");
      expect(row.actions.import.blockers).toContain("import-scope-required");
      const form = rowForm(row);
      expect(form.get("importScope")).toBe("");
      expect(form.get("expansionId")).toBe("");
      expect(form.get("seriesId")).toBe("");
      const submitted = commandContextFromFormData(`https://admin.example${row.currentWorkbenchHref}`, form);
      expect(submitted.importScope).toBe("en");
      expect(submitted.scope).toMatchObject({ languageCode: "en", seriesId: null, expansionId: null });
      form.set("languageCode", "");
      const context = commandContextFromFormData(`https://admin.example${row.currentWorkbenchHref}`, form);
      expect(context.importScope).toBeNull();
      const result = await handleScopeCommand({ api: recorder.api, intent: "scope.import", context, formData: form });
      expect(result.feedback.status).toBe("error");
    }
    expect(recorder.importCall).not.toHaveBeenCalled();
    expect(recorder.fetch).not.toHaveBeenCalled();

    const row = readModel.sourceScopeWorkset.units.find((candidate) => candidate.unitKey === TCGDEX_UNIT)!;
    const form = rowForm(row);
    const staleUrl = new URL(row.currentWorkbenchHref, "https://admin.example");
    staleUrl.searchParams.set("languageCode", "ja");
    staleUrl.searchParams.set("productLineId", "stale-line");
    staleUrl.searchParams.set("seriesId", "stale-series");
    staleUrl.searchParams.set("setId", "stale-set");
    staleUrl.searchParams.set("setName", "Stale Set");
    form.set("languageCode", "");
    const context = commandContextFromFormData(staleUrl.href, form);
    expect(context.scope).toMatchObject({
      languageCode: null,
      productLineId: null,
      seriesId: null,
      expansionId: null,
      expansionName: null,
    });
    expect(context.importScope).toBeNull();
    expect(
      (await handleScopeCommand({ api: recorder.api, intent: "scope.import", context, formData: form })).feedback
        .status,
    ).toBe("error");
    expect(recorder.importCall).not.toHaveBeenCalled();
    expect(recorder.fetch).not.toHaveBeenCalled();
  });
});
