import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { module as catalogModule } from "../../../index";
import { createCatalogServices } from "../../../support/authoring-support/services";
import { ProviderAdapterRegistry } from "../../source-observations/api/provider-adapters/registry";
import { createCatalogProviderIntegrationProfileVersionStore } from "../../source-observations/api/providers/provider-integration-profile-store";
import { createScrydexOnePieceProviderAdapter } from "../../source-observations/api/providers/scrydex/adapter";
import { CountCaptureStopped } from "../../source-observations/api/providers/count-capture-transport";
import { countCaptureUnitKeys } from "../domain/count-capture-plan";
import { createCountCaptureStore, readCountCaptureEffects } from "../read-model/count-capture-store";
import { countAccountSlot, createCountStore } from "../read-model/count-store";
import { captureActor, captureSession, freshCaptureAuthority } from "../tests/count-capture-session-fixture";
import {
  createCountCaptureLifecycle,
  observeDeployedScrydexUsage,
  readCountCaptureRoster,
  type CountCaptureLifecycle,
} from "./count-capture-lifecycle";

// DB Profile Tests owns this proof; missing Postgres is an error, not a skipped PASS.
const base = process.env.TEST_DATABASE_URL;
if (!base) throw new Error("TEST_DATABASE_URL is required for the count-capture lifecycle DB proof.");

const scopeRecordId = "scope-synthetic-op01";
const versionAt = "2026-10-13T07:00:00.000Z";
const usage = (remainingCredits: number | null, observedAt: string) => ({
  providerKey: "scrydex",
  creditUnit: "credit",
  creditState: "available" as const,
  remainingCredits,
  totalCredits: 100,
  usedCredits: 0,
  observedAt,
  attemptedAt: observedAt,
  attemptState: "checked" as const,
  providerUpdatedAt: null,
  lagCategory: "unobserved" as const,
  diagnosticCode: null,
  diagnostic: null,
  freshWithinSeconds: 900,
  unavailableAfterSeconds: 900,
});

describe("staging count-capture lifecycle on PostgreSQL", () => {
  let primary: Readonly<Record<"catalog", PgTransactionalPool>>;
  let replica: Readonly<Record<"catalog", PgTransactionalPool>>;
  let fetch: MockInstance<typeof globalThis.fetch>;
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(base!, ["catalog"], "count_capture_9585");
    await ensureMultiContextTestDatabases(base!, urls);
    // Two pools on one database stand in for two cold API replicas.
    primary = createMultiContextTestPools(urls);
    replica = createMultiContextTestPools(urls);
  });
  afterAll(async () => {
    await closeMultiContextTestPools(primary);
    await closeMultiContextTestPools(replica);
  });

  // One canonical OP01 scope, its three accepted Scrydex mappings, the seeded
  // profiles, three durable jobs and fresh retained usage in the staging slot.
  beforeEach(async () => {
    fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected provider I/O."));
    await resetMultiContextTestSchemas(primary);
    await primary.catalog.query(catalogModule.schemaSql);
    await createCatalogProviderIntegrationProfileVersionStore(primary.catalog).seedProfileVersions();
    await primary.catalog.query(
      `INSERT INTO catalog_scope_records (scope_record_id,product_domain,scope_kind,reference_type_key,reference_record_id,reference_record_key,name,lifecycle_status,updated_at)
       VALUES ($1,'one-piece','set','one-piece-set','ref-synthetic-op01','OP01','Synthetic Romance Dawn','active',$2)`,
      [scopeRecordId, versionAt],
    );
    for (const [index, unitKey] of countCaptureUnitKeys.entries()) await mapping(`mapping-synthetic-${index}`, unitKey);
    await primary.catalog.query(
      `INSERT INTO catalog_source_observation_integration_durable_jobs (job_id,job_kind,status,created_at,updated_at)
       VALUES ('job-synthetic-1','integration','completed',now(),now()),
              ('job-synthetic-2','integration','queued',now(),now()),
              ('job-synthetic-3','catalog-sync-scope','completed',now(),now())`,
    );
    await createCountStore(primary.catalog, countAccountSlot("staging", "runtime")).retainUsage(
      usage(100, new Date().toISOString()),
    );
  });
  afterEach(() => {
    fetch.mockRestore();
  });

  function mapping(mappingId: string, unitKey: string, providerKey = "scrydex") {
    return primary.catalog.query(
      `INSERT INTO catalog_provider_scope_mappings (mapping_id,scope_record_id,provider_key,unit_key,set_id,set_name,confidence,review_status,policy_version,updated_at)
       VALUES ($1,$2,$3,$4,'OP01','Synthetic Romance Dawn','exact','accepted','synthetic',$5)`,
      [mappingId, scopeRecordId, providerKey, unitKey, versionAt],
    );
  }
  // The deployed composition, exactly as a staging API replica builds it.
  function composed(pool: PgTransactionalPool, environment = "staging"): CountCaptureLifecycle | null {
    const previous = process.env.DEPLOYMENT_ENVIRONMENT;
    process.env.DEPLOYMENT_ENVIRONMENT = environment;
    try {
      return createCatalogServices(pool).countCapture;
    } finally {
      if (previous === undefined) delete process.env.DEPLOYMENT_ENVIRONMENT;
      else process.env.DEPLOYMENT_ENVIRONMENT = previous;
    }
  }
  const input = (dispatchId = "synthetic-dispatch") => ({
    scopeRecordId,
    authority: freshCaptureAuthority(Date.now(), dispatchId),
  });
  const runs = async () =>
    (
      await primary.catalog.query<{ payload: Record<string, unknown> }>(
        "SELECT DISTINCT ON (run_id) payload FROM catalog_scope_sync_count_capture_history ORDER BY run_id, position DESC",
      )
    ).rows.map((row) => row.payload);

  it("admits one bounded run", async () => {
    const capture = composed(primary.catalog)!;
    const result = await capture.baseline(captureSession(), input());
    expect(result.baseline.units).toEqual(
      countCaptureUnitKeys.map((unitKey, index) => ({
        unitKey,
        profileKey: [
          "one-piece-set-reference-data",
          "one-piece-card-print-source-observation",
          "one-piece-sealed-product-source-observation",
        ][index],
        profileVersion: "2026.06.22",
        mappingId: `mapping-synthetic-${index}`,
        mappingVersion: versionAt,
        setCoordinate: "OP01",
      })),
    );
    expect(result.baseline.selection).toMatchObject({ scopeRecordId, scopeRecordVersion: versionAt });
    expect(result.baseline.countAuthority).toMatchObject({ allowed: true, headroom: 100 });
    expect(result.baseline.effects).toMatchObject({ batches: 0, reservations: 0, jobs: 2, enqueues: 1, imports: 0 });
    expect(result.providerSends).toBe(0);
    expect(await runs()).toEqual([expect.objectContaining({ status: "open", phases: ["baseline"], request: null })]);

    // The notice is durable before the usage phase, which then skips on sufficient authority.
    const { notice } = await capture.initialNotice(captureSession());
    expect((await runs())[0]).toMatchObject({ notice: { fingerprint: notice.fingerprint } });
    await expect(capture.usage(captureSession())).resolves.toMatchObject({ usage: { state: "skipped" } });
    expect(await runs()).toEqual([
      expect.objectContaining({ status: "open", phases: ["baseline", "bootstrap"], sends: [] }),
    ]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("admits exactly one run when two cold replicas race", async () => {
    const outcomes = await Promise.allSettled(
      ["a", "b", "c", "d"].map((seed, index) =>
        composed((index % 2 ? replica : primary).catalog)!.baseline(
          captureSession({ actor: captureActor({ sessionId: `synthetic-session-${seed}` }) }),
          input(`synthetic-dispatch-${seed}`),
        ),
      ),
    );
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(await runs()).toHaveLength(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses a replayed dispatch after its run stopped, but admits a new one", async () => {
    const capture = composed(primary.catalog)!;
    await capture.baseline(captureSession(), input());
    // Usage before the notice stops the run for good.
    await expect(capture.usage(captureSession())).rejects.toThrow(CountCaptureStopped);
    await expect(capture.baseline(captureSession(), input())).rejects.toThrow(CountCaptureStopped);
    await expect(capture.baseline(captureSession(), input("synthetic-next"))).resolves.toBeDefined();
    expect((await runs()).map((run) => run.status).sort()).toEqual(["open", "stopped"]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("composes no capture outside staging", () => {
    expect(composed(primary.catalog, "production")).toBeNull();
  });

  type Refusal = Readonly<{
    prepare?: () => Promise<unknown>;
    body?: () => ReturnType<typeof input>;
    actor?: ReturnType<typeof captureActor>;
    // An admitted refusal stops the run it admitted; the others admit nothing.
    admitted: boolean;
  }>;
  const refusals: Record<string, Refusal> = {
    "an invalid envelope": {
      body: () => ({ ...input(), authority: { dispatchId: "synthetic-dispatch" } as never }),
      admitted: false,
    },
    "a missing permission": { actor: captureActor({ permissions: ["catalog.view"] }), admitted: false },
    "an agent grant": { actor: captureActor({ agentGrant: { grantId: "synthetic" } as never }), admitted: false },
    "a third Scrydex set unit": {
      prepare: () => mapping("m-third", "scrydex:one-piece:third-set:reference-data"),
      admitted: true,
    },
    "an omitted unit": {
      prepare: () =>
        primary.catalog.query("DELETE FROM catalog_provider_scope_mappings WHERE unit_key = $1", [
          countCaptureUnitKeys[2],
        ]),
      admitted: true,
    },
    "another provider's unit": {
      prepare: () => mapping("m-other", "tcgdex:one-piece:set:reference-data", "tcgdex"),
      admitted: true,
    },
  };
  it.each(Object.keys(refusals))("refuses %s with zero provider I/O", async (name) => {
    const { prepare, body, actor, admitted } = refusals[name]!;
    await prepare?.();
    await expect(composed(primary.catalog)!.baseline(captureSession({ actor }), (body ?? input)())).rejects.toThrow(
      CountCaptureStopped,
    );
    expect(await runs()).toEqual(admitted ? [expect.objectContaining({ status: "stopped", baseline: null })] : []);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("retains one targeted usage observation through the adapter's own callback", async () => {
    const pool = primary.catalog;
    const slot = countAccountSlot("staging", "synthetic-usage");
    const counts = createCountStore(pool, slot);
    const send = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({
        data: {
          credits_remaining: 40,
          total_credits_consumed: 0,
          overage_credits_consumed: 0,
          period_start: "2026-01-01T00:00:00Z",
          period_end: "2027-01-01T00:00:00Z",
        },
      }),
    );
    const registry = new ProviderAdapterRegistry([
      createScrydexOnePieceProviderAdapter({
        fetch: send,
        credentials: { apiKey: "synthetic-capture-key", teamId: "synthetic-capture-team" },
        onUsageObserved: counts.retainUsage,
      }),
    ]);
    const capture = createCountCaptureLifecycle({
      environment: "staging",
      accountRevision: "synthetic-usage",
      store: createCountCaptureStore(pool),
      readRoster: (id) => readCountCaptureRoster(pool, createCatalogProviderIntegrationProfileVersionStore(pool), id),
      readEffects: (at) => readCountCaptureEffects(pool, at),
      countAuthority: () => counts.authority(),
      observeUsage: observeDeployedScrydexUsage(registry, null),
    });
    await capture.baseline(captureSession(), input());
    await capture.initialNotice(captureSession());
    await expect(capture.usage(captureSession())).resolves.toMatchObject({
      usage: { state: "persisted", required: 11, authority: { allowed: true, headroom: 40 } },
    });
    expect(send).toHaveBeenCalledOnce();
    expect((await runs())[0]).toMatchObject({
      status: "open",
      sends: [{ phase: "bootstrap", category: "usage", usage: { purpose: "bootstrap" }, status: 200 }],
    });
    const retained = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM catalog_scope_sync_count_history WHERE account_slot = $1 AND event_kind = 'usage'",
      [slot],
    );
    expect(retained.rows[0]?.count).toBe("1");
    expect(fetch).not.toHaveBeenCalled();
  });
});
