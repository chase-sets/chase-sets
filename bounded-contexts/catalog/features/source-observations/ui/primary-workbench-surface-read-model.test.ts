import {
  buildCatalogPrimaryWorkbenchReadModelForSurface,
  controlPlaneOverview,
  describe,
  expect,
  it,
  profileAuthoringModel,
  profileReview,
  sourceObservationListItem,
  sourceObservationScope,
  validateCatalogPrimaryWorkbenchReadModelContract,
} from "./primary-workbench-read-model-test-support";
import {
  buildCatalogPrimaryWorkbenchDeferredSourceOptions,
  buildCatalogPrimaryWorkbenchSourceOptionRequests,
  type CatalogPrimaryWorkbenchInput,
} from "./primary-workbench-read-model";
import { tcgplayerSourceOptionKinds } from "./primary-workbench-test-fixtures";
import { afterEach, vi } from "vitest";

// Inputs rich enough that every supporting slice has real provider data to render,
// so a per-surface slice that matches the full builder proves it computed that
// slice from the same inputs (rather than collapsing to an empty default).
function fullSurfaceInput(section: string) {
  const profile = profileReview({ active: true, lifecycle: "active" });

  return {
    requestUrl: `https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&importScope=en:3:base:base1&profileVersion=2026.06.04&filter.status=changed&section=${section}`,
    scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
    profileReviews: { items: [profile], total: 1, count: 1 },
    profileAuthoringModel: profileAuthoringModel({ review: profile }),
    controlPlaneOverview: controlPlaneOverview(),
    reviewObservations: {
      items: [sourceObservationListItem({ observation_id: "obs_001", status: "changed", provider_key: "tcgdex" })],
      total: 1,
      count: 1,
    },
    reviewPagination: { limit: 25, offset: 0 },
    canManageCatalog: true,
  };
}

// The action command buttons the daily import-to-promotion surface actually
// renders. The daily read model only needs these action states (plus the core
// review/promotion slices); the lifecycle, clone, and activate action entries are
// present in the array but never surfaced on the daily route.
const dailyRenderedActionKeys = [
  "scope.sync",
  "scope.import",
  "observation.promote",
  "observation.reject",
  "observation.defer",
  "observation.reapply",
  "observation.replay",
] as const;

describe("Catalog primary workbench read model - per-surface slicing", () => {
  it("validates a read model for every audience surface route", () => {
    for (const surface of ["daily", "governance", "health"] as const) {
      const readModel = buildCatalogPrimaryWorkbenchReadModelForSurface(surface, fullSurfaceInput("workbench"));
      expect(() => validateCatalogPrimaryWorkbenchReadModelContract(readModel)).not.toThrow();
    }
  });

  it("keeps every control-plane provider selectable when daily profile reviews are selected-provider scoped", () => {
    const base = fullSurfaceInput("workbench");
    const overview = controlPlaneOverview();
    const tcgdexUnit = overview.readiness.units[0]!;
    const tcgdexProvider = overview.providerReadiness.providers[0]!;
    const referenceProofUnitKey = "reference-cards:pokemon:single-card:source-observation-proof";
    const tcgplayerUnitKey = "tcgplayer:pokemon:single-card:source-observation-import";
    const scrydexUnitKey = "scrydex:one-piece:single-card:source-observation-import";
    const readModel = buildCatalogPrimaryWorkbenchReadModelForSurface("daily", {
      ...base,
      // Staging can trim the daily profile review payload to the selected
      // provider, but the provider dropdown still needs the provider readiness
      // inventory so operators can switch to the other integration profiles.
      profileReviews: { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 },
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      controlPlaneOverview: {
        ...overview,
        readiness: {
          ...overview.readiness,
          units: [
            tcgdexUnit,
            {
              ...tcgdexUnit,
              unitKey: referenceProofUnitKey,
              providerKey: "reference-cards",
              displayName: "Reference Pokemon single-card Source Observation proof",
              ingestionPurpose: "proof",
            },
            {
              ...tcgdexUnit,
              unitKey: tcgplayerUnitKey,
              providerKey: "tcgplayer",
              displayName: "TCGplayer Pokemon products",
              productDomain: "pokemon",
              productForm: "single-card",
              profileVersion: "2026.06.03",
            },
            {
              ...tcgdexUnit,
              unitKey: scrydexUnitKey,
              providerKey: "scrydex",
              displayName: "Scrydex One Piece cards",
              productDomain: "one-piece",
              productForm: "single-card",
              profileVersion: "2026.06.22",
            },
          ],
        },
        providerReadiness: {
          ...overview.providerReadiness,
          providers: [
            tcgdexProvider,
            {
              ...tcgdexProvider,
              providerKey: "reference-cards",
              adapterKey: "reference-cards",
              unitKeys: [referenceProofUnitKey],
            },
            { ...tcgdexProvider, providerKey: "tcgplayer", adapterKey: "tcgplayer", unitKeys: [tcgplayerUnitKey] },
            { ...tcgdexProvider, providerKey: "scrydex", adapterKey: "scrydex", unitKeys: [scrydexUnitKey] },
          ],
        },
      },
    });

    expect(readModel.providerScope.providers.map((provider) => provider.providerKey)).toEqual([
      "scrydex",
      "tcgdex",
      "tcgplayer",
    ]);
    const tcgplayerProvider = readModel.providerScope.providers.find(
      (provider) => provider.providerKey === "tcgplayer",
    );
    expect(tcgplayerProvider).toMatchObject({
      displayName: "TCGplayer Pokemon products",
      units: [{ unitKey: tcgplayerUnitKey, productDomain: "pokemon", productForm: "single-card" }],
    });
    expect(tcgplayerProvider?.units[0]?.activeProfile).toBeNull();
    expect(readModel.providerScope.providers.find((provider) => provider.providerKey === "scrydex")).toMatchObject({
      displayName: "Scrydex One Piece cards",
      units: [{ unitKey: scrydexUnitKey, productDomain: "one-piece", productForm: "single-card" }],
    });
  });

  it("builds the daily surface without computing governance, lifecycle, release, or audit data", () => {
    // The daily surface drops the authoring-model, lifecycle-impact, and overview
    // inputs that the supporting slices feed on; supplying them but asking for the
    // daily surface must still collapse the supporting slices to their cheap
    // unavailable defaults instead of rendering provider data.
    const daily = buildCatalogPrimaryWorkbenchReadModelForSurface("daily", fullSurfaceInput("workbench"));

    // Every overview-gated supporting slice fell back to its overview-absent
    // default: lifecycle recovery surfaces no provider audit events, governance
    // is only partially fresh, audit evidence reports a missing projection, and
    // validation/profile authoring never saw the authoring model.
    expect(daily.lifecycleRecovery.freshness).not.toBe("fresh");
    expect(daily.lifecycleRecovery.recentAuditEvents).toEqual([]);
    expect(daily.governanceControls.freshness).toBe("partial");
    expect(daily.auditEvidence.projectionState.missingProjection).toBe(true);
    expect(daily.validationReadiness.freshness).not.toBe("fresh");
    expect(daily.profileAuthoring.status).toBe("missing-profile");
    expect(daily.profileAuthoring.availableProfiles).toEqual([]);
    expect(daily.profileAuthoring.sectionWorkspaces).toEqual([]);
    expect(daily.validationReadiness.fixtureFlows).toEqual([]);
    expect(daily.validationReadiness.dryRunEvidence).toEqual([]);
    expect(daily.validationReadiness.semanticCompare.sections).toEqual([]);
  });

  it("keeps the daily core slices and rendered action states identical to the full read model", () => {
    const input = fullSurfaceInput("workbench");
    // The health surface renders every supporting slice, so it computes the
    // complete read model — the reference the other surfaces are compared against.
    const full = buildCatalogPrimaryWorkbenchReadModelForSurface("health", input);
    const daily = buildCatalogPrimaryWorkbenchReadModelForSurface("daily", input);

    for (const slice of [
      "routeContext",
      "providerScope",
      "sourceOptions",
      "readiness",
      "importJobs",
      "sourceObservationReview",
      "promotionPreview",
      "securityPrivacy",
      "deploySkew",
      "promotionResult",
    ] as const) {
      expect(daily[slice], `core slice ${slice}`).toEqual(full[slice]);
    }
    for (const key of dailyRenderedActionKeys) {
      expect(
        daily.actions.find((action) => action.key === key),
        `daily action ${key}`,
      ).toEqual(full.actions.find((action) => action.key === key));
    }
  });

  it("surfaces the appended terminal promotion outcome on the daily workbench", () => {
    const readModel = buildCatalogPrimaryWorkbenchReadModelForSurface("daily", {
      ...fullSurfaceInput("promotion-result"),
      promotionOutcome: {
        outcomeId: "job_5801:3",
        jobId: "job_5801",
        eventSequence: 3,
        terminalState: "partial",
        requested: 3,
        promoted: 2,
        skipped: 0,
        failed: 1,
        outcomes: [
          {
            observationId: "obs_001",
            status: "promoted",
            catalogItemId: "cat_001",
            referenceRecordId: null,
            reason: null,
          },
          {
            observationId: "obs_002",
            status: "promoted",
            catalogItemId: null,
            referenceRecordId: "ref_002",
            reason: null,
          },
          {
            observationId: "obs_003",
            status: "failed",
            catalogItemId: null,
            reason: "Conflict requires operator review.",
          },
        ],
        errorMessage: null,
        recordedAt: "2026-07-19T20:00:00.000Z",
      },
    });

    expect(readModel.promotionResult).toEqual({
      resultId: "job_5801:3",
      jobId: "job_5801",
      status: "partial",
      requestedCount: 3,
      promotedCount: 2,
      skippedCount: 0,
      failedCount: 1,
      promotedCatalogItemIds: ["cat_001"],
      promotedReferenceIds: ["ref_002"],
      skippedObservationIds: [],
      failedObservationIds: ["obs_003"],
      redactedFailureReasons: ["Conflict requires operator review."],
      completedAt: "2026-07-19T20:00:00.000Z",
      auditEvidenceIds: ["job_5801:3"],
    });
  });

  it("computes the governance surface's profile/validation slices identically to the full read model (#3832: the retired providers surface's slices, now the v2 Provider detail page's loader input)", () => {
    const input = fullSurfaceInput("profile-work");
    // The health surface renders every supporting slice, so it computes the
    // complete read model — the reference the other surfaces are compared against.
    // "providers" was retired by #3832; the profile-authoring/validation-readiness
    // slices it used to own now feed only the v2 Provider detail page, which
    // composes from "governance"/"health" (see provider-detail-loader.ts) — so
    // this test compares "governance" (the cheaper of the two surfaces that still
    // computes both slices with real data) instead.
    const full = buildCatalogPrimaryWorkbenchReadModelForSurface("health", input);
    const governance = buildCatalogPrimaryWorkbenchReadModelForSurface("governance", input);

    expect(governance.profileAuthoring).toEqual(full.profileAuthoring);
    expect(governance.validationReadiness).toEqual(full.validationReadiness);
    expect(governance.profileAuthoring.status).toBe("ready");
  });

  it("computes the governance surface slices identically to the full read model", () => {
    const input = fullSurfaceInput("conflicts");
    const full = buildCatalogPrimaryWorkbenchReadModelForSurface("health", input);
    const governance = buildCatalogPrimaryWorkbenchReadModelForSurface("governance", input);

    expect(governance.conflictResolution).toEqual(full.conflictResolution);
    expect(governance.lifecycleRecovery).toEqual(full.lifecycleRecovery);
    expect(governance.governanceControls).toEqual(full.governanceControls);
  });
});

// A stand-in whose every traversal throws. A builder that never needs the input
// it replaces passes the reference through untouched; one that reads it fails.
function poisoned(label: string): never {
  const fail = (): never => {
    throw new Error(`traversed omitted input ${label}`);
  };
  return new Proxy(
    {},
    { get: fail, has: fail, ownKeys: fail, getOwnPropertyDescriptor: fail, getPrototypeOf: fail },
  ) as never;
}

function withSourceOptionPages(input: CatalogPrimaryWorkbenchInput): CatalogPrimaryWorkbenchInput {
  const requests = buildCatalogPrimaryWorkbenchSourceOptionRequests({
    requestUrl: input.requestUrl,
    scopes: input.scopes.items,
    profiles: input.profileReviews.items,
    cacheOnly: true,
  });

  return {
    ...input,
    sourceOptionPages: requests.map((request, index) =>
      index === 0
        ? {
            request,
            response: {
              items: [
                {
                  providerKey: request.providerKey,
                  queryKind: request.queryKind,
                  value: "en",
                  label: "English",
                  description: null,
                  parentValue: null,
                  imageUrl: null,
                  aliases: [],
                  metadata: { languageCode: "en" },
                },
              ],
              total: 1,
              count: 1,
              page: { cursor: request.cursor, nextCursor: null, limit: request.limit, hasMore: false },
              cache: {
                status: "fresh",
                source: "cache",
                cacheKey: `sha256:${request.queryKind}`,
                fetchedAt: "2026-06-09T00:00:00.000Z",
                expiresAt: "2026-06-09T00:15:00.000Z",
                staleUntil: "2026-06-10T00:00:00.000Z",
                cacheOnly: request.cacheOnly,
                forceRefresh: false,
                degraded: false,
                diagnostics: [],
              },
            },
          }
        : { request },
    ),
  };
}

const tcgplayerMagicOptionKinds = tcgplayerSourceOptionKinds().map((kind) => ({
  ...kind,
  queryKeySynonyms: [...kind.queryKeySynonyms],
}));
const tcgplayerMagicProfiles = [
  profileReview({
    providerKey: "tcgplayer",
    profileKey: "mtg-single-card-product-sku",
    profileVersion: "2026.06.19",
    ingestionUnitKey: "tcgplayer:mtg:single-card:source-observation-import",
    active: true,
    lifecycle: "active",
    supportedScopes: ["mtg/single-card"],
    sourceOptionKinds: tcgplayerMagicOptionKinds,
  }),
  profileReview({
    providerKey: "tcgplayer",
    profileKey: "mtg-sealed-product-sku",
    profileVersion: "2026.06.19",
    ingestionUnitKey: "tcgplayer:mtg:sealed-product:source-observation-import",
    active: true,
    lifecycle: "active",
    supportedScopes: ["mtg/sealed-product"],
    sourceOptionKinds: tcgplayerMagicOptionKinds,
  }),
];
const tcgplayerMagicScope = sourceObservationScope({
  provider_key: "tcgplayer",
  product_line_id: "1",
  product_line_name: "Magic",
});

// Route selection outcomes the extracted selection owner must keep: provider/unit
// conflicts, ambiguous units, inferred/explicit language, structured and legacy
// scope fallbacks, and the empty defaults.
const selectionCases: readonly (readonly [
  string,
  string,
  Partial<CatalogPrimaryWorkbenchInput>,
  Readonly<{
    providerKey: string | null;
    unitKey: string | null;
    importScope: string | null;
    profileVersion: string | null;
    languageCode: string | null;
    productLineId: string | null;
    expansionId: string | null;
  }>,
])[] = [
  [
    "a unit from another provider falls back to the provider's inferred unit",
    "providerKey=tcgdex&unitKey=tcgplayer:mtg:single-card:source-observation-import",
    {},
    {
      providerKey: "tcgdex",
      unitKey: "tcgdex:pokemon:card:import",
      importScope: null,
      profileVersion: "2026.06.04",
      languageCode: null,
      productLineId: null,
      expansionId: null,
    },
  ],
  [
    "several active units for one provider leave the unit unselected",
    "providerKey=tcgplayer",
    {
      scopes: { items: [tcgplayerMagicScope], total: 1, count: 1 },
      profileReviews: { items: tcgplayerMagicProfiles, total: 2, count: 2 },
    },
    {
      providerKey: "tcgplayer",
      unitKey: null,
      importScope: null,
      profileVersion: null,
      languageCode: null,
      productLineId: null,
      expansionId: null,
    },
  ],
  [
    "a structured set infers its language from the provider scope rows",
    "providerKey=tcgdex&expansionId=base1",
    {},
    {
      providerKey: "tcgdex",
      unitKey: "tcgdex:pokemon:card:import",
      importScope: "en:base1",
      profileVersion: "2026.06.04",
      languageCode: "en",
      productLineId: null,
      expansionId: "base1",
    },
  ],
  [
    "an explicit language wins over the inferred one",
    "providerKey=tcgdex&language=ja&expansionId=base1",
    {},
    {
      providerKey: "tcgdex",
      unitKey: "tcgdex:pokemon:card:import",
      importScope: "ja:base1",
      profileVersion: "2026.06.04",
      languageCode: "ja",
      productLineId: null,
      expansionId: "base1",
    },
  ],
  [
    "a legacy import scope that matches no provider scope is dropped on a source-option refresh",
    "providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&importScope=xx:9:zz:zz1&sourceOptionAction=refresh",
    {},
    {
      providerKey: "tcgdex",
      unitKey: "tcgdex:pokemon:card:import",
      importScope: null,
      profileVersion: "2026.06.04",
      languageCode: null,
      productLineId: null,
      expansionId: null,
    },
  ],
  [
    "a legacy structured scope is sanitized to the option profile's selectable scopes",
    "providerKey=tcgplayer&unitKey=tcgplayer:mtg:single-card:source-observation-import&productLineId=1&seriesId=s1&expansionId=e1&language=en&sourceOptionAction=refresh",
    {
      scopes: { items: [tcgplayerMagicScope], total: 1, count: 1 },
      profileReviews: { items: [tcgplayerMagicProfiles[0]!], total: 1, count: 1 },
    },
    {
      providerKey: "tcgplayer",
      unitKey: "tcgplayer:mtg:single-card:source-observation-import",
      importScope: "en:1",
      profileVersion: "2026.06.19",
      languageCode: "en",
      productLineId: "1",
      expansionId: null,
    },
  ],
  [
    "a product coordinate the profile cannot select falls back to the provider scope",
    "providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&productId=p1",
    {},
    {
      providerKey: "tcgdex",
      unitKey: "tcgdex:pokemon:card:import",
      importScope: null,
      profileVersion: "2026.06.04",
      languageCode: null,
      productLineId: null,
      expansionId: null,
    },
  ],
  [
    "an empty catalog keeps every selection empty",
    "",
    {
      scopes: { items: [], total: 0, count: 0 },
      profileReviews: { items: [], total: 0, count: 0 },
      profileAuthoringModel: null,
      controlPlaneOverview: null,
      reviewObservations: null,
      canManageCatalog: false,
    },
    {
      providerKey: null,
      unitKey: null,
      importScope: null,
      profileVersion: null,
      languageCode: null,
      productLineId: null,
      expansionId: null,
    },
  ],
];

describe("Catalog primary workbench read model - surface output and traversal", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("workbench surfaces preserve output and omit unused traversal", () => {
    // Without an overview the model stamps the current time; pin it so separate
    // builds of the same input compare byte for byte.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-19T12:00:00.000Z"));
    const input = withSourceOptionPages(fullSurfaceInput("workbench"));
    const overview = input.controlPlaneOverview!;

    // Daily renders no governance, lifecycle, health, or audit slice, so the
    // inputs only those slices read stay untouched...
    const dailyOmitted: CatalogPrimaryWorkbenchInput = {
      ...input,
      profileAuthoringModel: poisoned("profileAuthoringModel"),
      lifecycleImpacts: poisoned("lifecycleImpacts"),
      controlPlaneOverview: { ...overview, auditLifecycle: poisoned("controlPlaneOverview.auditLifecycle") },
    };
    expect(buildCatalogPrimaryWorkbenchReadModelForSurface("daily", dailyOmitted)).toEqual(
      buildCatalogPrimaryWorkbenchReadModelForSurface("daily", input),
    );
    // ...while the surfaces that do render them read those same inputs.
    for (const surface of ["governance", "health"] as const) {
      expect(() => buildCatalogPrimaryWorkbenchReadModelForSurface(surface, dailyOmitted)).toThrow(
        /traversed omitted input/,
      );
    }

    // The deferred slice is byte-identical to the synchronous one and derives
    // from the loader baseline alone: no review, candidate, sync, promotion,
    // job-activity, or audit input is traversed to produce it.
    const synchronous = buildCatalogPrimaryWorkbenchReadModelForSurface("daily", input).sourceOptions;
    const deferredOmitted: CatalogPrimaryWorkbenchInput = {
      ...dailyOmitted,
      reviewObservations: poisoned("reviewObservations"),
      mergeCandidates: poisoned("mergeCandidates"),
      promotionOutcome: poisoned("promotionOutcome"),
      promotionValidation: poisoned("promotionValidation"),
      catalogSyncPreview: poisoned("catalogSyncPreview"),
      controlPlaneOverview: {
        ...overview,
        auditLifecycle: poisoned("controlPlaneOverview.auditLifecycle"),
        unitActivity: poisoned("controlPlaneOverview.unitActivity"),
      },
    };
    const deferred = buildCatalogPrimaryWorkbenchDeferredSourceOptions(deferredOmitted);
    expect(synchronous.pages.some((page) => page.items.length > 0)).toBe(true);
    expect(JSON.stringify(deferred)).toBe(JSON.stringify(synchronous));
    expect(JSON.stringify(deferred)).not.toContain("total_observations");
    expect(() => buildCatalogPrimaryWorkbenchReadModelForSurface("daily", deferredOmitted)).toThrow(
      /traversed omitted input/,
    );

    for (const [name, query, overrides, expected] of selectionCases) {
      const caseInput = {
        ...fullSurfaceInput("workbench"),
        requestUrl: `https://admin.example/catalog/integrations?${query}`,
        ...overrides,
      };
      const models = (["daily", "governance", "health"] as const).map((surface) =>
        buildCatalogPrimaryWorkbenchReadModelForSurface(surface, caseInput),
      );
      for (const model of models) {
        expect(model.routeContext, name).toEqual(models[0]!.routeContext);
        expect(model.sourceOptions, name).toEqual(models[0]!.sourceOptions);
      }
      const { routeContext } = models[0]!;
      expect(
        {
          providerKey: routeContext.providerKey,
          unitKey: routeContext.unitKey,
          importScope: routeContext.importScope,
          profileVersion: routeContext.profileVersion,
          languageCode: routeContext.scope?.languageCode ?? null,
          productLineId: routeContext.scope?.productLineId ?? null,
          expansionId: routeContext.scope?.expansionId ?? null,
        },
        name,
      ).toEqual(expected);
      expect(JSON.stringify(buildCatalogPrimaryWorkbenchDeferredSourceOptions(caseInput)), name).toBe(
        JSON.stringify(models[0]!.sourceOptions),
      );
    }
  });
});
