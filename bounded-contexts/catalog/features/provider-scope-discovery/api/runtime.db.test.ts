import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { createPostgresEventStore, createPostgresProjectionStore } from "@chase-sets/event-core-postgres";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { module as catalogModule } from "../../../index";
import { createProviderScopeMappingRuntime } from "../../provider-scope-mapping/api/runtime";
import { catalogProviderIntegrationProfileVersions } from "../../source-observations/api/provider-integration-profiles";
import type { CatalogProviderOptionQueryPage } from "../../source-observations/api/provider-option-query-cache";
import { createProviderScopeDiscoveryRuntime } from "./runtime";
import type { ProviderRefreshCadenceConfig } from "./provider-refresh-cadence";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
const describeDb = databaseBaseUrl ? describe : describe.skip;
const contextNames = ["catalog"] as const;

const TEST_CONTEXT = {
  tenantId: "tnt_identity" as never,
  audit: {
    performedByUserId: "usr_identity_system" as never,
    forAccountId: "acc_identity_system" as never,
  },
};

const HOUR_MS = 60 * 60 * 1000;

const testCadence: readonly ProviderRefreshCadenceConfig[] = [
  {
    providerKey: "tcgdex",
    scheduleEnabled: true,
    manualOnly: false,
    creditAware: false,
    intervalMs: 6 * HOUR_MS,
    reason: "test",
  },
  {
    providerKey: "scrydex",
    scheduleEnabled: false,
    manualOnly: true,
    creditAware: true,
    intervalMs: 24 * HOUR_MS,
    reason: "test",
  },
];

describeDb("provider scope discovery runtime db", () => {
  let pools: Readonly<Record<(typeof contextNames)[number], PgTransactionalPool>>;

  beforeAll(async () => {
    const databaseUrls = createMultiContextTestDatabaseUrls(
      databaseBaseUrl!,
      contextNames,
      "catalog_provider_scope_discovery",
    );
    await ensureMultiContextTestDatabases(databaseBaseUrl!, databaseUrls);
    pools = createMultiContextTestPools(databaseUrls);
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await pools.catalog.query(catalogModule.schemaSql);
  });

  afterAll(async () => {
    await closeMultiContextTestPools(pools);
  });

  function buildRuntime(input: {
    optionPagesByQueryKind: Readonly<
      Record<
        string,
        readonly { value: string; label: string; parentValue?: string | null; metadata?: Record<string, unknown> }[]
      >
    >;
    failQueryKinds?: readonly string[];
  }) {
    const eventStore = createPostgresEventStore({ pool: pools.catalog });
    const checkpointStore = createPostgresProjectionStore({ db: pools.catalog });
    const deps = { eventStore, checkpointStore, db: pools.catalog } as const;
    const providerScopeMappings = createProviderScopeMappingRuntime(deps);
    const queryCalls: string[] = [];

    const runtime = createProviderScopeDiscoveryRuntime(
      deps,
      {
        listProfileVersions: async () =>
          catalogProviderIntegrationProfileVersions.filter((version) => version.providerKey === "tcgdex"),
        queryIntegrationOptions: async (query) => {
          queryCalls.push(`${query.providerKey}:${query.queryKind}`);
          if (input.failQueryKinds?.includes(query.queryKind)) {
            throw new Error(`provider transport unavailable for ${query.queryKind}`);
          }
          const items = input.optionPagesByQueryKind[query.queryKind] ?? [];
          return optionPage(
            items.map((item) => ({
              providerKey: "tcgdex",
              queryKind: query.queryKind,
              value: item.value,
              label: item.label,
              description: null,
              parentValue: item.parentValue ?? null,
              imageUrl: null,
              aliases: [],
              metadata: (item.metadata ?? {}) as CatalogProviderOptionQueryPage["items"][number]["metadata"],
            })),
          );
        },
        providerScopeMappingCommandHandler: providerScopeMappings.commandHandler,
      },
      testCadence,
    );

    return { runtime, queryCalls };
  }

  async function insertScopeRecord(input: { id: string; name: string; officialSetCode: string | null }) {
    await pools.catalog.query(
      `INSERT INTO catalog_scope_records (
         scope_record_id, product_domain, scope_kind, reference_type_key,
         reference_record_id, reference_record_key, name, lifecycle_status, official_set_code
       )
       VALUES ($1, 'pokemon', 'expansion', 'expansion', $1, $2, $3, 'active', $4)`,
      [input.id, input.id, input.name, input.officialSetCode],
    );
  }

  it("records observations and auto-accepts an exact set-code match without any manual pull", async () => {
    await insertScopeRecord({ id: "scope-paldean-fates", name: "Paldean Fates", officialSetCode: "PAF" });

    const { runtime } = buildRuntime({
      optionPagesByQueryKind: {
        expansions: [
          {
            value: "sv04.5",
            label: "Paldean Fates",
            parentValue: "sv",
            metadata: { abbreviation: "PAF" },
          },
        ],
      },
    });

    const summary = await runtime.processScheduledRefresh({ context: TEST_CONTEXT });

    expect(summary.providersDue).toBe(1);
    expect(summary.failures).toBe(0);
    expect(summary.observationsRecorded).toBeGreaterThan(0);
    expect(summary.mappingsProposed).toBe(1);

    const mappingEvents = await pools.catalog.query<{ event_type: string; payload: { reviewStatus: string } }>(
      `SELECT event_type, payload FROM event_store_events WHERE stream_id LIKE 'catalog.provider-scope-mapping-%'`,
    );
    expect(mappingEvents.rows).toHaveLength(1);
    expect(mappingEvents.rows[0]!.event_type).toBe("catalog.provider-scope-mapping.proposed");
    expect(mappingEvents.rows[0]!.payload.reviewStatus).toBe("auto-accepted");

    // A second sweep inside the cadence window claims nothing: the provider
    // is not due again and nothing is re-proposed.
    const secondSweep = await runtime.processScheduledRefresh({ context: TEST_CONTEXT });
    expect(secondSweep.providersDue).toBe(0);
    expect(secondSweep.mappingsProposed).toBe(0);
  });

  it("never claims manual-only credit-consuming providers and honors operator pause", async () => {
    const { runtime, queryCalls } = buildRuntime({ optionPagesByQueryKind: {} });

    const schedules = await runtime.listRefreshSchedules();
    expect(schedules.map((schedule) => schedule.providerKey).sort()).toEqual(["scrydex", "tcgdex"]);

    await runtime.setRefreshPaused({ providerKey: "tcgdex", paused: true, actor: "user:test", reason: "hold" });
    const summary = await runtime.processScheduledRefresh({ context: TEST_CONTEXT });

    expect(summary.providersDue).toBe(0);
    expect(queryCalls).toHaveLength(0);

    const paused = (await runtime.listRefreshSchedules()).find((schedule) => schedule.providerKey === "tcgdex");
    expect(paused?.paused).toBe(true);
    expect(paused?.pausedBy).toBe("user:test");

    // Resuming makes the provider claimable again; scrydex stays excluded.
    await runtime.setRefreshPaused({ providerKey: "tcgdex", paused: false, actor: "user:test" });
    const resumed = await runtime.processScheduledRefresh({ context: TEST_CONTEXT });
    expect(resumed.providers.map((provider) => provider.providerKey)).toEqual(["tcgdex"]);
    expect(queryCalls.every((call) => call.startsWith("tcgdex:"))).toBe(true);
  });

  it("records a failed run on the schedule so the scheduled-alerting watch can see it", async () => {
    const { runtime } = buildRuntime({
      optionPagesByQueryKind: {},
      failQueryKinds: ["languages", "series", "expansions"],
    });

    const summary = await runtime.processScheduledRefresh({ context: TEST_CONTEXT });

    expect(summary.failures).toBe(1);
    expect(summary.providers[0]).toMatchObject({ providerKey: "tcgdex", status: "failed" });

    const schedule = (await runtime.listRefreshSchedules()).find((entry) => entry.providerKey === "tcgdex");
    expect(schedule?.lastRunStatus).toBe("failed");
    expect(schedule?.lastRunError).toContain("provider transport unavailable");
  });

  it("supports an explicit manual run for manual-only providers", async () => {
    const { runtime } = buildRuntime({ optionPagesByQueryKind: {} });

    // Scrydex has no targets in this fixture (profiles are filtered to
    // tcgdex), so a manual run reports skipped-no-targets rather than
    // silently doing nothing.
    const result = await runtime.runProviderRefreshNow({ providerKey: "scrydex", context: TEST_CONTEXT });

    expect(result.status).toBe("skipped-no-targets");
    const schedule = (await runtime.listRefreshSchedules()).find((entry) => entry.providerKey === "scrydex");
    expect(schedule?.lastRunStatus).toBe("skipped-no-targets");
    expect(schedule?.lastRunTriggeredBy).toBe("manual");
  });
});

function optionPage(items: CatalogProviderOptionQueryPage["items"]): CatalogProviderOptionQueryPage {
  return {
    items,
    total: items.length,
    count: items.length,
    page: { cursor: null, nextCursor: null, limit: items.length, hasMore: false },
    cache: {
      status: "bypass",
      source: "live",
      cacheKey: "test",
      fetchedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      staleUntil: new Date(Date.now() + 120_000).toISOString(),
      cacheOnly: false,
      forceRefresh: true,
      degraded: false,
      diagnostics: [],
    } as CatalogProviderOptionQueryPage["cache"],
  };
}
