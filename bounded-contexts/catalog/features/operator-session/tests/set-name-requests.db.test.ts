import { createHash } from "node:crypto";
import { Hono } from "hono";
import { expect, it } from "vitest";
import type { ResolvedActor } from "@chase-sets/auth-context";
import { createActorEventStoreContext } from "@chase-sets/platform-runtime/auth";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { module as catalogModule } from "../../../index";
import type { CatalogAuthoringEnv } from "../../../support/authoring-support/api";
import { createScopeSyncBatchMcpHandlers } from "../../scope-sync-batches/api/mcp";
import { integrationJobRoutes } from "../../source-observations/api/route-modules/integration-job-routes";
import type { CatalogSyncRun } from "../../source-observations/api/runtime";
import type { ScopeSyncBatchPreview } from "../../scope-sync-batches/domain/batch";
import type { ScopeSyncBatchSnapshot } from "../../scope-sync-batches/read-model/store";
import { operatorSessionPublicRoutes } from "../api/route";
import { operatorOrigins } from "../domain/extension/protocol";
import { setNameRequestHeader } from "../domain/extension/set-names/request";
import { describeDb, useOperatorSessionDatabase } from "./db-fixture";
import { routePath, setNameEntry, setNamePost } from "./set-name-observation-fixture";

const operator = {
  sessionId: "sess_operator",
  tenantId: "tnt_identity",
  userId: "usr_set_name_operator",
  accountId: "acc_identity_system",
  membershipId: "mbr_set_name_operator",
  roleKey: "platform-admin",
  permissions: ["catalog.manage", "catalog.view"],
} satisfies ResolvedActor;
const context = createActorEventStoreContext(operator);
const secret = "A".repeat(43);
const grantId = "00000000-0000-4000-8000-000000000001";
const secondGrantId = "00000000-0000-4000-8000-000000000002";
const newPair = "B".repeat(42) + "E";
const magic = "scope-test-magic";
const otherMagic = "scope-test-other-magic";
const pokemon = "scope-test-pokemon";
const magicUnit = "tcgplayer:mtg:single-card:source-observation-import";
const workerTurn = { claimOwnerId: "set-name-test-worker", claimTtlMs: 1 };

describeDb("durable Scope Sync set-name requests", () => {
  const db = useOperatorSessionDatabase("durable_set_name_request");

  async function createHarness(beforeQuery: (sql: string) => void = () => undefined) {
    const base = db();
    const pool: PgTransactionalPool = {
      query: base.query.bind(base),
      async connect() {
        const connection = await base.connect();
        return {
          async query<Row>(sql: string, params?: readonly unknown[]) {
            beforeQuery(sql);
            return connection.query<Row>(sql, params);
          },
          release: connection.release.bind(connection),
        };
      },
    };
    const services = catalogModule.createServices(pool, {
      catalogOperatorAuthority: {
        forActor: async () => ({
          kind: "granted",
          membershipId: operator.membershipId,
          roleKey: "platform-admin",
          rolePermissions: operator.permissions,
        }),
        forGrantCreator: async () => ({
          kind: "granted",
          membershipId: operator.membershipId,
          roleKey: "platform-admin",
          rolePermissions: operator.permissions,
        }),
      },
    });
    await services.providerIntegrationProfiles.seedProfileVersions();
    for (const [id, domain] of [
      [magic, "magic"],
      [otherMagic, "magic"],
      [pokemon, "pokemon"],
    ]) {
      await pool.query(
        `INSERT INTO catalog_scope_records (scope_record_id, product_domain, scope_kind, reference_type_key,
          reference_record_id, reference_record_key, name, lifecycle_status)
         VALUES ($1, $2, 'product-line', 'game', $1, $1, $1, 'active')`,
        [id, domain],
      );
    }
    async function pair(id = grantId, bearer = secret) {
      await pool.query(
        `INSERT INTO catalog_operator_session_grants
          (id, token_hash, creator_user_id, creator_membership_id, created_at, last_used_at, idle_expires_at)
         VALUES ($1, $2, $3, $4, now(), now(), now() + interval '30 days')`,
        [id, createHash("sha256").update(bearer, "ascii").digest(), operator.userId, operator.membershipId],
      );
    }
    const operatorApp = operatorSessionPublicRoutes(services.operatorSession);
    const admin = new Hono<CatalogAuthoringEnv>();
    admin.use("*", async (c, next) => {
      c.set("actor", operator);
      c.set("context", context);
      await next();
    });
    admin.route("/", integrationJobRoutes(services.sourceObservations));
    const scope = (scopeRecordId = magic) => ({
      productDomain: "magic",
      reference: { kind: "product-line", scopeRecordId },
      providerParticipation: { requiredUnitKeys: [magicUnit] },
    });
    const adminPost = (path: "runs" | "preview", scopeRecordId?: string) =>
      admin.request(`/catalog-sync-scope/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope: scope(scopeRecordId) }),
      });
    const enqueue = async (scopeRecordId?: string) => {
      const response = await adminPost("runs", scopeRecordId);
      expect(response.status).toBe(202);
      return (await response.json()) as CatalogSyncRun;
    };
    const poll = async (bearer = secret) => {
      const response = await operatorApp.request(`${operatorOrigins.staging}/observation-requests/current?version=2`, {
        headers: { Authorization: `Bearer ${bearer}` },
      });
      expect(response.status).toBe(200);
      return ((await response.json()) as { request: { requestId: string; productLineId: number } | null }).request;
    };
    const answer = (requestId: string, post: unknown, bearer = secret, origin = operatorOrigins.staging as string) =>
      operatorApp.request(`${origin}${routePath}`, {
        method: "POST",
        body: JSON.stringify(post),
        headers: {
          Authorization: `Bearer ${bearer}`,
          "Content-Type": "application/json",
          [setNameRequestHeader]: requestId,
        },
      });
    const snapshot = (syncRunId: string) => services.sourceObservations.getCatalogSyncRun({ syncRunId, context });
    const count = async (sql: string) => Number((await pool.query<{ count: string }>(sql)).rows[0]!.count);
    return {
      pool,
      services,
      pair,
      adminPost,
      enqueue,
      poll,
      answer,
      snapshot,
      count,
      turn: () => services.sourceObservations.processNextIntegrationJob(workerTurn),
    };
  }

  it("coalesces overlapping Admin submissions and commits observations, mapping events, receipt and child together", async () => {
    let loseBeforeReceipt = true;
    const h = await createHarness((sql) => {
      if (loseBeforeReceipt && sql.includes("answer_digest = $3")) {
        loseBeforeReceipt = false;
        throw new Error("synthetic interruption before receipt");
      }
    });
    await h.pair();
    const preview = await h.adminPost("preview");
    expect(preview.status).toBe(200);
    await expect(preview.json()).resolves.toMatchObject({
      status: "ready",
      units: [
        {
          unitKey: magicUnit,
          childExecutionScope: { execution: "extension-set-names", productLineId: "1" },
          estimate: { estimatedRequestCount: 1 },
        },
      ],
    });
    const runs = await Promise.all([h.enqueue(), h.enqueue(), h.enqueue(otherMagic)]);
    expect(runs[0]!.syncRunId).toBe(runs[1]!.syncRunId);
    expect(new Set(runs.map((run) => run.childJobs[0]!.childJobId)).size).toBe(1);
    expect(await h.poll()).toBeNull();
    await h.turn();
    const request = await h.poll();
    expect(request).toMatchObject({ kind: "set-names", productLineId: 1 });
    expect(await h.poll()).toBeNull();
    const post = setNamePost(1, [setNameEntry(1, 42)]);
    const observations = "SELECT count(*) FROM catalog_provider_scope_observations";
    const proposals = "SELECT count(*) FROM event_store_events WHERE stream_id LIKE 'catalog.provider-scope-mapping-%'";
    expect((await h.answer(request!.requestId, post)).status).toBe(503);
    expect(await h.count(observations)).toBe(0);
    expect(await h.count(proposals)).toBe(0);
    expect(await h.snapshot(runs[0]!.syncRunId)).toMatchObject({ status: "running" });
    const replies = await Promise.all([h.answer(request!.requestId, post), h.answer(request!.requestId, post)]);
    expect(replies.map((reply) => reply.status)).toEqual([200, 200]);
    const receipts = await Promise.all(replies.map((reply) => reply.json()));
    expect(receipts).toEqual([
      { observationCount: 2, newObservationCount: 2, mappingsProposed: 2 },
      { observationCount: 2, newObservationCount: 2, mappingsProposed: 2 },
    ]);
    expect(await h.count(observations)).toBe(2);
    expect(await h.count(proposals)).toBe(2);
    expect((await h.answer(request!.requestId, { ...post, sets: [] })).status).toBe(409);
    for (const run of runs)
      expect(await h.snapshot(run.syncRunId)).toMatchObject({
        status: "completed",
        childJobs: [{ status: "completed", job: { result: { observed: 2 } } }],
      });
    const refresh = await h.enqueue();
    expect(refresh.childJobs[0]!.childJobId).not.toBe(runs[0]!.childJobs[0]!.childJobId);
  });

  it("settles no-poll work as extension-unavailable and keeps a mixed-line MCP batch moving", async () => {
    const h = await createHarness();
    const handlers = createScopeSyncBatchMcpHandlers(h.services.scopeSyncBatches).toolHandlers;
    const invoke = (name: string, args: Record<string, unknown>) =>
      handlers[name]!({ actor: operator, arguments: args } as never);
    const input = {
      selection: { mode: "ids", scopeRecordIds: [magic, pokemon] },
      budget: { defaultProviderConcurrency: 2 },
    };
    const preview = (await invoke("catalog.preview-scope-sync-batch", input)) as ScopeSyncBatchPreview;
    expect(preview).toMatchObject({
      status: "ready",
      counts: { readyScopes: 2 },
      providerUnitTotals: { tcgplayer: 2 },
    });
    const batch = (await invoke("catalog.confirm-scope-sync-batch", {
      ...input,
      planFingerprint: preview.planFingerprint,
    })) as ScopeSyncBatchSnapshot;
    await h.turn();
    await h.turn();
    const snapshot = () => h.services.scopeSyncBatches.get({ batchId: batch.batchId, context });
    const pending = await snapshot();
    const first = pending!.units.find((unit) => unit.scopeRecordId === magic)!;
    expect(first.syncRunId).toBeTruthy();
    expect(pending!.units.find((unit) => unit.scopeRecordId === pokemon)?.syncRunId).toBeTruthy();
    expect(await h.snapshot(first.syncRunId!)).toMatchObject({
      status: "running",
      childJobs: [{ job: { progress: { phase: "waiting-for-extension" } } }],
    });
    expect(await h.count("SELECT count(*) FROM catalog_set_name_requests WHERE deadline IS NOT NULL")).toBe(1);
    await h.pool.query(
      "UPDATE catalog_set_name_requests SET deadline = clock_timestamp() - interval '1 second' WHERE deadline IS NOT NULL",
    );
    for (let turn = 0; turn < 4; turn += 1) await h.turn();
    expect((await snapshot())?.units.find((unit) => unit.scopeRecordId === magic)).toMatchObject({
      state: "failed",
      errorMessage: "extension-unavailable",
    });
    expect(await h.snapshot(first.syncRunId!)).toMatchObject({
      status: "failed",
      childJobs: [{ job: { errorMessage: "extension-unavailable" } }],
    });
    await h.pair();
    const request = await h.poll();
    expect(request).toMatchObject({ productLineId: 3 });
    expect((await h.answer(request!.requestId, setNamePost(3, [setNameEntry(3, 15)]))).status).toBe(200);
    for (let turn = 0; turn < 4; turn += 1) await h.turn();
    expect(await snapshot()).toMatchObject({
      status: "partial",
      units: expect.arrayContaining([expect.objectContaining({ scopeRecordId: pokemon, state: "completed" })]),
    });
  });

  it("rejects wrong grants, environments, cancellation and late generations without writes", async () => {
    const h = await createHarness();
    await h.pair();
    const run = await h.enqueue();
    const jobId = run.childJobs[0]!.childJobId!;
    await h.turn();
    const old = (await h.poll())!.requestId;
    const post = setNamePost(1, [setNameEntry(1, 9)]);
    expect((await h.answer(old, post, secret, operatorOrigins.production)).status).toBe(409);
    await h.pool.query("UPDATE catalog_operator_session_grants SET revoked_at = now(), revoke_reason = 'replaced'");
    await h.pair(secondGrantId, newPair);
    expect((await h.answer(old, post, newPair)).status).toBe(409);
    await h.services.sourceObservations.cancelIntegrationJob({ jobId, context });
    expect((await h.answer(old, post)).status).toBe(401);
    await Promise.all([
      h.services.sourceObservations.retryIntegrationJob({ jobId, context }),
      h.services.sourceObservations.retryIntegrationJob({ jobId, context }),
    ]);
    await h.turn();
    const next = (await h.poll(newPair))!.requestId;
    expect(next).not.toBe(old);
    expect((await h.answer(old, post, newPair)).status).toBe(409);
    expect(await h.count("SELECT count(*) FROM catalog_provider_scope_observations")).toBe(0);
    expect((await h.answer(next, { failure: "provider-request-failed" }, newPair)).status).toBe(200);
    expect(await h.snapshot(run.syncRunId)).toMatchObject({
      status: "failed",
      childJobs: [{ job: { errorMessage: "provider-request-failed" } }],
    });
  });
});
