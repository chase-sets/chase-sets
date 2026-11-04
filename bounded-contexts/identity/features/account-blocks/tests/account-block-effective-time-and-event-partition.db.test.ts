import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  compareGlobalPosition,
  type AppendToStreamInput,
  type EventRecordToStore,
  type StoredEvent,
} from "@chase-sets/event-core/storage";
import {
  createPostgresEventStore,
  eventCorePostgresSchemaSql,
  withPgTransaction,
  type PgPoolClient,
  type PgTransactionalPool,
  type PostgresEventStore,
} from "@chase-sets/event-core-postgres";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import type { IsoUtcTimestamp } from "@chase-sets/primitives/iso-utc-timestamp";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import {
  stageAccountBlockCommand,
  type AccountBlockCommand,
  type AccountBlockStagedCommand,
} from "../api/transition-staging";
import { foldAccountBlockPairHistory } from "../domain/authority";
import {
  AccountBlockAuthorityError,
  accountBlockBudgetRecordedEventType,
  accountBlockBudgetStreamId,
  accountBlockEventIds,
  accountBlockPairStreamId,
  accountBlockTransitionRecordedEventType,
  encodeAccountBlockTransition,
  type AccountBlockOperation,
  type AccountBlockPair,
  type AccountBlockTransitionId,
} from "../domain/events";
import {
  DAY,
  HOUR,
  alternatingSteps,
  blockedAccountId,
  blockingAccountId,
  initiatingUserId,
  instant,
  otherBlockedAccountId,
  syntheticContext,
  syntheticPair,
  syntheticTenantId,
  syntheticTransitionId,
  type SyntheticStep,
} from "./account-block-test-support";

// Exercised against a real PostgreSQL sandbox: row locks, rollback, expected-version
// enforcement, event-id uniqueness and the server clock cannot be reasoned about mocked.
const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
}
const describeDb = databaseBaseUrl ? describe : describe.skip;

// Stands in for the receipt row owned by the admission slice; it shares the transaction.
// One row per (transition, outcome), so a duplicate delivery's own result can be recorded.
const receiptTableSql = `CREATE TABLE account_block_test_receipts (
  transition_id text NOT NULL,
  outcome text NOT NULL,
  PRIMARY KEY (transition_id, outcome)
)`;
const serverInstantSql = `SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS server_instant`;

type AdmitHooks = Readonly<{
  beforeAppend?: (
    client: PgPoolClient,
    staged: Extract<AccountBlockStagedCommand, { outcome: "transition" }>,
  ) => Promise<readonly AppendToStreamInput[] | void>;
  afterReceipt?: (client: PgPoolClient) => Promise<void>;
}>;

describeDb("account-block-effective-time-and-event-partition on real PostgreSQL", () => {
  let pools: Readonly<Record<"identity", PgTransactionalPool>>;
  let pool: PgTransactionalPool;
  let store: PostgresEventStore;

  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, ["identity"], "identity_account_block_authority");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
    pool = pools.identity;
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await pool.query(eventCorePostgresSchemaSql);
    await pool.query(receiptTableSql);
    store = createPostgresEventStore({ pool });
  });
  afterAll(async () => {
    if (pools) await closeMultiContextTestPools(pools);
  });

  const command = (
    label: string,
    operation: AccountBlockOperation,
    blocked: AccountId = blockedAccountId,
    blocking: AccountId = blockingAccountId,
  ): AccountBlockCommand => ({
    operation,
    blockingAccountId: blocking,
    blockedAccountId: blocked,
    transitionId: syntheticTransitionId(label),
    context: syntheticContext({ accountId: blocking }),
  });

  /** One admission transaction: stage, append the plan, write the receipt, commit. */
  async function admit(
    input: AccountBlockCommand,
    hooks: AdmitHooks = {},
    eventStore: PostgresEventStore = store,
  ): Promise<AccountBlockStagedCommand> {
    return withPgTransaction(pool, async (client) => {
      const staged = await stageAccountBlockCommand(eventStore, client, input);
      if (staged.outcome === "transition") {
        const appends = (await hooks.beforeAppend?.(client, staged)) ?? staged.appends;
        await eventStore.appendToStreamsInTransaction(client, appends);
      }
      await client.query("INSERT INTO account_block_test_receipts (transition_id, outcome) VALUES ($1, $2)", [
        input.transitionId,
        staged.outcome,
      ]);
      await hooks.afterReceipt?.(client);
      return staged;
    });
  }

  async function commit(inputs: readonly AppendToStreamInput[]): Promise<void> {
    await withPgTransaction(pool, async (client) => {
      await store.appendToStreamsInTransaction(client, inputs);
    });
  }

  /** Commits valid retained history directly, as an earlier admission would have. */
  async function plant(steps: readonly SyntheticStep[], blocking: AccountId = blockingAccountId): Promise<void> {
    for (const step of steps) {
      const pair = pairOf(blocking, step.blockedAccountId ?? blockedAccountId);
      const encoded = encodeAccountBlockTransition(pair, step.transitionId, step.operation, step.effectiveAt);
      await commit([
        budgetInput(pair, [encoded.budgetEvent]),
        {
          streamId: accountBlockPairStreamId(pair),
          expectedVersion: "any",
          events: encoded.pairEvents,
          context: syntheticContext({ accountId: blocking }),
        },
      ]);
    }
  }

  const pairOf = (blocking: AccountId, blocked: AccountId): AccountBlockPair => ({
    tenantId: syntheticTenantId,
    blockingAccountId: blocking,
    blockedAccountId: blocked,
  });
  const budgetInput = (pair: AccountBlockPair, events: readonly EventRecordToStore[]): AppendToStreamInput => ({
    streamId: accountBlockBudgetStreamId(pair.tenantId, pair.blockingAccountId),
    expectedVersion: "any",
    events,
    context: syntheticContext({ accountId: pair.blockingAccountId }),
  });
  const pairInput = (events: readonly EventRecordToStore[], pair = syntheticPair): AppendToStreamInput => ({
    streamId: accountBlockPairStreamId(pair),
    expectedVersion: "any",
    events,
    context: syntheticContext({ accountId: pair.blockingAccountId }),
  });

  const readPair = (pair = syntheticPair) => store.readStream({ streamId: accountBlockPairStreamId(pair) });
  const readBudget = (blocking: AccountId = blockingAccountId) =>
    store.readStream({ streamId: accountBlockBudgetStreamId(syntheticTenantId, blocking) });
  const receipts = async () =>
    (
      await pool.query<{ transition_id: string; outcome: string }>(
        "SELECT transition_id, outcome FROM account_block_test_receipts ORDER BY transition_id",
      )
    ).rows;
  const serverNow = async () =>
    Date.parse(String((await pool.query<{ server_instant: string }>(serverInstantSql)).rows[0]?.server_instant));

  async function refusal(run: () => Promise<unknown>): Promise<string> {
    try {
      await run();
    } catch (error) {
      if (error instanceof AccountBlockAuthorityError) return error.code;
      return `event-store:${(error as { code?: string }).code ?? (error as Error).message}`;
    }
    return "admitted";
  }

  it("commits the Account budget entry, private transition and public fact with the receipt in one transaction", async () => {
    const before = await serverNow();
    const staged = await admit(command("first", "block"));
    const after = await serverNow();

    expect(staged).toMatchObject({ outcome: "transition", operation: "block" });
    if (staged.outcome !== "transition") throw new Error("expected a transition");
    expect(Date.parse(staged.effectiveAt)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(staged.effectiveAt)).toBeLessThanOrEqual(after);

    const [budgetEvent] = await readBudget();
    const [privateEvent, publicEvent, ...rest] = await readPair();
    expect(rest).toEqual([]);
    expect([budgetEvent?.eventType, privateEvent?.eventType, publicEvent?.eventType]).toEqual([
      accountBlockBudgetRecordedEventType,
      accountBlockTransitionRecordedEventType,
      "identity.account-blocked",
    ]);
    expect([privateEvent?.streamVersion, publicEvent?.streamVersion]).toEqual([1, 2]);
    expect(compareGlobalPosition(budgetEvent!.globalPosition, privateEvent!.globalPosition)).toBeLessThan(0);
    expect(compareGlobalPosition(privateEvent!.globalPosition, publicEvent!.globalPosition)).toBeLessThan(0);
    const ids = accountBlockEventIds(syntheticPair, staged.transitionId);
    expect([budgetEvent?.eventId, privateEvent?.eventId, publicEvent?.eventId]).toEqual([
      ids.budget,
      ids.transition,
      ids.fact,
    ]);
    for (const event of [budgetEvent!, privateEvent!, publicEvent!]) {
      expect(event.occurredAt).toBe(staged.effectiveAt);
      expect(event.performedByUserId).toBe(initiatingUserId);
      expect(JSON.stringify(event.payload)).not.toContain(initiatingUserId);
    }
    expect(publicEvent?.payload).toEqual({ blockingAccountId, blockedAccountId });
    expect(await receipts()).toEqual([{ transition_id: staged.transitionId, outcome: "transition" }]);
  });

  it("hides every participant from other connections until commit", async () => {
    let seenBeforeCommit: readonly StoredEvent[] | undefined;
    await admit(command("hidden", "block"), {
      afterReceipt: async () => {
        seenBeforeCommit = [...(await readBudget()), ...(await readPair())];
        const visibleReceipts = await receipts();
        expect(visibleReceipts).toEqual([]);
      },
    });
    expect(seenBeforeCommit).toEqual([]);
    expect(await readPair()).toHaveLength(2);
  });

  describe("rolls back every event and the receipt", () => {
    const expectNothingAdmitted = async () => {
      expect(await readPair()).toEqual([]);
      expect(await readBudget()).toEqual([]);
      expect(await receipts()).toEqual([]);
    };

    it("when the receipt write fails after the append", async () => {
      expect(
        await refusal(() =>
          admit(command("receipt-failure", "block"), {
            afterReceipt: async () => {
              throw new Error("receipt-failure");
            },
          }),
        ),
      ).toBe("event-store:receipt-failure");
      await expectNothingAdmitted();
    });

    it("when the receipt identity already exists", async () => {
      const input = command("receipt-conflict", "block");
      await pool.query("INSERT INTO account_block_test_receipts (transition_id, outcome) VALUES ($1, 'transition')", [
        input.transitionId,
      ]);
      expect(await refusal(() => admit(input))).toBe("event-store:23505");
      expect(await readPair()).toEqual([]);
      expect(await readBudget()).toEqual([]);
    });

    it("when the pair stream's expected version fails after the budget entry was inserted", async () => {
      expect(
        await refusal(() =>
          admit(command("newer-pair-write", "block"), {
            beforeAppend: async (client, staged) => {
              await store.appendToStreamsInTransaction(client, [
                { ...staged.appends[1], events: [{ eventType: "identity.account-block-planted", payload: {} }] },
              ]);
            },
          }),
        ),
      ).toBe("event-store:concurrency_conflict");
      await expectNothingAdmitted();
    });

    it("when the private transition's event id is already used with different data", async () => {
      const input = command("insert-conflict", "block");
      const planted = {
        eventId: accountBlockEventIds(syntheticPair, input.transitionId).transition,
        eventType: "identity.planted",
        payload: {},
      };
      await commit([
        {
          streamId: "identity.account-block-planted-stream",
          expectedVersion: "any",
          events: [planted],
          context: syntheticContext(),
        },
      ]);
      expect(await refusal(() => admit(input))).toBe("event-store:concurrency_conflict");
      await expectNothingAdmitted();
    });

    it("when the budget entry's event id is already used with different data", async () => {
      const input = command("budget-conflict", "block");
      const planted = {
        eventId: accountBlockEventIds(syntheticPair, input.transitionId).budget,
        eventType: "identity.planted",
        payload: {},
      };
      await commit([
        {
          streamId: "identity.account-block-planted-stream",
          expectedVersion: "any",
          events: [planted],
          context: syntheticContext(),
        },
      ]);
      expect(await refusal(() => admit(input))).toBe("event-store:concurrency_conflict");
      await expectNothingAdmitted();
    });

    it("when a retained entry fails its codec", async () => {
      const encoded = encodeAccountBlockTransition(
        syntheticPair,
        syntheticTransitionId("malformed"),
        "block",
        instant(Date.now()),
      );
      await commit([
        budgetInput(syntheticPair, [
          { ...encoded.budgetEvent, payload: { ...encoded.budgetEvent.payload, version: 2 } },
        ]),
      ]);
      expect(await refusal(() => admit(command("after-malformed", "block")))).toBe("codec");
      expect(await readPair()).toEqual([]);
      expect(await readBudget()).toHaveLength(1);
      expect(await receipts()).toEqual([]);
    });
  });

  it("serializes a newer concurrent command for the same blocking Account behind the budget lock", async () => {
    const client = await pool.connect();
    let second: Promise<AccountBlockStagedCommand> | undefined;
    try {
      await client.query("BEGIN");
      const first = await stageAccountBlockCommand(store, client, command("concurrent-first", "block"));
      if (first.outcome !== "transition") throw new Error("expected a transition");
      let secondSettled = false;
      second = admit(command("concurrent-second", "block", otherBlockedAccountId)).finally(() => {
        secondSettled = true;
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 300));
      expect(secondSettled).toBe(false);
      await store.appendToStreamsInTransaction(client, first.appends);
      await client.query("COMMIT");

      const secondResult = await second;
      if (secondResult.outcome !== "transition") throw new Error("expected a transition");
      expect(Date.parse(secondResult.effectiveAt)).toBeGreaterThanOrEqual(Date.parse(first.effectiveAt));
      const budget = await readBudget();
      expect(budget.map((event) => event.payload.transitionId)).toEqual([
        first.transitionId,
        secondResult.transitionId,
      ]);
      expect(secondResult.appends[0].expectedVersion).toBe(1);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      await second?.catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  });

  it("replays retained history written under polarized process clocks and never moves time backwards", async () => {
    const pastStore = createPostgresEventStore({ pool, now: () => "1990-01-01T00:00:00.000Z" as IsoUtcTimestamp });
    const futureStore = createPostgresEventStore({ pool, now: () => "2090-01-01T00:00:00.000Z" as IsoUtcTimestamp });
    const before = await serverNow();
    const blocked = await admit(command("polar-block", "block"), {}, pastStore);
    const unblocked = await admit(command("polar-unblock", "unblock"), {}, futureStore);
    const after = await serverNow();
    if (blocked.outcome !== "transition" || unblocked.outcome !== "transition") throw new Error("expected transitions");

    const pairEvents = await readPair();
    expect(pairEvents.map((event) => event.recordedAt)).toEqual([
      "1990-01-01T00:00:00.000Z",
      "1990-01-01T00:00:00.000Z",
      "2090-01-01T00:00:00.000Z",
      "2090-01-01T00:00:00.000Z",
    ]);
    for (const staged of [blocked, unblocked]) {
      expect(Date.parse(staged.effectiveAt)).toBeGreaterThanOrEqual(before);
      expect(Date.parse(staged.effectiveAt)).toBeLessThanOrEqual(after);
    }
    expect(Date.parse(unblocked.effectiveAt)).toBeGreaterThanOrEqual(Date.parse(blocked.effectiveAt));
    expect(foldAccountBlockPairHistory(syntheticPair, pairEvents)).toEqual({
      streamVersion: 4,
      relation: "inactive",
      transitions: [
        { transitionId: blocked.transitionId, operation: "block", effectiveAt: blocked.effectiveAt, streamVersion: 1 },
        {
          transitionId: unblocked.transitionId,
          operation: "unblock",
          effectiveAt: unblocked.effectiveAt,
          streamVersion: 3,
        },
      ],
    });

    // A retained instant ahead of the server clock is kept; the next instant equals it and follows by version.
    const ahead = instant((await serverNow()) + DAY);
    await plant([{ transitionId: syntheticTransitionId("polar-ahead"), operation: "block", effectiveAt: ahead }]);
    const next = await admit(command("polar-next", "unblock"));
    expect(next).toMatchObject({ outcome: "transition", effectiveAt: ahead });
    expect((await readPair()).map((event) => event.streamVersion)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it.each([
    ["just before one hour old counts", HOUR - 1, "limited"],
    ["exactly one hour old is excluded", HOUR, "transition"],
    ["just after the boundary is excluded", HOUR + 1, "transition"],
  ] as const)("applies the pair rolling hour to stored instants: %s", async (_label, oldestAge, outcome) => {
    const newest = Date.parse("2100-01-01T00:00:00.000Z");
    const newerNine = Array.from({ length: 9 }, (_, index) => instant(newest - (8 - index) * 60_000));
    await plant(alternatingSteps("window", [instant(newest - oldestAge), ...newerNine]));

    const staged = await admit(command("window-command", "block"));
    expect(staged).toMatchObject({ outcome, effectiveAt: instant(newest) });
    expect(await readPair()).toHaveLength(outcome === "limited" ? 20 : 22);
    expect(await readBudget()).toHaveLength(outcome === "limited" ? 10 : 11);
  });

  describe("fails closed on poisoned retained history and appends nothing", () => {
    const at = Date.parse("2026-11-01T12:00:00.000Z");
    const step = (label: string, operation: AccountBlockOperation = "block", offset = 0) => ({
      transitionId: syntheticTransitionId(label) as AccountBlockTransitionId,
      operation,
      effectiveAt: instant(at + offset),
    });
    const encode = (s: ReturnType<typeof step>) =>
      encodeAccountBlockTransition(syntheticPair, s.transitionId, s.operation, s.effectiveAt);

    it.each([
      [
        "a duplicated transition with different data",
        async () => {
          await plant([step("dup")]);
          const again = encode({ ...step("dup", "unblock", 1) });
          await commit([
            pairInput(again.pairEvents.map((event) => ({ ...event, eventId: `${event.eventId}_dup` as never }))),
          ]);
        },
        "duplicate",
      ],
      [
        "a private-only transition",
        async () => {
          const e = encode(step("private-only"));
          await commit([budgetInput(syntheticPair, [e.budgetEvent]), pairInput([e.pairEvents[0]])]);
        },
        "unpaired",
      ],
      [
        "a public-only transition",
        async () => {
          const e = encode(step("public-only"));
          await commit([budgetInput(syntheticPair, [e.budgetEvent]), pairInput([e.pairEvents[1]])]);
        },
        "unpaired",
      ],
      [
        "a reordered pairing",
        async () => {
          const e = encode(step("reordered"));
          await commit([budgetInput(syntheticPair, [e.budgetEvent]), pairInput([e.pairEvents[1], e.pairEvents[0]])]);
        },
        "unpaired",
      ],
      [
        "a missing Account budget entry",
        async () => {
          await commit([pairInput(encode(step("missing-budget")).pairEvents)]);
        },
        "budget-link",
      ],
      [
        "non-monotonic effective instants",
        async () => {
          await plant([step("first"), step("earlier", "unblock", -1)]);
        },
        "time",
      ],
      [
        "a date-only effective instant",
        async () => {
          const e = encode(step("date-only"));
          await commit([
            budgetInput(syntheticPair, [e.budgetEvent]),
            pairInput([
              { ...e.pairEvents[0], payload: { ...e.pairEvents[0].payload, effectiveAt: "2026-11-01" } },
              e.pairEvents[1],
            ]),
          ]);
        },
        "codec",
      ],
      [
        "an altered event identity",
        async () => {
          const e = encode(step("altered"));
          await commit([
            budgetInput(syntheticPair, [e.budgetEvent]),
            pairInput([{ ...e.pairEvents[0], eventId: "evt_account_block_planted" as never }, e.pairEvents[1]]),
          ]);
        },
        "identity",
      ],
    ] as const)("with %s", async (_label, poisonHistory, code) => {
      await poisonHistory();
      const pairVersion = (await readPair()).length;
      const budgetVersion = (await readBudget()).length;
      expect(await refusal(() => admit(command("after-poison", "block")))).toBe(code);
      expect(await refusal(() => admit(command("after-poison-unblock", "unblock")))).toBe(code);
      expect((await readPair()).length).toBe(pairVersion);
      expect((await readBudget()).length).toBe(budgetVersion);
      expect(await receipts()).toEqual([]);
    });
  });

  it("refuses an authority stream beyond the unsnapshotted tail instead of replaying it", async () => {
    const yesterday = (await serverNow()) - DAY;
    const minutes = (count: number, from: number) =>
      Array.from({ length: count }, (_, index) => instant(from + index * 60_000));
    await plant(alternatingSteps("budget-tail", minutes(31, yesterday), otherBlockedAccountId));
    expect(await admit(command("tail-31", "block"))).toMatchObject({ outcome: "transition" });
    expect(await readBudget()).toHaveLength(32);
    expect(await refusal(() => admit(command("tail-32", "unblock")))).toBe("tail-bound");
    expect(await readPair()).toHaveLength(2);

    // Sixteen pair transitions are 32 pair events: the pair stream is bounded the same way.
    const pairBlocking = otherBlockedAccountId;
    await plant(alternatingSteps("pair-tail", minutes(16, yesterday)), pairBlocking);
    expect(await refusal(() => admit(command("pair-tail-command", "block", blockedAccountId, pairBlocking)))).toBe(
      "tail-bound",
    );
    expect(await readPair(pairOf(pairBlocking, blockedAccountId))).toHaveLength(32);
  });

  it("keeps both steady states across already-in-state, duplicate and next-day commands", async () => {
    const blocked = await admit(command("steady-block", "block"));
    expect(blocked).toMatchObject({ outcome: "transition" });
    expect(await admit(command("steady-block-again", "block"))).toEqual({
      outcome: "already-in-state",
      relation: "active",
    });
    expect(await admit(command("steady-block", "block"))).toMatchObject({ outcome: "already-recorded" });
    expect(await admit(command("steady-unblock", "unblock"))).toMatchObject({ outcome: "transition" });
    expect(await admit(command("steady-unblock-again", "unblock"))).toEqual({
      outcome: "already-in-state",
      relation: "inactive",
    });
    expect(await readPair()).toHaveLength(4);
    expect(await readBudget()).toHaveLength(2);
  });

  it("accepts ordinary next-day commands from both steady states after a full window yesterday", async () => {
    const now = await serverNow();
    const yesterday = now - DAY;
    const minutes = (count: number, from: number) =>
      Array.from({ length: count }, (_, index) => instant(from + index * 60_000));
    await plant(alternatingSteps("yesterday-inactive", minutes(10, yesterday)));
    await plant(alternatingSteps("yesterday-active", minutes(11, yesterday + 15 * 60_000), otherBlockedAccountId));

    const block = await admit(command("today-block", "block"));
    expect(block).toMatchObject({ outcome: "transition", operation: "block" });
    if (block.outcome !== "transition") throw new Error("expected a transition");
    expect(Date.parse(block.effectiveAt)).toBeGreaterThanOrEqual(now);
    expect(await admit(command("today-unblock", "unblock", otherBlockedAccountId))).toMatchObject({
      outcome: "transition",
      operation: "unblock",
    });
  });
});
