import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { module as paymentsModule } from "@chase-sets/payments";
import {
  createAgentGrantRevocations,
  createActiveAgentGrantFence,
  createLinkedPlatformAuthorizationStore,
  type RevocationBinding,
  type AgentGrantRevocations,
  type RevocationActivationProof,
} from "@chase-sets/identity/server";
import { module as identityModule } from "@chase-sets/identity";
import { module as authModule } from "../../../index";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import { createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import {
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
  closeMultiContextTestPools,
} from "@chase-sets/bounded-context-runtime/test-support";
import { resumeAgentGrantRevocation } from "./revocation";
import { createPostgresAgentWebhookOutbox } from "../../../support/ucp-support/agent-webhooks/agent-webhook-outbox";
import { createAgentWebhookDispatcher } from "../../../support/ucp-support/agent-webhooks/agent-webhook-dispatcher";

const baseUrl = process.env.TEST_DATABASE_URL;
if (!baseUrl && process.env.CI) throw new Error("TEST_DATABASE_URL is required for agent Grant revocation DB proof.");
const describeDb = baseUrl ? describe : describe.skip;
const contextNames = ["identity", "auth", "payments"] as const;
const context = {
  tenantId: "tnt_identity",
  audit: { performedByUserId: "usr_a", forAccountId: "acc_a" },
} as EventStoreContext;
const attemptId = "eea0342d-079b-460e-9dfe-06c42a0a8a70";
const deploymentContext: EventStoreContext = {
  tenantId: "tnt_identity",
  audit: { performedByUserId: "usr_identity_deployment", forAccountId: "acc_identity_deployment" },
};
function activationProof(): RevocationActivationProof {
  return {
    environment: "production",
    namespace: "synthetic",
    releaseCommit: "a".repeat(40),
    imageDigest: `sha256:${"b".repeat(64)}`,
    evidenceId: "synthetic-run",
    fenceId: "synthetic-fence",
    capturedAt: new Date().toISOString(),
    expectedReplicas: ["synthetic-api", "synthetic-worker"],
    replicas: [
      {
        id: "synthetic-api",
        uid: "api-uid",
        role: "platform-api",
        commit: "a".repeat(40),
        digest: `sha256:${"b".repeat(64)}`,
        supportVersion: 1,
      },
      {
        id: "synthetic-worker",
        uid: "worker-uid",
        role: "platform-worker",
        commit: "a".repeat(40),
        digest: `sha256:${"b".repeat(64)}`,
        supportVersion: 1,
      },
    ],
  };
}
const binding: RevocationBinding = {
  attemptId,
  tenantId: context.tenantId,
  accountId: "acc_a",
  grantId: "grant_a",
  userId: "usr_a",
  sessionId: "sess_a",
  provenance: "session",
  reason: "account_consent_revoked",
  intent: "revoke",
  contractVersion: 1,
};
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describeDb("agent Grant revocation separate-pool proof", () => {
  let pools: Readonly<Record<(typeof contextNames)[number], PgTransactionalPool>>;
  let owner: AgentGrantRevocations;
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(baseUrl!, contextNames, "agent_grant_revocation_7422");
    await ensureMultiContextTestDatabases(baseUrl!, urls);
    pools = createMultiContextTestPools(urls);
  });
  afterAll(async () => {
    if (pools) await closeMultiContextTestPools(pools);
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await bootstrapContextDatabase(identityModule, pools.identity);
    await bootstrapContextDatabase(authModule, pools.auth);
    await bootstrapContextDatabase(paymentsModule, pools.payments);
    owner = createAgentGrantRevocations(pools.identity, createPostgresEventStore({ pool: pools.identity }));
    const store = createLinkedPlatformAuthorizationStore(pools.identity);
    for (const [grantId, accountId] of [
      ["grant_a", "acc_a"],
      ["grant_sibling", "acc_a"],
      ["grant_foreign", "acc_b"],
    ])
      await store.grant({
        authorizationId: grantId,
        accountId,
        clientId: "client_a",
        userId: "usr_a",
        platformProfileUrl: "https://synthetic.example/profile",
        scopes: ["dev.ucp.shopping.order:read"],
        accessTokenHash: `synthetic-${grantId}`,
        refreshTokenHash: `synthetic-refresh-${grantId}`,
        accessTokenExpiresAt: "2020-01-01T00:00:00.000Z",
        grantedAt: "2020-01-01T00:00:00.000Z",
      });
  });
  async function activate() {
    // Synthetic control only, never a substitute for the host's pre-activation capture.
    const proof = activationProof();
    await owner.activate(proof, deploymentContext, { revalidate: async () => proof });
  }
  const delivery = (ids: readonly string[], key = "delivery_a") => ({
    clientId: "client_a",
    accountId: "acc_a",
    grantIds: ids,
    callbackUrl: "https://synthetic.example/hooks",
    sourceEventId: "evt_a",
    eventType: "ordering.order.created",
    orderId: "ord_a",
    orderStatus: "created" as const,
    payloadJson: "{}",
    idempotencyKey: key,
  });
  function outbox() {
    return createPostgresAgentWebhookOutbox({
      db: pools.auth,
      withActiveGrants: createActiveAgentGrantFence(pools.identity),
    });
  }

  it("agent-grant-revocation-floor stays dormant through boot twice and rejects old-worker activation", async () => {
    await bootstrapContextDatabase(identityModule, pools.identity);
    await bootstrapContextDatabase(authModule, pools.auth);
    expect(
      (
        await pools.identity.query(
          `SELECT migration_id FROM bounded_context_schema_migrations WHERE migration_id = '20261012_identity_agent_grant_revocation_support'`,
        )
      ).rows,
    ).toHaveLength(1);
    expect(
      (
        await pools.auth.query(
          `SELECT migration_id FROM bounded_context_schema_migrations WHERE migration_id = '20261012_auth_agent_webhook_grant_fence'`,
        )
      ).rows,
    ).toHaveLength(1);
    expect(await owner.isActivated()).toBe(false);
    await expect(owner.admit(binding, context)).rejects.toThrow("revocation_support_floor");
    const restarted = createAgentGrantRevocations(pools.identity, createPostgresEventStore({ pool: pools.identity }));
    expect(await restarted.isActivated()).toBe(false);
    await expect(
      restarted.activate(
        {
          ...activationProof(),
          capturedAt: new Date().toISOString(),
          expectedReplicas: ["synthetic-worker"],
          replicas: [
            {
              id: "synthetic-worker",
              uid: "synthetic-worker-uid",
              role: "platform-worker",
              commit: "a".repeat(40),
              digest: "sha256:" + "b".repeat(64),
              supportVersion: 0,
            },
          ],
        },
        deploymentContext,
        { revalidate: async () => activationProof() },
      ),
    ).rejects.toThrow("revocation_support_floor");
    await activate();
    expect(await restarted.isActivated()).toBe(true);
  });

  it("revocation-floor fences dormant writes, adopts their recorded authority, and replays activation inertly", async () => {
    owner = createAgentGrantRevocations(
      pools.identity,
      createPostgresEventStore({ pool: pools.identity }),
      "synthetic-api",
    );
    const entered = deferred();
    const release = deferred();
    const revokedAt = "2026-10-12T00:00:00.000Z";
    const request = owner.withMode(async (active) => {
      expect(active).toBe(false);
      entered.resolve();
      await release.promise;
      await createLinkedPlatformAuthorizationStore(pools.identity).revokeToken("synthetic-grant_a", revokedAt);
    });
    await entered.promise;
    const proof = activationProof();
    const fence = { revalidate: vi.fn(async () => proof) };
    await expect(owner.activate(proof, deploymentContext, fence)).rejects.toThrow(
      "revocation_dormant_request_unresolved",
    );
    expect(await owner.isActivated()).toBe(false);
    release.resolve();
    await request;
    await owner.activate(proof, deploymentContext, fence);
    await owner.activate(proof, deploymentContext, fence);
    expect(fence.revalidate).toHaveBeenCalledTimes(1);
    await expect(owner.activate(proof, context, fence)).rejects.toThrow("revocation_activation_authority_required");
    await expect(owner.activate({ ...proof, evidenceId: "different-run" }, deploymentContext, fence)).rejects.toThrow(
      "revocation_activation_conflict",
    );
    const work = await owner.pending();
    expect(work).toHaveLength(1);
    expect(work[0]).toMatchObject({
      state: { grantId: "grant_a", revokedAt, reason: "token_revocation", provenance: "adoption", phase: "admitted" },
    });
    const restarted = createAgentGrantRevocations(pools.identity, createPostgresEventStore({ pool: pools.identity }));
    expect(await restarted.isActivated()).toBe(true);
    await restarted.withMode(async (active) => expect(active).toBe(true));
    await expect(
      createLinkedPlatformAuthorizationStore(pools.identity).revokeToken("synthetic-grant_sibling", revokedAt),
    ).rejects.toThrow("revocation_dormant_write_closed");
    expect(await restarted.isActiveGrant("acc_a", "grant_sibling")).toBe(true);
  });

  it("revocation-floor rolls back adoption and activation if membership changes immediately before append", async () => {
    await createLinkedPlatformAuthorizationStore(pools.identity).revokeToken(
      "synthetic-grant_a",
      "2026-10-12T00:00:00.000Z",
    );
    const proof = activationProof();
    await expect(
      owner.activate(proof, deploymentContext, {
        revalidate: async () => ({ ...proof, fenceId: "changed-generation" }),
      }),
    ).rejects.toThrow("revocation_membership_changed");
    expect(await owner.isActivated()).toBe(false);
    expect((await pools.identity.query("SELECT * FROM identity_agent_grant_revocation_work")).rows).toEqual([]);
  });

  it("recovery-isolation reaches healthy item 51 after 50 poisoned histories across ticks and restart", async () => {
    await activate();
    const linked = createLinkedPlatformAuthorizationStore(pools.identity);
    const eventStore = createPostgresEventStore({ pool: pools.identity });
    for (let index = 0; index < 51; index += 1) {
      const grantId = `recovery-${String(index).padStart(3, "0")}`;
      await linked.grant({
        authorizationId: grantId,
        accountId: "acc_a",
        userId: "usr_a",
        clientId: "client_a",
        platformProfileUrl: "https://synthetic.example",
        scopes: ["dev.ucp.shopping.order:read"],
        accessTokenHash: `synthetic-${grantId}`,
        accessTokenExpiresAt: "2099-01-01T00:00:00.000Z",
        grantedAt: "2026-10-12T00:00:00.000Z",
      });
      await owner.admit(
        { ...binding, grantId, attemptId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}` },
        context,
      );
      if (index < 50)
        await eventStore.appendToStream({
          streamId: `identity.agent-grant-revocation-${createHash("sha256")
            .update(JSON.stringify(["acc_a", grantId]))
            .digest("hex")}`,
          expectedVersion: 1,
          context,
          events: [{ eventType: "identity.agent-grant-revocation.invalid", payload: {} }],
        });
    }
    const first = await owner.pending();
    expect(first).toHaveLength(50);
    expect(first.every((item) => "failure" in item)).toBe(true);
    const restarted = createAgentGrantRevocations(pools.identity, eventStore);
    const next = await restarted.pending();
    expect(next).toHaveLength(1);
    if (!("state" in next[0])) throw new Error("healthy recovery was not returned");
    const services = await paymentsModule.createServices(pools.payments, {});
    const completed = await resumeAgentGrantRevocation(
      {
        advance: restarted.advance,
        cleanup: services.payments.revokeSavedCheckoutInstrumentsForAgentGrant,
        exclude: outbox().excludeRevokedGrant,
      },
      next[0].state,
      next[0].context,
    );
    expect(completed).toMatchObject({ grantId: "recovery-050", phase: "completed" });
    expect(await restarted.pending()).toEqual([]);
  });

  it("agent-grant-revocation-concurrency-history converges token/UI and conflicts on changed Account binding", async () => {
    await activate();
    const tokenContext: EventStoreContext = {
      tenantId: "tnt_token",
      audit: { performedByUserId: "usr_identity_system", forAccountId: "acc_a" },
    };
    const tokenBinding: RevocationBinding = {
      ...binding,
      attemptId: "7d1245cd-bcaa-425c-963a-0048332db4d1",
      tenantId: tokenContext.tenantId,
      userId: tokenContext.audit.performedByUserId,
      provenance: "token",
      reason: "token_revocation",
      sessionId: "synthetic-token-digest",
    };
    const [session, token] = await Promise.all([
      owner.admit(binding, context),
      owner.admit(tokenBinding, tokenContext),
    ]);
    expect(session!.operationId).toBe(token!.operationId);
    expect(session!.revokedAt).toBe(token!.revokedAt);
    expect(session!.effectContext).toEqual(token!.effectContext);
    await expect(
      owner.admit(
        { ...binding, accountId: "acc_b", grantId: "grant_foreign" },
        {
          ...context,
          audit: { ...context.audit, forAccountId: "acc_b" as EventStoreContext["audit"]["forAccountId"] },
        },
      ),
    ).rejects.toThrow("revocation_conflict");
    expect(await owner.read({ ...binding, accountId: "acc_b", grantId: "grant_a" })).toBeNull();
    await pools.payments.query(`INSERT INTO payments_saved_checkout_instruments
      (instrument_id, account_id, agent_grant_id, payment_method_category, provider, provider_reference,
       display_label, confirmation_experience, readiness, is_default, created_at, updated_at)
      VALUES ('instrument_a', 'acc_a', 'grant_a', 'card', 'stripe', 'synthetic-provider-id',
       'Synthetic card', 'off-session-token', 'ready', true, now(), now())`);
    const services = await paymentsModule.createServices(pools.payments, {});
    const bothCleanupsEntered = deferred();
    let entered = 0;
    const cleanup = vi.fn<typeof services.payments.revokeSavedCheckoutInstrumentsForAgentGrant>(
      async (input, effectContext) => {
        if (++entered === 2) bothCleanupsEntered.resolve();
        await bothCleanupsEntered.promise;
        return services.payments.revokeSavedCheckoutInstrumentsForAgentGrant(input, effectContext);
      },
    );
    const effects = { advance: owner.advance, cleanup, exclude: outbox().excludeRevokedGrant };
    const concurrent = await Promise.allSettled([
      resumeAgentGrantRevocation(effects, session!, context),
      resumeAgentGrantRevocation(effects, token!, tokenContext),
    ]);
    expect(concurrent.some((result) => result.status === "fulfilled")).toBe(true);
    await resumeAgentGrantRevocation(effects, (await owner.read(binding))!, context);
    await resumeAgentGrantRevocation(effects, (await owner.read(tokenBinding))!, tokenContext);
    expect((await owner.read(binding))!.phase).toBe("completed");
    expect((await owner.read(tokenBinding))!.phase).toBe("completed");
    expect(
      await createLinkedPlatformAuthorizationStore(pools.identity).resolveAccessToken("synthetic-grant_a"),
    ).toBeNull();
    expect(
      (await createLinkedPlatformAuthorizationStore(pools.identity).resolveRevocationToken("synthetic-grant_a"))!
        .status,
    ).toBe("revoked");
    expect(cleanup).toHaveBeenCalledTimes(2);
    expect(
      (
        await pools.payments.query(`SELECT readiness, is_default FROM payments_saved_checkout_instruments
        WHERE instrument_id = 'instrument_a'`)
      ).rows,
    ).toEqual([{ readiness: "removed", is_default: false }]);
    expect(
      (
        await pools.payments.query(`SELECT audit_id FROM payments_saved_checkout_instrument_audit
        WHERE instrument_id = 'instrument_a' AND action = 'agent-grant-revoked'`)
      ).rows,
    ).toHaveLength(1);
    expect(
      (
        await pools.payments.query(`SELECT event_type FROM event_store_events WHERE event_type IN
        ('payments.checkout-affordances-published', 'payments.agent-grant-cleanup.completed')`)
      ).rows,
    ).toHaveLength(2);
    expect(
      (
        await pools.identity.query(`SELECT event_type FROM event_store_events
        WHERE event_type LIKE 'identity.agent-grant-revocation.%' ORDER BY global_position`)
      ).rows.map((row) => row.event_type),
    ).toEqual(
      ["admitted", "identity-terminal", "payments-terminal", "webhook-excluded", "completed"].map(
        (phase) => `identity.agent-grant-revocation.${phase}`,
      ),
    );
  });

  it.each(["token", "session"] as const)(
    "agent-grant-revocation-stage-recovery retains %s admission context through cross-caller Payments replay",
    async (firstCaller) => {
      await activate();
      const tokenContext: EventStoreContext = {
        tenantId: "tnt_token",
        audit: { performedByUserId: "usr_identity_system", forAccountId: "acc_a" },
      };
      const tokenBinding: RevocationBinding = {
        ...binding,
        attemptId: "7d1245cd-bcaa-425c-963a-0048332db4d1",
        tenantId: tokenContext.tenantId,
        userId: tokenContext.audit.performedByUserId,
        sessionId: "synthetic-token-digest",
        provenance: "token",
        reason: "token_revocation",
      };
      const [firstBinding, firstContext, nextBinding, nextContext] =
        firstCaller === "token"
          ? [tokenBinding, tokenContext, binding, context]
          : [binding, context, tokenBinding, tokenContext];
      await pools.payments.query(`INSERT INTO payments_saved_checkout_instruments
        (instrument_id, account_id, agent_grant_id, payment_method_category, provider, provider_reference,
         display_label, confirmation_experience, readiness, is_default, created_at, updated_at)
        VALUES ('instrument_a', 'acc_a', 'grant_a', 'card', 'stripe', 'synthetic-provider-id',
         'Synthetic card', 'off-session-token', 'ready', true, now(), now())`);
      const services = await paymentsModule.createServices(pools.payments, {});
      const admitted = await owner.admit(firstBinding, firstContext);
      const terminal = await owner.advance(admitted!, nextContext);
      let lost = false;
      const cleanup = vi.fn<typeof services.payments.revokeSavedCheckoutInstrumentsForAgentGrant>(
        async (input, effectContext) => {
          const result = await services.payments.revokeSavedCheckoutInstrumentsForAgentGrant(input, effectContext);
          if (!lost) {
            lost = true;
            throw new Error("synthetic_loss_after_payments_marker");
          }
          return result;
        },
      );
      const effects = { advance: owner.advance, cleanup, exclude: outbox().excludeRevokedGrant };
      await expect(resumeAgentGrantRevocation(effects, terminal, firstContext)).rejects.toThrow(
        "synthetic_loss_after_payments_marker",
      );
      const retained = await owner.admit(nextBinding, nextContext);
      const restarted = createAgentGrantRevocations(pools.identity, createPostgresEventStore({ pool: pools.identity }));
      await resumeAgentGrantRevocation({ ...effects, advance: restarted.advance }, retained!, nextContext);
      expect((await restarted.read(firstBinding))!.phase).toBe("completed");
      expect((await restarted.read(nextBinding))!.effectContext).toEqual(firstContext);
      expect(cleanup.mock.calls.map((call) => call[1])).toEqual([firstContext, firstContext]);
      const events = await pools.identity.query(
        `SELECT tenant_id, performed_by_user_id, for_account_id FROM event_store_events
         WHERE event_type LIKE 'identity.agent-grant-revocation.%' ORDER BY global_position`,
      );
      expect(events.rows).toEqual(
        Array.from({ length: 5 }, () => ({
          tenant_id: firstContext.tenantId,
          performed_by_user_id: firstContext.audit.performedByUserId,
          for_account_id: "acc_a",
        })),
      );
      const audit = await pools.payments.query(
        `SELECT performed_by_account_id FROM payments_saved_checkout_instrument_audit
         WHERE instrument_id = 'instrument_a' AND action = 'agent-grant-revoked'`,
      );
      expect(audit.rows).toEqual([{ performed_by_account_id: "acc_a" }]);
      const published = await pools.payments.query(
        `SELECT event_type, tenant_id, performed_by_user_id, for_account_id FROM event_store_events
         WHERE event_type IN ('payments.checkout-affordances-published', 'payments.agent-grant-cleanup.completed')`,
      );
      expect(published.rows).toHaveLength(2);
      expect(published.rows.every((row) => row.tenant_id === firstContext.tenantId)).toBe(true);
      expect(published.rows.every((row) => row.performed_by_user_id === firstContext.audit.performedByUserId)).toBe(
        true,
      );
      expect(published.rows.every((row) => row.for_account_id === "acc_a")).toBe(true);
    },
  );

  it("agent-grant-revocation-payments-cleanup restarts after local removal and recovers durable audit/default/affordance without provider calls", async () => {
    await activate();
    await pools.payments
      .query(`INSERT INTO payments_saved_checkout_instruments (instrument_id, account_id, agent_grant_id,
      payment_method_category, provider, provider_reference, display_label, confirmation_experience, readiness, is_default, created_at, updated_at)
      VALUES ('instrument_a', 'acc_a', 'grant_a', 'card', 'stripe', 'synthetic-provider-id', 'Synthetic card', 'off-session-token', 'ready', true, now(), now())`);
    const services = await paymentsModule.createServices(pools.payments, {});
    const state = await owner.admit(binding, context);
    const terminal = await owner.advance(state!, context);
    const foreignRemovedAt = "2020-01-01T00:00:00.000Z";
    await pools.payments.query(
      `INSERT INTO payments_saved_checkout_instruments (instrument_id, account_id, agent_grant_id,
       payment_method_category, provider, provider_reference, display_label, confirmation_experience,
       readiness, is_default, removed_at, created_at, updated_at)
       VALUES ('instrument_foreign', 'acc_a', 'grant_a', 'card', 'stripe', 'synthetic-foreign-provider-id',
       'Synthetic previously removed card', 'off-session-token', 'removed', false, $1, $1, $1)`,
      [foreignRemovedAt],
    );
    await pools.payments.query(
      `UPDATE payments_saved_checkout_instruments SET readiness = 'removed', is_default = false, removed_at = $1 WHERE instrument_id = 'instrument_a'`,
      [terminal.revokedAt],
    );
    await resumeAgentGrantRevocation(
      {
        advance: owner.advance,
        cleanup: services.payments.revokeSavedCheckoutInstrumentsForAgentGrant,
        exclude: outbox().excludeRevokedGrant,
      },
      terminal,
      context,
    );
    const replay = await services.payments.revokeSavedCheckoutInstrumentsForAgentGrant(
      {
        accountId: "acc_a" as EventStoreContext["audit"]["forAccountId"],
        agentGrantId: "grant_a",
        revokedAt: terminal.revokedAt,
        operationId: terminal.operationId,
      },
      context,
    );
    expect(replay.detached).toBe(0);
    expect(replay.instrumentIds).toEqual([]);
    const foreign = (
      await pools.payments.query<{ removed_at: Date; updated_at: Date; is_default: boolean }>(
        `SELECT removed_at, updated_at, is_default FROM payments_saved_checkout_instruments WHERE instrument_id = 'instrument_foreign'`,
      )
    ).rows[0];
    expect(foreign.removed_at.toISOString()).toBe(foreignRemovedAt);
    expect(foreign.updated_at.toISOString()).toBe(foreignRemovedAt);
    expect(foreign.is_default).toBe(false);
    expect(
      (
        await pools.payments.query(
          `SELECT count(*) AS count FROM payments_saved_checkout_instrument_audit WHERE instrument_id = 'instrument_foreign'`,
        )
      ).rows[0].count,
    ).toBe("0");
    expect(
      (
        await pools.payments.query(
          `SELECT readiness, is_default FROM payments_saved_checkout_instruments WHERE instrument_id = 'instrument_a'`,
        )
      ).rows[0],
    ).toMatchObject({ readiness: "removed", is_default: false });
    expect(
      (
        await pools.payments.query(
          `SELECT count(*) AS count FROM payments_saved_checkout_instrument_audit WHERE instrument_id = 'instrument_a' AND action = 'agent-grant-revoked'`,
        )
      ).rows[0].count,
    ).toBe("1");
    expect(
      (
        await pools.payments.query(
          `SELECT count(*) AS count FROM event_store_events WHERE event_type = 'payments.checkout-affordances-published' AND stream_id = 'payments.checkout-affordances-acc_a'`,
        )
      ).rows[0].count,
    ).toBe("1");
  });

  it("agent-grant-revocation-downstream-fence interleaves Identity terminal with separate Auth enqueue/send barriers", async () => {
    await activate();
    const admitted = await owner.admit(binding, context);
    const entered = deferred();
    const release = deferred();
    const enqueue = createActiveAgentGrantFence(pools.identity)("acc_a", "client_a", ["grant_a"], async () => {
      entered.resolve();
      await release.promise;
      await pools.auth.query(`SELECT 1`);
      return true;
    });
    await entered.promise;
    const terminalStarted = deferred();
    const observedPool: PgTransactionalPool = {
      query: pools.identity.query.bind(pools.identity),
      connect: async () => {
        const client = await pools.identity.connect();
        return {
          query: async <Row>(sql: string, values?: readonly unknown[]) => {
            if (sql.includes("FOR UPDATE")) terminalStarted.resolve();
            return client.query<Row>(sql, values);
          },
          release: (error) => client.release(error),
        };
      },
    };
    const observedOwner = createAgentGrantRevocations(observedPool, createPostgresEventStore({ pool: pools.identity }));
    let terminalDone = false;
    const terminal = observedOwner.advance(admitted!, context).then((result) => {
      terminalDone = true;
      return result;
    });
    await terminalStarted.promise;
    expect(terminalDone).toBe(false);
    release.resolve();
    await enqueue;
    await terminal;
    const box = outbox();
    await box.enqueueDelivery(delivery(["grant_a"], "stale-enqueue"));
    expect(await box.listForClient("client_a")).toEqual([]);
    await box.enqueueDelivery(delivery(["grant_sibling"], "shared"));
    // Replay must not add a later Grant to the immutable accepted row.
    await box.enqueueDelivery(delivery(["grant_foreign"], "shared"));
    const send = vi.fn(async () => ({ status: 200 }));
    await createAgentWebhookDispatcher({
      outbox: box,
      withActiveGrants: owner.withActiveGrants,
      resolveSigningSecret: async () => "synthetic-secret",
      send,
      claimOwnerId: "worker_a",
    }).runOnce();
    expect(send).toHaveBeenCalledTimes(1);
    expect(
      (await pools.auth.query(`SELECT grant_ids FROM identity_agent_webhook_deliveries WHERE delivery_id = 'shared'`))
        .rows[0].grant_ids,
    ).toEqual(["grant_sibling"]);
    expect(await owner.withActiveGrants("acc_a", "client_a", ["grant_foreign"], async () => true)).toBeNull();
  });

  it("agent-grant-revocation-downstream-fence rejects legacy/later Grant and stranded sending rows without resending", async () => {
    const box = outbox();
    await box.enqueueDelivery(delivery(["grant_a"], "legacy"));
    await pools.auth.query(
      `UPDATE identity_agent_webhook_deliveries SET grant_ids = NULL WHERE delivery_id = 'legacy'`,
    );
    await box.enqueueDelivery(delivery(["grant_sibling"], "stranded"));
    await box.enqueueDelivery(delivery(["grant_a"], "active-stranded"));
    await createLinkedPlatformAuthorizationStore(pools.identity).revokeAuthorization({
      authorizationId: "grant_sibling",
      accountId: "acc_a",
      revokedAt: new Date().toISOString(),
    });
    await pools.auth.query(
      `UPDATE identity_agent_webhook_deliveries SET status = 'sending', attempt_count = 1, claimed_until = now() - interval '1 hour' WHERE delivery_id IN ('stranded', 'active-stranded')`,
    );
    const send = vi.fn(async () => ({ status: 200 }));
    await createAgentWebhookDispatcher({
      outbox: box,
      withActiveGrants: owner.withActiveGrants,
      resolveSigningSecret: async () => "synthetic-secret",
      send,
      claimOwnerId: "worker_a",
    }).runOnce();
    expect(send).toHaveBeenCalledTimes(1);
    const rows = (
      await pools.auth.query(
        `SELECT delivery_id, status, last_error FROM identity_agent_webhook_deliveries ORDER BY delivery_id`,
      )
    ).rows;
    expect(rows).toEqual([
      { delivery_id: "active-stranded", status: "sent", last_error: null },
      { delivery_id: "legacy", status: "failed", last_error: "agent_grant_revoked" },
      { delivery_id: "stranded", status: "failed", last_error: "agent_grant_revoked" },
    ]);
  });

  it("agent-grant-revocation-downstream-fence revokes after claim but before send, without trusting a sibling or later Grant", async () => {
    await activate();
    const box = outbox();
    await box.enqueueDelivery(delivery(["grant_a"], "claimed-before-revoke"));
    const signing = deferred();
    const release = deferred();
    const send = vi.fn(async () => ({ status: 200 }));
    const run = createAgentWebhookDispatcher({
      outbox: box,
      withActiveGrants: owner.withActiveGrants,
      resolveSigningSecret: async () => {
        signing.resolve();
        await release.promise;
        return "synthetic-secret";
      },
      send,
      claimOwnerId: "worker_a",
    }).runOnce();
    await signing.promise;
    const admitted = await owner.admit(binding, context);
    await owner.advance(admitted!, context);
    release.resolve();
    await run;
    expect(send).not.toHaveBeenCalled();
    expect(
      (
        await pools.auth.query(
          `SELECT status, last_error FROM identity_agent_webhook_deliveries WHERE delivery_id = 'claimed-before-revoke'`,
        )
      ).rows[0],
    ).toEqual({ status: "failed", last_error: "agent_grant_revoked" });
  });

  it("agent-grant-revocation-downstream-fence allows only the original in-flight settlement after terminal and loss", async () => {
    await activate();
    const box = outbox();
    await box.enqueueDelivery(delivery(["grant_a"], "in-flight"));
    const entered = deferred();
    const release = deferred();
    const send = vi.fn(async () => {
      entered.resolve();
      await release.promise;
      throw new Error("synthetic-transport-loss");
    });
    const dispatcher = createAgentWebhookDispatcher({
      outbox: box,
      withActiveGrants: owner.withActiveGrants,
      resolveSigningSecret: async () => "synthetic-secret",
      send,
      claimOwnerId: "worker_a",
    });
    const run = dispatcher.runOnce();
    await entered.promise;
    const admitted = await owner.admit(binding, context);
    await owner.advance(admitted!, context);
    release.resolve();
    await run;
    await dispatcher.runOnce();
    expect(send).toHaveBeenCalledTimes(1);
    expect(
      (
        await pools.auth.query(
          `SELECT status, last_error FROM identity_agent_webhook_deliveries WHERE delivery_id = 'in-flight'`,
        )
      ).rows[0],
    ).toEqual({ status: "failed", last_error: "delivery_outcome_unknown" });
  });
});
