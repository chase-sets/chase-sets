import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { BcApiModule } from "@chase-sets/bounded-context-module";
import {
  attachReadConsistencyMiddleware,
  attachWriteConsistencyMiddleware,
  bootstrapContextDatabase,
  createProjectionAwarePool,
  resolveModuleProjectionGroups,
  resolveModuleSubscriptions,
  syncContextProjectionGroups,
  type MountedContextRuntimeEntry,
  type ReadConsistencyAuditRecord,
} from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import {
  CHASE_SETS_COMMIT_RECEIPT_HEADER,
  CHASE_SETS_READ_AFTER_WRITE_HEADER,
  decodeCommitReceipt,
  encodeFreshWriteReceipt,
} from "@chase-sets/http/responses";
import type { ResolvedActor } from "@chase-sets/platform-runtime/auth";
import {
  bootstrapPlatformControlPlane,
  createPostgresPlatformControlPlane,
} from "@chase-sets/platform-runtime/control-plane";
import { createProjectionWakeSchedulerRunners } from "@chase-sets/platform-runtime/projection-wake-scheduler";
import { createPostgresWorkSignalStore } from "@chase-sets/platform-runtime/work-signal-store";
import {
  createProjectionGroupRunnerLeaseName,
  createProjectionGroupWorkerRunner,
  createWorkerRunnerLoop,
  tryRunWithRenewedLease,
} from "@chase-sets/platform-runtime/worker";
import { parseTypedId } from "@chase-sets/primitives/typed-ids";
import { module as identityModule } from "..";
import { buildIdentityApi, type IdentityApiEnv } from "../api";
import { DENY_ALL_CAPABILITY_ADMINISTRATION_AUTHORITY } from "../features/account-capabilities/api/authority";
import { createIdentityServices } from "../support/runtime-support/services";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL is required for the Identity receipted hub read proof in CI.");
}
const describeDb = databaseBaseUrl ? describe : describe.skip;

const contextNames = ["identity", "marketplace", "control"] as const;
const actor: ResolvedActor = {
  tenantId: parseTypedId("tnt_receipthub", "tnt"),
  userId: parseTypedId("usr_receipthubowner", "usr"),
  accountId: parseTypedId("acc_receipthub", "acc"),
  membershipId: parseTypedId("mbr_receipthubowner", "mbr"),
  sessionId: parseTypedId("ses_receipthubowner", "ses"),
  roleKey: "owner",
  permissions: ["accounts.view", "memberships.view", "memberships.manage", "security.manage"],
};
const context: EventStoreContext = {
  tenantId: parseTypedId(actor.tenantId, "tnt"),
  audit: { performedByUserId: parseTypedId(actor.userId, "usr"), forAccountId: parseTypedId(actor.accountId, "acc") },
};
const invitationId = "ivt_receipthubinvite";
const marketplaceModule: BcApiModule<Record<string, never>, PgTransactionalPool, Record<string, never>> = {
  contextName: "marketplace",
  routePrefix: "/api/marketplace",
  streamPrefix: "marketplace.",
  schemaSql: "",
  apiMounts: [],
  createServices: () => ({}),
  buildApis: () => [],
};

// Three ways a receipted access workspace read can meet an Identity write:
// polling-only is the composition with no wake gateway, which reproduces the
// timeout; the two wake-before-wait cases are the API default, once with the
// write already applied by an ordinary worker pass (only projections the write
// did not touch are behind) and once before any worker has run (the write's own
// projection is behind too).
const variants = [
  { name: "polling-only, write applied", wakeBeforeWait: false, drainAfterWrite: true },
  { name: "wake-before-wait, write applied", wakeBeforeWait: true, drainAfterWrite: true },
  { name: "wake-before-wait, write not yet applied", wakeBeforeWait: true, drainAfterWrite: false },
] as const;

describeDb("Identity receipted access workspace read", () => {
  let pools: Readonly<Record<(typeof contextNames)[number], PgTransactionalPool>>;

  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, contextNames, "identity_receipt_hub_read");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await bootstrapPlatformControlPlane(pools.control);
    await bootstrapContextDatabase(identityModule, pools.identity);
    await bootstrapContextDatabase(marketplaceModule, pools.marketplace);
  });

  afterAll(async () => {
    if (pools) await closeMultiContextTestPools(pools);
  });

  it.each(variants)("$name", async ({ name, wakeBeforeWait, drainAfterWrite }) => {
    const trace: Array<{ kind: string; elapsedMs: number; event: unknown }> = [];
    const startedAt = performance.now();
    const record = (kind: string, event: unknown) => {
      trace.push({ kind, elapsedMs: performance.now() - startedAt, event });
    };
    const services = createIdentityServices(createProjectionAwarePool(pools.identity), {
      capabilityAdministrationAuthority: DENY_ALL_CAPABILITY_ADMINISTRATION_AUTHORITY,
    });
    const mountedContexts: readonly MountedContextRuntimeEntry[] = [
      {
        contextName: "marketplace",
        module: marketplaceModule,
        pool: pools.marketplace,
        services: {},
        projectionHandlerSets: [],
        mountRole: "source-only",
      },
      {
        contextName: "identity",
        module: identityModule,
        pool: pools.identity,
        services,
        projectionHandlerSets: identityModule.projectionHandlerSets?.(services) ?? [],
      },
    ];
    const subscriptions = resolveModuleSubscriptions(mountedContexts);
    const projectionGroups = resolveModuleProjectionGroups(mountedContexts, subscriptions);
    await syncContextProjectionGroups({ mountedContexts, projectionGroups }, "identity");
    const controlPlane = createPostgresPlatformControlPlane(pools.control);
    const workers = projectionGroups.map((group) => ({ group, runner: createProjectionGroupWorkerRunner(group) }));

    // An ordinary leased worker pass to applicable-work quiescence, without
    // idle settlement: projections with no applicable event stay where they were.
    const ordinaryDrain = async () => {
      let processed: number;
      do {
        processed = 0;
        for (const { group, runner } of workers) {
          const outcome = await tryRunWithRenewedLease(
            controlPlane,
            {
              leaseName: createProjectionGroupRunnerLeaseName(group),
              ownerId: "receipt-hub-ordinary-worker",
              ttlMs: 30_000,
              renewIntervalMs: 10_000,
            },
            async (runContext) => runner.runOnce(runContext),
          );
          if (!outcome.acquired) throw new Error(`Fixture worker could not acquire ${runner.name}.`);
          processed += outcome.result.processed;
        }
      } while (processed > 0);
    };
    const seed = (streamId: string, eventType: string, payload: Record<string, unknown>) =>
      services.eventStore!.appendToStream({
        streamId,
        expectedVersion: "no_stream",
        context,
        events: [{ eventType, payload: payload as never }],
      });
    await seed(`identity.account-${actor.accountId}`, "identity.account.created", {
      accountId: actor.accountId,
      name: "Receipt Hub LLC",
      displayName: "Receipt Hub",
      accountType: "business",
    });
    await seed(`identity.user-${actor.userId}`, "identity.user.created", {
      userId: actor.userId,
      displayName: "Receipt Owner",
      givenName: "Receipt",
      familyName: "Owner",
      primaryEmail: "receipt-owner@example.test",
    });
    await seed(`identity.membership-${actor.membershipId}`, "identity.membership.granted", {
      membershipId: actor.membershipId,
      userId: actor.userId,
      accountId: actor.accountId,
      roleKey: "owner",
    });
    await ordinaryDrain();

    const signals = createPostgresWorkSignalStore(pools.control, {
      ...(wakeBeforeWait ? { readConsistencyGateway: {} } : {}),
      observer: {
        projectionWakeIntentEnqueued: (event) => {
          record("enqueued", event);
          wakeLoop.nudge();
        },
      },
    });
    const wakeLoop = createWorkerRunnerLoop({
      workerId: "receipt-hub-wake",
      controlPlane,
      runners: createProjectionWakeSchedulerRunners({
        workerId: "receipt-hub-wake",
        controlPlane,
        workSignalStore: signals,
        projectionGroups,
        observer: {
          wakeIntentClaimed: (event) => record("claimed", event),
          wakeIntentCompleted: (event) => record("completed", event),
          wakeIntentNotReady: (event) => record("not-ready", event),
          wakeIntentDeferred: (event) => record("deferred", event),
          wakeIntentUnknownTarget: (event) => record("unknown-target", event),
          wakeIntentRunFailed: (event) => record("run-failed", { ...event, error: String(event.error) }),
          wakeIntentClaimLost: (event) => record("claim-lost", event),
        },
      }),
      maxConcurrentRunners: 2,
      leaseTtlMs: 30_000,
      leaseRenewIntervalMs: 10_000,
      pollIntervalMs: 1_000,
      observer: { runnerFailed: (event) => record("worker-failed", { ...event, error: String(event.error) }) },
    });
    const mounts = identityModule.apiMounts.map((mount) => ({ ...mount, contextName: "identity" }));
    const audits: ReadConsistencyAuditRecord[] = [];
    const app = new Hono<IdentityApiEnv>();
    app.use("/api/identity/*", async (c, next) => {
      c.set("actor", actor);
      c.set("context", context);
      await next();
    });
    attachWriteConsistencyMiddleware(app, mounts, projectionGroups, { enabled: false });
    attachReadConsistencyMiddleware(app, mounts, projectionGroups, {
      ...(wakeBeforeWait ? { workSignalGateway: signals.readConsistencyGateway } : {}),
      recordReadConsistencyAudit: (audit) => audits.push(audit),
    });
    app.use("/api/identity/*", async (c, next) => {
      await next();
      if (drainAfterWrite && c.req.method === "POST" && c.res.status < 400) await ordinaryDrain();
    });
    app.route("/api/identity", buildIdentityApi(services));
    const checkpoints = async () =>
      (
        await pools.identity.query<{ checkpoint_key: string; last_global_position: string }>(
          "SELECT checkpoint_key, last_global_position::text FROM event_subscription_checkpoints ORDER BY checkpoint_key",
        )
      ).rows;

    wakeLoop.start();
    try {
      const invite = await app.request("/api/identity/invitations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          invitationId,
          accountId: actor.accountId,
          email: "receipt-invitee@example.test",
          roleKey: "viewer",
          expiresAt: "2099-01-01T00:00:00Z",
        }),
      });
      expect(invite.status, await invite.clone().text()).toBe(201);
      const sources = decodeCommitReceipt(invite.headers.get(CHASE_SETS_COMMIT_RECEIPT_HEADER));
      expect(sources).toEqual([expect.objectContaining({ sourceContextName: "identity" })]);
      const token = encodeFreshWriteReceipt({ observedAtMs: Date.now(), sources });
      const beforeRead = await checkpoints();
      const hubPath = `/api/identity/access-hub/accounts/${actor.accountId}`;
      const read = async (receipted: boolean) => {
        const readStartedAt = performance.now();
        const response = await app.request(
          hubPath,
          receipted ? { headers: { [CHASE_SETS_READ_AFTER_WRITE_HEADER]: token } } : {},
        );
        return { status: response.status, elapsedMs: performance.now() - readStartedAt, body: await response.json() };
      };
      const hub = await read(true);
      const afterRead = await checkpoints();
      const nextHub = wakeBeforeWait ? await read(true) : null;
      const intents = await pools.control.query(
        `SELECT target_context_name, projection_name, required_position::text, state, attempt_count, last_error
         FROM platform_projection_wake_intents ORDER BY created_at, wake_intent_id`,
      );
      console.info(
        JSON.stringify({
          proof: "identity-receipt-hub-read",
          variant: name,
          sources,
          hub: { status: hub.status, elapsedMs: hub.elapsedMs, body: hub.body },
          nextHub,
          beforeRead,
          afterRead,
          audits,
          intents: intents.rows,
          trace,
        }),
      );

      const pendingProjections = (body: unknown) =>
        ((body as { error?: { pending?: Array<{ projectionName: string }> } }).error?.pending ?? []).map(
          (pending) => pending.projectionName,
        );
      if (!wakeBeforeWait) {
        // The reproduction: the write is applied, yet the read waits out its
        // budget on projections the invitation did not change.
        expect(hub.status).toBe(503);
        expect(hub.body).toMatchObject({ error: { code: "projection_freshness_timeout" } });
        expect(pendingProjections(hub.body).length).toBeGreaterThan(0);
        expect(pendingProjections(hub.body)).not.toContain("identity-invitation-projection");
        return;
      }

      expect(hub.status, JSON.stringify(hub.body)).toBe(200);
      expect(hub.elapsedMs).toBeLessThan(2_500);
      expect(hub.body).toMatchObject({
        account: expect.objectContaining({ account_id: actor.accountId }),
        invitations: [expect.objectContaining({ invitation_id: invitationId, status: "pending" })],
      });
      const receiptAudits = audits.filter((audit) => audit.readAfterWriteHeaderPresent);
      expect(receiptAudits[0]).toMatchObject({ outcome: "fresh" });
      expect(receiptAudits[0]!.wakeRequestCount).toBeGreaterThan(0);
      expect(trace.some((entry) => entry.kind === "completed")).toBe(true);
      expect(intents.rows.every((intent) => intent.last_error === null)).toBe(true);
      const identityPosition = BigInt(sources[0]!.maxGlobalPosition);
      for (const dependency of receiptAudits[0]!.dependencies) {
        const group = projectionGroups.find((candidate) => candidate.projectionName === dependency.projectionName);
        for (const runner of group?.subscriptionRunners ?? []) {
          if (runner.sourceContextName !== "identity") continue;
          const checkpoint = afterRead.find((row) => row.checkpoint_key === runner.checkpointKey);
          expect(checkpoint, runner.checkpointKey).toBeDefined();
          expect(BigInt(checkpoint!.last_global_position)).toBeGreaterThanOrEqual(identityPosition);
        }
      }
      // Once caught up, the same receipt reads without another wake.
      expect(nextHub).toMatchObject({ status: 200 });
      expect(nextHub!.elapsedMs).toBeLessThan(2_500);
      expect(receiptAudits[1]).toMatchObject({ outcome: "fresh", wakeRequestCount: 0 });
    } finally {
      await wakeLoop.stop();
    }
  });
});
