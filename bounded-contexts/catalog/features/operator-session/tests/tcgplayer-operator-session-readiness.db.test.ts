import { expect, it, vi } from "vitest";
import { withPgTransaction } from "@chase-sets/event-core-postgres";
import { describeDb, keyring, session, useOperatorSessionDatabase } from "./db-fixture";
import { createPostgresCatalogOperatorSessionStore, readCatalogOperatorSessionSnapshot } from "../api/store";
import { createOperatorSessionOutcomeRecorder, lockOperatorSessionReadiness } from "../api/outcomes";
import { createTcgplayerAutomationRuntime } from "../api/runtime";
import { deriveTcgplayerOperatorSessionReadiness } from "../domain/readiness";
import { createTcgplayerProviderAdapter } from "../../source-observations/api/providers/tcgplayer/adapter";
import { ProviderAdapterRegistry } from "../../source-observations/api/provider-adapters/registry";
import { buildCatalogIntegrationControlPlaneReadiness } from "../../source-observations/api/governance/catalog-integration-control-plane-readiness";
import { collectProviderHealthItems } from "../../attention-queue/read-model/collectors";
import { createCatalogProviderConnectionsReadSource } from "../../source-observations/api/admin/provider-connections-read-source";
import type { OperatorSessionIdentity } from "../domain/readiness";
import { getCatalogProviderIntegrationProfileVersion } from "../../source-observations/api/provider-integration-profiles";
import { createCatalogIntegrationRolloutControlPolicy } from "../../source-observations/api/governance/catalog-integration-rollout-controls";
import {
  TcgplayerAutomationDomainHttpClient,
  type TcgplayerAutomationAdmissionResult,
  type TcgplayerAutomationHttpConfigStore,
} from "../../source-observations/api/providers/tcgplayer-automation-client";

const operator = (revision: number): OperatorSessionIdentity => ({
  source: "operator-session",
  revision,
  custodyRevision: revision,
});
const environment = (custodyRevision: number): OperatorSessionIdentity => ({
  source: "environment",
  revision: 0,
  custodyRevision,
});
const marker = "LABELED_SYNTHETIC_HOSTILE_SESSION_8455";
async function profiles() {
  const profile = getCatalogProviderIntegrationProfileVersion("tcgplayer", "2026.06.05", {
    profileKey: "pokemon-single-card-product-sku",
  });
  if (!profile) throw new Error("labeled-synthetic fixture requires the registered Pokemon profile");
  return [profile];
}

describeDb("TCGplayer operator session readiness real storage", () => {
  const db = useOperatorSessionDatabase("operator_session_readiness_8455");
  const accept = (revision: number, value = marker) =>
    withPgTransaction(db(), (client) =>
      createPostgresCatalogOperatorSessionStore(client, keyring).accept(session(revision, value)),
    );
  const clear = (revision: number) =>
    withPgTransaction(db(), (client) =>
      createPostgresCatalogOperatorSessionStore(client, keyring).clear({
        expectedRevision: revision,
        expectedKeyId: keyring.activeKeyId,
      }),
    );
  const record = (
    identity: OperatorSessionIdentity,
    status = 403,
    rateBudgetContext: "retained" | "unknown" = "retained",
  ) => createOperatorSessionOutcomeRecorder(db())({ identity, status, rateBudgetContext });
  const rows = () => db().query("SELECT * FROM catalog_tcgplayer_operator_session_outcomes");
  const age = () =>
    db().query(`UPDATE catalog_tcgplayer_operator_session_outcomes
    SET state_since = clock_timestamp() - interval '31 minutes', last_rejection_at = clock_timestamp(), updated_at = clock_timestamp()`);
  const read = async (env: string | null = "labeled-synthetic-environment") =>
    deriveTcgplayerOperatorSessionReadiness(
      (await readCatalogOperatorSessionSnapshot(db(), keyring, env)).readiness,
      Date.now(),
    );

  it.each([403, 429])("durable headers without onStage survive %i cooldown abort exactly once", async (status) => {
    await accept(0);
    const controller = new AbortController();
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response("labeled-synthetic-rejection", { status }));
    let cooldowns = 0;
    const runtime = createTcgplayerAutomationRuntime(
      { pool: db(), keyring, config: { maxRetries: 1 } },
      {
        fetch,
        sleep: async (_ms, signal) => {
          if (signal === controller.signal) {
            cooldowns++;
            controller.abort();
            signal.throwIfAborted();
          } else
            await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
        },
      },
    )!;
    const recorded = vi.spyOn(runtime.configStore, "recordCredentialOutcome");
    await expect(
      runtime.httpClients.infiniteApi.get("/labeled-synthetic", {}, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(cooldowns).toBe(1);
    expect(recorded).toHaveBeenCalledTimes(status === 403 ? 1 : 0);
    if (status === 403) {
      expect(recorded).toHaveBeenCalledWith({ identity: operator(1), status: 403, rateBudgetContext: "retained" });
      expect((await rows()).rows[0]).toMatchObject({
        state: "rejecting",
        last_rejection_status: 403,
        rate_budget_context: "retained",
      });
    } else expect((await rows()).rows).toEqual([]);
  });

  it.each([false, true])(
    "later pre-headers abort preserves the first tuple, custody switch=%s",
    async (switchCustody) => {
      await accept(0);
      const controller = new AbortController();
      const runtime = createTcgplayerAutomationRuntime({ pool: db(), keyring, config: { maxRetries: 1 } })!;
      const recorded = vi.fn(runtime.configStore.recordCredentialOutcome);
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValueOnce(new Response("labeled-synthetic-rejection", { status: 403 }))
        .mockImplementationOnce(async () => {
          controller.abort();
          controller.signal.throwIfAborted();
          throw new Error("unreachable");
        });
      let cooldowns = 0;
      // The fallback is read only on attempt two; it must never be assigned attempt one's rejection.
      const envRuntime = createTcgplayerAutomationRuntime({
        pool: db(),
        keyring,
        config: {
          maxRetries: 1,
          auth: { tcgAuthCookie: "labeled-synthetic-fallback", userAgent: "labeled-synthetic" },
        },
      })!;
      const store: TcgplayerAutomationHttpConfigStore = {
        ...runtime.configStore,
        loadConfig: envRuntime.configStore.loadConfig,
        recordCredentialOutcome: recorded,
      };
      const boundClient = new TcgplayerAutomationDomainHttpClient(
        "infiniteApi",
        "https://labeled-synthetic.invalid",
        store,
        {
          fetch,
          sleep: async (_ms, signal) => {
            if (signal !== controller.signal)
              return new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
            cooldowns++;
            if (switchCustody) await clear(1);
            await db().query(
              "UPDATE catalog_tcgplayer_automation_domain_rate_limits SET cooldown_until = NULL, last_request_started_at = NULL",
            );
          },
        },
      );
      await expect(boundClient.get("/labeled-synthetic", {}, { signal: controller.signal })).rejects.toMatchObject({
        name: "AbortError",
      });
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(cooldowns).toBe(1);
      expect(recorded).toHaveBeenCalledExactlyOnceWith({
        identity: operator(1),
        status: 403,
        rateBudgetContext: "retained",
      });
      if (switchCustody) expect((await rows()).rows).toEqual([]);
      else expect((await rows()).rows[0]).toMatchObject({ revision: "1", custody_revision: "1" });
    },
  );

  it.each(["matching", "missing", "wrong-domain", "stale", "uncorrelated", "legacy"] as const)(
    "same real admission with %s provenance alone controls sustained-403 readiness",
    async (kind) => {
      await accept(0);
      await record(operator(1), 200);
      const runtime = createTcgplayerAutomationRuntime({ pool: db(), keyring, config: { maxRetries: 0 } })!;
      const realAdmit = runtime.configStore.admitDomainRequest!;
      const store: TcgplayerAutomationHttpConfigStore = {
        ...runtime.configStore,
        admitDomainRequest: async (...args) => {
          const grant = await realAdmit(...args);
          const patch: Partial<TcgplayerAutomationAdmissionResult> =
            kind === "wrong-domain"
              ? { domainKey: "mpApi" }
              : kind === "stale"
                ? {
                    admittedAt: "2020-01-01T00:00:00.000Z",
                    notBefore: "2020-01-01T00:00:00.000Z",
                    leaseExpiresAt: "2020-01-01T00:01:00.000Z",
                  }
                : kind === "uncorrelated"
                  ? { notBefore: new Date(Date.parse(grant.admittedAt) + 1).toISOString() }
                  : kind === "missing"
                    ? { floorRequestDelayMs: NaN }
                    : {};
          return { ...grant, ...patch };
        },
      };
      const legacy: TcgplayerAutomationHttpConfigStore = {
        loadConfig: store.loadConfig,
        loadDomainConfig: store.loadDomainConfig,
        persistDomainDelays: store.persistDomainDelays,
        recordCredentialOutcome: store.recordCredentialOutcome,
      };
      const client = new TcgplayerAutomationDomainHttpClient(
        "infiniteApi",
        "https://labeled-synthetic.invalid",
        kind === "legacy" ? legacy : store,
        {
          fetch: async () => new Response("labeled-synthetic-rejection", { status: 403 }),
          sleep: async (_ms, signal) => {
            if (signal)
              await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
          },
        },
      );
      await expect(client.get("/labeled-synthetic")).rejects.toMatchObject({ status: 403 });
      await age();
      expect((await rows()).rows[0]).toMatchObject({
        rate_budget_context: kind === "matching" ? "retained" : "unknown",
      });
      expect(await read()).toMatchObject(
        kind === "matching"
          ? { state: "invalid", diagnosticCode: "credential-refresh-needed" }
          : { state: "unknown", diagnosticCode: "adapter-authentication-failed" },
      );
    },
  );

  it("joins the caller transaction: a renewal refusal rolls back custody and outcome deletion", async () => {
    await record(environment(0), 401);
    const before = (await rows()).rows;
    await expect(
      withPgTransaction(db(), async (client) => {
        await createPostgresCatalogOperatorSessionStore(client, keyring).accept(session(0, marker));
        expect((await client.query("SELECT * FROM catalog_tcgplayer_operator_session_outcomes")).rows).toEqual([]);
        throw new Error("labeled-synthetic-renewal-refusal");
      }),
    ).rejects.toThrow("labeled-synthetic-renewal-refusal");
    expect((await rows()).rows).toEqual(before);
    expect(await createPostgresCatalogOperatorSessionStore(db(), keyring).readMetadata()).toBeNull();
    await accept(0);
    expect((await rows()).rows).toEqual([]);
  });

  it("the recorder never takes the grant lock and exposes no credential-bearing evidence", async () => {
    const grantOwner = await db().connect();
    await grantOwner.query("SELECT pg_advisory_lock($1::bigint)", ["84518450"]);
    try {
      await record(environment(0), 401);
      expect((await rows()).rows[0]).toMatchObject({ last_rejection_status: 401 });
      expect(JSON.stringify(await read())).not.toContain(marker);
    } finally {
      await grantOwner.query("SELECT pg_advisory_unlock($1::bigint)", ["84518450"]);
      grantOwner.release();
    }
  });

  it("missing-source control blocks the same existing collector without a fetch", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const runtime = createTcgplayerAutomationRuntime({ pool: db(), keyring, config: null }, { fetch })!;
    const registry = new ProviderAdapterRegistry([
      createTcgplayerProviderAdapter({ client: runtime.catalogClient, loadProfileVersions: profiles }),
    ]);
    const readiness = await buildCatalogIntegrationControlPlaneReadiness(
      registry,
      undefined,
      createCatalogIntegrationRolloutControlPolicy(),
    );
    expect(readiness.units.length).toBeGreaterThan(0);
    expect(readiness.units.every((unit) => unit.credentialDiagnosticCode === "credential-missing")).toBe(true);
    expect(collectProviderHealthItems(readiness.units, { generatedAt: readiness.generatedAt })).toHaveLength(
      readiness.units.length,
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("real client, admission, adapter, collector and Provider Connections clear after reaccept and success", async () => {
    await accept(0);
    let status = 200;
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response("{}", { status }));
    const runtime = createTcgplayerAutomationRuntime({ pool: db(), keyring, config: { maxRetries: 0 } }, { fetch })!;
    const send = async () => {
      await db().query("UPDATE catalog_tcgplayer_automation_domain_rate_limits SET last_request_started_at = NULL");
      return runtime.httpClients.infiniteApi.get("/labeled-synthetic");
    };
    await send();
    status = 403;
    await expect(send()).rejects.toMatchObject({ status: 403 });
    await age();
    const adapter = createTcgplayerProviderAdapter({
      client: runtime.catalogClient,
      loadProfileVersions: profiles,
    });
    const registry = new ProviderAdapterRegistry([adapter]);
    const getCatalogIntegrationControlPlaneReadiness = () =>
      buildCatalogIntegrationControlPlaneReadiness(registry, undefined, createCatalogIntegrationRolloutControlPolicy());
    const connections = createCatalogProviderConnectionsReadSource(() => ({
      getCatalogIntegrationControlPlaneReadiness,
    }));
    const blocked = await getCatalogIntegrationControlPlaneReadiness();
    expect(blocked.units.length).toBeGreaterThan(0);
    expect(blocked.units.every((unit) => unit.credentialDiagnosticCode === "credential-refresh-needed")).toBe(true);
    const alert = collectProviderHealthItems(blocked.units, { generatedAt: blocked.generatedAt });
    expect(alert).toHaveLength(blocked.units.length);
    expect(alert.every((item) => item.severity === "critical")).toBe(true);
    expect((await connections()).rows[0]).toMatchObject({ credentialReadiness: "invalid" });
    expect(JSON.stringify({ blocked, alert, connections: await connections() })).not.toContain(marker);
    expect(fetch).toHaveBeenCalledTimes(2);
    await accept(1, "labeled-synthetic-refreshed");
    status = 200;
    await send();
    const recovered = await getCatalogIntegrationControlPlaneReadiness();
    expect(collectProviderHealthItems(recovered.units, { generatedAt: recovered.generatedAt })).toEqual([]);
    expect((await connections()).rows[0]).toMatchObject({ credentialReadiness: "configured" });
    expect((await rows()).rows[0]).toMatchObject({
      state: "healthy",
      ever_succeeded: true,
      last_rejection_status: null,
    });
  });

  it("fresh retained rejection differs from unreadable stored custody and cleared fallback", async () => {
    await accept(0);
    await record(operator(1));
    await age();
    expect(await read()).toMatchObject({ state: "unknown", diagnosticCode: "rejected-after-refresh" });
    const unreadable = await readCatalogOperatorSessionSnapshot(db(), null, "labeled-synthetic-environment");
    expect(unreadable.value).toBeNull();
    expect(
      await createTcgplayerAutomationRuntime({
        pool: db(),
        keyring: null,
        config: null,
      }).catalogClient.resolveCredentialReadiness(),
    ).toMatchObject({ state: "unknown", diagnosticCode: "operator-session-custody-unavailable" });
    expect(deriveTcgplayerOperatorSessionReadiness(unreadable.readiness, Date.now())).toMatchObject({
      state: "unknown",
      diagnosticCode: "operator-session-custody-unavailable",
    });
    await clear(1);
    expect(await read()).toMatchObject({ sourceKind: "environment-secret", state: "configured", diagnosticCode: null });
    expect(await read(null)).toMatchObject({ state: "missing", diagnosticCode: "credential-missing" });
    expect((await rows()).rows).toEqual([]);
  });

  it("old operator and environment identities cannot insert, reset or extend after every custody transition", async () => {
    await record(environment(0), 200);
    await accept(0);
    await record(environment(0), 401);
    expect((await rows()).rows).toEqual([]);
    await record(operator(1), 200);
    await clear(1);
    await record(operator(1), 401);
    expect((await rows()).rows).toEqual([]);
    await record(environment(2));
    await accept(2, "labeled-synthetic-next");
    await record(environment(2), 401);
    expect((await rows()).rows).toEqual([]);
    await clear(3);
    await record(environment(4), 200);
    const current = (await rows()).rows;
    await record(environment(2), 401);
    await record(operator(3), 401);
    expect((await rows()).rows).toEqual(current);
  });

  it("serializes recorder and caller-owned accept before row access, including absent custody", async () => {
    const client = await db().connect();
    await client.query("BEGIN");
    await lockOperatorSessionReadiness(client);
    let completed = false;
    const pending = record(environment(0), 401).then(() => {
      completed = true;
    });
    try {
      await createPostgresCatalogOperatorSessionStore(client, keyring).accept(session(0, marker));
      expect(completed).toBe(false);
      await client.query("COMMIT");
      await pending;
      expect((await rows()).rows).toEqual([]);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it("unchanged and stale mutations preserve the row; restart and repeated healthy outcomes are inert", async () => {
    await accept(0);
    await record(operator(1), 200);
    const before = (await rows()).rows;
    expect(await accept(1)).toMatchObject({ outcome: "unchanged" });
    expect(await accept(0)).toMatchObject({ outcome: "stale-revision" });
    expect(await clear(3)).toMatchObject({ outcome: "stale-revision" });
    await record(operator(1), 200);
    expect((await rows()).rows).toEqual(before);
    expect(await read()).toMatchObject({ state: "configured" });
    await record(operator(1));
    await age();
    expect(await read()).toMatchObject({ state: "invalid" });
    await db().query(`UPDATE catalog_tcgplayer_operator_session_outcomes SET
      state_since = clock_timestamp() - interval '3 hours', last_rejection_at = clock_timestamp() - interval '2 hours'`);
    expect(await read()).toMatchObject({ state: "configured" });
    await record(operator(1));
    expect(await read()).toMatchObject({ state: "configured" });
  });

  it("bounds real writes across 1,000 same outcomes and a five-minute refresh", async () => {
    await record(environment(0));
    const before = (
      await db().query<{ xmin: string }>("SELECT xmin::text FROM catalog_tcgplayer_operator_session_outcomes")
    ).rows[0]!.xmin;
    for (let i = 0; i < 1000; i++) await record(environment(0));
    expect((await db().query("SELECT xmin::text FROM catalog_tcgplayer_operator_session_outcomes")).rows[0]).toEqual({
      xmin: before,
    });
    await db()
      .query(`UPDATE catalog_tcgplayer_operator_session_outcomes SET state_since = clock_timestamp() - interval '6 minutes',
      last_rejection_at = clock_timestamp() - interval '5 minutes'`);
    await record(environment(0));
    const refreshed = (await rows()).rows;
    await record(environment(0));
    expect((await rows()).rows).toEqual(refreshed);
  });

  it.each([
    ["source", "hostile-marker"],
    ["state", "hostile-marker"],
    ["rate_budget_context", "hostile-marker"],
    ["revision", -1],
    ["revision", "9007199254740992"],
    ["revision", "1.5"],
    ["custody_revision", -1],
    ["custody_revision", "9007199254740992"],
    ["state_since", "infinity"],
    ["last_rejection_at", "-infinity"],
    ["updated_at", "infinity"],
    ["last_rejection_status", 429],
    ["last_rejection_status", null],
    ["last_rejection_at", null],
    ["ever_succeeded", null],
    ["source", "operator-session"],
    ["state", "healthy"],
  ] as const)("rejects invalid persisted %s=%s", async (column, value) => {
    await record(environment(0));
    await expect(
      db().query(`UPDATE catalog_tcgplayer_operator_session_outcomes SET ${column} = $1`, [value]),
    ).rejects.toThrow();
  });
});
