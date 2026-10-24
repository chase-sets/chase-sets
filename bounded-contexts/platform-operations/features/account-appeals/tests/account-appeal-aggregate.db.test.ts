import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildTransportEvent } from "@chase-sets/event-core/test-support";
import type { ProjectorHandler, ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { TransportEvent } from "@chase-sets/event-core/transport";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { createPostgresEventStore } from "@chase-sets/event-core-postgres";
import {
  closeMultiContextTestPools,
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
} from "@chase-sets/primitives/typed-ids";
import { module as platformOperationsModule } from "../../../index";
import { APPEALABLE_ACTION_INDETERMINATE, readAppealableEnforcementAction } from "../read-model/projection";
import { accountAppealSchemaMigrations } from "../read-model/schema";
import { createAccountAppealRuntime } from "../api/runtime";
import { withAccountAppealOperatorAccess, withAccountAppealSellerAccess } from "../api/access";

// phantom-SQL rule: exercised against a real Postgres sandbox (TEST_DATABASE_URL), never mocked.
const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
}
const describeDb = databaseBaseUrl ? describe : describe.skip;
const contextNames = ["platform-operations"] as const;
const OCCURRED_AT = "2026-10-21T00:00:00.000Z";

type Delivery = Readonly<{ type: string; streamId: string; streamVersion: number; data: Record<string, unknown> }>;

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
        ).rejects.toThrow("seller capability");
        const race = await Promise.allSettled([
          runtime.file(capability, resolved.action, input, {
            tenantId: seller.tenantId,
            audit: { performedByUserId: seller.userId, forAccountId: owner },
          }),
          runtime.file(capability, resolved.action, input, {
            tenantId: seller.tenantId,
            audit: { performedByUserId: seller.userId, forAccountId: owner },
          }),
        ]);
        expect(race.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
        expect(race.filter((entry) => entry.status === "rejected")).toHaveLength(1);
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
