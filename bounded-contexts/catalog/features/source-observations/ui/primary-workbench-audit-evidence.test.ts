import {
  buildCatalogPrimaryWorkbenchReadModel,
  buildCatalogPrimaryWorkbenchSourceObservationReviewQuery,
  catalogProviderProfileEditableSectionKeys,
  cleanVerificationReport,
  controlPlaneOverview,
  describe,
  expect,
  integrationJobSummary,
  it,
  jsonClone,
  lifecycleImpact,
  profileAuthoringModel,
  profileReview,
  sourceObservationListItem,
  sourceObservationScope,
  tcgdexPokemonCardSourceObservationMappingContract,
  tcgdexPokemonTcgProviderProfile,
  tcgplayerAutomationClientProviderProfile,
  validateCatalogPrimaryWorkbenchReadModelContract,
  type CatalogProviderIntegrationProfile,
} from "./primary-workbench-read-model-test-support";
import { catalogMergeCandidateListItem } from "./primary-workbench-test-fixtures";
import { catalogEntityEvidenceHref, parseCatalogEvidenceReference } from "./primary-workbench-evidence-reference";
import type { CatalogPrimaryWorkbenchInput } from "./primary-workbench-read-model-input";
import { auditEvidenceFor } from "./primary-workbench-audit-evidence";
import { importJobsFor } from "./primary-workbench-import-jobs";
import { parseCatalogPrimaryWorkbenchRouteContext } from "./primary-workbench-route-context";

function entityInput(
  reference: string,
  overrides: Partial<CatalogPrimaryWorkbenchInput> = {},
): CatalogPrimaryWorkbenchInput {
  return {
    requestUrl: `https://admin.example/catalog/providers/tcgdex?evidenceRef=${encodeURIComponent(reference)}`,
    scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
    profileReviews: { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 },
    controlPlaneOverview: controlPlaneOverview(),
    canManageCatalog: true,
    ...overrides,
  };
}

describe("Catalog primary workbench read model - audit evidence", () => {
  it("normalizes unsupported loader locations to their live owner without admitting a retired path", () => {
    const audit = buildCatalogPrimaryWorkbenchReadModel(
      entityInput("provider/tcgdex", {
        requestUrl:
          "https://admin.example/catalog/integrations/providers?providerKey=tcgdex&evidenceRef=provider/tcgdex",
      }),
    ).auditEvidence;
    expect(audit.returnToPrimaryHref).toBe("/catalog/providers/tcgdex?providerKey=tcgdex");
    expect(
      audit.evidenceLinks.every(
        (link) => new URL(link.href, "https://admin.example").pathname === "/catalog/providers/tcgdex",
      ),
    ).toBe(true);
  });
  it("selects a provider across loaded units rather than inheriting the workbench's default unit", () => {
    const overview = controlPlaneOverview();
    const unit = "tcgdex:pokemon:sealed-product:source-observation-import";
    const audit = buildCatalogPrimaryWorkbenchReadModel(
      entityInput("provider/tcgdex", {
        controlPlaneOverview: {
          ...overview,
          unitActivity: {
            ...overview.unitActivity,
            units: [
              ...overview.unitActivity.units,
              { unitKey: unit, recentJobs: [integrationJobSummary({ jobId: "sibling-unit-job", unitKey: unit })] },
            ],
          },
        },
      }),
    ).auditEvidence;
    expect(audit.timeline.some((row) => row.jobId === "sibling-unit-job")).toBe(true);
    const withoutProfile = buildCatalogPrimaryWorkbenchReadModel(
      entityInput("provider/tcgdex", { profileReviews: { items: [], total: 0, count: 0 } }),
    ).auditEvidence;
    expect(withoutProfile.selection).toMatchObject({ state: "resolved", deepLinkOpen: true });
    expect(withoutProfile.timeline.some((row) => row.providerKey === "tcgdex")).toBe(true);
  });
  it("rejects foreign-provider membership even when the bounded input contains the requested id", () => {
    const audit = buildCatalogPrimaryWorkbenchReadModel(
      entityInput("source-observation/foreign", {
        reviewObservations: {
          items: [sourceObservationListItem({ observation_id: "foreign", provider_key: "other" })],
          total: 1,
          count: 1,
        },
      }),
    ).auditEvidence;
    expect(audit.selection).toMatchObject({ state: "no-associated-evidence", deepLinkOpen: false });
    expect(audit.timeline).toEqual([]);
  });
  it("excludes unrelated Scope observations and unresolved job membership", () => {
    const overview = controlPlaneOverview();
    const input = entityInput("scope/scope-base", {
      requestUrl:
        "https://admin.example/catalog/scopes/scope-base?scopeRecordId=scope-base&providerKey=tcgdex&importScope=en:3:base:base1&evidenceRef=scope/scope-base",
      controlPlaneOverview: {
        ...overview,
        unitActivity: {
          ...overview.unitActivity,
          units: [
            {
              unitKey: "tcgdex:pokemon:card:import",
              recentJobs: [integrationJobSummary({ jobId: "unresolved", importScope: null })],
            },
          ],
        },
      },
      reviewObservations: {
        items: [
          sourceObservationListItem({ observation_id: "belongs" }),
          sourceObservationListItem({
            observation_id: "other-scope",
            normalized: { ...sourceObservationListItem().normalized, expansionId: "other" },
          }),
        ],
        total: 2,
        count: 2,
      },
    });
    const audit = buildCatalogPrimaryWorkbenchReadModel(input).auditEvidence;
    expect(audit.selection.state).toBe("resolved");
    expect(audit.timeline.length).toBeGreaterThan(0);
    expect(audit.timeline.every((row) => row.observationId === "belongs")).toBe(true);
  });
  it("selects dry-run source identity before its eight-row cap and rejects null or unrelated versions", () => {
    const input = entityInput("provider-profile/2026.06.04/tcgdex");
    const model = buildCatalogPrimaryWorkbenchReadModel(input);
    const dry = model.validationReadiness.dryRunEvidence[0]!;
    const audit = auditEvidenceFor({
      requestUrl: input.requestUrl,
      routeContext: model.routeContext,
      controlPlaneOverview: input.controlPlaneOverview,
      profiles: input.profileReviews.items,
      providerKeys: ["tcgdex"],
      observations: [],
      candidates: [],
      aliases: [],
      generatedAt: model.generatedAt,
      conflictResolution: model.conflictResolution,
      healthTriage: model.healthTriage,
      importJobs: model.importJobs.jobs,
      promotionPreview: model.promotionPreview,
      securityPrivacy: model.securityPrivacy,
      sourceObservationReview: model.sourceObservationReview,
      reviewEvidenceByObservationId: new Map(),
      validationReadiness: {
        ...model.validationReadiness,
        dryRunEvidence: [
          ...Array.from({ length: 9 }, (_, index) => ({
            ...dry,
            externalKey: `unrelated-${index}`,
            profileVersion: "other-version",
          })),
          { ...dry, externalKey: "null-version", profileVersion: null },
          { ...dry, externalKey: "other-provider", providerKey: "other" },
          { ...dry, externalKey: "selected-proof", providerKey: "tcgdex", profileVersion: "2026.06.04" },
        ],
      },
    });
    expect(audit.timeline.map((row) => row.eventId)).toEqual(["dry-run:tcgdex:2026.06.04:selected-proof"]);
    expect(audit.timeline[0]?.targetId).toBe("2026.06.04");
    expect(audit.evidenceLinks.map((link) => link.label)).toEqual(["selected-proof"]);
  });
  it("selects a direct observation after sixteen unrelated observations, before the source cap", () => {
    const observations = [
      ...Array.from({ length: 17 }, (_, index) => sourceObservationListItem({ observation_id: `unrelated-${index}` })),
      sourceObservationListItem({ observation_id: "selected", promoted_catalog_item_id: "item-selected" }),
    ];
    const input = entityInput("source-observation/selected", {
      reviewObservations: { items: observations, total: observations.length, count: observations.length },
    });
    const audit = buildCatalogPrimaryWorkbenchReadModel(input).auditEvidence;
    expect(audit.selection).toMatchObject({ state: "resolved", deepLinkOpen: true });
    expect(audit.timeline.map((row) => row.targetId)).toEqual(["selected"]);
    expect(audit.evidenceLinks).toHaveLength(1);
    const roundTrip = buildCatalogPrimaryWorkbenchReadModel({
      ...input,
      requestUrl: new URL(audit.evidenceLinks[0]!.href, "https://admin.example").toString(),
    }).auditEvidence;
    expect(roundTrip.selection).toEqual(audit.selection);
    expect(roundTrip.timeline.map((row) => row.eventId)).toEqual(audit.timeline.map((row) => row.eventId));
    const item = buildCatalogPrimaryWorkbenchReadModel({
      ...input,
      requestUrl: "https://admin.example/catalog/providers/tcgdex?evidenceRef=catalog-item/item-selected",
    }).auditEvidence;
    expect(item.timeline.map((row) => row.observationId)).toEqual(["selected"]);
  });

  it("resolves scope jobs before twelve jobs and fifty newer unrelated projection rows", () => {
    const overview = controlPlaneOverview();
    const jobs = [
      ...Array.from({ length: 13 }, (_, index) =>
        integrationJobSummary({ jobId: `other-${index}`, importScope: "en:3:other:other" }),
      ),
      integrationJobSummary({ jobId: "selected-job", importScope: "en:3:base:base1" }),
    ];
    const entry = {
      eventId: "selected-event",
      occurredAt: "2026-01-01T00:00:00.000Z",
      eventName: "import-job-started" as const,
      category: "import-job" as const,
      providerKey: "tcgdex",
      unitKey: "tcgdex:pokemon:card:import",
      profileVersion: null,
      actorUserId: "operator",
      relatedJobId: "selected-job",
      summary: "Selected job evidence",
      diagnosticCodes: [],
    };
    const input = entityInput("scope/scope-base", {
      requestUrl:
        "https://admin.example/catalog/scopes/scope-base?scopeRecordId=scope-base&providerKey=tcgdex&importScope=en:3:base:base1&evidenceRef=scope/scope-base",
      controlPlaneOverview: {
        ...overview,
        unitActivity: {
          ...overview.unitActivity,
          units: [{ unitKey: "tcgdex:pokemon:card:import", recentJobs: jobs }],
        },
        auditLifecycle: {
          ...overview.auditLifecycle,
          entries: [
            ...Array.from({ length: 55 }, (_, index) => ({
              ...entry,
              eventId: `unrelated-${index}`,
              relatedJobId: `unknown-${index}`,
              occurredAt: "2026-11-01T00:00:00.000Z",
            })),
            entry,
          ],
        },
      },
    });
    const audit = buildCatalogPrimaryWorkbenchReadModel(input).auditEvidence;
    expect(audit.timeline.map((row) => row.eventId)).toContain("selected-event");
    expect(audit.timeline.every((row) => row.jobId === "selected-job")).toBe(true);
    expect(
      audit.evidenceLinks.every(
        (link) => new URL(link.href, "https://admin.example").pathname === "/catalog/scopes/scope-base",
      ),
    ).toBe(true);
  });

  it("resolves candidates through member observations and actual promoted records, never preview hashes", () => {
    const candidate = catalogMergeCandidateListItem({ matched_catalog_item_id: "actual-item" });
    const observation = sourceObservationListItem({
      observation_id: candidate.membership_json[0]!.observationId,
      promoted_catalog_item_id: "actual-item",
    });
    const input = entityInput(`candidate/${candidate.candidate_id}`, {
      requestUrl: `https://admin.example/catalog/scopes/scope_pokemon_base_set?scopeRecordId=scope_pokemon_base_set&evidenceRef=candidate/${candidate.candidate_id}`,
      mergeCandidates: { items: [candidate], total: 1, count: 1 },
      reviewObservations: {
        items: [observation, sourceObservationListItem({ observation_id: "other-observation" })],
        total: 2,
        count: 2,
      },
    });
    const audit = buildCatalogPrimaryWorkbenchReadModel(input).auditEvidence;
    expect(audit.selection.state).toBe("resolved");
    expect(audit.timeline.length).toBeGreaterThan(0);
    expect(
      audit.timeline.every(
        (row) => row.observationId === observation.observation_id || row.catalogItemId === "actual-item",
      ),
    ).toBe(true);
    expect(audit.timeline.some((row) => row.targetId.startsWith("sha256:"))).toBe(false);
    const memberOnly = buildCatalogPrimaryWorkbenchReadModel({ ...input, reviewObservations: null }).auditEvidence;
    expect(memberOnly.timeline.some((row) => row.observationId === observation.observation_id)).toBe(true);
  });

  it("resolves candidate runs to loaded child job ids before source and final caps, never same-Scope jobs or run ids", () => {
    const seed = catalogMergeCandidateListItem();
    const candidate = {
      ...seed,
      candidate_id: "synthetic-candidate",
      sync_run_ids_json: ["synthetic-sync-run"],
      membership_json: seed.membership_json.map((member) => ({ ...member, syncRunId: "synthetic-sync-run" })),
    };
    const overview = controlPlaneOverview();
    const entry = {
      eventId: "synthetic-child-event",
      occurredAt: "2026-01-01T00:00:00.000Z",
      eventName: "import-job-started" as const,
      category: "import-job" as const,
      providerKey: "tcgdex",
      unitKey: "tcgdex:pokemon:card:import",
      profileVersion: null,
      actorUserId: null,
      relatedJobId: "synthetic-child-job",
      summary: "Synthetic child job evidence",
      diagnosticCodes: [],
    };
    const input = entityInput(`candidate/${candidate.candidate_id}`, {
      requestUrl: `https://admin.example/catalog/scopes/scope_pokemon_base_set?scopeRecordId=scope_pokemon_base_set&providerKey=tcgdex&importScope=en:3:base:base1&evidenceRef=candidate/${candidate.candidate_id}`,
      mergeCandidates: { items: [candidate], total: 1, count: 1 },
      controlPlaneOverview: {
        ...overview,
        unitActivity: {
          ...overview.unitActivity,
          units: [
            {
              unitKey: entry.unitKey,
              recentJobs: [
                ...Array.from({ length: 55 }, (_, index) =>
                  integrationJobSummary({
                    jobId: `unrelated-${index}`,
                    syncRunId: `other-run-${index}`,
                    importScope: "en:3:base:base1",
                  }),
                ),
                integrationJobSummary({
                  jobId: "synthetic-child-job",
                  syncRunId: "synthetic-sync-run",
                  createdAt: entry.occurredAt,
                  startedAt: entry.occurredAt,
                }),
                integrationJobSummary({ jobId: "null-run-job", syncRunId: null }),
                integrationJobSummary({
                  jobId: "foreign-provider-job",
                  providerKey: "other",
                  syncRunId: "synthetic-sync-run",
                }),
              ],
            },
          ],
        },
        auditLifecycle: {
          ...overview.auditLifecycle,
          entries: [
            ...Array.from({ length: 55 }, (_, index) => ({
              ...entry,
              eventId: `unrelated-${index}`,
              relatedJobId: `unrelated-${index}`,
              occurredAt: "2026-11-01T00:00:00.000Z",
            })),
            { ...entry, eventId: "invented-run-target", relatedJobId: "synthetic-sync-run" },
            { ...entry, eventId: "foreign-provider-event", providerKey: "other", relatedJobId: "foreign-provider-job" },
            entry,
          ],
        },
      },
    });
    const audit = buildCatalogPrimaryWorkbenchReadModel(input).auditEvidence;
    expect(audit.selection).toMatchObject({ state: "resolved", deepLinkOpen: true });
    const jobs = importJobsFor(
      input.controlPlaneOverview,
      parseCatalogPrimaryWorkbenchRouteContext(input.requestUrl),
      [],
      Infinity,
    );
    expect(jobs.find((job) => job.jobId === "synthetic-child-job")).toMatchObject({ syncRunId: "synthetic-sync-run" });
    expect(jobs.find((job) => job.jobId === "null-run-job")).toMatchObject({ syncRunId: null });
    expect(audit.timeline.map((row) => row.eventId)).toContain("synthetic-child-event");
    const jobRows = audit.timeline.filter((row) => row.targetType === "import-job");
    expect(jobRows.map((row) => row.eventId)).toEqual(["synthetic-child-event", "job:synthetic-child-job:running"]);
    expect(jobRows.every((row) => row.targetId === "synthetic-child-job")).toBe(true);
    expect(audit.timeline.some((row) => row.eventId === "invented-run-target")).toBe(false);
    expect(audit.timeline.every((row) => !row.jobId || row.jobId === "synthetic-child-job")).toBe(true);
    const candidateOnlyUrl = new URL(input.requestUrl);
    candidateOnlyUrl.searchParams.delete("providerKey");
    candidateOnlyUrl.searchParams.delete("importScope");
    const candidateOnly = buildCatalogPrimaryWorkbenchReadModel({
      ...input,
      requestUrl: candidateOnlyUrl,
    }).auditEvidence;
    expect(candidateOnly.timeline.map((row) => row.eventId)).toContain("synthetic-child-event");
    expect(candidateOnly.timeline.every((row) => !row.jobId || row.jobId === "synthetic-child-job")).toBe(true);
  });

  it.each([
    "https://evil.example",
    "source-observation/missing",
    "provider/other",
    "provider-profile/missing/tcgdex",
    "unknown/id",
    "%E0%A4%A",
  ])("does not broaden invalid or nonmember reference %s", (reference) => {
    const audit = buildCatalogPrimaryWorkbenchReadModel(entityInput(reference)).auditEvidence;
    expect(audit.selection).toMatchObject({ state: "no-associated-evidence", deepLinkOpen: false });
    expect(audit.timeline).toEqual([]);
    expect(audit.evidenceLinks).toEqual([]);
  });

  it("keeps version evidence strictly typed and provider-associated, with a fifty-row final bound", () => {
    const overview = controlPlaneOverview();
    const matching = {
      eventId: "profile",
      occurredAt: "2026-06-09T00:00:00.000Z",
      unitKey: null,
      actorUserId: "operator",
      summary: "Profile evidence",
      diagnosticCodes: [],
      providerKey: "tcgdex",
      profileVersion: "2026.06.04",
      relatedJobId: null,
      category: "profile" as const,
      eventName: "profile-created" as const,
    };
    const audit = buildCatalogPrimaryWorkbenchReadModel(
      entityInput("provider-profile/2026.06.04/tcgdex", {
        controlPlaneOverview: {
          ...overview,
          auditLifecycle: {
            ...overview.auditLifecycle,
            entries: [
              ...Array.from({ length: 55 }, (_, index) => ({ ...matching, eventId: `match-${index}` })),
              { ...matching, eventId: "null-version", profileVersion: null },
              { ...matching, eventId: "other-provider", providerKey: "other" },
              { ...matching, eventId: "other-version", profileVersion: "other-version" },
              {
                ...matching,
                eventId: "job-not-profile",
                category: "import-job",
                relatedJobId: "job_001",
                eventName: "import-job-started",
              },
            ],
          },
        },
      }),
    ).auditEvidence;
    expect(audit.timeline).toHaveLength(50);
    expect(audit.timeline.every((row) => row.eventId.startsWith("match-"))).toBe(true);
    expect(new Set(audit.evidenceLinks.map((link) => link.key)).size).toBe(audit.evidenceLinks.length);
    for (const link of audit.evidenceLinks) {
      const url = new URL(link.href, "https://admin.example");
      expect(url.pathname).toBe("/catalog/providers/tcgdex");
      expect(url.searchParams.has("returnPath")).toBe(false);
      expect(parseCatalogEvidenceReference(url.searchParams.get("evidenceRef"))).toEqual({
        kind: "provider-profile",
        id: "2026.06.04",
        providerKey: "tcgdex",
      });
    }
  });

  it("preserves the owning page and its selection in an entity link round trip", () => {
    const href = catalogEntityEvidenceHref("/catalog/scopes/scope-base?reviewOffset=25&jobId=held", {
      kind: "source-observation",
      id: "obs/with:delimiter",
    });
    const url = new URL(href, "https://admin.example");
    expect(url.pathname).toBe("/catalog/scopes/scope-base");
    expect(url.searchParams.get("reviewOffset")).toBe("25");
    expect(url.searchParams.get("jobId")).toBe("held");
    expect(parseCatalogEvidenceReference(url.searchParams.get("evidenceRef"))).toEqual({
      kind: "source-observation",
      id: "obs/with:delimiter",
    });
  });
  it("models the audit timeline with filters and redacted evidence links", () => {
    const profile = profileReview({ active: true, lifecycle: "active" });
    const readModel = buildCatalogPrimaryWorkbenchReadModel({
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&importScope=en:3:base:base1&filter.status=changed&selectedObservationIds=obs_001&jobId=job_001&promotionPreviewId=preview_001&section=evidence",
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: { items: [profile], total: 1, count: 1 },
      profileAuthoringModel: profileAuthoringModel({ review: profile }),
      controlPlaneOverview: {
        ...controlPlaneOverview(),
        unitActivity: {
          generatedAt: "2026-06-09T01:00:00.000Z",
          units: [
            {
              unitKey: "tcgdex:pokemon:card:import",
              recentJobs: [
                integrationJobSummary({
                  jobId: "job_001",
                  phase: "completed",
                  operatorStatus: "completed",
                  completed: 24,
                  total: 24,
                }),
              ],
            },
          ],
        },
        auditLifecycle: {
          generatedAt: "2026-06-09T01:05:00.000Z",
          projectionStatus: "partial",
          statusMessage: "Audit lifecycle projection is partial.",
          entries: [
            {
              eventId: "aud_profile_001",
              occurredAt: "2026-06-09T00:30:00.000Z",
              eventName: "profile-section-edited",
              category: "profile-section",
              providerKey: "tcgdex",
              unitKey: "tcgdex:pokemon:card:import",
              profileVersion: "2026.06.04",
              actorUserId: "user_editor",
              relatedJobId: null,
              summary: "Mapping section changed with redacted evidence.",
              diagnosticCodes: [],
            },
            {
              eventId: "aud_import_001",
              occurredAt: "2026-06-09T01:00:00.000Z",
              eventName: "import-job-started",
              category: "import-job",
              providerKey: "tcgdex",
              unitKey: "tcgdex:pokemon:card:import",
              profileVersion: "2026.06.04",
              actorUserId: "user_operator",
              relatedJobId: "job_001",
              summary: "Provider import started for release evidence.",
              diagnosticCodes: [],
            },
          ],
        },
      },
      reviewObservations: {
        items: [
          sourceObservationListItem({
            observation_id: "obs_001",
            status: "changed",
            provider_key: "tcgdex",
          }),
        ],
        total: 1,
        count: 1,
      },
      canManageCatalog: true,
    });

    expect(readModel.auditEvidence.status).toBe("partial");
    expect(readModel.auditEvidence.filters.map((filter) => filter.key)).toEqual([
      "provider",
      "unit",
      "profile-version",
      "job",
      "observation",
      "action-category",
      "actor",
      "time",
    ]);
    expect(readModel.auditEvidence.timeline.map((event) => event.eventName)).toEqual(
      expect.arrayContaining([
        "import-job-started",
        "source-observation-changed",
        "dry-run-executed",
        "promotion-plan-generated",
        "diagnostics-present",
      ]),
    );
    expect(readModel.auditEvidence.redactionPolicy).toMatchObject({
      sourcePayloadAccess: "not-required",
      profileSnapshotAccess: "not-required",
    });
    expect(JSON.stringify(readModel.auditEvidence)).not.toMatch(/raw\s+json|payload\s+json|profile\s+json/i);
    expect(readModel.auditEvidence).not.toHaveProperty("releaseChecklist");
    expect(JSON.stringify(readModel.auditEvidence)).not.toMatch(
      /blocks release|smokeProof|ops-release|catalog-source-observations/i,
    );
  });

  it("keeps audit evidence unavailable when the timeline projection is missing while preserving redaction policy", () => {
    const readModel = buildCatalogPrimaryWorkbenchReadModel({
      requestUrl: "https://admin.example/catalog/integrations?providerKey=tcgdex&section=evidence",
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 },
      controlPlaneOverview: null,
      reviewObservations: { items: [sourceObservationListItem({ observation_id: "obs_001" })], total: 1, count: 1 },
      canManageCatalog: true,
    });

    expect(readModel.auditEvidence.status).toBe("unavailable");
    expect(readModel.auditEvidence.projectionState).toMatchObject({
      queryKey: "audit-evidence-timeline",
      missingProjection: true,
      partialProjection: false,
    });
    expect(readModel.auditEvidence.redactionPolicy.forbiddenEvidenceRequests).toEqual(
      expect.arrayContaining(["source payload body download", "provider profile snapshot document"]),
    );
  });
});
