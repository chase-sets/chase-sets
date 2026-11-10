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

const NOW = "2026-07-14T12:00:00.000Z";
const TCGDEX_UNIT = "tcgdex:pokemon:single-card:source-observation-import";

function readinessUnit(unitKey: string, providerKey: string, profileVersion: string) {
  return {
    unitKey,
    providerKey,
    displayName: unitKey,
    productDomain: "pokemon",
    productForm: "single-card",
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
        // Issue #11142: N5 must deliberately update this pin when aligning reapply with the row form.
        expect(
          body.readModel.sourceScopeWorkset.units.find((row: { unitKey: string }) => row.unitKey === TCGDEX_UNIT)
            .commandScopes.reapply.status,
        ).toBe("changed");
      }
    },
  );
});
