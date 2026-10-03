import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { createPostgresEventStore, createPostgresProjectionStore } from "@chase-sets/event-core-postgres";
import { Hono } from "hono";
import type { CatalogAuthoringEnv } from "../../../../support/authoring-support/api";
import type { CatalogRuntimeDeps } from "../../../../support/authoring-support/runtime-support";
import { createCatalogItemRuntime } from "../../../catalog-items/api/runtime";
import { createReferenceDataRuntime } from "../../../reference-data/api/runtime";
import { createSourceObservationRuntime } from "../runtime";
import { sourceObservationRoutes } from "../route";
import { createCatalogProviderConnectionsReadSource } from "../admin/provider-connections-read-source";
import { createCatalogProviderSendRuntime } from "./provider-send-runtime";
import { createCatalogIntegrationDryRunProofRegistry } from "../governance/catalog-integration-dry-run-proofs";
import { module as catalogModule } from "../../../../index";
import { createPostgresProviderSendLedger, type ProviderSendWindowInstallation } from "./provider-send-ledger";
import {
  createProviderSendAdmission,
  runCatalogProviderWork,
  sendCatalogProviderRequest,
  type ProviderSendRequest,
} from "./provider-send-admission";
import {
  catalogIntegrationDataResetTargetTables,
  resetCatalogIntegrationPreLaunchData,
} from "../governance/catalog-integration-data-migration-reset";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI)
  throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
const describeDb = databaseBaseUrl ? describe : describe.skip;
const installation: ProviderSendWindowInstallation = {
  windowId: "synthetic-window",
  actor: "synthetic-operator",
  armedAt: "2026-10-02T00:00:00.000Z",
  members: [
    {
      ordinal: 1,
      unitKey: "scrydex:lorcana:single-card:source-observation-import",
      language: "en",
      coordinate: "synthetic-one",
    },
    { ordinal: 2, unitKey: "scrydex:lorcana:set:reference-data", language: "en", coordinate: "synthetic-one" },
    {
      ordinal: 9,
      unitKey: "scrydex:lorcana:single-card:source-observation-import",
      language: "en",
      coordinate: "synthetic-two",
    },
    { ordinal: 10, unitKey: "scrydex:lorcana:set:reference-data", language: "en", coordinate: "synthetic-two" },
    {
      ordinal: 17,
      unitKey: "scrydex:one-piece:single-card:source-observation-import",
      language: "en",
      coordinate: "synthetic-three",
    },
    {
      ordinal: 18,
      unitKey: "scrydex:one-piece:sealed-product:source-observation-import",
      language: "en",
      coordinate: "synthetic-four",
    },
  ],
};

describeDb("Catalog provider-send durable window", () => {
  let pools: Readonly<Record<"catalog", PgTransactionalPool>>;
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, ["catalog"], "provider_send_window");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await bootstrapContextDatabase(catalogModule, pools.catalog);
  });
  afterAll(async () => closeMultiContextTestPools(pools));

  async function armed() {
    const ledger = createPostgresProviderSendLedger(pools.catalog);
    const binding = await ledger.arm(installation);
    const request: ProviderSendRequest = {
      provider: "scrydex",
      tariff: "general-one-credit",
      category: "card-force",
      binding,
      unitKey: installation.members[0]!.unitKey,
      language: "en",
      coordinate: "synthetic-one",
    };
    return { ledger, binding, request };
  }

  it("actual readiness reads preserve an armed window with only usage attempts and complete proofs", async () => {
    const { ledger } = await armed();
    vi.stubEnv("DEPLOYMENT_ENVIRONMENT", "staging");
    vi.stubEnv("CATALOG_PROVIDER_SEND_WINDOW_ENABLED", "true");
    vi.stubEnv("SCRYDEX_API_KEY", "SYNTHETIC_TEST_API_KEY");
    vi.stubEnv("SCRYDEX_TEAM_ID", "SYNTHETIC_TEST_TEAM_ID");
    const http = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      if (url.hostname !== "api.scrydex.com" || url.pathname !== "/account/v1/usage") {
        throw new Error(`Unexpected provider HTTP in readiness: ${url.origin}${url.pathname}`);
      }
      return Response.json({ total_credits: 50_000, remaining_credits: 50_000, used_credits: 0 });
    });
    vi.stubGlobal("fetch", http);
    try {
      const deps: CatalogRuntimeDeps = {
        db: pools.catalog,
        eventStore: createPostgresEventStore({ pool: pools.catalog }),
        checkpointStore: createPostgresProjectionStore({ db: pools.catalog }),
        providerSendRuntime: createCatalogProviderSendRuntime(pools.catalog),
      };
      const services = createSourceObservationRuntime(
        deps,
        createCatalogItemRuntime(deps),
        createReferenceDataRuntime(deps),
      );
      const readiness = vi.spyOn(services, "getCatalogIntegrationControlPlaneReadiness");
      const app = new Hono<CatalogAuthoringEnv>();
      app.use("*", async (c, next) => {
        c.set("actor", { permissions: ["catalog.view"] });
        await next();
      });
      app.route("/", sourceObservationRoutes(services));
      const connections = createCatalogProviderConnectionsReadSource(() => services);
      const expectedProofs = [...createCatalogIntegrationDryRunProofRegistry().keys()];
      const reads = [
        async () => expect((await app.request("/integration-control-plane/overview?audience=daily")).status).toBe(200),
        async () => expect((await app.request("/integration-control-plane/overview")).status).toBe(200),
        async () => expect((await app.request("/integration-control-plane/readiness")).status).toBe(200),
        async () => expect((await connections()).complete).toBe(true),
      ];
      let previousAttempts = 0;
      for (let repeat = 0; repeat < 2; repeat++) {
        for (const read of reads) {
          readiness.mockClear();
          await read();
          expect(readiness).toHaveBeenCalledTimes(1);
          const result: Awaited<ReturnType<typeof services.getCatalogIntegrationControlPlaneReadiness>> =
            await readiness.mock.results[0]!.value;
          for (const unitKey of expectedProofs) {
            expect(
              result.units.find((unit) => unit.unitKey === unitKey),
              unitKey,
            ).toMatchObject({
              dryRunStatus: "completed",
              fixtureValidationStatus: "ready",
              observationFacts: expect.any(Number),
            });
            expect(result.units.find((unit) => unit.unitKey === unitKey)!.observationFacts).toBeGreaterThan(0);
          }
          const persisted = await ledger.read();
          expect(persisted).toMatchObject({ state: "armed", refusal: null, inFlight: 0 });
          if (persisted.state === "unarmed") throw new Error("Expected armed window");
          expect(persisted.attempts.length).toBeGreaterThan(previousAttempts);
          expect(
            persisted.attempts.every((attempt) => attempt.category === "usage" && attempt.provider === "scrydex"),
          ).toBe(true);
          expect(persisted.used).toBe(http.mock.calls.length);
          previousAttempts = persisted.attempts.length;
        }
      }
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });

  it("non-exempt uncategorized transport terminates the armed window before HTTP", async () => {
    const { ledger, binding } = await armed();
    const transport = vi.fn<typeof fetch>(async () => Response.json({ synthetic: true }));
    const admission = createProviderSendAdmission({ enabled: true, ledger });
    await expect(
      runCatalogProviderWork(
        admission,
        () => sendCatalogProviderRequest("tcgdex", transport, "https://api.tcgdex.net/v2/en/sets/swsh3"),
        binding,
      ),
    ).rejects.toThrow("unknown-request");
    expect(transport).not.toHaveBeenCalled();
    expect(await ledger.read()).toMatchObject({ state: "terminal", refusal: "unknown-request", used: 0, attempts: [] });
  });

  it("bootstrap installs an affirmative unarmed authority and immutable exact quota slots", async () => {
    const ledger = createPostgresProviderSendLedger(pools.catalog);
    expect(await ledger.debit({ provider: "scrydex", category: "usage" })).toEqual({ state: "unarmed" });
    await ledger.arm(installation);
    const readout = await ledger.read();
    expect(readout).toMatchObject({ state: "armed", used: 0, reserved: 246_000, quota: 246_000, inFlight: 0 });
    if (readout.state === "unarmed") throw new Error("Expected installed quotas");
    expect(readout.quotas.reduce((total, quota) => total + quota.quota, 0)).toBe(246_000);
    expect(
      readout.quotas.filter((quota) => quota.bucket !== "non-scrydex").reduce((total, quota) => total + quota.quota, 0),
    ).toBe(46_000);
    expect(readout.quotas).toHaveLength(78);
  });

  it("separate transactions racing for the final Card permit send exactly once", async () => {
    const { ledger, request } = await armed();
    for (let i = 0; i < 31; i++) expect((await ledger.debit(request)).state).toBe("admitted");
    const fetch = vi.fn(async () => Response.json({ synthetic: true }));
    const replica = createPostgresProviderSendLedger(pools.catalog);
    const outcomes = await Promise.allSettled(
      [ledger, replica].map((store) =>
        createProviderSendAdmission({ enabled: true, ledger: store }).send(
          request,
          fetch,
          "https://synthetic.invalid/cards",
        ),
      ),
    );
    expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await ledger.read()).toMatchObject({ state: "terminal", used: 32, refusal: "quota-exhausted" });
  });

  it("restart and failed transport retain debit and outstanding attribution", async () => {
    const { ledger, request } = await armed();
    const fetch = vi.fn(async () => {
      throw new Error("synthetic connection loss");
    });
    await expect(
      createProviderSendAdmission({ enabled: true, ledger }).send(request, fetch, "https://synthetic.invalid/cards"),
    ).rejects.toThrow("synthetic connection loss");
    const restarted = createPostgresProviderSendLedger(pools.catalog);
    expect(await restarted.read()).toMatchObject({ used: 1, inFlight: 1, reserved: 245_999 });
    expect((await restarted.debit(request)).state).toBe("admitted");
    expect(await restarted.read()).toMatchObject({ used: 2, inFlight: 2 });
  });

  it("lost COMMIT acknowledgement charges but sends zero", async () => {
    const { request, ledger } = await armed();
    const commitLoss: PgTransactionalPool = {
      query: pools.catalog.query,
      connect: async () => {
        const client = await pools.catalog.connect();
        return {
          release: client.release,
          query: async <Row = Record<string, unknown>>(sql: string, values?: readonly unknown[]) => {
            const result = await client.query<Row>(sql, values);
            if (sql === "COMMIT") throw new Error("synthetic lost commit acknowledgement");
            return result;
          },
        };
      },
    };
    const fetch = vi.fn();
    await expect(
      createProviderSendAdmission({ enabled: true, ledger: createPostgresProviderSendLedger(commitLoss) }).send(
        request,
        fetch,
        "https://synthetic.invalid/cards",
      ),
    ).rejects.toThrow("authority-unavailable");
    expect(fetch).not.toHaveBeenCalled();
    expect(await ledger.read()).toMatchObject({ used: 1, inFlight: 1 });
  });

  it("missing authority is a fault, never affirmative unarmed", async () => {
    const ledger = createPostgresProviderSendLedger(pools.catalog);
    await pools.catalog.query("DELETE FROM catalog_provider_send_authority");
    const fetch = vi.fn();
    await expect(
      createProviderSendAdmission({ enabled: true, ledger }).send(
        { provider: "scrydex", category: "usage" },
        fetch,
        "https://synthetic.invalid/usage",
      ),
    ).rejects.toThrow("authority-unavailable");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("arm race installs only one window without replacing identities", async () => {
    const first = createPostgresProviderSendLedger(pools.catalog);
    const second = createPostgresProviderSendLedger(pools.catalog);
    const results = await Promise.allSettled([
      first.arm(installation),
      second.arm({ ...installation, windowId: "synthetic-other" }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect((await pools.catalog.query("SELECT window_id FROM catalog_provider_send_windows")).rows).toHaveLength(1);
  });

  it("advance is CAS through nine slots, never a tenth or a refill", async () => {
    const { ledger, binding, request } = await armed();
    await ledger.debit(request);
    let current = await ledger.advance(binding);
    await expect(ledger.advance(binding)).rejects.toThrow("advance-refused");
    for (let pass = 2; pass <= 9; pass++) current = await ledger.advance(current);
    await expect(ledger.advance(current)).rejects.toThrow("advance-refused");
    expect(await ledger.read()).toMatchObject({ pass: 9, used: 1, reserved: 245_999 });
    await ledger.terminate(current);
    await expect(ledger.advance(current)).rejects.toThrow("advance-refused");
    expect(await ledger.read()).toMatchObject({ state: "terminal", used: 1, inFlight: 1 });
  });

  it("stale reclaimed binding terminates before any new-phase send", async () => {
    const { ledger, binding, request } = await armed();
    await ledger.advance(binding);
    const fetch = vi.fn();
    await expect(
      createProviderSendAdmission({ enabled: true, ledger }).send(request, fetch, "https://synthetic.invalid/cards"),
    ).rejects.toThrow("stale-binding");
    expect(fetch).not.toHaveBeenCalled();
    expect(await ledger.read()).toMatchObject({ state: "terminal", used: 0 });
  });

  it("an uninstalled member cannot mint a payload quota", async () => {
    const { ledger, binding, request } = await armed();
    const next = await ledger.advance(binding);
    expect(
      await ledger.debit({ ...request, binding: next, category: "payload", coordinate: "synthetic-forged" }),
    ).toEqual({ state: "refused", code: "unknown-request" });
    expect(await ledger.read()).toMatchObject({ state: "terminal", used: 0 });
  });

  it("governance reset retains the ledger and cannot refill used permits", async () => {
    const { ledger, request } = await armed();
    await ledger.debit(request);
    expect(catalogIntegrationDataResetTargetTables().some((table) => table.startsWith("catalog_provider_send_"))).toBe(
      false,
    );
    await resetCatalogIntegrationPreLaunchData(pools.catalog, { rebuildSeedProfiles: false });
    expect(await ledger.read()).toMatchObject({ used: 1, inFlight: 1, reserved: 245_999 });
  });

  it("installed policy, coordinates, quota sizes and debits cannot be rewritten or deleted", async () => {
    const { ledger, request } = await armed();
    await ledger.debit(request);
    for (const sql of [
      "UPDATE catalog_provider_send_windows SET policy = '{}'::jsonb",
      "UPDATE catalog_provider_send_windows SET members = '[]'::jsonb",
      "UPDATE catalog_provider_send_quotas SET quota = quota + 1",
      "UPDATE catalog_provider_send_quotas SET used = 0",
      "DELETE FROM catalog_provider_send_attempts",
    ])
      await expect(pools.catalog.query(sql)).rejects.toBeDefined();
    expect(await ledger.read()).toMatchObject({ used: 1, inFlight: 1 });
  });
});
