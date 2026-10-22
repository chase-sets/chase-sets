import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { createPostgresEventStore, createPostgresProjectionStore } from "@chase-sets/event-core-postgres";
import { toTransportEvent } from "@chase-sets/event-core";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { ResolvedActor } from "@chase-sets/auth-context";
import { module as catalogModule } from "../../../index";
import { createCatalogServices } from "../../../support/authoring-support";
import { createProviderScopeDiscoveryRuntime } from "../../provider-scope-discovery/api/runtime";
import { createProviderScopeDiscoveryMcpHandlers } from "../../provider-scope-discovery/api/mcp";
import { createProviderScopeMappingMcpHandlers } from "../../provider-scope-mapping/api/mcp";
import { createReferenceDataMcpHandlers } from "../../reference-data/api/mcp";
import { createScopeRegistryMcpHandlers } from "../../scope-registry/api/mcp";
import { createScopeSyncBatchMcpHandlers } from "../api/mcp";
import { createSourceObservationsMcpHandlers } from "../../source-observations/api/mcp";
import { catalogFixtureTransports } from "../../source-observations/api/providers/catalog-fixture-transports";
import { catalogProviderIntegrationProfileVersions } from "../../source-observations/api/providers/registry";

const actor = {
  sessionId: "sess_new_set",
  tenantId: "tenant_new_set",
  userId: "user_new_set",
  accountId: "account_new_set",
  membershipId: "membership_new_set",
  roleKey: "platform-admin",
  permissions: ["catalog.view", "catalog.manage"],
} satisfies ResolvedActor;

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl) throw new Error("TEST_DATABASE_URL is required for the new-set MCP journey.");

const context = {
  tenantId: actor.tenantId as `tnt_${string}`,
  audit: { performedByUserId: actor.userId, forAccountId: actor.accountId },
};
const MTGJSON_SET_UNIT = "mtgjson:mtg:set:reference-data";
const mtgjsonSetProfile = catalogProviderIntegrationProfileVersions.find(
  (version) => version.providerKey === "mtgjson" && version.profileKey === "mtg-set-reference-data",
);
if (!mtgjsonSetProfile) throw new Error(`Missing profile for ${MTGJSON_SET_UNIT}.`);

describe("new set over MCP journey", () => {
  let pool: PgTransactionalPool;
  let projectEvents: () => Promise<void>;

  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl, ["catalog"], "catalog_new_set_mcp_journey");
    await ensureMultiContextTestDatabases(databaseBaseUrl, urls);
    pool = createMultiContextTestPools(urls).catalog;
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas({ catalog: pool });
    await pool.query(catalogModule.schemaSql);
    const eventStore = createPostgresEventStore({ pool });
    const services = createCatalogServices(pool);
    // The journey proves one new set unit. Seed only that active profile so the
    // planner's default primary-unit participation cannot add unrelated units.
    await services.providerIntegrationProfiles.seedProfileVersions([mtgjsonSetProfile]);

    await pool.query(
      `INSERT INTO catalog_scope_records
         (scope_record_id, product_domain, scope_kind, reference_type_key, reference_record_id,
          reference_record_key, name, lifecycle_status)
       VALUES ('ref_magic_product_line', 'magic', 'product-line', 'product-line',
               'ref_magic_product_line', 'magic-the-gathering', 'Magic: The Gathering', 'active')`,
    );

    projectEvents = async () => {
      const events = await eventStore.readAll({ tenantId: context.tenantId, limit: 500 });
      for (const event of events) {
        for (const projector of services.projectors) {
          const handler = projector.handlers[event.eventType];
          if (handler) {
            await handler(toTransportEvent(event));
          }
        }
      }
    };
  });

  afterAll(async () => {
    await closeMultiContextTestPools({ catalog: pool });
  });

  it("refreshes, canonicalizes, maps, previews, confirms, and completes a new set unit", async () => {
    const eventStore = createPostgresEventStore({ pool });
    const services = createCatalogServices(pool);
    const discovery = createProviderScopeDiscoveryRuntime(
      { db: pool, eventStore, checkpointStore: createPostgresProjectionStore({ db: pool }) },
      {
        listProfileVersions: () => services.providerIntegrationProfiles.listProfileVersions(),
        queryIntegrationOptions: async ({ providerKey, queryKind, profileKey, ingestionUnitKey }) => ({
          items:
            queryKind === "sets"
              ? [
                  {
                    providerKey,
                    queryKind,
                    value: "TSP",
                    label: "Time Spiral",
                    description: null,
                    parentValue: null,
                    imageUrl: null,
                    aliases: [],
                    metadata: { releaseDate: "2006-10-06" },
                  },
                ]
              : [],
          total: queryKind === "sets" ? 1 : 0,
          count: queryKind === "sets" ? 1 : 0,
          page: { cursor: null, nextCursor: null, limit: 50, hasMore: false },
          cache: {
            status: "bypass",
            source: "live",
            cacheKey: `${providerKey}:${profileKey ?? ""}:${ingestionUnitKey ?? ""}:${queryKind}`,
            fetchedAt: null,
            expiresAt: null,
            staleUntil: null,
            cacheOnly: false,
            forceRefresh: false,
            degraded: false,
            diagnostics: [],
          },
        }),
        providerScopeMappingCommandHandler: services.providerScopeMappings.commandHandler,
      },
    );
    const discoveryHandlers = createProviderScopeDiscoveryMcpHandlers(discovery).toolHandlers;
    const references = createReferenceDataMcpHandlers(services.referenceData).toolHandlers;
    const registry = createScopeRegistryMcpHandlers(services.scopeRegistry).toolHandlers;
    const mappings = createProviderScopeMappingMcpHandlers(services.providerScopeMappings).toolHandlers;
    const batches = createScopeSyncBatchMcpHandlers(services.scopeSyncBatches).toolHandlers;
    const observations = createSourceObservationsMcpHandlers(services.sourceObservations).toolHandlers;
    const invoke = <T = Record<string, unknown>>(
      handler: ((input: never) => unknown) | undefined,
      args: Record<string, unknown>,
    ) => handler!({ actor, arguments: args } as never) as Promise<T>;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = catalogFixtureTransports.mtgjson;
    try {
      const refresh = await invoke(discoveryHandlers["catalog.run-provider-refresh"], { providerKey: "mtgjson" });
      expect(refresh).toMatchObject({ providerKey: "mtgjson", status: "succeeded", newObservationCount: 1 });
      expect(
        (
          await invoke(discoveryHandlers["catalog.list-scope-observations"], {
            providerKey: "mtgjson",
            unitKey: MTGJSON_SET_UNIT,
          })
        ).items,
      ).toHaveLength(1);
      expect(
        (await invoke(discoveryHandlers["catalog.list-scope-record-proposals"], { productDomain: "magic" })).items,
      ).toHaveLength(1);

      await invoke(references["catalog.create-reference-record"], {
        referenceRecordId: "ref_time_spiral",
        typeKey: "set",
        key: "time-spiral",
        name: { defaultLocale: "en", values: { en: "Time Spiral" } },
        attributes: {
          "product-domain": "magic",
          "release-date": "2006-10-06",
          "official-set-code": "TSP",
          "language-editions": ["en"],
        },
        relationships: [{ relationshipType: "part-of", referenceId: "ref_magic_product_line" }],
      });
      await projectEvents();
      await invoke(references["catalog.publish-reference-record"], { referenceRecordId: "ref_time_spiral" });
      await projectEvents();

      const scopeRecord = await invoke(registry["catalog.get-scope-record"], { scopeRecordId: "ref_time_spiral" });
      expect(scopeRecord).toMatchObject({ scopeRecordId: "ref_time_spiral", lifecycleStatus: "active" });

      const proposed = await invoke(mappings["catalog.propose-scope-mapping"], {
        scopeRecordId: "ref_time_spiral",
        providerKey: "mtgjson",
        unitKey: MTGJSON_SET_UNIT,
        coordinates: { setId: "TSP", setName: "Time Spiral" },
      });
      await projectEvents();
      await invoke(mappings["catalog.review-scope-mappings"], {
        intent: "accept",
        mappingIds: [proposed.mappingId],
      });
      await projectEvents();

      const preview = await invoke(batches["catalog.preview-scope-sync-batch"], {
        selection: { mode: "ids", scopeRecordIds: ["ref_time_spiral"] },
      });
      expect(preview).toMatchObject({ status: "ready", counts: { scopes: 1, providerUnits: 1 } });

      const confirmed = await invoke(batches["catalog.confirm-scope-sync-batch"], {
        selection: { mode: "ids", scopeRecordIds: ["ref_time_spiral"] },
        planFingerprint: preview.planFingerprint,
      });
      expect(confirmed).toMatchObject({ status: "queued", units: [expect.objectContaining({ state: "queued" })] });

      for (let turn = 0; turn < 3; turn += 1) {
        await services.sourceObservations.processNextIntegrationJob({
          claimOwnerId: "journey-worker",
          claimTtlMs: 120_000,
        });
        await projectEvents();
        const current = await invoke(batches["catalog.get-scope-sync-batch"], { batchId: confirmed.batchId });
        if ((current.units as readonly { state: string }[])[0]?.state === "completed") break;
      }

      const settled = await invoke(batches["catalog.get-scope-sync-batch"], { batchId: confirmed.batchId });
      expect(settled).toMatchObject({ units: [expect.objectContaining({ state: "completed" })] });
      const sourceRows = await invoke<{ items: readonly Record<string, unknown>[] }>(
        observations["catalog.list-source-observations"],
        {
          provider: "mtgjson",
          setId: "TSP",
        },
      );
      expect(sourceRows.items.length).toBeGreaterThan(0);
      expect(sourceRows.items[0]).toEqual(expect.objectContaining({ syncRunId: expect.any(String) }));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
