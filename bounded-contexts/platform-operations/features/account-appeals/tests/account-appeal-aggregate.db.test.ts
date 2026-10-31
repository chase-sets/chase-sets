import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildTransportEvent } from "@chase-sets/event-core/test-support";
import type { ProjectorHandler, ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { TransportEvent } from "@chase-sets/event-core/transport";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { createPostgresEventStore } from "@chase-sets/event-core-postgres";
import {
  bootstrapContextDatabase,
  drainContextRuntime,
  resetProjectionGroup,
  syncContextProjectionGroups,
} from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMountedContextTestRuntime,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { identitySeedIds } from "@chase-sets/identity-seed";
import {
  createId,
  type AccountId,
  type EnforcementActionId,
  type ListingEnforcementActionId,
  type TenantId,
  type UserId,
} from "@chase-sets/primitives/typed-ids";
import { module as platformOperationsModule } from "../../../index";
import {
  ACCOUNT_APPEAL_PROJECTION_EVENT_TYPES,
  ACCOUNT_APPEAL_PROJECTION_NAME,
  ACCOUNT_APPEAL_OPERATOR_HISTORY_COLUMNS,
  ACCOUNT_APPEAL_SELLER_HISTORY_COLUMNS,
  APPEALABLE_ACTION_INDETERMINATE,
  buildAccountAppealProjectionHandlers,
  readAppealableEnforcementAction,
} from "../read-model/projection";
import { accountAppealSchemaMigrations } from "../read-model/schema";
import { createAccountAppealRuntime } from "../api/runtime";
import { withAccountAppealOperatorAccess, withAccountAppealSellerAccess } from "../api/access";
import { appealStreamId } from "../domain/domain";

// phantom-SQL rule: exercised against a real Postgres sandbox (TEST_DATABASE_URL), never mocked.
const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
}
const describeDb = databaseBaseUrl ? describe : describe.skip;
const contextNames = ["platform-operations"] as const;
const OCCURRED_AT = "2026-10-21T00:00:00.000Z";

type Delivery = Readonly<{ type: string; streamId: string; streamVersion: number; data: Record<string, unknown> }>;

type RuntimeAppealFixture = Readonly<{
  actionId: EnforcementActionId;
  appealId: string;
  streamId: string;
  eventStore: ReturnType<typeof createPostgresEventStore>;
  tenantId: TenantId;
  ownerAccountId: AccountId;
  sellerUserId: UserId;
  operatorUserId: UserId;
}>;

type ConcurrentFilingDiagnostic = Readonly<{
  call: "first" | "second";
  phase: "load-rendezvous" | "transaction-begin" | "stream-guard" | "event-insert" | "commit" | "rollback";
  backendPid?: number;
  transactionId?: string;
  streamId?: string;
  observedVersion?: number;
  insertedRows?: number | null;
}>;

type ConcurrentFilingCall = ConcurrentFilingDiagnostic["call"];

function createConcurrentFilingRendezvous(diagnostics: ConcurrentFilingDiagnostic[]) {
  const arrivals = new Set<ConcurrentFilingCall>();
  const createDeferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((resolvePromise) => {
      resolve = () => resolvePromise();
    });
    return { promise, resolve };
  };
  let releaseBoth: (() => void) | undefined;
  const bothArrived = new Promise<void>((resolve) => {
    releaseBoth = resolve;
  });
  const settled = {
    first: createDeferred(),
    second: createDeferred(),
  } satisfies Record<ConcurrentFilingCall, ReturnType<typeof createDeferred>>;

  return {
    arrive(call: ConcurrentFilingCall): Promise<void> {
      arrivals.add(call);
      diagnostics.push({ call, phase: "load-rendezvous" });
      if (arrivals.size === 2) releaseBoth?.();
      const otherCall: ConcurrentFilingCall = call === "first" ? "second" : "first";
      return Promise.race([bothArrived, settled[otherCall].promise]);
    },
    settle(call: ConcurrentFilingCall): void {
      settled[call].resolve();
    },
  };
}

/**
 * Keep the concurrent proof on the real event-store transaction path while
 * recording the facts needed to distinguish a stale read, a loser rollback,
 * and two committed inserts. The wrapper is test-only and delegates every
 * query to the production pool/client.
 */
function instrumentConcurrentFilingPool(
  pool: PgTransactionalPool,
  call: ConcurrentFilingDiagnostic["call"],
  diagnostics: ConcurrentFilingDiagnostic[],
  rendezvous: ReturnType<typeof createConcurrentFilingRendezvous>,
): PgTransactionalPool {
  return {
    query: pool.query.bind(pool),
    idleInTransactionSessionTimeoutMillis: pool.idleInTransactionSessionTimeoutMillis,
    connect: async () => {
      await rendezvous.arrive(call);
      const client = await pool.connect();
      const instrumentedClient = {
        query: async (text: string, values?: readonly unknown[]) => {
          const normalized = text.trim().toLowerCase();
          const result = await client.query(text, values);
          // These diagnostic phases intentionally follow the event-store SQL text; a storage refactor must update this proof.
          if (normalized === "begin") {
            const identity = await client.query<{ pid: number; transaction_id: string }>(
              "SELECT pg_backend_pid() AS pid, txid_current()::text AS transaction_id",
            );
            const row = identity.rows[0];
            diagnostics.push({
              call,
              phase: "transaction-begin",
              backendPid: row?.pid,
              transactionId: row?.transaction_id,
            });
          } else if (normalized.includes("from event_store_streams") && normalized.includes("for update")) {
            diagnostics.push({
              call,
              phase: "stream-guard",
              streamId: typeof values?.[0] === "string" ? values[0] : undefined,
              observedVersion: Number(result.rows[0]?.current_version),
            });
          } else if (normalized.startsWith("insert into event_store_events")) {
            diagnostics.push({ call, phase: "event-insert", insertedRows: result.rowCount });
          } else if (normalized === "commit") {
            diagnostics.push({ call, phase: "commit" });
          } else if (normalized === "rollback") {
            diagnostics.push({ call, phase: "rollback" });
          }
          return result;
        },
        release: (error?: unknown) => client.release(error),
      } as Awaited<ReturnType<PgTransactionalPool["connect"]>>;
      return instrumentedClient;
    },
  };
}

function concurrentFilingDiagnosticsMessage(
  diagnostics: readonly ConcurrentFilingDiagnostic[],
  race: readonly PromiseSettledResult<unknown>[],
): string {
  const outcomes = race.map((entry, index) => {
    if (entry.status === "fulfilled") return { call: index === 0 ? "first" : "second", status: entry.status };
    const reason = entry.reason as { code?: unknown; message?: unknown };
    return {
      call: index === 0 ? "first" : "second",
      status: entry.status,
      error: {
        message: reason && typeof reason.message === "string" ? reason.message : String(entry.reason),
        ...(reason && typeof reason.code === "string" ? { code: reason.code } : {}),
      },
    };
  });
  return JSON.stringify({ diagnostics, outcomes });
}

function identityEnforcement(
  type: "identity.account.suspended" | "identity.account.reactivated" | "identity.account.closed",
  owner: string,
  enforcementActionId: string,
  streamVersion = 2,
): Delivery {
  const reversal = type === "identity.account.reactivated";
  return {
    type,
    streamId: `identity.account-${owner}`,
    streamVersion,
    data: {
      enforcement: {
        version: 1,
        enforcementActionId,
        reason: reversal ? "appeal-upheld" : "policy-violation",
        reference: reversal ? { kind: "support-request", supportRequestId: createId("sup") } : null,
      },
    },
  };
}

function listingEnforcementRecord(
  listingEnforcementActionId: string,
  owner: string,
  source: "operator-unlist" | "automatic-report-threshold",
  sourceActionId: string,
) {
  return { version: 1, listingEnforcementActionId, accountId: owner, source, sourceActionId, occurredAt: OCCURRED_AT };
}

function operatorUnlisted(owner: string, listingEnforcementActionId: string, streamVersion = 3): Delivery {
  return {
    type: "marketplace.listing.operator-unlisted",
    streamId: `marketplace.listing-${createId("lst")}`,
    streamVersion,
    data: {
      listingEnforcement: listingEnforcementRecord(
        listingEnforcementActionId,
        owner,
        "operator-unlist",
        createId("rca"),
      ),
    },
  };
}

function autoUnlisted(owner: string, listingEnforcementActionId: string | null, streamVersion = 4): Delivery {
  const reportId = createId("rpt");
  const report = { reportId, reportCount: 3, threshold: 3, autoUnlistedAt: OCCURRED_AT };
  return {
    type: "marketplace.listing.auto-unlisted",
    streamId: `marketplace.listing-${createId("lst")}`,
    streamVersion,
    data:
      listingEnforcementActionId === null
        ? report
        : {
            ...report,
            listingEnforcement: listingEnforcementRecord(
              listingEnforcementActionId,
              owner,
              "automatic-report-threshold",
              reportId,
            ),
          },
  };
}

/** The audit actor is deliberately a different account, so a caller-owned attribution mutant is visible. */
function toEvent(delivery: Delivery, auditAccountId: string = createId("acc")): TransportEvent {
  return buildTransportEvent(delivery.type, delivery.data, {
    id: createId("evt"),
    streamId: delivery.streamId,
    streamVersion: delivery.streamVersion,
    audit: { performedByUserId: createId("usr"), forAccountId: auditAccountId as AccountId },
    timing: { occurredAt: OCCURRED_AT, recordedAt: OCCURRED_AT },
  });
}

describeDb("account appeal aggregate DB proof", () => {
  let pools: Readonly<Record<(typeof contextNames)[number], PgTransactionalPool>>;
  let pool: PgTransactionalPool;

  /**
   * Handlers come from the production manifest registration, so these cases drive
   * `buildAccountAppealInterestProjectionHandlers` exactly as the worker composes it.
   */
  function registeredHandlers(): ProjectorHandlerMap {
    const services = platformOperationsModule.createServices(pool, {});
    const subscriptions = (platformOperationsModule.buildSubscriptions?.(services) ?? []).filter(
      (subscription) => subscription.projectionName === "account-appeal-interest-projection",
    );
    expect(subscriptions.map((subscription) => subscription.sourceContextName).sort()).toEqual([
      "identity",
      "marketplace",
    ]);
    return Object.assign({}, ...subscriptions.map((subscription) => subscription.handlers)) as ProjectorHandlerMap;
  }

  function appealProjectionHandlers(): ProjectorHandlerMap {
    return buildAccountAppealProjectionHandlers(pool);
  }

  async function bootProjectionRuntime() {
    await bootstrapContextDatabase(platformOperationsModule, pool);
    const accountAppealModule = {
      ...platformOperationsModule,
      eventSubscriptions: platformOperationsModule.eventSubscriptions!.filter(
        ({ projectionName, sourceContextName }) =>
          projectionName === ACCOUNT_APPEAL_PROJECTION_NAME && sourceContextName === "platform-operations",
      ),
      eventReactions: [],
      projectionHandlerSets: (
        services: Parameters<NonNullable<typeof platformOperationsModule.projectionHandlerSets>>[0],
      ) =>
        platformOperationsModule.projectionHandlerSets!(services).filter(
          (set) => set.projectionName === ACCOUNT_APPEAL_PROJECTION_NAME,
        ),
      buildSubscriptions: (services: Parameters<NonNullable<typeof platformOperationsModule.buildSubscriptions>>[0]) =>
        platformOperationsModule.buildSubscriptions!(services).filter(
          ({ projectionName, sourceContextName }) =>
            projectionName === ACCOUNT_APPEAL_PROJECTION_NAME && sourceContextName === "platform-operations",
        ),
      projectionGroups: platformOperationsModule.projectionGroups?.filter(
        ({ projectionName }) => projectionName === ACCOUNT_APPEAL_PROJECTION_NAME,
      ),
    };
    const runtime = createMountedContextTestRuntime([
      { contextName: "platform-operations", module: accountAppealModule, pool, ports: {} },
    ]);
    await syncContextProjectionGroups(runtime, "platform-operations", { requiredOnly: true });
    return runtime;
  }

  async function appendRuntimeAppeal(
    terminal: "withdrawn" | "upheld" | "reversed" | "modified",
    source: "identity.account.reactivated" | "identity.account.closed" = "identity.account.closed",
    reviewBeforeWithdraw = false,
  ): Promise<RuntimeAppealFixture> {
    const ownerAccountId = createId("acc");
    const actionId = createId("enf");
    const tenantId = createId("tnt");
    const sellerUserId = createId("usr");
    const operatorUserId = createId("usr");
    await deliver(identityEnforcement(source, ownerAccountId, actionId));

    const eventStore = createPostgresEventStore({ pool });
    const appealRuntime = createAccountAppealRuntime(pool, eventStore);
    const seller = {
      tenantId,
      accountId: ownerAccountId,
      userId: sellerUserId,
      permissions: ["account-appeals.file"],
    } as const;
    const operator = {
      tenantId,
      userId: operatorUserId,
      roleKey: "trust-operator",
      permissions: ["account-appeals.review"],
    } as const;
    const context = {
      tenantId,
      audit: { performedByUserId: sellerUserId, forAccountId: ownerAccountId },
    } as const;
    const resolved = await withAccountAppealSellerAccess(seller, "account-appeals.file", async (capability) =>
      appealRuntime.resolve(capability, actionId as EnforcementActionId),
    );
    if (resolved.status !== "resolved") throw new Error("Synthetic appeal action must resolve.");
    const action = resolved.action;
    await withAccountAppealSellerAccess(seller, "account-appeals.file", async (capability) => {
      await appealRuntime.file(capability, action, { statement: "The closure was mistaken" }, context);
    });

    if (terminal === "withdrawn") {
      if (reviewBeforeWithdraw) {
        await withAccountAppealOperatorAccess(operator, "account-appeals.review", async (capability) => {
          const operatorContext = {
            tenantId,
            audit: { performedByUserId: operatorUserId, forAccountId: ownerAccountId },
          } as const;
          await appealRuntime.startReview(capability, actionId as EnforcementActionId, operatorContext);
        });
      }
      await withAccountAppealSellerAccess(seller, "account-appeals.file", async (capability) => {
        await appealRuntime.withdraw(capability, action, context);
      });
    } else {
      await withAccountAppealOperatorAccess(operator, "account-appeals.review", async (capability) => {
        const operatorContext = {
          tenantId,
          audit: { performedByUserId: operatorUserId, forAccountId: ownerAccountId },
        } as const;
        await appealRuntime.startReview(capability, actionId as EnforcementActionId, operatorContext);
        await appealRuntime.recordOutcome(
          capability,
          actionId as EnforcementActionId,
          { outcome: terminal, rationale: `${terminal} rationale`, note: `${terminal} note` },
          operatorContext,
        );
      });
    }

    const stored = await pool.query<{ appeal_id: string }>(
      `SELECT payload->>'appealId' AS appeal_id
         FROM event_store_events
        WHERE stream_id = $1 AND event_type = 'platform-operations.account-appeal.filed'`,
      [`platform-operations.account-appeal-${actionId}`],
    );
    const appealId = stored.rows[0]?.appeal_id;
    if (!appealId) throw new Error("Synthetic runtime appeal did not store a filing event.");
    return {
      actionId,
      appealId,
      streamId: `platform-operations.account-appeal-${actionId}`,
      eventStore,
      tenantId,
      ownerAccountId,
      sellerUserId,
      operatorUserId,
    };
  }

  async function storedAppealEvents(streamId: string) {
    return pool.query<{
      event_type: string;
      payload: Record<string, unknown>;
      stream_version: number;
    }>(
      `SELECT event_type, payload, stream_version
         FROM event_store_events
        WHERE stream_id = $1
        ORDER BY stream_version`,
      [streamId],
    );
  }

  async function projectionRows(appealId: string) {
    const [seller, operator] = await Promise.all([
      pool.query("SELECT * FROM platform_operations_account_appeal_seller_history WHERE appeal_id = $1", [appealId]),
      pool.query("SELECT * FROM platform_operations_account_appeal_operator_history WHERE appeal_id = $1", [appealId]),
    ]);
    return { seller: seller.rows, operator: operator.rows };
  }

  /** One projection transaction per event, committed on success and rolled back on a thrown error. */
  async function deliver(delivery: Delivery, auditAccountId?: string): Promise<void> {
    const event = toEvent(delivery, auditAccountId);
    const handler = (registeredHandlers() as Readonly<Record<string, ProjectorHandler | undefined>>)[event.type];
    if (!handler) throw new Error(`No registered handler for ${event.type}`);
    const scoped = await pool.connect();
    try {
      await scoped.query("BEGIN");
      await handler(event, { db: scoped });
      await scoped.query("COMMIT");
    } catch (error) {
      await scoped.query("ROLLBACK");
      throw error;
    } finally {
      scoped.release();
    }
  }

  async function deliverAppeal(delivery: Delivery): Promise<void> {
    const event = toEvent(delivery);
    const handler = (appealProjectionHandlers() as Readonly<Record<string, ProjectorHandler | undefined>>)[event.type];
    if (!handler) throw new Error(`No registered appeal handler for ${event.type}`);
    const scoped = await pool.connect();
    try {
      await scoped.query("BEGIN");
      await handler(event, { db: scoped });
      await scoped.query("COMMIT");
    } catch (error) {
      await scoped.query("ROLLBACK");
      throw error;
    } finally {
      scoped.release();
    }
  }

  function appealDelivery(
    appealId: string,
    streamVersion: number,
    type: (typeof ACCOUNT_APPEAL_PROJECTION_EVENT_TYPES)[number],
    data: Record<string, unknown> = {},
  ): Delivery {
    return {
      type,
      streamId: `platform-operations.account-appeal-${appealId}`,
      streamVersion,
      data,
    };
  }

  function read(appealableActionId: string, ownerAccountId: string) {
    return readAppealableEnforcementAction(pool, {
      appealableActionId: appealableActionId as EnforcementActionId | ListingEnforcementActionId,
      ownerAccountId: ownerAccountId as AccountId,
    });
  }

  async function registryRows() {
    const result = await pool.query<{
      appealable_action_id: string;
      owner_account_id: string;
      source: string;
      source_stream_id: string;
      source_stream_version: number;
      conflict_state: string;
    }>(
      `SELECT appealable_action_id, owner_account_id, source, source_stream_id, source_stream_version, conflict_state
       FROM platform_operations_account_appealable_actions
       ORDER BY appealable_action_id`,
    );
    return result.rows;
  }

  beforeAll(async () => {
    const databaseUrls = createMultiContextTestDatabaseUrls(
      databaseBaseUrl!,
      contextNames,
      "platform_operations_account_appeal_aggregate",
    );
    await ensureMultiContextTestDatabases(databaseBaseUrl!, databaseUrls);
    pools = createMultiContextTestPools(databaseUrls);
    pool = pools["platform-operations"];
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await pool.query(platformOperationsModule.schemaSql);
  });

  afterAll(async () => {
    await closeMultiContextTestPools(pools);
  });

  describe("event-only seller and operator projections (R3)", () => {
    it("fresh boot applies the four private events and replay leaves both rows byte-identical", async () => {
      const appealId = createId("apl");
      const accountId = createId("acc");
      const actionId = createId("enf");
      const tenantId = createId("tnt");
      const filedByUserId = createId("usr");
      const operatorUserId = createId("usr");
      const history = [
        appealDelivery(appealId, 1, "platform-operations.account-appeal.filed", {
          appealId,
          tenantId,
          accountId,
          action: {
            appealableActionId: actionId,
            ownerAccountId: accountId,
            source: "identity.account.closed",
            sourceStreamId: `identity.account-${accountId}`,
            sourceStreamVersion: 2,
          },
          statement: "The closure was mistaken",
          filedByUserId,
        }),
        appealDelivery(appealId, 2, "platform-operations.account-appeal.review-started"),
        appealDelivery(appealId, 3, "platform-operations.account-appeal.outcome-recorded", {
          outcome: "reversed",
          rationale: "Evidence changed",
          note: "Internal review note",
          operatorUserId,
        }),
      ];
      for (const event of history) await deliverAppeal(event);

      const before = await Promise.all([
        pool.query(
          `SELECT appeal_id, tenant_id, account_id, appealable_action_id, appealable_action_source,
                  appealable_action_source_stream_id, appealable_action_source_stream_version, statement,
                  filed_by_user_id, status, outcome, rationale, stream_version
             FROM platform_operations_account_appeal_seller_history WHERE appeal_id=$1`,
          [appealId],
        ),
        pool.query(
          `SELECT appeal_id, tenant_id, account_id, appealable_action_id, appealable_action_source,
                  appealable_action_source_stream_id, appealable_action_source_stream_version, statement,
                  filed_by_user_id, status, outcome, rationale, stream_version, note, operator_user_id
             FROM platform_operations_account_appeal_operator_history WHERE appeal_id=$1`,
          [appealId],
        ),
      ]);
      expect(before[0]?.rows[0]).toMatchObject({ status: "reversed", outcome: "reversed", stream_version: 3 });
      expect(before[0]?.rows[0]).not.toHaveProperty("note");
      expect(before[0]?.rows[0]).not.toHaveProperty("operator_user_id");
      expect(before[1]?.rows[0]).toMatchObject({
        status: "reversed",
        outcome: "reversed",
        rationale: "Evidence changed",
        note: "Internal review note",
        operator_user_id: operatorUserId,
        stream_version: 3,
      });

      for (const event of history) await deliverAppeal(event);
      const after = await Promise.all([
        pool.query("SELECT * FROM platform_operations_account_appeal_seller_history WHERE appeal_id=$1", [appealId]),
        pool.query("SELECT * FROM platform_operations_account_appeal_operator_history WHERE appeal_id=$1", [appealId]),
      ]);
      expect(after.map((result) => result.rows)).toEqual(before.map((result) => result.rows));
    });

    it("enforces the seller allowlist and rejects missing or skipped stream versions", async () => {
      const columns = await pool.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema='public' AND table_name='platform_operations_account_appeal_seller_history'
          ORDER BY ordinal_position`,
      );
      expect(columns.rows.map((row) => row.column_name)).toEqual([...ACCOUNT_APPEAL_SELLER_HISTORY_COLUMNS]);
      const operatorColumns = await pool.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema='public' AND table_name='platform_operations_account_appeal_operator_history'
          ORDER BY ordinal_position`,
      );
      expect(operatorColumns.rows.map((row) => row.column_name)).toEqual([...ACCOUNT_APPEAL_OPERATOR_HISTORY_COLUMNS]);

      const appealId = createId("apl");
      await expect(
        deliverAppeal(appealDelivery(appealId, 2, "platform-operations.account-appeal.review-started")),
      ).rejects.toThrow("version gap");
      await deliverAppeal(
        appealDelivery(appealId, 1, "platform-operations.account-appeal.filed", {
          appealId,
          tenantId: createId("tnt"),
          accountId: createId("acc"),
          action: {
            appealableActionId: createId("enf"),
            ownerAccountId: createId("acc"),
            source: "identity.account.closed",
            sourceStreamId: "identity.account-placeholder",
            sourceStreamVersion: 1,
          },
          statement: "Statement",
          filedByUserId: createId("usr"),
        }),
      );
      await expect(
        deliverAppeal(appealDelivery(appealId, 3, "platform-operations.account-appeal.review-started")),
      ).rejects.toThrow("version gap");
      await deliverAppeal(appealDelivery(appealId, 2, "platform-operations.account-appeal.review-started"));
      await deliverAppeal(appealDelivery(appealId, 2, "platform-operations.account-appeal.review-started"));
      expect(
        (await pool.query("SELECT stream_version,status FROM platform_operations_account_appeal_seller_history")).rows,
      ).toEqual([{ stream_version: 2, status: "in-review" }]);
    });

    it("boots the real group, resets replay-only without truncating, and re-enables after a disabled interval", async () => {
      const runtime = await bootProjectionRuntime();
      const first = await appendRuntimeAppeal("reversed");
      await drainContextRuntime(runtime);
      const group = runtime.projectionGroups.find(
        ({ projectionName }) => projectionName === "account-appeal-projection",
      );
      expect(group).toBeDefined();
      expect(group?.ownedTables).toEqual([
        "platform_operations_account_appeal_seller_history",
        "platform_operations_account_appeal_operator_history",
      ]);
      expect(group?.resetStrategy).toBe("replay-only");
      const beforeReset = await projectionRows(first.appealId);
      expect(beforeReset.seller[0]).toMatchObject({ status: "reversed", stream_version: 3 });

      const revisionSyncToken = await resetProjectionGroup(group!);
      expect(await projectionRows(first.appealId)).toEqual(beforeReset);

      const second = await appendRuntimeAppeal("upheld");
      await drainContextRuntime({ subscriptionRunners: group!.subscriptionRunners });
      await group!.markRevisionSynced(revisionSyncToken);
      expect(await projectionRows(first.appealId)).toEqual(beforeReset);
      expect((await projectionRows(second.appealId)).seller[0]).toMatchObject({ status: "upheld", stream_version: 3 });
    });

    it("skips an adjacent unknown private event and advances the projection checkpoint", async () => {
      const runtime = await bootProjectionRuntime();
      const fixture = await appendRuntimeAppeal("reversed");
      await drainContextRuntime(runtime);
      const group = runtime.projectionGroups.find(
        ({ projectionName }) => projectionName === "account-appeal-projection",
      )!;
      const before = await projectionRows(fixture.appealId);
      const subscriptions =
        platformOperationsModule.buildSubscriptions?.(platformOperationsModule.createServices(pool, {})) ?? [];
      const appealSubscription = subscriptions.find(
        ({ projectionName, sourceContextName }) =>
          projectionName === "account-appeal-projection" && sourceContextName === "platform-operations",
      );
      expect(appealSubscription?.eventTypes).toEqual([
        "platform-operations.account-appeal.filed",
        "platform-operations.account-appeal.review-started",
        "platform-operations.account-appeal.outcome-recorded",
        "platform-operations.account-appeal.withdrawn",
      ]);
      expect(Object.keys(appealSubscription?.handlers ?? {})).not.toContain(
        "platform-operations.account-appeal.synthetic-unknown",
      );
      const unknown = await fixture.eventStore.appendToStream({
        streamId: fixture.streamId,
        expectedVersion: 3,
        context: {
          tenantId: fixture.tenantId,
          audit: { performedByUserId: fixture.operatorUserId, forAccountId: fixture.ownerAccountId },
        },
        events: [{ eventType: "platform-operations.account-appeal.synthetic-unknown", payload: { synthetic: true } }],
      });
      expect(unknown[0]?.streamVersion).toBe(4);

      expect(group.subscriptionRunners).toHaveLength(1);
      const settled = await group.subscriptionRunners[0]!.runOnce({ settleIdleCheckpoints: true });
      expect(settled).toMatchObject({ processed: 0, blockedStreams: 0, poisonEvents: 0 });
      expect(await projectionRows(fixture.appealId)).toEqual(before);
      const checkpoint = await pool.query<{ last_global_position: string }>(
        `SELECT last_global_position::text
           FROM event_subscription_checkpoints
          WHERE checkpoint_key = $1`,
        [group.subscriptionRunners[0]?.checkpointKey],
      );
      expect(checkpoint.rows[0]).toBeDefined();
      expect(BigInt(checkpoint.rows[0]!.last_global_position)).toBeGreaterThanOrEqual(
        BigInt(String(unknown[0]!.globalPosition)),
      );
    });

    it("projects the history matrix and keeps restoration and closure record-only", async () => {
      const cases = [
        { terminal: "withdrawn" as const, expectedStatus: "withdrawn", expectedOutcome: null, version: 2 },
        { terminal: "withdrawn" as const, expectedStatus: "withdrawn", expectedOutcome: null, version: 3 },
        { terminal: "upheld" as const, expectedStatus: "upheld", expectedOutcome: "upheld", version: 3 },
        { terminal: "modified" as const, expectedStatus: "modified", expectedOutcome: "modified", version: 3 },
        { terminal: "reversed" as const, expectedStatus: "reversed", expectedOutcome: "reversed", version: 3 },
      ];
      for (const [index, testCase] of cases.entries()) {
        const fixture = await appendRuntimeAppeal(testCase.terminal, "identity.account.closed", index === 1);
        const events = await storedAppealEvents(fixture.streamId);
        const selected = events.rows;
        for (const event of selected) {
          await deliverAppeal({
            type: event.event_type,
            streamId: fixture.streamId,
            streamVersion: Number(event.stream_version),
            data: event.payload,
          });
        }
        const before = await projectionRows(fixture.appealId);
        expect(before.seller[0]).toMatchObject({
          status: testCase.expectedStatus,
          outcome: testCase.expectedOutcome,
          stream_version: testCase.version,
        });
        expect(before.operator[0]).toMatchObject(
          testCase.expectedOutcome === null
            ? {
                status: "withdrawn",
                outcome: null,
                note: null,
                operator_user_id: null,
                stream_version: testCase.version,
              }
            : {
                status: testCase.expectedStatus,
                outcome: testCase.expectedOutcome,
                rationale: `${testCase.expectedOutcome} rationale`,
                note: `${testCase.expectedOutcome} note`,
                operator_user_id: fixture.operatorUserId,
                stream_version: testCase.version,
              },
        );
        for (const event of selected) {
          await deliverAppeal({
            type: event.event_type,
            streamId: fixture.streamId,
            streamVersion: Number(event.stream_version),
            data: event.payload,
          });
        }
        expect(await projectionRows(fixture.appealId)).toEqual(before);
      }

      for (const source of ["identity.account.reactivated", "identity.account.closed"] as const) {
        const fixture = await appendRuntimeAppeal("reversed", source);
        const sourceRows = (await registryRows()).filter((row) => row.appealable_action_id === fixture.actionId);
        const events = await storedAppealEvents(fixture.streamId);
        for (const event of events.rows) {
          await deliverAppeal({
            type: event.event_type,
            streamId: fixture.streamId,
            streamVersion: Number(event.stream_version),
            data: event.payload,
          });
        }
        expect((await projectionRows(fixture.appealId)).seller[0]).toMatchObject({
          status: "reversed",
          outcome: "reversed",
        });
        expect((await registryRows()).filter((row) => row.appealable_action_id === fixture.actionId)).toEqual(
          sourceRows,
        );
        const projectionBefore = await projectionRows(fixture.appealId);
        const appealRuntime = createAccountAppealRuntime(pool, fixture.eventStore);
        await expect(
          withAccountAppealSellerAccess(
            {
              tenantId: fixture.tenantId,
              accountId: fixture.ownerAccountId as AccountId,
              userId: fixture.sellerUserId,
              permissions: ["account-appeals.file"],
            },
            "account-appeals.file",
            async (capability) => {
              const resolved = await appealRuntime.resolve(capability, fixture.actionId as EnforcementActionId);
              if (resolved.status !== "resolved") throw new Error("Synthetic appeal action must resolve.");
              return appealRuntime.file(
                capability,
                resolved.action,
                { statement: "The closure was mistaken", appealId: fixture.appealId as never },
                {
                  tenantId: fixture.tenantId,
                  audit: { performedByUserId: fixture.sellerUserId, forAccountId: fixture.ownerAccountId },
                },
              );
            },
          ),
        ).rejects.toThrow("A terminal or withdrawn appeal cannot be filed.");
        expect(await projectionRows(fixture.appealId)).toEqual(projectionBefore);
      }
    });

    it("rolls back handler writes with the runner transaction context", async () => {
      const appealId = createId("apl");
      const actionId = createId("enf");
      const accountId = createId("acc");
      const filed = toEvent(
        appealDelivery(appealId, 1, "platform-operations.account-appeal.filed", {
          appealId,
          tenantId: createId("tnt"),
          accountId,
          action: {
            appealableActionId: actionId,
            ownerAccountId: accountId,
            source: "identity.account.closed",
            sourceStreamId: `identity.account-${accountId}`,
            sourceStreamVersion: 2,
          },
          statement: "Statement",
          filedByUserId: createId("usr"),
        }),
      );
      const handler = appealProjectionHandlers()[filed.type]!;
      const scoped = await pool.connect();
      try {
        await scoped.query("BEGIN");
        await handler(filed, { db: scoped });
        await scoped.query("ROLLBACK");
      } finally {
        scoped.release();
      }
      expect(await projectionRows(appealId)).toEqual({ seller: [], operator: [] });

      await deliverAppeal({
        type: filed.type,
        streamId: filed.streamId,
        streamVersion: filed.streamVersion,
        data: filed.data,
      });
      const review = toEvent(appealDelivery(appealId, 2, "platform-operations.account-appeal.review-started"));
      const reviewHandler = appealProjectionHandlers()[review.type]!;
      const updateScoped = await pool.connect();
      try {
        await updateScoped.query("BEGIN");
        await reviewHandler(review, { db: updateScoped });
        await updateScoped.query("ROLLBACK");
      } finally {
        updateScoped.release();
      }
      expect((await projectionRows(appealId)).seller[0]).toMatchObject({ status: "filed", stream_version: 1 });
    });
  });

  describe("registry (R1)", () => {
    // Drives the registered identity and marketplace handlers, then the typed reader.
    // Kills the collapsed-source-discriminator mutant (AC17): every action must come back with its own source.
    it("five sources produce complete owner-attributed tuples with five distinct discriminators", async () => {
      const owner = createId("acc");
      const actionIds = [createId("enf"), createId("enf"), createId("enf"), createId("lea"), createId("lea")] as const;
      const deliveries = [
        identityEnforcement("identity.account.suspended", owner, actionIds[0]),
        identityEnforcement("identity.account.reactivated", owner, actionIds[1], 3),
        identityEnforcement("identity.account.closed", owner, actionIds[2], 4),
        operatorUnlisted(owner, actionIds[3]),
        autoUnlisted(owner, actionIds[4]),
      ];
      for (const delivery of deliveries) await deliver(delivery);

      const resolved = [];
      for (const [index, delivery] of deliveries.entries()) {
        const actionId = actionIds[index]!;
        const action = await read(actionId, owner);
        expect(action, delivery.type).toEqual({
          appealableActionId: actionId,
          ownerAccountId: owner,
          source: delivery.type,
          sourceStreamId: delivery.streamId,
          sourceStreamVersion: delivery.streamVersion,
        });
        resolved.push(action);
      }
      expect(new Set(resolved.map((action) => ("source" in action ? action.source : null))).size).toBe(5);
      expect((await registryRows()).map((row) => row.conflict_state)).toEqual(Array(5).fill("clear"));
    });

    // Drives every handler with legacy and modern shapes. Kills the empty-legacy-row mutant (AC20) and,
    // with a valid createId fixture beside a malformed-id control, the permissive-parser mutant (AC27).
    it("legacy versus modern: exactly-empty Identity and unenriched auto-unlisted payloads produce no row", async () => {
      const owner = createId("acc");
      for (const type of ["identity.account.suspended", "identity.account.reactivated", "identity.account.closed"]) {
        await deliver({ type, streamId: `identity.account-${owner}`, streamVersion: 2, data: {} });
      }
      await deliver(autoUnlisted(owner, null));
      expect(await registryRows()).toEqual([]);

      const malformedIdentity = identityEnforcement("identity.account.suspended", owner, "enf_not-a-ulid");
      await expect(deliver(malformedIdentity)).rejects.toThrow("complete owner-attributed appealable action");
      await expect(deliver(operatorUnlisted(owner, "lea_not-a-ulid"))).rejects.toThrow("Malformed modern");
      await expect(
        deliver({
          type: "identity.account.closed",
          streamId: `identity.account-${owner}`,
          streamVersion: 2,
          data: { x: 1 },
        }),
      ).rejects.toThrow("Malformed modern");
      const wrongPrefix = identityEnforcement("identity.account.suspended", owner, createId("lea"));
      await expect(deliver(wrongPrefix)).rejects.toThrow("complete owner-attributed appealable action");
      expect(await registryRows()).toEqual([]);

      const enforcementActionId = createId("enf");
      await deliver(identityEnforcement("identity.account.suspended", owner, enforcementActionId));
      const listingEnforcementActionId = createId("lea");
      await deliver(autoUnlisted(owner, listingEnforcementActionId));
      expect((await registryRows()).map((row) => row.appealable_action_id).sort()).toEqual(
        [enforcementActionId, listingEnforcementActionId].sort(),
      );
    });

    // Drives conflicting deliveries through real projection transactions in both orders, then the reader.
    // Kills a last-writer-wins mutant: the first tuple stays frozen whichever source arrives first, and the
    // conflict marker survives the rollback of the transaction whose corruption error rejected the delivery.
    it("source order matrix: a changed tuple freezes the first tuple and durably marks the row conflicted", async () => {
      for (const order of ["suspended-first", "closed-first"] as const) {
        await resetMultiContextTestSchemas(pools);
        await pool.query(platformOperationsModule.schemaSql);
        const owner = createId("acc");
        const enforcementActionId = createId("enf");
        const suspended = identityEnforcement("identity.account.suspended", owner, enforcementActionId, 2);
        const closed = identityEnforcement("identity.account.closed", owner, enforcementActionId, 5);
        const [first, second] = order === "suspended-first" ? [suspended, closed] : [closed, suspended];

        await deliver(first);
        await deliver(first);
        expect(await read(enforcementActionId, owner), order).toMatchObject({
          source: first.type,
          sourceStreamVersion: first.streamVersion,
        });

        await expect(deliver(second), order).rejects.toThrow("marked conflicted");
        expect(await registryRows(), order).toEqual([
          {
            appealable_action_id: enforcementActionId,
            owner_account_id: owner,
            source: first.type,
            source_stream_id: first.streamId,
            source_stream_version: first.streamVersion,
            conflict_state: "conflicted",
          },
        ]);
        expect(await read(enforcementActionId, owner), order).toBe(APPEALABLE_ACTION_INDETERMINATE);

        // Replaying the original fact neither clears the marker nor rewrites the tuple.
        await deliver(first);
        expect((await registryRows())[0]?.conflict_state, order).toBe("conflicted");
        expect(await read(enforcementActionId, owner), order).toBe(APPEALABLE_ACTION_INDETERMINATE);
      }
    });

    // Drives the identity and marketplace handlers with an audit actor that is not the owner, then a redelivery
    // whose stream names another account. Kills the caller-owned-attribution mutant (AC4).
    it("immutable attribution: the owner comes from the source stream or payload, never the caller", async () => {
      const owner = createId("acc");
      const caller = createId("acc");
      const enforcementActionId = createId("enf");
      const listingEnforcementActionId = createId("lea");
      await deliver(identityEnforcement("identity.account.suspended", owner, enforcementActionId), caller);
      await deliver(operatorUnlisted(owner, listingEnforcementActionId), caller);
      expect((await registryRows()).map((row) => row.owner_account_id)).toEqual([owner, owner]);
      expect(await read(enforcementActionId, caller)).toBe(APPEALABLE_ACTION_INDETERMINATE);

      // Identity owner extraction is prefix-checked: a non-account stream id is rejected, not attributed.
      const closure = identityEnforcement("identity.account.closed", owner, createId("enf"));
      await expect(deliver({ ...closure, streamId: `identity.account-${createId("usr")}` })).rejects.toThrow(
        "complete owner-attributed appealable action",
      );

      // The seeded Dormant Account has a prefix-valid, non-ULID id and is still attributed.
      const seededOwner = identitySeedIds.suspended.accountId;
      const seededActionId = createId("enf");
      await deliver(identityEnforcement("identity.account.suspended", seededOwner, seededActionId));
      expect(await read(seededActionId, seededOwner)).toMatchObject({ ownerAccountId: seededOwner });

      const hijack = identityEnforcement("identity.account.suspended", caller, enforcementActionId);
      await expect(deliver(hijack)).rejects.toThrow("changed owner, source stream id");
      const stored = (await registryRows()).find((row) => row.appealable_action_id === enforcementActionId);
      expect(stored).toMatchObject({
        owner_account_id: owner,
        source_stream_id: `identity.account-${owner}`,
        conflict_state: "conflicted",
      });
    });

    // Drives the reader before and after the identity handler. Kills the guessed-absence mutant (AC2-3):
    // an unprojected action is indeterminate, never "not appealable", and the unchanged retry resolves.
    it("delayed eligibility: a source arriving before its registry row resolves only after projection", async () => {
      const owner = createId("acc");
      const enforcementActionId = createId("enf");
      const delivery = identityEnforcement("identity.account.closed", owner, enforcementActionId);

      const beforeProjection = await read(enforcementActionId, owner);
      expect(beforeProjection).toBe(APPEALABLE_ACTION_INDETERMINATE);
      expect(beforeProjection).toBe(await read(createId("enf"), owner));

      await deliver(delivery);
      expect(await read(enforcementActionId, owner)).toEqual({
        appealableActionId: enforcementActionId,
        ownerAccountId: owner,
        source: "identity.account.closed",
        sourceStreamId: delivery.streamId,
        sourceStreamVersion: delivery.streamVersion,
      });
    });

    // Drives the marketplace handler and a conflicting redelivery, then reads absent, foreign, conflicted and
    // complete rows. Kills a disclosure mutant that returns raw rows or distinguishes the failure cases.
    it("reader nondisclosure: only typed fields for a complete row, one singleton for every other case", async () => {
      const owner = createId("acc");
      const listingEnforcementActionId = createId("lea");
      const delivery = autoUnlisted(owner, listingEnforcementActionId);
      await deliver(delivery);

      const action = await read(listingEnforcementActionId, owner);
      expect(Object.keys(action).sort()).toEqual(
        ["appealableActionId", "ownerAccountId", "source", "sourceStreamId", "sourceStreamVersion"].sort(),
      );
      expect(Object.isFrozen(action)).toBe(true);

      expect(Object.isFrozen(APPEALABLE_ACTION_INDETERMINATE)).toBe(true);
      expect(await read(createId("lea"), owner)).toBe(APPEALABLE_ACTION_INDETERMINATE);
      expect(await read(listingEnforcementActionId, createId("acc"))).toBe(APPEALABLE_ACTION_INDETERMINATE);

      const conflicting = { ...delivery, streamVersion: delivery.streamVersion + 1 };
      await expect(deliver(conflicting)).rejects.toThrow("changed source stream version");
      expect(await read(listingEnforcementActionId, owner)).toBe(APPEALABLE_ACTION_INDETERMINATE);
    });

    // Drives the boot schema and the ledger migration statements on one database, then a handler.
    // Kills a boot-only or migration-only registry: both paths must leave a usable, identical table.
    it("enrollment: boot schema and migration converge on one usable registry", async () => {
      for (const migration of accountAppealSchemaMigrations) {
        for (const statement of migration.statements) await pool.query(statement);
      }
      const owner = createId("acc");
      const enforcementActionId = createId("enf");
      await deliver(identityEnforcement("identity.account.reactivated", owner, enforcementActionId));
      expect(await read(enforcementActionId, owner)).toMatchObject({ source: "identity.account.reactivated" });
    });

    it("runtime commands use the typed reader, expected versions, and terminal idempotency", async () => {
      const owner = createId("acc");
      const enforcementActionId = createId("enf");
      await deliver(identityEnforcement("identity.account.closed", owner, enforcementActionId));
      const diagnostics: ConcurrentFilingDiagnostic[] = [];
      const runtime = createAccountAppealRuntime(pool, createPostgresEventStore({ pool }));
      const seller = {
        tenantId: createId("tnt"),
        accountId: owner,
        userId: createId("usr"),
        permissions: ["account-appeals.file", "account-appeals.view"],
      } as const;
      const fileResult = await withAccountAppealSellerAccess(seller, "account-appeals.file", async (capability) => {
        const resolved = await runtime.resolve(capability, enforcementActionId);
        expect(resolved.status).toBe("resolved");
        if (resolved.status !== "resolved") throw new Error("expected resolved action");
        const input = { statement: "The closure was mistaken" };
        await expect(
          runtime.file(capability, resolved.action, input, {
            tenantId: seller.tenantId,
            audit: { performedByUserId: createId("usr"), forAccountId: owner },
          }),
        ).rejects.toThrow("account capability");
        const streamId = appealStreamId(resolved.action.appealableActionId);
        // Discriminator for the exact-stream readback: one committed event on a sibling appeal stream, appended
        // through the real event store before the race, so an unscoped readback observes two rows instead of one.
        const unrelatedStreamId = appealStreamId(createId("enf"));
        expect(unrelatedStreamId).not.toBe(streamId);
        const unrelated = await createPostgresEventStore({ pool }).appendToStream({
          streamId: unrelatedStreamId,
          expectedVersion: "no_stream",
          context: {
            tenantId: seller.tenantId,
            audit: { performedByUserId: createId("usr"), forAccountId: createId("acc") },
          },
          events: [
            { eventType: "platform-operations.account-appeal.synthetic-unrelated", payload: { synthetic: true } },
          ],
        });
        expect(unrelated.map((event) => event.streamVersion)).toEqual([1]);
        const rendezvous = createConcurrentFilingRendezvous(diagnostics);
        const firstPool = instrumentConcurrentFilingPool(pool, "first", diagnostics, rendezvous);
        const secondPool = instrumentConcurrentFilingPool(pool, "second", diagnostics, rendezvous);
        const run = (call: ConcurrentFilingCall, filing: () => Promise<unknown>): Promise<unknown> =>
          filing().finally(() => rendezvous.settle(call));
        const race = await Promise.allSettled([
          run("first", () =>
            createAccountAppealRuntime(firstPool, createPostgresEventStore({ pool: firstPool })).file(
              capability,
              resolved.action,
              input,
              {
                tenantId: seller.tenantId,
                audit: { performedByUserId: seller.userId, forAccountId: owner },
              },
            ),
          ),
          run("second", () =>
            createAccountAppealRuntime(secondPool, createPostgresEventStore({ pool: secondPool })).file(
              capability,
              resolved.action,
              input,
              {
                tenantId: seller.tenantId,
                audit: { performedByUserId: seller.userId, forAccountId: owner },
              },
            ),
          ),
        ]);
        const diagnosticsMessage = concurrentFilingDiagnosticsMessage(diagnostics, race);
        const exactStream = await pool.query<{
          stream_version: number | string;
          event_type: string;
        }>(
          `SELECT stream_version, event_type
             FROM event_store_events
            WHERE stream_id = $1
            ORDER BY stream_version ASC`,
          [streamId],
        );
        expect(
          race.filter((entry) => entry.status === "fulfilled"),
          diagnosticsMessage,
        ).toHaveLength(1);
        expect(
          race.filter((entry) => entry.status === "rejected"),
          diagnosticsMessage,
        ).toHaveLength(1);
        const rejected = race.find((entry) => entry.status === "rejected");
        expect(rejected, diagnosticsMessage).toMatchObject({
          status: "rejected",
          reason: { code: "concurrency_conflict", message: "Expected no stream but stream already exists." },
        });
        expect(exactStream.rows, diagnosticsMessage).toHaveLength(1);
        expect(exactStream.rows[0], diagnosticsMessage).toMatchObject({
          stream_version: "1",
          event_type: "platform-operations.account-appeal.filed",
        });
        expect(
          diagnostics.filter((entry) => entry.phase === "commit"),
          diagnosticsMessage,
        ).toHaveLength(1);
        expect(
          diagnostics.filter((entry) => entry.phase === "rollback"),
          diagnosticsMessage,
        ).toHaveLength(1);
        expect(
          diagnostics.filter((entry) => entry.phase === "event-insert" && entry.insertedRows === 1),
          diagnosticsMessage,
        ).toHaveLength(1);
        expect(
          diagnostics.filter((entry) => entry.phase === "stream-guard"),
          diagnosticsMessage,
        ).toHaveLength(2);
        expect(
          diagnostics.filter((entry) => entry.phase === "load-rendezvous"),
          diagnosticsMessage,
        ).toHaveLength(2);
        expect(
          diagnostics
            .filter((entry) => entry.phase === "load-rendezvous")
            .map((entry) => entry.call)
            .sort(),
          diagnosticsMessage,
        ).toEqual(["first", "second"]);
        expect(
          diagnostics.filter((entry) => entry.phase === "stream-guard").every((entry) => entry.streamId === streamId),
          diagnosticsMessage,
        ).toBe(true);
        expect(
          diagnostics
            .filter((entry) => entry.phase === "stream-guard")
            .map((entry) => entry.observedVersion)
            .sort((left, right) => (left ?? 0) - (right ?? 0)),
          diagnosticsMessage,
        ).toEqual([0, 1]);
        expect(
          diagnostics.map((entry) => entry.backendPid).filter((pid) => pid !== undefined),
          diagnosticsMessage,
        ).toHaveLength(2);
        expect(
          diagnostics.map((entry) => entry.transactionId).filter((id) => id !== undefined),
          diagnosticsMessage,
        ).toHaveLength(2);
        return resolved.action;
      });
      expect(fileResult).toBeDefined();

      const operator = {
        tenantId: seller.tenantId,
        userId: createId("usr"),
        roleKey: "trust-operator",
        permissions: ["account-appeals.review"],
      } as const;
      await withAccountAppealOperatorAccess(operator, "account-appeals.review", async (capability) => {
        const context = {
          tenantId: operator.tenantId,
          audit: { performedByUserId: operator.userId, forAccountId: owner },
        } as const;
        await expect(
          runtime.startReview(capability, enforcementActionId, {
            tenantId: operator.tenantId,
            audit: { performedByUserId: operator.userId, forAccountId: createId("acc") },
          }),
        ).rejects.toThrow("appeal account");
        await runtime.startReview(capability, enforcementActionId, context);
        const first = await runtime.recordOutcome(
          capability,
          enforcementActionId,
          {
            outcome: "reversed",
            rationale: "Evidence changed",
            note: "Keep internal history",
          },
          context,
        );
        const retry = await runtime.recordOutcome(
          capability,
          enforcementActionId,
          {
            outcome: "reversed",
            rationale: "Evidence changed",
            note: "Keep internal history",
          },
          context,
        );
        expect(first.newEvents).toHaveLength(1);
        expect(retry.newEvents).toEqual([]);
      });

      const stored = await pool.query<{
        event_type: string;
        payload: Record<string, unknown>;
        performed_by_user_id: string;
        for_account_id: string;
      }>(
        `SELECT event_type, payload
                , performed_by_user_id, for_account_id
         FROM event_store_events
         WHERE stream_id = $1
         ORDER BY stream_version`,
        [`platform-operations.account-appeal-${enforcementActionId}`],
      );
      expect(stored.rows.map((row) => row.event_type)).toEqual([
        "platform-operations.account-appeal.filed",
        "platform-operations.account-appeal.review-started",
        "platform-operations.account-appeal.outcome-recorded",
      ]);
      expect(stored.rows[2]?.payload).toMatchObject({
        outcome: "reversed",
        rationale: "Evidence changed",
        note: "Keep internal history",
        operatorUserId: operator.userId,
      });
      expect(stored.rows[2]).toMatchObject({ performed_by_user_id: operator.userId, for_account_id: owner });

      // The production runtime is the event producer; the projection consumes its stored events,
      // proving this is event-only rather than a route-side read-model write.
      const runtimeEvents = await pool.query<{
        event_type: string;
        payload: Record<string, unknown>;
        stream_version: number;
      }>(
        `SELECT event_type, payload, stream_version
           FROM event_store_events
          WHERE stream_id = $1
          ORDER BY stream_version`,
        [`platform-operations.account-appeal-${enforcementActionId}`],
      );
      for (const row of runtimeEvents.rows) {
        await deliverAppeal({
          type: row.event_type,
          streamId: `platform-operations.account-appeal-${enforcementActionId}`,
          streamVersion: Number(row.stream_version),
          data: row.payload,
        });
      }
      expect(
        (
          await pool.query(
            `SELECT status, outcome, rationale, stream_version
             FROM platform_operations_account_appeal_seller_history
            WHERE appeal_id = (SELECT payload->>'appealId' FROM event_store_events WHERE stream_id=$1 ORDER BY stream_version LIMIT 1)`,
            [`platform-operations.account-appeal-${enforcementActionId}`],
          )
        ).rows,
      ).toMatchObject([{ status: "reversed", outcome: "reversed", rationale: "Evidence changed", stream_version: 3 }]);
    });

    it("concurrent distinct outcomes produce one terminal winner and one conflict", async () => {
      const owner = createId("acc");
      const enforcementActionId = createId("enf");
      await deliver(identityEnforcement("identity.account.closed", owner, enforcementActionId));
      const runtime = createAccountAppealRuntime(pool, createPostgresEventStore({ pool }));
      const seller = {
        tenantId: createId("tnt"),
        accountId: owner,
        userId: createId("usr"),
        permissions: ["account-appeals.file"],
      } as const;
      const operator = {
        tenantId: seller.tenantId,
        userId: createId("usr"),
        roleKey: "trust-operator",
        permissions: ["account-appeals.review"],
      } as const;
      const action = await withAccountAppealSellerAccess(seller, "account-appeals.file", async (capability) => {
        const resolved = await runtime.resolve(capability, enforcementActionId);
        if (resolved.status !== "resolved") throw new Error("expected resolved action");
        await runtime.file(
          capability,
          resolved.action,
          { statement: "The closure was mistaken" },
          {
            tenantId: seller.tenantId,
            audit: { performedByUserId: seller.userId, forAccountId: owner },
          },
        );
        return resolved.action;
      });
      await withAccountAppealOperatorAccess(operator, "account-appeals.review", async (capability) => {
        const context = {
          tenantId: operator.tenantId,
          audit: { performedByUserId: operator.userId, forAccountId: owner },
        } as const;
        await runtime.startReview(capability, enforcementActionId, context);
        const race = await Promise.allSettled([
          runtime.recordOutcome(
            capability,
            enforcementActionId,
            {
              outcome: "reversed",
              rationale: "Evidence changed",
              note: "Winner A",
            },
            context,
          ),
          runtime.recordOutcome(
            capability,
            enforcementActionId,
            {
              outcome: "upheld",
              rationale: "Evidence confirmed",
              note: "Winner B",
            },
            context,
          ),
        ]);
        expect(race.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
        expect(race.filter((entry) => entry.status === "rejected")).toHaveLength(1);
      });
      expect(action).toBeDefined();

      const stored = await pool.query<{ event_type: string; payload: Record<string, unknown> }>(
        `SELECT event_type, payload
         FROM event_store_events
         WHERE stream_id = $1
         ORDER BY stream_version`,
        [`platform-operations.account-appeal-${enforcementActionId}`],
      );
      const terminal = stored.rows.filter(
        (row) => row.event_type === "platform-operations.account-appeal.outcome-recorded",
      );
      expect(terminal).toHaveLength(1);
      expect([
        { rationale: "Evidence changed", note: "Winner A" },
        { rationale: "Evidence confirmed", note: "Winner B" },
      ]).toContainEqual({ rationale: terminal[0]?.payload.rationale, note: terminal[0]?.payload.note });
    });
  });
});
