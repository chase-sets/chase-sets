import { describe, expect, it, vi } from "vitest";
import {
  mergeObservedCoordinatePreviewReceipt,
  runScrydexCoordinatePreview,
  type ScrydexCoordinatePreviewObserved,
} from "./scrydex-coordinate-preview-runner";
import {
  scrydexCacheCaptureCoordinate,
  scrydexCacheCaptureUnits,
  type ScrydexCacheCaptureUnitKey,
} from "../domain/scrydex-cache-capture";
import {
  scrydexCoordinatePreviewPhases,
  validateScrydexCoordinatePreviewReceipt,
  type ScrydexCoordinatePreviewReceipt,
} from "../domain/scrydex-coordinate-preview";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { CatalogScopeRecordRow } from "../../scope-registry/read-model/queries";
import type { ProviderScopeMappingRow } from "../../provider-scope-mapping/read-model/queries";
import { ProviderAdapterRegistry } from "../../source-observations/api/provider-adapters/registry";
import { createTcgplayerProviderAdapter } from "../../source-observations/api/provider-adapters/tcgplayer";
import { previewCatalogSyncProviderParticipation } from "../../source-observations/api/catalog-sync-scope-planner";
import { createScopeSyncBatchPlanner } from "./planner";
import { catalogProviderIntegrationProfileVersions } from "../../source-observations/api/providers/registry";
import { createScrydexOnePieceProviderAdapter } from "../../source-observations/api/providers/scrydex/adapter";

const runner = {
  sha: "a".repeat(40),
  runId: "100000000001",
  runAttempt: "1",
  journeyScope: "scrydex-coordinate-preview" as const,
  origin: "admin.staging.chasesets.com" as const,
};
const startedAt = "2026-10-21T01:47:04.995Z";
const resolvedAt = "2026-10-21T01:47:56.449Z";
const finishedAt = "2026-10-21T01:48:22.801Z";
const generation = {
  runId: "100000000002",
  runAttempt: 1,
  jobId: "100000000003",
  jobCompletedAt: "2026-10-21T01:31:12.000Z",
  deployedHead: runner.sha,
  imageDigest: `sha256:${"c".repeat(64)}`,
};
const units = scrydexCacheCaptureUnits.map(({ productDomain, unitKey }, index) => ({
  unitKey,
  scopeRecordId: productDomain === "one-piece" ? "synthetic-scope-one-piece" : "synthetic-scope-lorcana",
  setName: productDomain === "one-piece" ? "Romance Dawn" : "The First Chapter",
  mappingId: `synthetic-mapping-${index + 1}`,
  version: `2026-10-20T18:02:1${index}.12345${index}Z`,
  profileKey: `synthetic-profile-${index + 1}`,
  profileVersion: `synthetic-profile-version-${index + 1}`,
}));
const rows: ScrydexCoordinatePreviewReceipt["rows"] = units.map((unit) => ({
  unitKey: unit.unitKey,
  scopeRecordId: unit.scopeRecordId,
  planFingerprint: "d".repeat(64),
  profileKey: unit.profileKey,
  profileVersion: unit.profileVersion,
  mapping: {
    mappingId: unit.mappingId,
    version: unit.version,
    reviewStatus: "auto-accepted" as const,
    setId: null,
    setName: unit.setName,
  },
  coordinate: unit.setName,
  cache: {
    status: "fresh" as const,
    cacheKey: `sha256:${"e".repeat(64)}`,
    fetchedAt: "2026-10-21T01:40:00.000Z",
    expiresAt: "2026-10-21T01:55:00.000Z",
    staleUntil: "2026-10-22T01:40:00.000Z",
  },
  membership: "member" as const,
}));
const samples = ["synthetic-scope-lorcana", "synthetic-scope-one-piece"].map((scopeRecordId) => ({
  scopeRecordId,
  mappingVersions: units
    .filter((unit) => unit.scopeRecordId === scopeRecordId)
    .map((unit) => ({ mappingId: unit.mappingId, version: unit.version, reviewStatus: "auto-accepted" })),
  profileVersions: units
    .filter((unit) => unit.scopeRecordId === scopeRecordId)
    .map((unit) => ({
      providerKey: "scrydex",
      unitKey: unit.unitKey,
      profileKey: unit.profileKey,
      profileVersion: unit.profileVersion,
    })),
}));
const preview: NonNullable<ScrydexCoordinatePreviewReceipt["preview"]> = {
  planFingerprint: "d".repeat(64),
  status: "blocked",
  confirmAllowed: false,
  resolvedAt,
  selection: {
    mode: "ids",
    scopeRecordIds: ["synthetic-scope-lorcana", "synthetic-scope-one-piece"],
  },
  samples,
  blockers: [
    {
      code: "credited-provider-estimate-unavailable",
      scopeRecordId: null,
      providerKey: "scrydex",
      message: "scrydex request or credit evidence is unavailable; confirmation is closed.",
    },
  ],
};

function observed(overrides: Partial<ScrydexCoordinatePreviewObserved> = {}): ScrydexCoordinatePreviewObserved {
  return {
    phases: [...scrydexCoordinatePreviewPhases],
    requests: {
      signIn: 6,
      profileReads: 1,
      scopeInventoryReads: 2,
      coverageReads: 4,
      cacheOptionReads: 10,
      previewPosts: 1,
      usageReads: 1,
      forbidden: 0,
    },
    usageRead: { count: 1, allowed: true },
    forbiddenCalls: [],
    preview,
    rows,
    ...overrides,
  };
}

function run(overrides: Partial<ScrydexCoordinatePreviewObserved> = {}) {
  return mergeObservedCoordinatePreviewReceipt(
    {
      runner,
      deployment: { before: generation, after: generation },
      startedAt,
      finishedAt,
    },
    observed(overrides),
  );
}

describe("merge", () => {
  it("complete", () => {
    const receipt = run();
    expect(validateScrydexCoordinatePreviewReceipt(receipt)).toEqual([]);
    expect(receipt.outcome).toBe("complete");
  });

  it("forbidden-call", () => {
    const receipt = run({
      requests: {
        ...observed().requests,
        forbidden: 1001,
        cacheOptionReads: 1010,
      },
      forbiddenCalls: Array.from({ length: 101 }, (_, index) => `mutation:POST:${index}`),
    });
    expect(receipt.requests.forbidden).toBe(1000);
    expect(receipt.requests.cacheOptionReads).toBe(1000);
    expect(receipt.forbiddenCalls).toHaveLength(100);
    expect(receipt.reasons).toContain("forbidden-call");
    expect(validateScrydexCoordinatePreviewReceipt(receipt)).toEqual([]);
  });

  it("usage-clamped", () => {
    const receipt = run({ usageRead: { count: 1001, allowed: true } });
    expect(receipt.usageRead.count).toBe(1000);
    expect(validateScrydexCoordinatePreviewReceipt(receipt)).toEqual([]);
  });

  it("reasons-rebuilt", () => {
    const receipt = mergeObservedCoordinatePreviewReceipt(
      {
        runner,
        deployment: { before: generation, after: generation },
        startedAt,
        finishedAt,
        runnerReasons: ["preview-post-count", "usage-read-count", "producer-failed:bracket-changed"],
      },
      observed(),
    );
    expect(receipt.reasons).toEqual(["producer-failed:bracket-changed"]);
    expect(receipt.outcome).toBe("governed-unknown");
    expect(validateScrydexCoordinatePreviewReceipt(receipt)).toEqual([]);
  });
});

describe("chain", () => {
  it("coordinate-precedence", () => {
    expect(
      scrydexCacheCaptureCoordinate(
        {
          mappingId: "synthetic-coordinate-precedence",
          unitKey: "scrydex:one-piece:set:reference-data",
          reviewStatus: "accepted",
          version: startedAt,
          setId: "explicit-set-id",
          setName: "ignored-set-name",
        },
        "synthetic-scope-one-piece",
      ),
    ).toBe("explicit-set-id");
  });

  it("coordinate-refused", () => {
    expect(
      scrydexCacheCaptureCoordinate(
        {
          mappingId: "synthetic-coordinate-refused",
          unitKey: "scrydex:one-piece:set:reference-data",
          reviewStatus: "accepted",
          version: startedAt,
          setId: null,
          setName: "",
        },
        "synthetic-scope-one-piece",
      ),
    ).toBeNull();
    expect(
      scrydexCacheCaptureCoordinate(
        {
          mappingId: "synthetic-coordinate-refused-missing",
          unitKey: "scrydex:one-piece:set:reference-data",
          reviewStatus: "accepted",
          version: startedAt,
          setId: null,
          setName: null,
        },
        "synthetic-scope-one-piece",
      ),
    ).toBeNull();
  });

  async function executeChain(nonUsageSend = false) {
    const calls: string[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      calls.push(String(input));
      if (String(input) !== "https://api.scrydex.com/account/v1/usage") return Response.json({}, { status: 403 });
      return Response.json({
        data: {
          credits_remaining: 30,
          total_credits_consumed: 0,
          overage_credits_consumed: 0,
          period_start: "2026-01-01T00:00:00Z",
          period_end: "2027-01-01T00:00:00Z",
        },
      });
    });
    const adapter = createScrydexOnePieceProviderAdapter({
      fetch,
      credentials: { apiKey: "synthetic-key", teamId: "synthetic-team" },
      now: () => new Date(resolvedAt),
    });
    const tcgplayer = createTcgplayerProviderAdapter({
      loadProfileVersions: async () =>
        catalogProviderIntegrationProfileVersions.filter((version) => version.providerKey === "tcgplayer"),
    });
    const records = [
      chainScopeRecord("synthetic-scope-one-piece", "one-piece", "Romance Dawn"),
      chainScopeRecord("synthetic-scope-lorcana", "lorcana", "The First Chapter"),
    ];
    const mappings = scrydexCacheCaptureUnits.map(
      ({ productDomain, unitKey }, index): ProviderScopeMappingRow => ({
        mapping_id: `synthetic-mapping-${index + 1}`,
        scope_record_id: productDomain === "one-piece" ? records[0]!.scope_record_id : records[1]!.scope_record_id,
        provider_key: "scrydex",
        unit_key: unitKey,
        product_line_id: null,
        series_id: null,
        set_id: null,
        set_name: productDomain === "one-piece" ? "Romance Dawn" : "The First Chapter",
        language_coordinates: {},
        confidence: "exact",
        review_status: "accepted",
        provenance: {},
        evidence: {},
        last_actor: null,
        last_reason: null,
        policy_version: "synthetic",
        proposed_at: startedAt,
        reviewed_at: startedAt,
        updated_at: startedAt,
      }),
    );
    const dbStatements: string[] = [];
    const db: PgQueryable = {
      async query<Row>(sql: string) {
        dbStatements.push(sql);
        return { rows: (sql.includes("FROM catalog_scope_records") ? records : mappings) as Row[] };
      },
    };
    const context: EventStoreContext = {
      tenantId: "tnt_synthetic_coordinate_preview",
      audit: { performedByUserId: "usr_synthetic_coordinate_preview", forAccountId: "acc_synthetic" },
    };
    const planner = createScopeSyncBatchPlanner({
      db,
      now: () => resolvedAt,
      previewCatalogSyncScope: (input) =>
        previewCatalogSyncProviderParticipation({
          ...input,
          acceptedScopeMappings: input.acceptedScopeMappings ?? [],
          providerProfileVersions: catalogProviderIntegrationProfileVersions,
          providerAdapterRegistry: new ProviderAdapterRegistry([adapter, tcgplayer]),
        }),
    });
    const zeroEffectCount = () => dbStatements.filter((sql) => !/^\s*SELECT\b/i.test(sql)).length;
    const baselineZeroEffectCount = zeroEffectCount();
    const produce = async (): Promise<ScrydexCoordinatePreviewObserved> => {
      if (nonUsageSend) await fetch("https://api.scrydex.com/onepiece/v1/expansions");
      const planned = await planner.resolve({
        selection: { mode: "ids", scopeRecordIds: records.map((record) => record.scope_record_id) },
        context,
      });
      const samples = planned.plans.map((plan) => ({
        scopeRecordId: plan.scopeRecordId,
        mappingVersions: [...plan.mappingVersions],
        profileVersions: [...plan.profileVersions],
      }));
      const previewProjection = {
        planFingerprint: planned.preview.planFingerprint,
        status: planned.preview.status,
        confirmAllowed: planned.preview.confirmAllowed,
        resolvedAt: planned.preview.resolvedAt,
        selection: {
          mode: "ids" as const,
          scopeRecordIds: [
            ...(planned.preview.selection.mode === "ids" ? planned.preview.selection.scopeRecordIds : []),
          ],
        },
        samples: [...samples],
        blockers: [...planned.preview.blockers],
      };
      const previewRows = planned.plans.flatMap((plan) =>
        plan.participationPreview.units
          .filter((unit) => unit.providerKey === "scrydex" && unit.selected)
          .map((unit) => {
            const mapping = mappings.find(
              (candidate) => candidate.scope_record_id === plan.scopeRecordId && candidate.unit_key === unit.unitKey,
            );
            if (!mapping || !unit.childExecutionScope) throw new Error(`missing executable mapping:${unit.unitKey}`);
            const coordinate = scrydexCacheCaptureCoordinate(
              {
                mappingId: mapping.mapping_id,
                unitKey: mapping.unit_key,
                reviewStatus: mapping.review_status as "accepted",
                version: mapping.updated_at,
                setId: mapping.set_id,
                setName: mapping.set_name,
              },
              plan.scopeRecordId,
            );
            if (!coordinate || coordinate !== (unit.childExecutionScope.setName ?? unit.childExecutionScope.setId)) {
              throw new Error(`planner coordinate mismatch:${unit.unitKey}`);
            }
            return {
              unitKey: unit.unitKey,
              scopeRecordId: plan.scopeRecordId,
              planFingerprint: planned.preview.planFingerprint,
              profileKey: unit.profileKey,
              profileVersion: unit.profileVersion,
              mapping: {
                mappingId: mapping.mapping_id,
                version: mapping.updated_at,
                reviewStatus: mapping.review_status as "accepted",
                setId: mapping.set_id,
                setName: mapping.set_name,
              },
              coordinate,
              cache: {
                status: "fresh" as const,
                cacheKey: `sha256:${"f".repeat(64)}`,
                fetchedAt: startedAt,
                expiresAt: "2026-10-22T01:55:00.000Z",
                staleUntil: "2026-10-23T01:55:00.000Z",
              },
              membership: "member" as const,
            };
          }),
      );
      const forbiddenCalls = calls
        .filter((url) => url !== "https://api.scrydex.com/account/v1/usage")
        .map(() => "provider:GET");
      return {
        phases: [...scrydexCoordinatePreviewPhases],
        // Synthetic browser fence tallies are separate from provider transport calls.
        requests: {
          signIn: 1,
          profileReads: 0,
          scopeInventoryReads: 0,
          coverageReads: 0,
          cacheOptionReads: 0,
          previewPosts: 1,
          usageReads: 1,
          forbidden: forbiddenCalls.length,
        },
        usageRead: { count: 1, allowed: true },
        forbiddenCalls,
        preview: previewProjection,
        rows: previewRows,
      };
    };
    const receipt = await runScrydexCoordinatePreview({
      runner,
      credentialsPresent: true,
      selectDeployment: vi.fn(async () => ({ generation, stop: null })),
      signIn: vi.fn(async () => undefined),
      produce,
      now: vi.fn<() => string>().mockReturnValueOnce(startedAt).mockReturnValueOnce(finishedAt),
    });
    return { receipt, calls, dbStatements, baselineZeroEffectCount, finalZeroEffectCount: zeroEffectCount() };
  }

  it("red control: non-usage send", async () => {
    const { receipt } = await executeChain(true);
    expect(receipt.outcome).toBe("governed-unknown");
    expect(receipt.reasons).toContain("forbidden-call");
    expect(receipt.requests.forbidden).toBe(1);
    expect(receipt.forbiddenCalls).toEqual(["provider:GET"]);
    expect(receipt.outcome === "complete").toBe(false);
    expect(validateScrydexCoordinatePreviewReceipt(receipt)).toEqual([]);
  });

  it("complete", async () => {
    const { receipt, calls, dbStatements, baselineZeroEffectCount, finalZeroEffectCount } = await executeChain();
    expect(receipt.outcome).toBe("complete");
    expect(receipt.requests.previewPosts).toBe(1);
    expect(receipt.requests.forbidden).toBe(0);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((url) => url === "https://api.scrydex.com/account/v1/usage")).toBe(true);
    expect(dbStatements.every((sql) => /^\s*SELECT\b/i.test(sql))).toBe(true);
    expect(finalZeroEffectCount).toBe(baselineZeroEffectCount);
    expect(receipt.rows).toHaveLength(5);
    expect(validateScrydexCoordinatePreviewReceipt(receipt)).toEqual([]);
  });
});

function chainScopeRecord(id: string, productDomain: "one-piece" | "lorcana", name: string): CatalogScopeRecordRow {
  return {
    scope_record_id: id,
    product_domain: productDomain,
    scope_kind: "set",
    reference_type_key: `${productDomain}-set`,
    reference_record_id: `ref-${id}`,
    reference_record_key: id,
    name_i18n: {},
    name,
    parent_scope_record_id: null,
    product_line_scope_record_id: null,
    series_scope_record_id: null,
    release_date: "2026-01-01",
    official_set_code: null,
    language_editions: [],
    attributes: {},
    relationships: {},
    lifecycle_status: "active",
    updated_at: startedAt,
  };
}

describe("runner", () => {
  const base = () => ({
    runner,
    credentialsPresent: true,
    selectDeployment: vi.fn(async () => ({ generation, stop: null })),
    signIn: vi.fn(async () => undefined),
    produce: vi.fn(async () => observed()),
    now: vi.fn<() => string>().mockReturnValueOnce(startedAt).mockReturnValueOnce(finishedAt),
  });

  it("complete", async () => {
    const receipt = await runScrydexCoordinatePreview(base());
    expect(receipt.outcome).toBe("complete");
    expect(receipt.runner).toEqual(runner);
  });

  it("deployment-head-mismatch", async () => {
    const receipt = await runScrydexCoordinatePreview({
      ...base(),
      selectDeployment: vi.fn(async () => ({
        generation: { ...generation, deployedHead: "b".repeat(40) },
        stop: null,
      })),
    });
    expect(receipt.reasons).toContain("deployment-head-mismatch");
  });

  it("deployment-generation-changed", async () => {
    const receipt = await runScrydexCoordinatePreview({
      ...base(),
      selectDeployment: vi
        .fn()
        .mockResolvedValueOnce({ generation, stop: null })
        .mockResolvedValueOnce({ generation: { ...generation, jobId: "100000000004" }, stop: null }),
    });
    expect(receipt.reasons).toContain("deployment-generation-changed");
  });

  it("complete-with-blockers", async () => {
    const blocked = structuredClone(preview);
    blocked.blockers = [
      {
        code: "credited-provider-estimate-unavailable",
        scopeRecordId: null,
        providerKey: "scrydex",
        message: "scrydex request or credit evidence is unavailable; confirmation is closed.",
      },
      {
        code: "credited-provider-budget-exceeded",
        scopeRecordId: null,
        providerKey: "scrydex",
        message: "scrydex credited provider budget is exceeded; confirmation is closed.",
      },
    ];
    const receipt = await runScrydexCoordinatePreview({
      ...base(),
      produce: vi.fn(async () => observed({ preview: blocked })),
    });
    expect(receipt.reasons).toEqual([]);
    expect(receipt.outcome).toBe("complete");
    expect(receipt.preview?.blockers.map((blocker) => blocker.code)).toEqual([
      "credited-provider-estimate-unavailable",
      "credited-provider-budget-exceeded",
    ]);
    expect(validateScrydexCoordinatePreviewReceipt(receipt)).toEqual([]);
  });

  it("scrydex-scope-planning-blocked", async () => {
    const blocked = structuredClone(preview);
    blocked.blockers = [
      {
        code: "scope-planning-blocked",
        scopeRecordId: "synthetic-scope-one-piece",
        providerKey: "scrydex",
        message: "Scope planning is blocked.",
      },
    ];
    const receipt = await runScrydexCoordinatePreview({
      ...base(),
      produce: vi.fn(async () => observed({ preview: blocked })),
    });
    expect(receipt.reasons).toContain("scrydex-scope-planning-blocked");
    expect(receipt.outcome).toBe("governed-unknown");
  });

  it("preview-post-count", async () => {
    const receipt = await runScrydexCoordinatePreview({
      ...base(),
      produce: vi.fn(async () => observed({ requests: { ...observed().requests, previewPosts: 2 } })),
    });
    expect(receipt.reasons).toContain("preview-post-count");
  });

  it("producer-failed:bracket-changed", async () => {
    const receipt = await runScrydexCoordinatePreview({
      ...base(),
      produce: vi.fn(async () => {
        throw new Error("bracket-changed");
      }),
    });
    expect(receipt.reasons).toContain("producer-failed:bracket-changed");
  });

  it("producer-failed", async () => {
    const receipt = await runScrydexCoordinatePreview({
      ...base(),
      produce: vi.fn(async () => {
        throw new Error("unexpected failure with spaces");
      }),
    });
    expect(receipt.reasons).toContain("producer-failed");
  });

  it("credentials-missing", async () => {
    const signIn = vi.fn(async () => undefined);
    const receipt = await runScrydexCoordinatePreview({ ...base(), credentialsPresent: false, signIn });
    expect(signIn).not.toHaveBeenCalled();
    expect(receipt.reasons).toContain("credentials-missing");
  });

  it("deployment-before:<stop>", async () => {
    const signIn = vi.fn(async () => undefined);
    const receipt = await runScrydexCoordinatePreview({
      ...base(),
      signIn,
      selectDeployment: vi.fn(async () => ({ generation: null, stop: "deployment-not-found" })),
    });
    expect(signIn).not.toHaveBeenCalled();
    expect(receipt.reasons).toContain("deployment-before:deployment-not-found");
  });

  it("phases-incomplete", async () => {
    const receipt = await runScrydexCoordinatePreview({
      ...base(),
      produce: vi.fn(async () => observed({ phases: undefined })),
    });
    expect(receipt.reasons).toContain("phases-incomplete");
  });

  it("unknown phase is incomplete", async () => {
    const receipt = await runScrydexCoordinatePreview({
      ...base(),
      produce: vi.fn(async () => observed({ phases: ["sign-in", "unexpected"] })),
    });
    expect(receipt.reasons).toContain("phases-incomplete");
  });

  it("producer-failed:sign-in", async () => {
    const receipt = await runScrydexCoordinatePreview({
      ...base(),
      signIn: vi.fn(async () => {
        throw new Error("sign-in failed");
      }),
    });
    expect(receipt.reasons).toContain("producer-failed:sign-in");
  });

  it("clamped", async () => {
    const receipt = await runScrydexCoordinatePreview({
      ...base(),
      produce: vi.fn(async () => observed({ requests: { ...observed().requests, cacheOptionReads: 1010 } })),
    });
    expect(receipt.requests.cacheOptionReads).toBe(1000);
    expect(validateScrydexCoordinatePreviewReceipt(receipt)).toEqual([]);
  });
});

void (scrydexCacheCaptureUnits satisfies readonly { unitKey: ScrydexCacheCaptureUnitKey }[]);
