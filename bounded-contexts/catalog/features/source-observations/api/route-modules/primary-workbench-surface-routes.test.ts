import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SourceObservationRouteServices } from "../route";
import { ProviderAdapterRegistry } from "../provider-adapters/registry";
import type { CatalogAuthoringEnv } from "../../../../support/authoring-support/api";
import { buildCatalogAuthoringTestApp } from "../../../../support/authoring-support/test-support";
import type { CatalogServices } from "../../../../support/authoring-support/services";
import { context } from "./route-test-harness";
import type { ProviderRefreshScheduleRecord } from "../../../provider-scope-discovery/api/refresh-schedule-store";
import { buildApp, mutableProfileStore, viewOnlyActor } from "./route-test-harness";
import {
  buildDailyMergeCandidateQuery,
  MAX_SOURCE_OPTION_CONTINUATION_PAGES,
} from "../admin/primary-workbench-surface-read";
import type { CatalogPrimaryWorkbenchRouteContext } from "../primary-workbench-admin-contracts";
import { buildCatalogPrimaryWorkbenchReadModelForSurface } from "../../ui/primary-workbench-read-model";
import {
  catalogPrimaryWorkbenchHref,
  parseCatalogPrimaryWorkbenchRouteContext,
} from "../../ui/primary-workbench-route-context";
import {
  catalogProviderIntegrationProfileVersions,
  type CatalogProviderIntegrationProfileVersionRecord,
  type CatalogProviderScope,
} from "../provider-integration-profiles";
import { catalogImportPreviewMatchesSelection } from "../admin/daily-import-preview";
import type { SourceObservationIntegrationImportPreview } from "../../ui/contracts";
import {
  controlPlaneOverview,
  sourceObservationListItem,
  sourceObservationScope,
  syntheticPromotionPreviewResponse,
} from "../../ui/primary-workbench-test-fixtures";

const NOW = "2026-07-14T12:00:00.000Z";
const TCGDEX_UNIT = "tcgdex:pokemon:single-card:source-observation-import";
const POKEMON_UNIT = "tcgplayer:pokemon:single-card:source-observation-import";

function providerActor(): NonNullable<CatalogAuthoringEnv["Variables"]["actor"]> {
  return { permissions: ["catalog.view"], roleKey: "platform-admin", userId: "user-a", membershipId: "membership-a" };
}

function refreshSchedule(providerKey: string): ProviderRefreshScheduleRecord {
  return {
    providerKey,
    scheduleEnabled: true,
    manualOnly: false,
    creditAware: false,
    intervalMs: 60000,
    paused: false,
    pausedBy: null,
    pausedReason: null,
    pausedAt: null,
    nextRunAt: NOW,
    lastRunStartedAt: NOW,
    lastRunCompletedAt: NOW,
    lastRunStatus: "succeeded",
    lastRunObservationCount: 2,
    lastRunError: null,
    lastRunTriggeredBy: "synthetic",
  };
}

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

// Literal predicates exercise the real HTTP preview binding, never admission.
describe("Catalog held promotion commit verdict", () => {
  const location = `/catalog/integrations?providerKey=tcgdex&unitKey=${TCGDEX_UNIT}&languageCode=en&productLineId=3&seriesId=base&expansionId=base1&promotionPreviewId=held-token&selectedObservationIds=obs_001`;
  type PromotionPreview = Awaited<ReturnType<SourceObservationRouteServices["previewPromoteObservations"]>>;
  const fixture = syntheticPromotionPreviewResponse();
  const base: PromotionPreview = {
    ...fixture,
    scope: { ...fixture.scope, syncRunId: "", normalizedKind: "" },
  };
  const validation = base.validation;
  const cases: readonly [string, Partial<PromotionPreview>, string, boolean][] = [
    ["explicit ids", {}, "", true],
    ["scope selection", {}, "scope", true],
    ["draft selection", { validation: { ...validation, promoteAsDraft: true } }, "draft", true],
    ["eligible and terminal selection", { matched: 2, terminal: 1 }, "mixed", true],
    ["empty fingerprint", { fingerprint: "" }, "", false],
    ["draft mismatch", { validation: { ...validation, promoteAsDraft: true } }, "", false],
    ["partial coverage", { validation: { ...validation, coverage: "partial" } }, "", false],
    ["continuation", { validation: { ...validation, continuation: "next" } }, "", false],
    ["zero page limit", { validation: { ...validation, pageLimit: 0 } }, "", false],
    ["negative page limit", { validation: { ...validation, pageLimit: -1 } }, "", false],
    ["no eligible observations", { eligible: 0 }, "", false],
    [
      "covered ids above limit",
      {
        eligible: 2,
        matched: 2,
        validation: { ...validation, pageLimit: 1, coveredObservationIds: ["obs_001", "obs_002"] },
      },
      "scope",
      false,
    ],
    [
      "duplicate covered ids",
      { validation: { ...validation, coveredObservationIds: ["obs_001", "obs_001"] } },
      "",
      false,
    ],
    ["eligible count differs", { eligible: 2 }, "", false],
    ["empty covered ids", { validation: { ...validation, coveredObservationIds: [] } }, "", false],
    ["duplicate selected ids", {}, "duplicates", false],
    ["selected count differs from matched", { matched: 2 }, "", false],
    ["covered id outside selection", { validation: { ...validation, coveredObservationIds: ["other"] } }, "", false],
    [
      "blocking diagnostic",
      {
        validation: {
          ...validation,
          diagnostics: [
            {
              observationId: "obs_001",
              code: "synthetic",
              path: "facts",
              diagnosticText: "Synthetic blocker",
              blocking: true,
            },
          ],
        },
      },
      "",
      false,
    ],
    [
      "nonblocking diagnostic",
      {
        validation: {
          ...validation,
          diagnostics: [
            {
              observationId: "obs_001",
              code: "synthetic",
              path: "facts",
              diagnosticText: "Synthetic warning",
              blocking: false,
            },
          ],
        },
      },
      "",
      true,
    ],
    ["no held token", {}, "no-token", false],
    ["stale profile", {}, "stale", false],
    ["no manage permission", {}, "no-manage", false],
    ["failed preview", {}, "failed", false],
  ];
  it.each(cases)("returns the literal verdict for %s", async (_name, override, variant, expected) => {
    const url = new URL(location, "https://catalog.example");
    if (variant === "scope") url.searchParams.delete("selectedObservationIds");
    if (variant === "duplicates") url.searchParams.set("selectedObservationIds", "obs_001,obs_001");
    if (variant === "mixed") url.searchParams.set("selectedObservationIds", "obs_001,synthetic-terminal-id");
    if (variant === "draft") url.searchParams.set("promoteAsDraft", "true");
    if (variant === "no-token") url.searchParams.delete("promotionPreviewId");
    if (variant === "stale") url.searchParams.set("profileVersion", "stale-profile");
    const preview = { ...base, ...override };
    const ids = vi.fn<SourceObservationRouteServices["previewPromoteObservations"]>().mockResolvedValue(preview);
    const scope = vi.fn<SourceObservationRouteServices["previewPromoteObservationScope"]>().mockResolvedValue(preview);
    if (variant === "failed") ids.mockRejectedValue(new Error("Synthetic preview failure"));
    const admission = vi.fn();
    const jobs = vi.fn();
    const services = surfaceServices({
      previewPromoteObservations: ids,
      previewPromoteObservationScope: scope,
      admitBulkPromotionJob: admission,
      enqueueBulkReviewJob: jobs,
      enqueueIntegrationJob: jobs,
      getBulkReviewJob: jobs,
      getBulkReviewPromotionOutcome: jobs,
    });
    const app = buildApp(services, mutableProfileStore(), variant === "no-manage" ? viewOnlyActor : undefined);
    const body = await getJson(app, surfacePath("daily", `${url.pathname}${url.search}`));
    expect(body.readModel.promotionPreview.previewCommittable).toBe(expected);
    expect(admission).not.toHaveBeenCalled();
    expect(jobs).not.toHaveBeenCalled();
    if (["no-token", "no-manage"].includes(variant)) {
      expect(ids).not.toHaveBeenCalled();
      expect(scope).not.toHaveBeenCalled();
    } else if (variant === "scope") {
      expect(scope).toHaveBeenCalledTimes(1);
      expect(ids).not.toHaveBeenCalled();
    } else {
      expect(ids).toHaveBeenCalledExactlyOnceWith({
        observationIds: variant === "mixed" ? ["obs_001", "synthetic-terminal-id"] : ["obs_001"],
        promoteAsDraft: variant === "draft",
        validationAfter: null,
      });
      expect(scope).not.toHaveBeenCalled();
    }
  });
});

// Issue #11130: selected preview rules execute through the real Catalog HTTP read.
describe("Catalog daily selected import preview", () => {
  const location = `/catalog/integrations?providerKey=tcgdex&unitKey=${TCGDEX_UNIT}&languageCode=en&productLineId=3&seriesId=base&expansionId=base1`;
  const scope = {
    provider: "tcgdex",
    ingestionUnitKey: TCGDEX_UNIT,
    language: "en",
    productLineId: "3",
    seriesId: "base",
    setId: "base1",
  };
  const preview: Awaited<ReturnType<SourceObservationRouteServices["previewIntegrationImport"]>> = {
    action: "import",
    providerKey: "tcgdex",
    scope,
    profileSnapshot: null,
    targetCount: 0,
    targets: [],
  };
  const path = (value = location) => surfacePath("daily/import-preview", value);
  const emptySummary = {
    requestStrategy: null,
    estimateState: null,
    estimatedRequestCount: null,
    estimateReason: null,
    usageCheckState: null,
    pageSize: null,
    selectedFields: [],
    perRecordFallbackReason: null,
    creditDiagnostic: null,
    degradedDiagnostic: null,
  };
  const estimate = {
    requestStrategy: "bulk-first" as const,
    estimateState: "estimated" as const,
    estimatedRequestCount: 2,
    estimateReason: "first ordinary reason",
    usageCheckState: "checked" as const,
    pageSize: 100,
    selectedFields: ["id", "name"],
    perRecordFallbackReason: null,
    creditDiagnostic: null,
    degradedDiagnostic: null,
  };
  function target(
    usageEstimate: SourceObservationIntegrationImportPreview["targets"][number]["usageEstimate"],
  ): SourceObservationIntegrationImportPreview["targets"][number] {
    return {
      targetId: "synthetic",
      name: "Synthetic",
      languageCode: "en",
      scopeKey: "synthetic",
      planKey: "synthetic",
      transportSteps: [],
      estimatedPayloads: null,
      usageEstimate,
    };
  }
  function setup(value = preview, actor = viewOnlyActor) {
    const plan = vi.fn<SourceObservationRouteServices["previewIntegrationImport"]>().mockResolvedValue(value);
    return { plan, app: buildApp(surfaceServices({ previewIntegrationImport: plan }), mutableProfileStore(), actor) };
  }
  it("derives the scope once and passes the request context for a view-only actor", async () => {
    const { app, plan } = setup();
    expect(await getJson(app, path())).toEqual({ status: "ready", preview, usageSummary: emptySummary });
    expect(plan).toHaveBeenCalledExactlyOnceWith({ scope, context });
  });
  it.each([
    undefined,
    "https://admin.example/catalog/integrations",
    "/other",
    "//elsewhere/catalog/integrations",
    "/catalog/../../other",
  ])("refuses invalid location %s without planning", async (value) => {
    const { app, plan } = setup();
    const response = await app.request(
      value === undefined ? "/source-observations/workbench-surfaces/daily/import-preview" : path(value),
    );
    expect(response.status).toBe(400);
    expect(plan).not.toHaveBeenCalled();
  });
  it("denies an actor without catalog.view before planning", async () => {
    const { app, plan } = setup(preview, { permissions: [] });
    expect((await app.request(path())).status).toBe(403);
    expect(plan).not.toHaveBeenCalled();
  });
  it.each([`/catalog/integrations?providerKey=tcgdex&unitKey=${TCGDEX_UNIT}`])(
    "does not plan an incomplete selection %s",
    async (value) => {
      const { app, plan } = setup();
      expect(await getJson(app, path(value))).toBeNull();
      expect(plan).not.toHaveBeenCalled();
    },
  );
  it("does not plan without any provider or unit selection", async () => {
    const { plan } = setup();
    const app = buildApp(
      surfaceServices({
        previewIntegrationImport: plan,
        listIntegrationScopes: async () => [],
        getCatalogIntegrationControlPlaneReadiness: async () => readiness([]),
      }),
      mutableProfileStore([]),
    );
    expect(await getJson(app, path("/catalog/integrations"))).toBeNull();
    expect(plan).not.toHaveBeenCalled();
  });
  it("fails soft when the planner capability is absent or throws", async () => {
    expect(await getJson(buildApp(surfaceServices(), mutableProfileStore()), path())).toBeNull();
    const { app, plan } = setup();
    plan.mockRejectedValue(new Error("Synthetic private failure"));
    expect(await getJson(app, path())).toBeNull();
    expect(plan).toHaveBeenCalledTimes(1);
  });
  it.each([
    "providerKey",
    "provider",
    "ingestionUnitKey",
    "language",
    "productLineId",
    "seriesId",
    "setId",
    "productId",
  ] as const)("rejects mismatched %s echo", async (field) => {
    const mismatched =
      field === "providerKey"
        ? { ...preview, providerKey: "other" }
        : { ...preview, scope: { ...scope, [field]: "other" } };
    const { app, plan } = setup(mismatched);
    expect(await getJson(app, path())).toBeNull();
    expect(plan).toHaveBeenCalledTimes(1);
  });
  it("accepts folded strings and set intersection but does not constrain absent expected strings", async () => {
    const echoed = {
      ...preview,
      providerKey: " TCGDEX ",
      scope: {
        ...scope,
        provider: " TCGDEX ",
        ingestionUnitKey: ` ${TCGDEX_UNIT.toUpperCase()} `,
        language: " EN ",
        productLineId: " 3 ",
        seriesId: " BASE ",
        setId: "different",
        setName: " BASE1 ",
      },
    };
    const { app } = setup(echoed);
    expect(await getJson(app, path())).toMatchObject({ status: "ready", preview: echoed });
    expect(
      await getJson(app, path(`/catalog/integrations?providerKey=tcgdex&unitKey=${TCGDEX_UNIT}&languageCode=en`)),
    ).toMatchObject({ status: "ready" });
  });
  it("keeps filter precedence and the route match as a conjunction", async () => {
    const { app, plan } = setup({ ...preview, scope: { ...scope, language: "fr" } });
    expect(await getJson(app, path(`${location}&filter.language=fr`))).toBeNull();
    expect(plan).toHaveBeenCalledExactlyOnceWith({ scope: { ...scope, language: "fr" }, context });
  });
  it("uses a set name and the normalized inferred default selection", async () => {
    const { app, plan } = setup({ ...preview, scope: { ...scope, setId: undefined, setName: "Synthetic set" } });
    expect(
      await getJson(
        app,
        path(
          `/catalog/integrations?providerKey=tcgdex&unitKey=${TCGDEX_UNIT}&languageCode=en&expansionName=Synthetic+set`,
        ),
      ),
    ).toMatchObject({ status: "ready" });
    expect(plan.mock.calls[0]?.[0].scope).toMatchObject({ setName: "Synthetic set" });
    plan.mockResolvedValue(preview);
    expect(await getJson(app, path("/catalog/integrations"))).toMatchObject({ status: "ready" });
    expect(plan.mock.calls[1]?.[0].scope).toEqual(scope);
  });
  it("keeps exact product identity, deselection and mixed-language refusal at the HTTP boundary", async () => {
    const profile = catalogProviderIntegrationProfileVersions.find(
      (item) =>
        item.providerKey === "ygojson" &&
        item.profile.supportedScopes.includes("product") &&
        item.active &&
        item.executableMappingContract?.normalizedObservation.outputKind === "yugioh-sealed-product",
    );
    if (!profile || !("ingestionUnitIdentity" in profile) || !profile.ingestionUnitIdentity)
      throw new Error("Synthetic product test requires the registered sealed-product profile.");
    const unit = profile.ingestionUnitIdentity.unitKey;
    const productScope = {
      provider: "ygojson",
      ingestionUnitKey: unit,
      language: "en",
      productId: "synthetic-product-A",
    };
    const productPreview = { ...preview, providerKey: "ygojson", scope: productScope };
    const plan = vi.fn<SourceObservationRouteServices["previewIntegrationImport"]>().mockResolvedValue(productPreview);
    const app = buildApp(
      surfaceServices({ previewIntegrationImport: plan, listIntegrationScopes: async () => [] }),
      mutableProfileStore([profile]),
    );
    const selected = `/catalog/integrations?providerKey=ygojson&unitKey=${unit}&languageCode=en&productId=synthetic-product-A`;
    expect(await getJson(app, path(selected))).toMatchObject({ status: "ready", preview: productPreview });
    expect(plan).toHaveBeenCalledExactlyOnceWith({ scope: productScope, context });
    for (const productId of ["synthetic-product-a", "synthetic-product-B", undefined]) {
      plan.mockResolvedValue({ ...productPreview, scope: { ...productScope, productId } });
      expect(await getJson(app, path(selected))).toBeNull();
    }
    plan.mockResolvedValue(productPreview);
    expect(await getJson(app, path(selected.replace("&productId=synthetic-product-A", "")))).toBeNull();
    plan.mockClear();
    expect(await getJson(app, path(`${selected}&filter.language=fr`))).toBeNull();
    expect(plan).not.toHaveBeenCalled();
  });
  it.each([[[]], [[target(null)]], [[target(estimate), target(null)]]])(
    "summarizes zero/all-null/mixed estimates independently",
    async (targets) => {
      const { app } = setup({ ...preview, targets, targetCount: targets.length });
      const result = await getJson(app, path());
      expect(result.usageSummary).toEqual(targets.some((item) => item.usageEstimate) ? estimate : emptySummary);
    },
  );
  it("folds disagreement, partial counts, unavailable reason priority and ordered unique fields", async () => {
    const targets = [
      target(estimate),
      target({
        ...estimate,
        requestStrategy: "single-record",
        estimateState: "estimate-unavailable",
        estimatedRequestCount: null,
        estimateReason: "first unavailable reason",
        usageCheckState: "unavailable",
        pageSize: 50,
        selectedFields: ["name", "image", ""],
        perRecordFallbackReason: "fallback one",
        creditDiagnostic: "credit one",
        degradedDiagnostic: "degraded one",
      }),
      target({
        ...estimate,
        estimateState: "estimate-unavailable",
        estimateReason: "later unavailable reason",
        selectedFields: ["image", "last"],
        perRecordFallbackReason: "fallback two",
        creditDiagnostic: "credit two",
        degradedDiagnostic: "degraded two",
      }),
    ];
    const { app } = setup({ ...preview, targets, targetCount: 3 });
    expect((await getJson(app, path())).usageSummary).toEqual({
      requestStrategy: null,
      estimateState: "estimate-unavailable",
      estimatedRequestCount: null,
      estimateReason: "first unavailable reason",
      usageCheckState: null,
      pageSize: null,
      selectedFields: ["id", "name", "image", "last"],
      perRecordFallbackReason: "fallback one",
      creditDiagnostic: "credit one",
      degradedDiagnostic: "degraded one",
    });
  });
  it("sums complete counts and keeps the first ordinary reason", async () => {
    const { app } = setup({
      ...preview,
      targets: [target(estimate), target({ ...estimate, estimatedRequestCount: 3, estimateReason: "second" })],
      targetCount: 2,
    });
    expect((await getJson(app, path())).usageSummary).toEqual({ ...estimate, estimatedRequestCount: 5 });
  });
  it("returns unavailable at 2500ms, not 2499ms, and consumes late rejection", async () => {
    vi.useFakeTimers();
    let reject!: (error: Error) => void;
    let started!: () => void;
    const planning = new Promise<void>((resolve) => {
      started = resolve;
    });
    const { app, plan } = setup();
    plan.mockImplementation(() => {
      started();
      return new Promise((_resolve, fail) => {
        reject = fail;
      });
    });
    let settled = false;
    const result = Promise.resolve(app.request(path())).then(async (response) => {
      settled = true;
      return response.json();
    });
    await Promise.race([
      planning,
      result.then(() => {
        throw new Error("Preview read settled before planning started.");
      }),
    ]);
    await vi.advanceTimersByTimeAsync(2499);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toEqual({ status: "unavailable" });
    reject(new Error("Synthetic late private failure"));
    await vi.advanceTimersByTimeAsync(0);
    expect(plan).toHaveBeenCalledTimes(1);
  });
});

describe("Catalog primary workbench surface routes", () => {
  // Issue #11080: real HTTP reads own effective scope and guided import answers.
  it("returns inferred scope equal to the explicit daily scope without fetching default review", async () => {
    const services = surfaceServices();
    const app = buildApp(services, mutableProfileStore());
    const inferred = (await getJson(app, surfacePath("daily", "/catalog/integrations"))).readModel;
    expect(services.listSourceObservations).not.toHaveBeenCalled();
    expect(inferred.routeContext.scope).toEqual({
      providerKey: "tcgdex",
      productId: null,
      languageCode: "en",
      productLineId: "3",
      productLineName: null,
      seriesId: "base",
      seriesName: null,
      expansionId: "base1",
      expansionName: null,
      status: null,
    });
    const explicit = (
      await getJson(app, surfacePath("daily", "/catalog/integrations?providerKey=tcgdex&importScope=en:3:base:base1"))
    ).readModel;
    expect(inferred.routeContext.scope).toEqual(explicit.routeContext.scope);
    expect(buildDailyMergeCandidateQuery(inferred.routeContext)).toBe(
      buildDailyMergeCandidateQuery(explicit.routeContext),
    );
    expect(catalogPrimaryWorkbenchHref(inferred.routeContext)).toBe(catalogPrimaryWorkbenchHref(explicit.routeContext));
    expect(
      inferred.actions.find((action: { key: string }) => action.key === "observation.promote").commandPreview,
    ).toEqual(explicit.actions.find((action: { key: string }) => action.key === "observation.promote").commandPreview);
    const preview: SourceObservationIntegrationImportPreview = {
      action: "import",
      providerKey: "tcgdex",
      scope: {
        provider: "tcgdex",
        ingestionUnitKey: TCGDEX_UNIT,
        language: "en",
        productLineId: "3",
        seriesId: "base",
        setId: "base1",
      },
      profileSnapshot: null,
      targetCount: 0,
      targets: [],
    };
    expect(catalogImportPreviewMatchesSelection(preview, preview.scope, inferred.routeContext)).toBe(true);
    expect(catalogImportPreviewMatchesSelection(preview, preview.scope, inferred.routeContext)).toBe(
      catalogImportPreviewMatchesSelection(preview, preview.scope, explicit.routeContext),
    );
    expect(
      catalogImportPreviewMatchesSelection(
        { ...preview, scope: { ...preview.scope, setId: "sibling" } },
        preview.scope,
        inferred.routeContext,
      ),
    ).toBe(false);
  });

  it.each([
    ["importScope=en:base", { languageCode: "en", seriesId: "base", expansionId: null }],
    ["importScope=en:base:base1", { languageCode: "en", seriesId: "base", expansionId: "base1" }],
    ["importScope=en:3:base:base1", { languageCode: "en", productLineId: "3", seriesId: "base", expansionId: "base1" }],
    ["languageCode=fr", { languageCode: "fr", seriesId: null, expansionId: null }],
    [`unitKey=${TCGDEX_UNIT}`, { languageCode: null, seriesId: null, expansionId: null }],
    [
      "importScope=en:base:base1&languageCode=fr&expansionId=other&expansionName=Other",
      { languageCode: "fr", expansionId: "other", expansionName: "Other" },
    ],
    [
      "unitKey=lorcanajson:lorcana:set:reference-data&importScope=en:base:base1",
      { languageCode: null, seriesId: null, expansionId: null },
    ],
  ])("preserves effective HTTP scope for %s", async (query, scope) => {
    const body = await getJson(
      buildApp(surfaceServices(), mutableProfileStore()),
      surfacePath("daily", `/catalog/integrations?providerKey=tcgdex&${query}`),
    );
    expect(body.readModel.routeContext.scope).toMatchObject({ providerKey: "tcgdex", ...scope });
  });

  // Issue #11142: promotion request composition belongs to the daily API answer.
  it("returns the selected promotion descriptor with exact filters and incomplete-scope ids support", async () => {
    const app = buildApp(surfaceServices(), mutableProfileStore());
    const location = `/catalog/integrations?providerKey=tcgdex&unitKey=${TCGDEX_UNIT}&importScope=en:3:base:base1&profileVersion=synthetic-profile&filter.language=fr&filter.productLineId=synthetic-line&filter.seriesId=synthetic-series&filter.setId=synthetic-set&filter.status=changed&filter.search=synthetic-query`;
    const body = await getJson(app, surfacePath("daily", location));
    const scope = {
      search: "synthetic-query",
      status: "changed",
      provider: "tcgdex",
      language: "fr",
      productLineId: "synthetic-line",
      seriesId: "synthetic-series",
      expansionId: "synthetic-set",
      setId: "synthetic-set",
    };
    expect(
      body.readModel.actions.find((entry: { key: string }) => entry.key === "observation.promote").commandPreview,
    ).toEqual({
      scope,
      confirmation: {
        unitKey: TCGDEX_UNIT,
        importScope: "en:3:base:base1",
        profileVersion: "synthetic-profile",
        scope,
      },
      allowScopeSelection: true,
    });
    expect(body.readModel.sourceScopeWorkset.units.length).toBeGreaterThan(0);
    for (const row of body.readModel.sourceScopeWorkset.units) {
      const rowScope = Object.fromEntries(
        Object.entries({
          provider: row.providerKey,
          language: row.commandContext.languageCode,
          productLineId: row.commandContext.productLineId,
          seriesId: row.commandContext.seriesId,
          expansionId: row.commandContext.expansionId ?? row.commandContext.expansionName,
          setId: row.commandContext.expansionId ?? row.commandContext.expansionName,
        }).filter(([, value]) => value),
      );
      expect(row.actions.previewPromotion.commandPreview).toEqual({
        scope: rowScope,
        confirmation: {
          unitKey: row.unitKey,
          importScope: row.importScope,
          profileVersion: row.profileVersion,
          scope: rowScope,
        },
        allowScopeSelection: Boolean(row.importScope),
      });
    }
    const emptyApp = buildApp(
      surfaceServices({
        listIntegrationScopes: vi.fn(async () => []),
        getCatalogIntegrationControlPlaneReadiness: vi.fn(async () => readiness([])),
      }),
      mutableProfileStore([]),
    );
    const sparse = await getJson(
      emptyApp,
      surfacePath("daily", "/catalog/integrations?selectedObservationIds=synthetic-id"),
    );
    expect(
      sparse.readModel.actions.find((entry: { key: string }) => entry.key === "observation.promote").commandPreview,
    ).toEqual({
      scope: {},
      confirmation: { unitKey: null, importScope: null, profileVersion: null, scope: {} },
      allowScopeSelection: false,
    });
    const empty = await getJson(
      emptyApp,
      surfacePath(
        "daily",
        `/catalog/integrations?providerKey=tcgdex&unitKey=${TCGDEX_UNIT}&importScope=&languageCode=&productLineId=&seriesId=&expansionId=&status=&profileVersion=`,
      ),
    );
    expect(
      empty.readModel.actions.find((entry: { key: string }) => entry.key === "observation.promote").commandPreview,
    ).toEqual({
      scope: { provider: "tcgdex" },
      confirmation: { unitKey: TCGDEX_UNIT, importScope: null, profileVersion: null, scope: { provider: "tcgdex" } },
      allowScopeSelection: false,
    });
    for (const alias of ["setId", "expansionId"]) {
      const answer = await getJson(
        app,
        surfacePath(
          "daily",
          `/catalog/integrations?providerKey=tcgdex&unitKey=${TCGDEX_UNIT}&languageCode=en&productLineId=3&seriesId=base&${alias}=base1&profileVersion=synthetic-profile`,
        ),
      );
      expect(
        answer.readModel.actions.find((entry: { key: string }) => entry.key === "observation.promote").commandPreview,
      ).toEqual({
        scope: {
          provider: "tcgdex",
          language: "en",
          productLineId: "3",
          seriesId: "base",
          expansionId: "base1",
          setId: "base1",
        },
        confirmation: {
          unitKey: TCGDEX_UNIT,
          importScope: "en:3:base:base1",
          profileVersion: "synthetic-profile",
          scope: {
            provider: "tcgdex",
            language: "en",
            productLineId: "3",
            seriesId: "base",
            expansionId: "base1",
            setId: "base1",
          },
        },
        allowScopeSelection: true,
      });
    }
  });

  // Issue #11050: provider detail composes from its own path, not the first scope/profile.
  it("matches explicit provider selection while preserving profile, unit, job and selected observations", async () => {
    const services = surfaceServices({
      getSelectedOptionAuthoringSchema: vi.fn(async () => ({ dimensions: [] })),
      getPromotionTargetAuthoringSchema: vi.fn(async () => ({ blueprints: [], categories: [], fields: [] })),
      listIntegrationScopes: vi.fn(async () => [sourceObservationScope({ provider_key: "tcgplayer" })]),
    });
    const app = buildApp(services, mutableProfileStore());
    const selection = `profileVersion=2026.06.03&unitKey=${TCGDEX_UNIT}&jobId=selected-job&selectedObservationIds=obs-a,obs-b&section=triage`;
    const implicit = await getJson(app, surfacePath("health", `/catalog/providers/tcgdex?${selection}`));
    const explicit = await getJson(
      app,
      surfacePath("health", `/catalog/providers/tcgdex?providerKey=tcgdex&${selection}`),
    );
    expect(implicit.readModel).toEqual(explicit.readModel);
    const empty = await getJson(app, surfacePath("health", `/catalog/providers/tcgdex?providerKey=&${selection}`));
    expect(empty.readModel).toEqual(explicit.readModel);
    expect(implicit.readModel.routeContext).toMatchObject({
      providerKey: "tcgdex",
      unitKey: TCGDEX_UNIT,
      profileVersion: "2026.06.03",
      jobId: "selected-job",
      selectedObservationIds: ["obs-a", "obs-b"],
    });
    const conflict = await getJson(app, surfacePath("health", "/catalog/providers/tcgdex?providerKey=tcgplayer"));
    expect(conflict.readModel.routeContext.providerKey).toBe("tcgplayer");
  });

  it("reads only path-provider schedules once, retaining wire dates and query model precedence", async () => {
    const list = vi.fn(async () => [refreshSchedule("tcgdex"), refreshSchedule("tcgplayer")]);
    const app = buildApp(surfaceServices(), mutableProfileStore(), viewOnlyActor, list);
    const body = await getJson(app, surfacePath("health", "/catalog/providers/tcgdex?providerKey=tcgplayer"));
    expect(body.providerRefreshSchedules).toEqual([refreshSchedule("tcgdex")]);
    expect(body.readModel.routeContext.providerKey).toBe("tcgplayer");
    expect(list).toHaveBeenCalledTimes(1);
    expect((await getJson(app, surfacePath("health", "/catalog/providers/scryfall"))).providerRefreshSchedules).toEqual(
      [],
    );
  });

  it("starts the path-provider schedule read while the health baseline is pending", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const listIntegrationScopes = vi.fn(async () => {
      await pending;
      return [];
    });
    const list = vi.fn(async () => [refreshSchedule("tcgdex")]);
    const response = buildApp(
      surfaceServices({ listIntegrationScopes }),
      mutableProfileStore(),
      viewOnlyActor,
      list,
    ).request(surfacePath("health", "/catalog/providers/tcgdex"));
    try {
      await vi.waitFor(() => expect(listIntegrationScopes).toHaveBeenCalledTimes(1));
      expect(list).toHaveBeenCalledTimes(1);
    } finally {
      release();
    }
    expect((await response).status).toBe(200);
  });

  it("keeps health available on missing or rejected schedule reads without leaking rejection details", async () => {
    const marker = "synthetic-private-schedule-rejection";
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const warnLog = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      for (const list of [
        undefined,
        vi.fn(async () => {
          throw new Error(marker);
        }),
      ]) {
        const body = await getJson(
          buildApp(surfaceServices(), mutableProfileStore(), viewOnlyActor, list),
          surfacePath("health", "/catalog/providers/tcgdex"),
        );
        expect(body.providerRefreshSchedules).toBeNull();
        expect(body.readModel.schemaVersion).toBeTruthy();
        expect(JSON.stringify(body)).not.toContain(marker);
      }
      expect(JSON.stringify([...errorLog.mock.calls, ...warnLog.mock.calls])).not.toContain(marker);
    } finally {
      errorLog.mockRestore();
      warnLog.mockRestore();
    }
  });

  it.each([
    ["health", "/catalog/integrations/health"],
    ["daily", "/catalog/providers/tcgplayer"],
    ["governance", "/catalog/providers/tcgplayer"],
  ])("does not read schedules on %s outside provider health", async (surface, location) => {
    const list = vi.fn(async () => [refreshSchedule("tcgplayer")]);
    const body = await getJson(
      buildApp(surfaceServices(), mutableProfileStore(), providerActor(), list),
      surfacePath(surface, location),
    );
    expect(body).toMatchObject({ providerRefreshSchedules: [], operatorSession: false, operatorSessionActorKey: null });
    expect(list).not.toHaveBeenCalled();
  });

  it("admits the platform admin with view alone and keys actor changes without grant data", async () => {
    for (const [userId, membershipId, permissions] of [
      ["user-a", "membership-a", ["catalog.view"]],
      ["user-b", "membership-a", ["catalog.view", "catalog.manage"]],
      ["user-a", "membership-b", ["catalog.view"]],
    ] as const) {
      const body = await getJson(
        buildApp(surfaceServices(), mutableProfileStore(), { ...providerActor(), userId, membershipId, permissions }),
        surfacePath("health", "/catalog/providers/tcgplayer?providerKey=tcgdex"),
      );
      expect(body).toMatchObject({ operatorSession: true, operatorSessionActorKey: `${userId}:${membershipId}` });
      expect(JSON.stringify(body)).not.toContain("synthetic-grant-secret");
    }
  });

  it.each([
    [
      "non-admin with manage",
      { ...providerActor(), roleKey: "catalog-admin", permissions: ["catalog.view", "catalog.manage"] },
      "tcgplayer",
    ],
    ["missing role", { permissions: ["catalog.view"], userId: "user-a", membershipId: "membership-a" }, "tcgplayer"],
    ["missing user", { ...providerActor(), userId: undefined }, "tcgplayer"],
    ["missing membership", { ...providerActor(), membershipId: undefined }, "tcgplayer"],
    ["empty user", { ...providerActor(), userId: "" }, "tcgplayer"],
    ["empty membership", { ...providerActor(), membershipId: "" }, "tcgplayer"],
    ["another provider", providerActor(), "tcgdex"],
  ] as const)("fails closed for %s despite forged location identity", async (_label, actor, provider) => {
    const body = await getJson(
      buildApp(surfaceServices(), mutableProfileStore(), actor),
      surfacePath(
        "health",
        `/catalog/providers/${provider}?roleKey=platform-admin&userId=forged&membershipId=forged&providerKey=tcgplayer`,
      ),
    );
    expect(body).toMatchObject({ operatorSession: false, operatorSessionActorKey: null });
  });

  it.each([
    [null, 401],
    [{ permissions: [] }, 403],
  ] as const)("keeps outer refusals separate from eligibility", async (actor, status) => {
    const list = vi.fn(async () => []);
    const response = await buildApp(surfaceServices(), mutableProfileStore(), actor, list).request(
      surfacePath("health", "/catalog/providers/tcgplayer"),
    );
    expect(response.status).toBe(status);
    expect(list).not.toHaveBeenCalled();
  });

  it("binds the real schedule service through buildCatalogAuthoringApi exactly once", async () => {
    const listRefreshSchedules = vi.fn(async () => [refreshSchedule("tcgdex"), refreshSchedule("tcgplayer")]);
    const services = {
      operatorSession: {} as never,
      dimensions: {} as never,
      displayTemplates: {} as never,
      fields: {} as never,
      referenceData: {} as never,
      components: {} as never,
      blueprints: {} as never,
      categories: {} as never,
      items: {} as never,
      productContents: {} as never,
      productMeasures: {} as never,
      scopeRegistry: {} as never,
      providerScopeMappings: {} as never,
      countCapture: null,
      providerScopeDiscovery: {
        listRefreshSchedules,
        processScheduledRefresh: async () => {
          throw new Error("Unexpected refresh");
        },
        runProviderRefreshNow: async () => {
          throw new Error("Unexpected refresh");
        },
        setRefreshPaused: async () => {
          throw new Error("Unexpected command");
        },
        listScopeObservations: async () => [],
        listCanonicalScopeRecordProposals: async () => [],
      },
      providerIntegrationProfiles: mutableProfileStore(),
      sourceObservations: {
        ...surfaceServices(),
        getProviderSendWindow: async () => ({ state: "unarmed" as const }),
        commandHandler: async () => {
          throw new Error("Unexpected source observation command");
        },
        providerAdapterRegistry: new ProviderAdapterRegistry([]),
        pruneSourceObservationJobRetention: async () => {
          throw new Error("Unexpected retention command");
        },
        projectors: [],
      },
      scopeSyncBatches: {} as never,
      catalogAliases: {} as never,
      attentionQueue: {} as never,
      authoringBulkJobs: {} as never,
      projectors: [],
      pool: {} as never,
      db: {} as never,
    } satisfies CatalogServices;
    const app = buildCatalogAuthoringTestApp(services, context, providerActor());
    const response = await app.request(`/api/catalog${surfacePath("health", "/catalog/providers/tcgdex")}`);
    expect(response.status).toBe(200);
    expect((await response.json()).providerRefreshSchedules).toEqual([refreshSchedule("tcgdex")]);
    expect(listRefreshSchedules).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["import-jobs", "run-sync"],
    ["provider-scope-selection", "run-sync"],
    ["readiness", "run-sync"],
    ["source-observation-review", "review-changes"],
    ["conflict-resolution", "review-changes"],
    ["promotion-preview", "create-items"],
    ["promotion-result", "create-items"],
  ])("returns the daily flow answer for %s over HTTP", async (section, openStage) => {
    const services = surfaceServices();
    const body = await getJson(
      buildApp(services, mutableProfileStore()),
      surfacePath("daily", `/catalog/integrations?providerKey=tcgdex&section=${section}`),
    );
    expect(body.readModel.flow.openStage).toBe(openStage);
    expect(body.readModel.flow.openStageWithHeldPreview).toBe(openStage);
    expect(body.readModel.flow.stages).toEqual(body.readModel.flow.stagesByOpenStage[openStage]);
    for (const selected of ["run-sync", "review-changes", "create-items"]) {
      expect(body.readModel.flow.stagesByOpenStage[selected].map((stage: { key: string }) => stage.key)).toEqual([
        "run-sync",
        "review-changes",
        "create-items",
      ]);
    }
    expect(services.listSourceObservations).toHaveBeenCalledTimes(1);
  });

  it("returns daily status and flow even when readiness is unavailable", async () => {
    const services = surfaceServices({
      getCatalogIntegrationControlPlaneReadiness: vi.fn(async () => {
        throw new Error("Synthetic unavailable readiness");
      }),
    });
    const body = await getJson(
      buildApp(services, mutableProfileStore()),
      surfacePath("daily", "/catalog/integrations"),
    );
    expect(body.readModel.dailyStatus).toEqual({ governance: null, health: "degraded" });
    expect(body.readModel.flow.openStageWithHeldPreview).toBe("create-items");
    expect(body.readModel.readiness.freshness).not.toBe("fresh");
    expect(body.readModelFailures.length).toBeGreaterThan(0);
  });

  it("returns denied daily governance for a view-only HTTP actor", async () => {
    const app = buildApp(surfaceServices(), mutableProfileStore(), viewOnlyActor);
    const body = await getJson(app, surfacePath("daily", "/catalog/integrations"));
    expect(body.readModel.dailyStatus.governance).toBe("denied");
  });

  it.each([
    ["governance", "/catalog/integrations/governance"],
    ["health", "/catalog/integrations/health"],
  ])("composes the %s surface the admin loader composed from the per-projection routes", async (surface, location) => {
    const app = buildApp(surfaceServices(), mutableProfileStore());

    const body = await getJson(app, surfacePath(surface, location));
    const expected = buildCatalogPrimaryWorkbenchReadModelForSurface(surface as "governance" | "health", {
      requestUrl: new URL(location, "https://admin.example").toString(),
      scopes: await getJson(app, "/source-observations/integration-scopes"),
      profileReviews: await getJson(app, "/source-observations/provider-profiles"),
      controlPlaneOverview: await getJson(app, "/source-observations/integration-control-plane/overview"),
      profileAuthoringModel: null,
      lifecycleImpacts: null,
      readModelFailures: [],
      reviewObservations: null,
      mergeCandidates: null,
      sourceOptionPages: null,
      catalogSyncPreview: null,
      canManageCatalog: true,
    });

    expect(body.readModelFailures).toEqual([]);
    expect(body.readModel).toEqual(JSON.parse(JSON.stringify(expected)));
  });

  it("composes the daily surface the admin loader composed from the per-projection routes", async () => {
    const location = "/catalog/integrations";
    const services = surfaceServices();
    const app = buildApp(services, mutableProfileStore());

    const body = await getJson(app, surfacePath("daily", location));
    const routeContext = parseCatalogPrimaryWorkbenchRouteContext(new URL(location, "https://admin.example"));
    const expected = buildCatalogPrimaryWorkbenchReadModelForSurface("daily", {
      requestUrl: new URL(location, "https://admin.example").toString(),
      scopes: await getJson(app, "/source-observations/integration-scopes"),
      profileReviews: await getJson(app, "/source-observations/provider-profiles"),
      controlPlaneOverview: await getJson(
        app,
        "/source-observations/integration-control-plane/overview?audience=daily",
      ),
      profileAuthoringModel: null,
      lifecycleImpacts: null,
      readModelFailures: [],
      reviewObservations: null,
      mergeCandidates: await getJson(
        app,
        `/source-observations/merge-candidates?${buildDailyMergeCandidateQuery(routeContext)}`,
      ),
      promotionOutcome: null,
      promotionValidation: null,
      reviewPagination: { limit: 25, offset: 0 },
      sourceOptionPages: null,
      catalogSyncPreview: null,
      canManageCatalog: true,
    });

    expect(body.readModelFailures).toEqual([]);
    expect(body.readModel).toEqual(JSON.parse(JSON.stringify(expected)));
    expect(services.listSourceObservations).not.toHaveBeenCalled();
  });

  it("carries the current promotion preview's validation and evidence fingerprint into the daily surface", async () => {
    const validation = {
      promoteAsDraft: false,
      pageLimit: 25,
      coveredObservationIds: ["obs-1"],
      coverage: "complete",
      continuation: null,
      diagnostics: [],
    };
    const previewPromoteObservations = vi.fn(async () => ({
      matched: 1,
      eligible: 1,
      terminal: 0,
      scope: { kind: "selected", observationIds: ["obs-1"] },
      fingerprint: "sha256:current-evidence",
      validation,
    }));
    const app = buildApp(surfaceServices({ previewPromoteObservations }), mutableProfileStore());
    const location = `/catalog/integrations?${new URLSearchParams({
      providerKey: "tcgdex",
      unitKey: TCGDEX_UNIT,
      selectedObservationIds: "obs-1",
      promotionPreviewId: "preview-1",
    })}`;

    const body = await getJson(app, surfacePath("daily", location));

    expect(previewPromoteObservations).toHaveBeenCalledWith(
      expect.objectContaining({ observationIds: ["obs-1"], promoteAsDraft: false }),
    );
    expect(JSON.stringify(body.readModel)).toContain('"currentFingerprint":"sha256:current-evidence"');
  });

  it("reads catalog.manage from the API actor and refuses actors without integration read access", async () => {
    const viewer = buildApp(surfaceServices(), mutableProfileStore(), viewOnlyActor);
    const anonymous = buildApp(surfaceServices(), mutableProfileStore(), null);

    const body = await getJson(viewer, surfacePath("health", "/catalog/integrations/health"));
    const manager = await getJson(
      buildApp(surfaceServices(), mutableProfileStore()),
      surfacePath("health", "/catalog/integrations/health"),
    );

    expect(body.readModel).not.toEqual(manager.readModel);
    expect((await anonymous.request(surfacePath("health", "/catalog/integrations/health"))).status).toBe(401);
  });

  it.each([
    ["an unknown surface", surfacePath("providers", "/catalog/integrations"), 404],
    ["a location outside the Catalog admin", surfacePath("daily", "/account/sales"), 400],
    ["an absolute location", surfacePath("daily", "https://evil.example/catalog/integrations"), 400],
    ["a missing location", "/source-observations/workbench-surfaces/daily", 400],
  ])("refuses %s", async (_label, path, status) => {
    const app = buildApp(surfaceServices(), mutableProfileStore());

    expect((await app.request(path)).status).toBe(status);
  });
});

describe("Catalog HTTP guided import scope answers", () => {
  // These option lists are synthetic controls, not provider observations.
  function syntheticProfile(
    providerKey = "tcgdex",
    scopes: readonly CatalogProviderScope[] = [
      "language",
      "product-line/category",
      "series",
      "expansion",
      "set-name",
      "product/card",
    ],
  ): CatalogProviderIntegrationProfileVersionRecord {
    const base = catalogProviderIntegrationProfileVersions.find(
      (profile) => profile.providerKey === providerKey && profile.active,
    )!;
    return {
      ...base,
      profile: {
        ...base.profile,
        optionQueries: scopes.map((scope, index) => ({
          queryKind: `synthetic-${scope}`,
          displayName: `Synthetic ${scope}`,
          scope,
          parentScope: index === 2 ? "language" : index === 3 ? "series" : null,
          ...(index === 2 || index === 3
            ? {
                parentValue: {
                  required: true,
                  valueKind: "series-id" as const,
                  diagnosticText: "Synthetic choose parent",
                },
              }
            : {}),
          operation: "catalog-provider-profiles",
          output: { valuePath: "value", labelPath: "label", metadataPaths: {} },
        })),
      },
    };
  }

  function setup(profile = syntheticProfile(), fail = false) {
    const queryIntegrationOptions = vi.fn(async (query: { queryKind: string }) => {
      if (fail) throw new Error("Synthetic options unavailable");
      const items = [
        { value: "chosen", label: "Wrong same-valued sibling", parentValue: "other", aliases: [] },
        {
          value: "chosen",
          label: "Native chosen",
          parentValue: "BASE",
          aliases: [
            { aliasText: "English chosen", aliasLanguageCode: "en", confidence: "high", reviewStatus: "accepted" },
          ],
        },
        { value: "sibling", label: "Synthetic sibling", parentValue: "other", aliases: [] },
        { value: "unparented", label: "Synthetic unparented", parentValue: null, aliases: [] },
      ].map((item) => ({
        ...item,
        providerKey: profile.providerKey,
        queryKind: query.queryKind,
        description: null,
        imageUrl: null,
        metadata: {},
      }));
      return {
        items,
        total: 4,
        count: 4,
        page: { cursor: null, nextCursor: null, limit: 200, hasMore: false },
        cache: {
          status: "fresh",
          source: "cache",
          cacheKey: `synthetic:${query.queryKind}`,
          fetchedAt: NOW,
          expiresAt: NOW,
          staleUntil: NOW,
          cacheOnly: true,
          forceRefresh: false,
          degraded: false,
          diagnostics: [],
        },
      };
    });
    const app = buildApp(surfaceServices({ queryIntegrationOptions }), mutableProfileStore([profile]));
    return { app, queryIntegrationOptions };
  }

  async function both(app: ReturnType<typeof buildApp>, location: string) {
    const skeleton = (await getJson(app, surfacePath("daily", location))).readModel.sourceOptions;
    const deferred = await getJson(
      app,
      `/source-observations/workbench-surfaces/daily/source-options?${new URLSearchParams({ location })}`,
    );
    return { skeleton, deferred };
  }

  it("returns all mapped fields in profile order, inferred leaf, gate and a distinct context summary", async () => {
    const { app, queryIntegrationOptions } = setup();
    const skeleton = (await getJson(app, surfacePath("daily", "/catalog/integrations"))).readModel.sourceOptions;
    expect(queryIntegrationOptions).not.toHaveBeenCalled();
    expect(skeleton.guidedFields.map((field: { fieldName: string }) => field.fieldName)).toEqual([
      "languageCode",
      "productLineId",
      "seriesId",
      "expansionId",
      "expansionId",
    ]);
    expect(skeleton.guidedFields[0]).toMatchObject({
      queryKind: "synthetic-language",
      scope: "language",
      label: "Synthetic language",
      selectedValue: "en",
      selectedLabel: "English",
      options: [{ value: "en", label: "English" }],
    });
    expect(skeleton.guidedFields[3]).toMatchObject({
      fieldName: "expansionId",
      labelFieldName: "expansionName",
      selectedValue: "base1",
      parentScope: "series",
      parentMissing: false,
    });
    expect(skeleton.freeTextApplicable).toBe(false);
    expect(skeleton.contextSummary).toBe(
      `tcgdex · ${TCGDEX_UNIT} · en/3/base/base1 · profile ${skeleton.selectedProfile.profileVersion}`,
    );
    expect(skeleton.summary.declaredKinds).toBe(6);
    const { deferred } = await both(app, "/catalog/integrations");
    expect(deferred.guidedFields[3].selectedValue).toBe("base1");
    expect(deferred.contextSummary).toBe(skeleton.contextSummary);
  });

  it.each([
    ["tcgdex", ["chosen", "unparented"]],
    ["lorcanajson", ["unparented"]],
  ])("narrows mixed parents for %s without treating selected fallback as completeness", async (providerKey, values) => {
    const { app } = setup(syntheticProfile(providerKey));
    const { deferred } = await both(
      app,
      `/catalog/integrations?providerKey=${providerKey}&languageCode=en&seriesId=base&expansionId=absent&expansionName=Synthetic+absent`,
    );
    const field = deferred.guidedFields.find((field: { scope: string }) => field.scope === "expansion");
    expect(field.options.map((option: { value: string }) => option.value)).toEqual(["absent", ...values]);
    expect(field.selectedLabel).toBe("Synthetic absent");
    expect(field.options[0]).toEqual({ value: "absent", label: "absent", description: null, parentValue: null });
  });

  it("reports missing parents, hydrates only explicit descendants and never hydrates a parent-only choice", async () => {
    const { app } = setup();
    const parentOnly = await both(
      app,
      `/catalog/integrations?providerKey=tcgdex&unitKey=${TCGDEX_UNIT}&languageCode=fr`,
    );
    expect(parentOnly.deferred.guidedFields[2]).toMatchObject({ selectedValue: "", parentMissing: false });
    expect(parentOnly.deferred.guidedFields[3]).toMatchObject({
      selectedValue: "",
      parentMissing: true,
      parentDiagnostic: "Synthetic choose parent",
    });
    const childOnly = await both(
      app,
      `/catalog/integrations?providerKey=tcgdex&unitKey=${TCGDEX_UNIT}&expansionId=base1`,
    );
    expect(childOnly.deferred.guidedFields[0].selectedValue).toBe("en");
    expect(childOnly.deferred.guidedFields[2].selectedValue).toBe("base");
  });

  it("returns language and accepted alias labels without browser label derivation", async () => {
    const { app } = setup();
    const { deferred } = await both(
      app,
      "/catalog/integrations?providerKey=tcgdex&languageCode=en&seriesId=base&expansionId=chosen",
    );
    expect(deferred.guidedFields[0]).toMatchObject({ selectedValue: "en", selectedLabel: "English" });
    expect(deferred.guidedFields[3]).toMatchObject({
      selectedValue: "chosen",
      selectedLabel: "English chosen (Native chosen)",
    });
  });

  it("keeps deferred failures visibly unavailable beside the selected display fallback", async () => {
    const { app } = setup(syntheticProfile(), true);
    const { deferred } = await both(app, "/catalog/integrations");
    expect(deferred.pages.some((page: { state: string }) => page.state === "unavailable")).toBe(true);
    expect(deferred.guidedFields[3].selectedValue).toBe("base1");
    expect(deferred.status).not.toBe("ready");
  });

  it("returns free text and null summary for an unmapped-only unit", async () => {
    const { app } = setup(syntheticProfile("tcgdex", ["product/card"]));
    const { skeleton, deferred } = await both(app, `/catalog/integrations?providerKey=tcgdex&unitKey=${TCGDEX_UNIT}`);
    for (const answer of [skeleton, deferred]) {
      expect(answer.guidedFields).toEqual([]);
      expect(answer.freeTextApplicable).toBe(true);
      expect(answer.contextSummary).toBeNull();
    }
  });

  it("keeps products distinct from sets over both HTTP reads", async () => {
    const profile = catalogProviderIntegrationProfileVersions.find(
      (profile) =>
        profile.providerKey === "ygojson" &&
        profile.profile.supportedScopes.includes("product") &&
        profile.active &&
        profile.executableMappingContract?.normalizedObservation.outputKind === "yugioh-sealed-product",
    );
    expect(profile).toMatchObject({
      profileKey: "yugioh-sealed-product-reference-data",
      ingestionUnitIdentity: { productForm: "sealed-product" },
      executableMappingContract: { normalizedObservation: { outputKind: "yugioh-sealed-product" } },
    });
    if (!profile || !("ingestionUnitIdentity" in profile) || !profile.ingestionUnitIdentity) {
      throw new Error("Expected the sealed-product profile to declare its ingestion unit.");
    }
    const { app } = setup(profile);
    const unit = profile.ingestionUnitIdentity.unitKey;
    const location = `/catalog/integrations?providerKey=ygojson&unitKey=${unit}&languageCode=en&productId=synthetic-product`;
    const body = await getJson(app, surfacePath("daily", location));
    expect(body.readModel.routeContext.scope).toMatchObject({ productId: "synthetic-product", expansionId: null });
    const { skeleton, deferred } = await both(app, location);
    for (const answer of [skeleton, deferred]) {
      expect(answer.guidedFields).toContainEqual(
        expect.objectContaining({ fieldName: "productId", labelFieldName: null, selectedValue: "synthetic-product" }),
      );
    }
  });
});

describe("Catalog primary workbench surface fail-soft projections", () => {
  const dailyLocation = `/catalog/integrations?providerKey=tcgdex&unitKey=${encodeURIComponent(TCGDEX_UNIT)}&languageCode=en`;
  const failing = async () => {
    throw new Error("synthetic projection failure");
  };

  it.each([
    ["integration-scopes", { listIntegrationScopes: failing }],
    ["control-plane-overview", { getCatalogIntegrationControlPlaneReadiness: failing }],
    ["source-observation-review", { listSourceObservations: failing }],
    ["merge-candidate-review", { listCatalogMergeCandidates: failing }],
  ] as const)("names a failed %s projection instead of reading it as empty", async (failure, overrides) => {
    const app = buildApp(surfaceServices(overrides), mutableProfileStore());

    const body = await getJson(app, surfacePath("daily", dailyLocation));

    expect(body.readModelFailures).toContain(failure);
    expect(body.readModel.schemaVersion).toBeTruthy();
  });

  it("names failed provider profiles instead of reading them as empty", async () => {
    const store = mutableProfileStore();
    const app = buildApp(surfaceServices(), {
      ...store,
      listProfileVersions: failing,
      seedProfileVersions: failing,
    });

    const body = await getJson(app, surfacePath("health", "/catalog/integrations/health"));

    expect(body.readModelFailures).toContain("provider-profiles");
  });

  it("reports no failures when every projection reads", async () => {
    const app = buildApp(surfaceServices(), mutableProfileStore());

    const body = await getJson(app, surfacePath("daily", dailyLocation));

    expect(body.readModelFailures).toEqual([]);
  });

  // Issue #11231: a YGOJSON set reference is stored without a sync run or imageUrls.
  it("lists a counted set-reference observation without a sync run or image URLs", async () => {
    const setId = "synthetic-ygojson-set";
    const observation = {
      ...sourceObservationListItem({
        observation_id: `ygojson_set_en_${setId}`,
        provider_key: "ygojson",
        external_key: `set:${setId}`,
        source_profile_key: "yugioh-set-reference-data",
        status: "observed",
        normalized: {
          tcg: "yugioh",
          kind: "yugioh-set-reference",
          name: "Synthetic set",
          setId,
          setName: "Synthetic set",
          languageCode: "en",
          productLineName: "Yu-Gi-Oh!",
        } as unknown as ReturnType<typeof sourceObservationListItem>["normalized"],
      }),
      sync_run_id: null,
    };
    const listSourceObservations = vi.fn(async () => ({ items: [observation], total: 1 }));
    const app = buildApp(
      surfaceServices({
        listIntegrationScopes: vi.fn(async () => [
          sourceObservationScope({
            provider_key: "ygojson",
            expansion_id: setId,
            expansion_name: "Synthetic set",
            series_id: "",
            series_name: "",
            product_line_id: "",
            product_line_name: "Yu-Gi-Oh!",
            total_observations: 1,
            observed_observations: 1,
            changed_observations: 0,
            promoted_observations: 0,
            rejected_observations: 0,
          }),
        ]),
        listSourceObservations,
      }),
      mutableProfileStore(),
    );
    const unit = encodeURIComponent("ygojson:yugioh:set:reference-data");

    const body = await getJson(
      app,
      surfacePath(
        "daily",
        `/catalog/integrations?providerKey=ygojson&unitKey=${unit}&languageCode=en&section=source-observation-review`,
      ),
    );

    expect(listSourceObservations).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "ygojson", language: "en" }),
    );
    expect(body.readModelFailures).not.toContain("source-observation-review");
    const review = body.readModel.sourceObservationReview;
    expect(review.statusFilters.find((option: { value: string }) => option.value === "all").count).toBe(1);
    expect(review.pagination.total).toBe(1);
    expect(review.rows.map((row: { observationId: string }) => row.observationId)).toEqual([
      observation.observation_id,
    ]);
    expect(review.rows[0].promotionReadiness.state).toBe("eligible");
  });
});

describe("Catalog primary workbench deferred source options pagination", () => {
  const location = `/catalog/integrations?providerKey=tcgplayer&unitKey=${encodeURIComponent(POKEMON_UNIT)}&profileVersion=2026.06.05&sourceOptionAction=force-refresh-all`;
  const path = `/source-observations/workbench-surfaces/daily/source-options?${new URLSearchParams({ location })}`;

  // The seeded TCGplayer Pokemon profile's first, parentless option group.
  const GROUP = "product-lines";

  type OptionQuery = Readonly<{ queryKind: string; cursor?: string }>;

  function optionPage(input: {
    query: OptionQuery;
    nextCursor: string | null;
    hasMore: boolean;
    value?: string;
    // The whole list's option count; each page carries one option.
    total?: number;
    count?: number;
    cacheKey?: string;
  }) {
    return {
      items: [{ value: input.value ?? `option-${input.query.cursor ?? "first"}`, label: "Option", metadata: {} }],
      total: input.total ?? 1,
      count: input.count ?? 1,
      page: { cursor: input.query.cursor ?? null, nextCursor: input.nextCursor, limit: 25, hasMore: input.hasMore },
      cache: {
        status: "fresh",
        source: input.query.cursor ? "cache" : "live",
        cacheKey: input.cacheKey ?? "sha256:stable",
        fetchedAt: NOW,
        expiresAt: NOW,
        staleUntil: NOW,
        cacheOnly: Boolean(input.query.cursor),
        forceRefresh: !input.query.cursor,
        degraded: false,
        diagnostics: [],
      },
    };
  }

  async function surfacePages(
    queryIntegrationOptions: (query: OptionQuery) => Promise<unknown>,
    surfacePath: string = path,
  ) {
    const services = surfaceServices({
      getCatalogIntegrationControlPlaneReadiness: async () =>
        readiness([readinessUnit(POKEMON_UNIT, "tcgplayer", "2026.06.05")]),
      listIntegrationScopes: async () => [],
      queryIntegrationOptions,
    });
    const body = await getJson(buildApp(services, mutableProfileStore()), surfacePath);
    return body.pages as { queryKind: string; state: string; items: { value: string }[] }[];
  }

  async function groupPage(queryIntegrationOptions: (query: OptionQuery) => Promise<unknown>) {
    return (await surfacePages(queryIntegrationOptions)).find((page) => page.queryKind === GROUP);
  }

  function expectPaginationFailure(page: unknown) {
    expect(page).toMatchObject({
      state: "unavailable",
      items: [],
      page: { count: 0, total: 0, hasMore: false, nextCursor: null },
      cache: { diagnostics: [expect.objectContaining({ code: "catalog_provider_option_pagination_invalid" })] },
    });
  }

  it("fails the group closed past the continuation page cap, even when the decisive option lies beyond it", async () => {
    const calls: OptionQuery[] = [];
    const page = await groupPage(async (query) => {
      if (query.queryKind !== GROUP) {
        return optionPage({ query, nextCursor: null, hasMore: false });
      }
      calls.push(query);
      const pageNumber = query.cursor ? Number(query.cursor.slice("page-".length)) : 0;
      return optionPage({
        query,
        nextCursor: `page-${pageNumber + 1}`,
        hasMore: true,
        value: pageNumber === MAX_SOURCE_OPTION_CONTINUATION_PAGES + 1 ? "decisive-option" : undefined,
        total: MAX_SOURCE_OPTION_CONTINUATION_PAGES + 2,
      });
    });

    expect(calls).toHaveLength(MAX_SOURCE_OPTION_CONTINUATION_PAGES + 1);
    expectPaginationFailure(page);
  });

  it("fails the group closed when the option cache changes between pages", async () => {
    const page = await groupPage(async (query) =>
      query.queryKind === GROUP && !query.cursor
        ? optionPage({ query, nextCursor: "page-1", hasMore: true, total: 2 })
        : optionPage({ query, nextCursor: null, hasMore: false, total: 2, cacheKey: "sha256:replaced" }),
    );

    expectPaginationFailure(page);
  });

  it("fails the group closed when the option count changes between pages", async () => {
    const page = await groupPage(async (query) =>
      query.queryKind === GROUP && !query.cursor
        ? optionPage({ query, nextCursor: "page-1", hasMore: true, total: 2 })
        : optionPage({ query, nextCursor: null, hasMore: false, total: 3 }),
    );

    expectPaginationFailure(page);
  });

  it("returns every option when the continuation pages agree with their total", async () => {
    const page = await groupPage(async (query) =>
      query.queryKind !== GROUP
        ? optionPage({ query, nextCursor: null, hasMore: false })
        : !query.cursor
          ? optionPage({ query, nextCursor: "page-1", hasMore: true, total: 2 })
          : optionPage({ query, nextCursor: null, hasMore: false, total: 2 }),
    );

    expect(page!.items.map((item) => item.value)).toEqual(["option-first", "option-page-1"]);
  });

  // Each case answers the group's query with pages that end before, or past, the total they
  // report; every other group gets one complete page.
  it.each([
    [
      "a single last page carries fewer options than its total",
      (query: OptionQuery) => optionPage({ query, nextCursor: null, hasMore: false, total: 3 }),
    ],
    [
      "the continuation pages end, at a stable total, before every option",
      (query: OptionQuery) =>
        query.cursor
          ? optionPage({ query, nextCursor: null, hasMore: false, total: 3 })
          : optionPage({ query, nextCursor: "page-1", hasMore: true, total: 3 }),
    ],
    [
      "the pages carry more options than their total",
      (query: OptionQuery) =>
        query.cursor
          ? optionPage({ query, nextCursor: null, hasMore: false, total: 1 })
          : optionPage({ query, nextCursor: "page-1", hasMore: true, total: 1 }),
    ],
    [
      "a page's count disagrees with the options it carries",
      (query: OptionQuery) => optionPage({ query, nextCursor: null, hasMore: false, total: 1, count: 2 }),
    ],
    [
      "the total is not a count",
      (query: OptionQuery) => optionPage({ query, nextCursor: null, hasMore: false, total: 1.5 }),
    ],
  ])("fails only the group closed when %s", async (_case, groupResponse) => {
    // With a product line selected, its set names load beside the failing group.
    const withProductLine = `/source-observations/workbench-surfaces/daily/source-options?${new URLSearchParams({
      location: `${location}&productLineId=3&productLineName=Pokemon`,
    })}`;
    const pages = await surfacePages(
      async (query) =>
        query.queryKind === GROUP ? groupResponse(query) : optionPage({ query, nextCursor: null, hasMore: false }),
      withProductLine,
    );

    expectPaginationFailure(pages.find((page) => page.queryKind === GROUP));
    const others = pages.filter((page) => page.queryKind !== GROUP && page.state !== "not-requested");
    expect(others.length).toBeGreaterThan(0);
    for (const other of others) {
      expect(other.state).not.toBe("unavailable");
      expect(other.items.length).toBe(1);
    }
  });
});

describe("buildDailyMergeCandidateQuery", () => {
  const baseContext: CatalogPrimaryWorkbenchRouteContext = {
    section: "import-to-promotion",
    providerKey: "tcgplayer",
    unitKey: "tcgplayer:pokemon:single-card:source-observation-import",
    importScope: "en:3:Base Set",
    profileVersion: "2026.06.03",
    sourceObservationFilters: {},
    selectedObservationIds: [],
    reviewOffset: null,
    reviewLimit: null,
    jobId: "job_parent_sync",
    promotionPreviewId: null,
    returnPath: null,
    scope: {
      providerKey: "tcgplayer",
      productId: null,
      languageCode: "en",
      productLineId: "3",
      productLineName: "Pokemon",
      seriesId: null,
      seriesName: null,
      expansionId: "Base Set",
      expansionName: "Base Set",
      status: null,
    },
  };

  it("queries merge candidates by selected catalog scope instead of only the current parent sync run", () => {
    const params = new URLSearchParams(buildDailyMergeCandidateQuery(baseContext));

    expect(params.get("provider")).toBe("tcgplayer");
    expect(params.get("language")).toBe("en");
    expect(params.get("productLineId")).toBe("3");
    expect(params.get("productLineName")).toBe("Pokemon");
    expect(params.get("setId")).toBe("Base Set");
    expect(params.has("syncRunId")).toBe(false);
  });

  it("keeps sync-run filtering when no catalog scope is selected", () => {
    const params = new URLSearchParams(
      buildDailyMergeCandidateQuery({
        ...baseContext,
        importScope: null,
        scope: undefined,
      }),
    );

    expect(params.get("syncRunId")).toBe("job_parent_sync");
    expect(params.has("productLineId")).toBe(false);
  });

  it("uses canonical Scope Record identity on the scope-first journey", () => {
    const params = new URLSearchParams(
      buildDailyMergeCandidateQuery({
        ...baseContext,
        providerKey: null,
        unitKey: null,
        scopeRecordId: "scope_expansion_paldean_fates",
      }),
    );

    expect(params.get("scopeRecordId")).toBe("scope_expansion_paldean_fates");
    expect(params.has("setId")).toBe(false);
    expect(params.has("syncRunId")).toBe(false);
  });
});
