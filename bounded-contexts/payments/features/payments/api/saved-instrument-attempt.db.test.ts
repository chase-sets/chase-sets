import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, onTestFinished } from "vitest";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { createPostgresEventStore, type PgQueryable, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { EventRecordToStore, EventStoreContext } from "@chase-sets/event-core/storage";
import type { PaymentProcessorGateway } from "@chase-sets/payment-processing";
import { createFakePaymentProcessorGateway } from "@chase-sets/payment-processing/test-support";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import { module as paymentsModule } from "../../../index";
import { createPaymentsServices } from "../../../support/runtime-support/services";
import { recordSavedCheckoutSetupSession, upsertSavedCheckoutInstrument } from "../read-model/queries";
import {
  SAVED_CHECKOUT_INSTRUMENT_ATTEMPT_COMPLETED,
  SAVED_CHECKOUT_INSTRUMENT_ATTEMPT_STARTED,
  savedCheckoutInstrumentAttemptFingerprint,
} from "./runtime";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required for the saved-instrument-attempt DB proof.");

const accountId = "acc_SYNTHETIC_ATTEMPT" as AccountId;
const context: EventStoreContext = {
  tenantId: "tnt_SYNTHETIC_ATTEMPT" as never,
  audit: { performedByUserId: "usr_SYNTHETIC_ATTEMPT" as never, forAccountId: accountId },
};
const base = "https://example.com";
const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
// Independently recomputed from the brief, so a drifted stream identity fails here.
const streamIdFor = (attemptId: string, account: string = accountId) =>
  `payments.saved-checkout-instrument-attempt-${sha256(JSON.stringify([account, attemptId]))}`;
let ids = 0;
const freshAttemptId = () => {
  ids += 1;
  return `00000000-0000-4000-8000-${String(ids).padStart(12, "0")}`;
};

type Runtime = "primary" | "replica";
type Statement = Readonly<{ runtime: Runtime; client: number; sql: string; params: readonly unknown[] }>;
const passThrough = (_statement: Statement, run: () => Promise<unknown>) => run();

describe("saved-instrument-attempt (synthetic DB proof)", () => {
  let pools: Readonly<Record<"payments", PgTransactionalPool>>;
  // A second pool on the same database stands in for another replica's runtime.
  let replicaPools: Readonly<Record<"payments", PgTransactionalPool>>;
  let writes: string[] = [];
  let intercept: (statement: Statement, run: () => Promise<unknown>) => Promise<unknown> = passThrough;
  let clients = 0;
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseUrl, ["payments"], "saved_instrument_attempt");
    await ensureMultiContextTestDatabases(databaseUrl, urls);
    pools = createMultiContextTestPools(urls);
    replicaPools = createMultiContextTestPools(urls);
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await bootstrapContextDatabase(paymentsModule, pools.payments);
    writes = [];
    intercept = passThrough;
  });
  afterAll(async () => {
    if (pools) await closeMultiContextTestPools(pools);
    if (replicaPools) await closeMultiContextTestPools(replicaPools);
  });

  /**
   * The pool a runtime sees. Every statement, pooled or on a transaction client, passes through
   * `intercept` (which may hold it at a barrier or fail it before or after it runs) and is counted
   * in `writes` when it writes a saved-instrument table.
   */
  function observedPool(pool: PgTransactionalPool, runtime: Runtime): PgTransactionalPool {
    const observe =
      (client: number, query: PgQueryable["query"]) =>
      (sql: string, params: readonly unknown[] = []) =>
        intercept({ runtime, client, sql, params }, async () => {
          const result = await query(sql, params);
          if (/^\s*(INSERT|UPDATE|DELETE|WITH)\b/i.test(sql) && /payments_saved_checkout/.test(sql)) writes.push(sql);
          return result;
        });
    return {
      query: observe(0, pool.query.bind(pool)) as PgQueryable["query"],
      async connect() {
        const client = await pool.connect();
        clients += 1;
        // Names the backend after its runtime, so a pg_stat_activity capture tells the two apart.
        await client.query("SELECT set_config('application_name', $1, false)", [
          `payments-saved-instrument-attempt-${runtime}`,
        ]);
        return {
          query: observe(clients, client.query.bind(client)) as PgQueryable["query"],
          release: (error?: unknown) => client.release(error),
        };
      },
      idleInTransactionSessionTimeoutMillis: pool.idleInTransactionSessionTimeoutMillis,
    };
  }

  function harness(overrides: Partial<PaymentProcessorGateway> = {}, runtime: Runtime = "primary") {
    const calls = { createCustomer: 0, createSetupSession: 0, detach: 0 };
    const eventStore = createPostgresEventStore({ pool: pools.payments });
    const startedExists = async (setupReferenceId: string) =>
      (await eventStore.readAll({ streamPrefixes: ["payments.saved-checkout-instrument-attempt-"], limit: 500 })).some(
        (event) =>
          event.eventType === SAVED_CHECKOUT_INSTRUMENT_ATTEMPT_STARTED &&
          (event.payload as { setupReferenceId?: string }).setupReferenceId === setupReferenceId,
      );
    const fake = createFakePaymentProcessorGateway();
    const processorGateway: PaymentProcessorGateway = {
      ...fake,
      async createCustomer(input) {
        calls.createCustomer += 1;
        return fake.createCustomer(input);
      },
      async createSetupSession(input) {
        calls.createSetupSession += 1;
        const setupReferenceId = new URL(input.returnUrl!).searchParams.get("setupReferenceId")!;
        // Send-before-started guard: the attempt's `started` fact must already be durable.
        if (!(await startedExists(setupReferenceId))) throw new Error("SYNTHETIC_SENT_BEFORE_STARTED");
        return {
          processorName: "stripe",
          processorSetupKind: "checkout-setup-session",
          processorSetupReference: `cs_SYNTHETIC_${calls.createSetupSession}`,
          processorClientSecret: null,
          processorRedirectUrl: `https://checkout.stripe.test/SYNTHETIC_${calls.createSetupSession}`,
          processorStatus: "open",
        } as Awaited<ReturnType<PaymentProcessorGateway["createSetupSession"]>>;
      },
      async detachSavedPaymentMethod(providerReference) {
        calls.detach += 1;
        return fake.detachSavedPaymentMethod(providerReference);
      },
      ...overrides,
    };
    const pool = runtime === "primary" ? pools.payments : replicaPools.payments;
    const services = createPaymentsServices(observedPool(pool, runtime), { processorGateway }).payments;
    return {
      calls,
      services,
      eventStore,
      get writes() {
        return writes;
      },
    };
  }

  async function seedInstrument(instrumentId: string, readiness: "ready" | "removed" = "ready", isDefault = false) {
    await upsertSavedCheckoutInstrument(pools.payments, {
      instrumentId,
      accountId,
      paymentMethodCategory: "card",
      provider: "stripe",
      providerCustomerReference: "cus_SYNTHETIC",
      providerReference: `pm_SYNTHETIC_${instrumentId}`,
      displayLabel: "Visa ending in 4242",
      confirmationExperience: "off-session-token",
      readiness,
      isDefault,
      ...(readiness === "removed" ? { removedAt: "2026-10-01T00:00:00.000Z" } : {}),
    });
  }

  async function auditRows(instrumentId: string) {
    return (
      await pools.payments.query<{ action: string }>(
        "SELECT action FROM payments_saved_checkout_instrument_audit WHERE instrument_id = $1",
        [instrumentId],
      )
    ).rows;
  }

  async function streamEvents(eventStore: ReturnType<typeof createPostgresEventStore>, attemptId: string) {
    return eventStore.readStream({ streamId: streamIdFor(attemptId), limit: 500 });
  }

  async function eventTypes(eventStore: ReturnType<typeof createPostgresEventStore>, attemptId: string) {
    return (await streamEvents(eventStore, attemptId)).map((event) => event.eventType);
  }

  async function defaults() {
    return (
      await pools.payments.query<{ instrument_id: string }>(
        "SELECT instrument_id FROM payments_saved_checkout_instruments WHERE account_id = $1 AND is_default",
        [accountId],
      )
    ).rows.map((row) => row.instrument_id);
  }

  async function publications() {
    const eventStore = createPostgresEventStore({ pool: pools.payments });
    return (await eventStore.readStream({ streamId: `payments.checkout-affordances-${accountId}`, limit: 500 })).length;
  }

  /**
   * Both runtimes' backends while a party is parked, read until `settled()` or until one backend
   * waits on another (polling no longer than `bounded`), so the capture shows any wait it causes.
   */
  async function parkedActivity(settled: () => boolean) {
    for (let polls = 1; ; polls += 1) {
      const { rows } = await pools.payments.query<{
        pid: number;
        application_name: string;
        state: string | null;
        wait_event_type: string | null;
        wait_event: string | null;
        backend_xid: string | null;
        blocked_by: number[];
      }>(
        `SELECT pid, application_name, state, wait_event_type, wait_event, backend_xid::text AS backend_xid,
                pg_blocking_pids(pid) AS blocked_by
         FROM pg_stat_activity
         WHERE datname = current_database() AND pid <> pg_backend_pid()
           AND application_name IN ('payments-saved-instrument-attempt-primary', 'payments-saved-instrument-attempt-replica')`,
      );
      if (settled() || rows.some((row) => row.blocked_by.length > 0) || polls === 400) return rows;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  const isDefaultWrite = (sql: string) => /SET is_default = instrument_id/.test(sql);
  // The event store's first statement of every append, so it marks which stream a client appends to.
  const streamUpsert = (statement: Statement, streamId: string) =>
    /INSERT INTO event_store_streams/.test(statement.sql) && statement.params[0] === streamId;
  // The runtime's attempt lock only: the event store's shared append lock is taken mid-append, while
  // that append's stream row is still uncommitted, so holding a runtime there blocks the other's append.
  const isAttemptLock = (statement: Statement, attemptId?: string) =>
    /pg_advisory_xact_lock\(hashtextextended/.test(statement.sql) &&
    (attemptId === undefined || statement.params[0] === `payments-command:${streamIdFor(attemptId)}`);
  const deferred = () => {
    let resolve!: () => void;
    let settled = false;
    const promise = new Promise<void>((done) => {
      resolve = () => {
        settled = true;
        done();
      };
    });
    return {
      promise,
      resolve,
      get settled() {
        return settled;
      },
    };
  };
  // A barrier opens after a bound instead of hanging, so a red head fails on its assertions.
  const bounded = async (promise: Promise<void>) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const opened = await Promise.race([
      promise.then(() => true),
      new Promise<boolean>((done) => {
        timer = setTimeout(() => done(false), 20_000);
      }),
    ]);
    clearTimeout(timer);
    return opened;
  };

  async function appendHistory(attemptId: string, events: readonly EventRecordToStore[]) {
    const eventStore = createPostgresEventStore({ pool: pools.payments });
    await eventStore.appendToStream({
      streamId: streamIdFor(attemptId),
      expectedVersion: "no_stream",
      context,
      events,
    });
  }

  const fingerprint = (kind: "setup" | "default" | "remove", instrumentId: string | null) =>
    savedCheckoutInstrumentAttemptFingerprint({
      kind,
      accountId,
      instrumentId,
      uiMode: kind === "setup" ? "hosted" : null,
      returnUrl: kind === "setup" ? `${base}/account/payment-methods` : null,
    });
  const started = (kind: "setup" | "default" | "remove", target: string, payload: Record<string, unknown> = {}) => ({
    eventType: SAVED_CHECKOUT_INSTRUMENT_ATTEMPT_STARTED,
    payload: {
      version: 1,
      kind,
      accountId,
      ...(kind === "setup" ? { setupReferenceId: target } : { instrumentId: target }),
      fingerprint: fingerprint(kind, kind === "setup" ? null : target),
      ...payload,
    },
  });
  const setup = (services: ReturnType<typeof harness>["services"], attemptId: string, input: object = {}) =>
    services.createSavedCheckoutSetupSession(
      { accountId, attemptId, returnUrlBase: base, returnUrlPath: "/account/payment-methods", ...input },
      context,
    );

  describe("AC2 setup", () => {
    it("sends zero further setups after the first, also for concurrent exact submits", async () => {
      const { calls, services, eventStore } = harness();
      const attemptId = freshAttemptId();
      const first = await setup(services, attemptId);
      const replay = await setup(services, attemptId);
      expect(replay).toEqual(first);
      expect(calls.createSetupSession).toBe(1);
      expect((await streamEvents(eventStore, attemptId)).map((event) => event.eventType)).toEqual([
        SAVED_CHECKOUT_INSTRUMENT_ATTEMPT_STARTED,
        SAVED_CHECKOUT_INSTRUMENT_ATTEMPT_COMPLETED,
      ]);

      const concurrentId = freshAttemptId();
      const results = await Promise.allSettled([setup(services, concurrentId), setup(services, concurrentId)]);
      expect(calls.createSetupSession).toBe(2);
      const fulfilled = results.filter((result) => result.status === "fulfilled");
      expect(fulfilled.length).toBeGreaterThanOrEqual(1);
      for (const result of results) {
        if (result.status === "rejected") expect(result.reason).toMatchObject({ code: "attempt_unconfirmed" });
      }
      await expect(setup(services, concurrentId)).resolves.toEqual(
        (fulfilled[0] as PromiseFulfilledResult<unknown>).value,
      );
      expect(calls.createSetupSession).toBe(2);
    });

    it("shares one stream for equivalent return URLs and conflicts before any write on every changed field", async () => {
      const { calls, services, writes } = harness();
      const attemptId = freshAttemptId();
      const input = { returnUrlBase: "HTTPS://Example.COM:443", returnUrlPath: "/a/./b?x=1&y=2#f" };
      const first = await setup(services, attemptId, input);
      await expect(
        setup(services, attemptId, { returnUrlBase: "https://example.com", returnUrlPath: "/a/b?x=1&y=2" }),
      ).resolves.toEqual(first);
      expect(calls.createSetupSession).toBe(1);
      const writesAfterFirst = writes.length;

      for (const changed of [
        { returnUrlPath: "/A/b?x=1&y=2" },
        { returnUrlPath: "/a/b/?x=1&y=2" },
        { returnUrlPath: "/a/b?y=2&x=1" },
        { agentGrantId: "lpa_SYNTHETIC_OTHER" },
        { uiMode: "embedded" as const },
      ]) {
        await expect(setup(services, attemptId, { ...input, ...changed })).rejects.toMatchObject({
          code: "attempt_conflict",
        });
      }
      expect(calls).toMatchObject({ createCustomer: 1, createSetupSession: 1 });
      expect(writes.length).toBe(writesAfterFirst);
    });

    it("refuses an unparseable or origin-leaving return URL and a non-canonical id before started", async () => {
      const { calls, services, eventStore } = harness();
      const attemptId = freshAttemptId();
      for (const input of [
        { returnUrlBase: "" },
        { returnUrlPath: "@evil.test/x" },
        { returnUrlPath: "//evil.test/x" },
      ]) {
        await expect(setup(services, attemptId, input)).rejects.toMatchObject({ code: "validation_failed" });
      }
      for (const nonCanonical of [
        "SYNTHETIC-NOT-A-UUID",
        "00000000-0000-1000-8000-000000000000",
        attemptId.replace("4000", "4ABC"),
      ]) {
        await expect(setup(services, nonCanonical)).rejects.toMatchObject({ code: "validation_failed" });
      }
      expect(await streamEvents(eventStore, attemptId)).toEqual([]);
      expect(calls).toMatchObject({ createCustomer: 0, createSetupSession: 0 });
    });
  });

  describe("AC3 Decision 2 cells", () => {
    it("setup: completed replays the first receipt; started-only returns a stored session or stays unconfirmed", async () => {
      const { calls, services, eventStore, writes } = harness();
      const attemptId = freshAttemptId();
      const first = await setup(services, attemptId);
      const writesAfterFirst = writes.length;
      await expect(setup(services, attemptId)).resolves.toEqual(first);
      expect(writes.length).toBe(writesAfterFirst);

      const orphan = freshAttemptId();
      await appendHistory(orphan, [started("setup", "scs_SYNTHETIC_ORPHAN")]);
      await expect(setup(services, orphan)).rejects.toMatchObject({ code: "attempt_unconfirmed" });
      await expect(setup(services, orphan)).rejects.toMatchObject({ code: "attempt_unconfirmed" });
      expect(await streamEvents(eventStore, orphan)).toHaveLength(1);

      const crashed = freshAttemptId();
      await appendHistory(crashed, [started("setup", first.setup_reference_id)]);
      await expect(setup(services, crashed)).resolves.toMatchObject({ setup_reference_id: first.setup_reference_id });
      expect((await streamEvents(eventStore, crashed)).map((event) => event.eventType)).toEqual([
        SAVED_CHECKOUT_INSTRUMENT_ATTEMPT_STARTED,
        SAVED_CHECKOUT_INSTRUMENT_ATTEMPT_COMPLETED,
      ]);
      expect(calls).toMatchObject({ createCustomer: 1, createSetupSession: 1 });
    });

    it("default: completed is zero writes and audit; started-only applies one write and one audit row", async () => {
      const { services, eventStore, writes } = harness();
      await seedInstrument("sci_SYNTHETIC_A", "ready", true);
      await seedInstrument("sci_SYNTHETIC_B");
      const attemptId = freshAttemptId();
      const command = { accountId, instrumentId: "sci_SYNTHETIC_B", attemptId };
      await expect(services.setSavedCheckoutInstrumentDefault(command, context)).resolves.toMatchObject({
        is_default: true,
      });
      const writesAfterFirst = writes.length;
      await services.setSavedCheckoutInstrumentDefault(command, context);
      expect(writes.length).toBe(writesAfterFirst);
      expect(await auditRows("sci_SYNTHETIC_B")).toEqual([{ action: "set-default" }]);

      const resumed = freshAttemptId();
      await appendHistory(resumed, [started("default", "sci_SYNTHETIC_A")]);
      const before = writes.length;
      await expect(
        services.setSavedCheckoutInstrumentDefault(
          { accountId, instrumentId: "sci_SYNTHETIC_A", attemptId: resumed },
          context,
        ),
      ).resolves.toMatchObject({ is_default: true });
      expect(writes.slice(before).filter((sql) => /SET is_default = instrument_id/.test(sql))).toHaveLength(1);
      expect(await auditRows("sci_SYNTHETIC_A")).toEqual([{ action: "set-default" }]);
      expect(await streamEvents(eventStore, resumed)).toHaveLength(2);
    });

    it("remove: a locally removed instrument, fresh or replayed, completes with zero detach and zero audit", async () => {
      const { calls, services, eventStore, writes } = harness();
      await seedInstrument("sci_SYNTHETIC_GONE", "removed");
      const fresh = freshAttemptId();
      const before = writes.length;
      await expect(
        services.removeSavedCheckoutInstrument(
          { accountId, instrumentId: "sci_SYNTHETIC_GONE", attemptId: fresh },
          context,
        ),
      ).resolves.toMatchObject({ readiness: "removed" });
      await services.removeSavedCheckoutInstrument(
        { accountId, instrumentId: "sci_SYNTHETIC_GONE", attemptId: fresh },
        context,
      );
      const resumed = freshAttemptId();
      await appendHistory(resumed, [started("remove", "sci_SYNTHETIC_GONE")]);
      await services.removeSavedCheckoutInstrument(
        { accountId, instrumentId: "sci_SYNTHETIC_GONE", attemptId: resumed },
        context,
      );
      expect(calls.detach).toBe(0);
      expect(writes.length).toBe(before);
      expect(await auditRows("sci_SYNTHETIC_GONE")).toEqual([]);
      expect(await streamEvents(eventStore, fresh)).toHaveLength(2);
      expect(await streamEvents(eventStore, resumed)).toHaveLength(2);
    });

    it("remove: a lost detach replays with zero detach and stays unconfirmed; a first remove detaches once", async () => {
      let lose = true;
      const { calls, services, eventStore } = harness({
        async detachSavedPaymentMethod() {
          calls.detach += 1;
          if (lose) throw new Error("SYNTHETIC_PRIVATE_TRANSPORT_ERROR");
          return createFakePaymentProcessorGateway().detachSavedPaymentMethod("pm_SYNTHETIC");
        },
      });
      await seedInstrument("sci_SYNTHETIC_LOST");
      const attemptId = freshAttemptId();
      const command = { accountId, instrumentId: "sci_SYNTHETIC_LOST", attemptId };
      const failure = await services.removeSavedCheckoutInstrument(command, context).catch((error: Error) => error);
      expect(failure).toMatchObject({ code: "attempt_unconfirmed" });
      expect(String((failure as Error).message)).not.toContain("SYNTHETIC_PRIVATE_TRANSPORT_ERROR");
      lose = false;
      await expect(services.removeSavedCheckoutInstrument(command, context)).rejects.toMatchObject({
        code: "attempt_unconfirmed",
      });
      expect(calls.detach).toBe(1);
      expect(await streamEvents(eventStore, attemptId)).toHaveLength(1);
      expect(await auditRows("sci_SYNTHETIC_LOST")).toEqual([]);

      await seedInstrument("sci_SYNTHETIC_ONCE");
      const once = { accountId, instrumentId: "sci_SYNTHETIC_ONCE", attemptId: freshAttemptId() };
      await expect(services.removeSavedCheckoutInstrument(once, context)).resolves.toMatchObject({
        readiness: "removed",
      });
      await expect(services.removeSavedCheckoutInstrument(once, context)).resolves.toMatchObject({
        readiness: "removed",
      });
      expect(calls.detach).toBe(2);
      expect(await auditRows("sci_SYNTHETIC_ONCE")).toEqual([{ action: "removed" }]);
    });

    it("conflicts a reused id on another target, kind or actor before any write, with no receipt", async () => {
      const { calls, services, writes } = harness();
      await seedInstrument("sci_SYNTHETIC_A", "ready", true);
      await seedInstrument("sci_SYNTHETIC_B");
      const attemptId = freshAttemptId();
      await services.setSavedCheckoutInstrumentDefault(
        { accountId, instrumentId: "sci_SYNTHETIC_B", attemptId },
        context,
      );
      const before = writes.length;
      for (const attempt of [
        () =>
          services.setSavedCheckoutInstrumentDefault(
            { accountId, instrumentId: "sci_SYNTHETIC_A", attemptId },
            context,
          ),
        () =>
          services.removeSavedCheckoutInstrument({ accountId, instrumentId: "sci_SYNTHETIC_B", attemptId }, context),
        () =>
          services.setSavedCheckoutInstrumentDefault(
            { accountId, instrumentId: "sci_SYNTHETIC_B", attemptId, agentGrantId: "lpa_SYNTHETIC" },
            context,
          ),
        () => setup(services, attemptId),
      ]) {
        await expect(attempt()).rejects.toMatchObject({ code: "attempt_conflict" });
      }
      expect(writes.length).toBe(before);
      expect(calls).toMatchObject({ createCustomer: 0, createSetupSession: 0, detach: 0 });
    });
  });

  describe("AC5 history matrix", () => {
    type Kind = "setup" | "default" | "remove";
    // A receipt that is valid for its kind, so each poisoned history below has exactly one defect.
    const receipt = (kind: Kind, target: string, attemptId: string): EventRecordToStore => ({
      eventType: SAVED_CHECKOUT_INSTRUMENT_ATTEMPT_COMPLETED,
      payload:
        kind === "setup"
          ? { version: 1, kind, setupReferenceId: target }
          : {
              version: 1,
              kind,
              instrumentId: target,
              auditId:
                kind === "remove"
                  ? null
                  : `audit_${kind}_${sha256(JSON.stringify([streamIdFor(attemptId), fingerprint(kind, target)]))}`,
            },
    });
    const poisoned: readonly (readonly [
      string,
      (target: string, kind: Kind, attemptId: string) => EventRecordToStore[],
    ])[] = [
      ["poisoned extra field", (target, kind) => [started(kind, target, { extra: "SYNTHETIC" })]],
      ["foreign account", (target, kind) => [started(kind, target, { accountId: "acc_SYNTHETIC_FOREIGN" })]],
      [
        "wrong kind",
        (target, kind) => [
          started(kind === "setup" ? "default" : "setup", target, {
            fingerprint: fingerprint(kind, kind === "setup" ? null : target),
          }),
        ],
      ],
      [
        "unknown event type",
        (target, kind) => [
          { ...started(kind, target), eventType: "payments.saved-checkout-instrument-attempt.unknown.v1" },
        ],
      ],
      ["out of order", (target, kind, attemptId) => [receipt(kind, target, attemptId), started(kind, target)]],
      [
        "over 10 events",
        (target, kind, attemptId) => [
          started(kind, target),
          ...Array.from({ length: 10 }, () => receipt(kind, target, attemptId)),
        ],
      ],
      [
        "duplicate completion",
        (target, kind, attemptId) => [
          started(kind, target),
          receipt(kind, target, attemptId),
          receipt(kind, target, attemptId),
        ],
      ],
    ];

    async function seedTargets() {
      await seedInstrument("sci_SYNTHETIC_TARGET");
      await recordSavedCheckoutSetupSession(pools.payments, {
        setupReferenceId: "scs_SYNTHETIC_TARGET",
        accountId,
        provider: "stripe",
        providerCustomerReference: "cus_SYNTHETIC",
        processorSetupReference: "cs_SYNTHETIC_TARGET",
        processorStatus: "open",
        consentId: "consent_SYNTHETIC",
        consentText: "Synthetic consent",
      });
      writes.length = 0;
    }
    const replayFor = (services: ReturnType<typeof harness>["services"], kind: Kind, attemptId: string) => {
      const target = kind === "setup" ? "scs_SYNTHETIC_TARGET" : "sci_SYNTHETIC_TARGET";
      return () =>
        kind === "setup"
          ? setup(services, attemptId)
          : kind === "default"
            ? services.setSavedCheckoutInstrumentDefault({ accountId, instrumentId: target, attemptId }, context)
            : services.removeSavedCheckoutInstrument({ accountId, instrumentId: target, attemptId }, context);
    };

    it.each(["setup", "default", "remove"] as const)(
      "control: the unpoisoned started+completed history for %s replays its receipt",
      async (kind) => {
        const { calls, services, writes } = harness();
        await seedTargets();
        const attemptId = freshAttemptId();
        const target = kind === "setup" ? "scs_SYNTHETIC_TARGET" : "sci_SYNTHETIC_TARGET";
        await appendHistory(attemptId, [started(kind, target), receipt(kind, target, attemptId)]);
        await expect(replayFor(services, kind, attemptId)()).resolves.toBeTruthy();
        expect(calls).toMatchObject({ createCustomer: 0, createSetupSession: 0, detach: 0 });
        expect(writes).toEqual([]);
      },
    );

    it.each(
      poisoned.flatMap(([label, history]) =>
        (["setup", "default", "remove"] as const).map((kind) => [label, kind, history] as const),
      ),
    )(
      "%s history for %s fails closed as attempt_unconfirmed with zero processor calls and writes",
      async (_label, kind, history) => {
        const { calls, services, eventStore, writes } = harness();
        await seedTargets();
        const attemptId = freshAttemptId();
        const target = kind === "setup" ? "scs_SYNTHETIC_TARGET" : "sci_SYNTHETIC_TARGET";
        await appendHistory(attemptId, history(target, kind, attemptId));
        const retained = await streamEvents(eventStore, attemptId);
        const replay = replayFor(services, kind, attemptId);
        await expect(replay()).rejects.toMatchObject({ code: "attempt_unconfirmed" });
        await expect(replay()).rejects.toMatchObject({ code: "attempt_unconfirmed" });
        expect(calls).toMatchObject({ createCustomer: 0, createSetupSession: 0, detach: 0 });
        expect(writes).toEqual([]);
        expect(await streamEvents(eventStore, attemptId)).toEqual(retained);
      },
    );

    it.each(
      (["default", "remove"] as const).flatMap((kind) =>
        (["started-only", "started+completed"] as const).map((shape) => [kind, shape] as const),
      ),
    )(
      "a %s history (%s) whose retained target is not the request's fails closed, first and day after",
      async (kind, shape) => {
        const { calls, services, eventStore } = harness();
        await seedTargets();
        await seedInstrument("sci_SYNTHETIC_FOREIGN");
        const attemptId = freshAttemptId();
        // The request's own fingerprint over another retained instrument; the receipt matches its
        // `started`, so only the target binding can refuse it.
        const requestFingerprint = fingerprint(kind, "sci_SYNTHETIC_TARGET");
        const history: EventRecordToStore[] = [
          started(kind, "sci_SYNTHETIC_FOREIGN", { fingerprint: requestFingerprint }),
          {
            eventType: SAVED_CHECKOUT_INSTRUMENT_ATTEMPT_COMPLETED,
            payload: {
              version: 1,
              kind,
              instrumentId: "sci_SYNTHETIC_FOREIGN",
              auditId: `audit_${kind}_${sha256(JSON.stringify([streamIdFor(attemptId), requestFingerprint]))}`,
            },
          },
        ];
        await appendHistory(attemptId, shape === "started-only" ? history.slice(0, 1) : history);
        const retained = await streamEvents(eventStore, attemptId);
        const replay = replayFor(services, kind, attemptId);
        for (let day = 0; day < 2; day += 1) {
          await expect(replay()).rejects.toMatchObject({ code: "attempt_unconfirmed" });
        }
        expect(calls).toMatchObject({ createCustomer: 0, createSetupSession: 0, detach: 0 });
        expect(writes).toEqual([]);
        expect(await defaults()).toEqual([]);
        expect(await streamEvents(eventStore, attemptId)).toEqual(retained);
      },
    );

    it("day-after replay from every retained state appends nothing and calls nothing", async () => {
      const { calls, services, eventStore, writes } = harness({
        async detachSavedPaymentMethod() {
          calls.detach += 1;
          throw new Error("SYNTHETIC_LOST");
        },
      });
      await seedInstrument("sci_SYNTHETIC_A", "ready", true);
      await seedInstrument("sci_SYNTHETIC_B");
      await seedInstrument("sci_SYNTHETIC_GONE", "removed");
      const setupId = freshAttemptId();
      const defaultId = freshAttemptId();
      const removedId = freshAttemptId();
      const lostId = freshAttemptId();
      const orphanId = freshAttemptId();
      const commands = [
        () => setup(services, setupId),
        () =>
          services.setSavedCheckoutInstrumentDefault(
            { accountId, instrumentId: "sci_SYNTHETIC_B", attemptId: defaultId },
            context,
          ),
        () =>
          services.removeSavedCheckoutInstrument(
            { accountId, instrumentId: "sci_SYNTHETIC_GONE", attemptId: removedId },
            context,
          ),
        () =>
          services.removeSavedCheckoutInstrument(
            { accountId, instrumentId: "sci_SYNTHETIC_A", attemptId: lostId },
            context,
          ),
        () => setup(services, orphanId),
      ];
      await appendHistory(orphanId, [started("setup", "scs_SYNTHETIC_ORPHAN")]);
      for (const command of commands) await command().catch(() => undefined);
      const retained = await Promise.all(
        [setupId, defaultId, removedId, lostId, orphanId].map((attemptId) => streamEvents(eventStore, attemptId)),
      );
      expect(retained.map((events) => events.length)).toEqual([2, 2, 2, 1, 1]);
      const callsBefore = { ...calls };
      const writesBefore = writes.length;
      for (let day = 0; day < 2; day += 1) {
        for (const command of commands) await command().catch(() => undefined);
      }
      expect(calls).toEqual(callsBefore);
      expect(writes.length).toBe(writesBefore);
      expect(
        await Promise.all(
          [setupId, defaultId, removedId, lostId, orphanId].map((attemptId) => streamEvents(eventStore, attemptId)),
        ),
      ).toEqual(retained);
    });
  });

  describe("F1 default effect under the attempt lock", () => {
    beforeEach(async () => {
      await seedInstrument("sci_SYNTHETIC_A", "ready", true);
      await seedInstrument("sci_SYNTHETIC_B");
    });

    it("applies an exact default racing on two runtimes once: one update, audit row and publication", async () => {
      const primary = harness();
      const replica = harness({}, "replica");
      const command = { accountId, instrumentId: "sci_SYNTHETIC_B", attemptId: freshAttemptId() };
      // The first runtime to reach its default update holds there until the other is admitted (it
      // asks for the attempt lock, or reaches its own update), so both copies are in flight at once.
      const admitted = { primary: deferred(), replica: deferred() };
      const opened: boolean[] = [];
      intercept = async (statement, run) => {
        if (isAttemptLock(statement) || isDefaultWrite(statement.sql)) admitted[statement.runtime].resolve();
        if (isDefaultWrite(statement.sql)) {
          opened.push(await bounded(admitted[statement.runtime === "primary" ? "replica" : "primary"].promise));
        }
        return run();
      };

      const results = await Promise.all([
        primary.services.setSavedCheckoutInstrumentDefault(command, context),
        replica.services.setSavedCheckoutInstrumentDefault(command, context),
      ]);

      expect(results).toEqual([
        expect.objectContaining({ instrument_id: "sci_SYNTHETIC_B", is_default: true }),
        expect.objectContaining({ instrument_id: "sci_SYNTHETIC_B", is_default: true }),
      ]);
      expect(opened).toEqual([true]);
      expect(writes.filter(isDefaultWrite)).toHaveLength(1);
      expect(await auditRows("sci_SYNTHETIC_B")).toEqual([{ action: "set-default" }]);
      expect(await publications()).toBe(1);
      expect(await defaults()).toEqual(["sci_SYNTHETIC_B"]);
      expect(await eventTypes(primary.eventStore, command.attemptId)).toEqual([
        SAVED_CHECKOUT_INSTRUMENT_ATTEMPT_STARTED,
        SAVED_CHECKOUT_INSTRUMENT_ATTEMPT_COMPLETED,
      ]);
    });

    it("detects a forced late second read without accepting the old race outcome", async () => {
      const primary = harness();
      const replica = harness({}, "replica");
      const command = { accountId, instrumentId: "sci_SYNTHETIC_B", attemptId: freshAttemptId() };
      const streamId = streamIdFor(command.attemptId);
      const firstStartedCommit = deferred();
      const appended: Runtime[] = [];
      const trace: Array<{ event: string; runtime?: Runtime; detail?: unknown }> = [];
      const readAbsent: Record<Runtime, boolean> = { primary: false, replica: false };
      let lateSecondRead = false;
      let firstStarted: Runtime | undefined;
      let firstReadRuntime: Runtime | undefined;
      let readReleased = false;

      intercept = async (statement, run) => {
        const readsAttemptStream =
          /^\s*SELECT\b/i.test(statement.sql) &&
          /\bFROM\s+event_store_events\b/i.test(statement.sql) &&
          statement.params[0] === streamId;
        if (readsAttemptStream) {
          if (firstReadRuntime === undefined) firstReadRuntime = statement.runtime;
          if (statement.runtime !== firstReadRuntime && !readReleased) {
            await firstStartedCommit.promise;
            readReleased = true;
          }
          const result = await run();
          const rows = (result as { rows?: readonly unknown[] }).rows;
          if (!readAbsent[statement.runtime] && rows?.length === 0) {
            readAbsent[statement.runtime] = true;
            trace.push({ event: "readAbsent", runtime: statement.runtime });
          }
          return result;
        }
        if (statement.sql === "COMMIT" && firstStarted === undefined) {
          const result = await run();
          firstStarted = statement.runtime;
          const other: Runtime = statement.runtime === "primary" ? "replica" : "primary";
          lateSecondRead = !readAbsent[other];
          trace.push({ event: "firstStartedCommit", runtime: statement.runtime });
          firstStartedCommit.resolve();
          return result;
        }
        if (streamUpsert(statement, streamId) && !appended.includes(statement.runtime)) {
          appended.push(statement.runtime);
          trace.push({ event: "appended", runtime: statement.runtime });
        }
        return run();
      };

      const first = primary.services.setSavedCheckoutInstrumentDefault(command, context);
      const duplicate = replica.services.setSavedCheckoutInstrumentDefault(command, context);
      const copiesSettled = Promise.allSettled([first, duplicate]);
      onTestFinished(async () => {
        firstStartedCommit.resolve();
        await copiesSettled;
        console.info(
          "saved-instrument-race-control",
          JSON.stringify({
            trace,
            appended,
            assertions: { readAbsent, firstStarted, lateSecondRead },
            bounds: { cleanup: true },
          }),
        );
      });

      await copiesSettled;
      expect(firstStarted).toBeDefined();
      expect(lateSecondRead).toBe(true);
      const other: Runtime = firstStarted === "primary" ? "replica" : "primary";
      expect(readAbsent[other]).toBe(false);
      expect(appended).toHaveLength(1);
      expect(writes.filter(isDefaultWrite)).toHaveLength(1);
      expect(await auditRows("sci_SYNTHETIC_B")).toEqual([{ action: "set-default" }]);
    });

    it.each<Runtime>(["replica", "primary"])(
      "never lets a delayed exact duplicate overwrite a later completed distinct default when the %s appends started first",
      async (firstAppender) => {
        const primary = harness();
        const replica = harness({}, "replica");
        const command = { accountId, instrumentId: "sci_SYNTHETIC_B", attemptId: freshAttemptId() };
        const streamId = streamIdFor(command.attemptId);
        const firstAppended = deferred();
        const secondAppended = deferred();
        const reachedUpsert = { primary: deferred(), replica: deferred() };
        const duplicateAdmitted = deferred();
        const releaseDuplicate = deferred();
        const appended: Runtime[] = [];
        const trace: Array<{ event: string; runtime?: Runtime; detail?: unknown }> = [];
        const readAbsent: Record<Runtime, boolean> = { primary: false, replica: false };
        const startedAppendClients = new Set<string>();
        const startedCommitRuntimes = new Set<Runtime>();
        let firstStartedCommit: Runtime | undefined;
        let lateSecondRead = false;
        const opened: Partial<Record<"order" | "rendezvous" | "admitted" | "first" | "duplicate", boolean>> = {};
        let firstHeld = false;
        let duplicateHeld = false;
        // The copies' `started` appends reach `event_store_streams` in the forced order: the second
        // waits before its upsert, holding nothing, until the first's upsert has run. The first
        // appender waits for that second upsert to be reached before either append can commit, so
        // both attempt-history reads observe absence. The duplicate (replica) is then held at its
        // attempt lock until its first copy and a later distinct default have both completed.
        intercept = async (statement, run) => {
          const clientKey = `${statement.runtime}:${statement.client}`;
          const readsAttemptStream =
            /^\s*SELECT\b/i.test(statement.sql) &&
            /\bFROM\s+event_store_events\b/i.test(statement.sql) &&
            statement.params[0] === streamId;
          if (readsAttemptStream) {
            const result = await run();
            const rows = (result as { rows?: readonly unknown[] }).rows;
            if (!readAbsent[statement.runtime] && rows?.length === 0) {
              readAbsent[statement.runtime] = true;
              trace.push({ event: "readAbsent", runtime: statement.runtime });
            }
            return result;
          }
          if (
            statement.sql === "COMMIT" &&
            startedAppendClients.has(clientKey) &&
            !startedCommitRuntimes.has(statement.runtime)
          ) {
            const result = await run();
            startedCommitRuntimes.add(statement.runtime);
            if (firstStartedCommit === undefined) {
              firstStartedCommit = statement.runtime;
              const other: Runtime = statement.runtime === "primary" ? "replica" : "primary";
              if (!readAbsent[other]) lateSecondRead = true;
              trace.push({ event: "firstStartedCommit", runtime: statement.runtime });
            } else {
              trace.push({ event: "startedCommit", runtime: statement.runtime });
            }
            return result;
          }
          if (streamUpsert(statement, streamId) && !appended.includes(statement.runtime)) {
            startedAppendClients.add(clientKey);
            trace.push({ event: "reachedUpsert", runtime: statement.runtime });
            reachedUpsert[statement.runtime].resolve();
            if (statement.runtime === firstAppender) {
              const other: Runtime = firstAppender === "primary" ? "replica" : "primary";
              opened.rendezvous = await bounded(reachedUpsert[other].promise);
            } else {
              opened.order = await bounded(firstAppended.promise);
            }
            appended.push(statement.runtime);
            const result = await run();
            (statement.runtime === firstAppender ? firstAppended : secondAppended).resolve();
            return result;
          }
          if (
            statement.runtime === "replica" &&
            (isAttemptLock(statement) || isDefaultWrite(statement.sql)) &&
            !duplicateHeld
          ) {
            duplicateHeld = true;
            duplicateAdmitted.resolve();
            opened.duplicate = await bounded(releaseDuplicate.promise);
            return run();
          }
          if (statement.runtime === "primary" && isDefaultWrite(statement.sql) && !firstHeld) {
            firstHeld = true;
            opened.first = await bounded(duplicateAdmitted.promise);
          }
          return run();
        };

        const first = primary.services.setSavedCheckoutInstrumentDefault(command, context);
        const duplicate = replica.services.setSavedCheckoutInstrumentDefault(command, context);
        // Every barrier opens even when the test fails or times out, so both copies settle before the
        // next test resets the schema or the pools close.
        const copiesSettled = Promise.allSettled([first, duplicate]);
        onTestFinished(async () => {
          for (const barrier of [
            reachedUpsert.primary,
            reachedUpsert.replica,
            firstAppended,
            duplicateAdmitted,
            releaseDuplicate,
          ]) {
            barrier.resolve();
          }
          await copiesSettled;
        });
        onTestFinished(async () => {
          await copiesSettled;
          console.info(
            "saved-instrument-race-finished",
            JSON.stringify({
              firstAppender,
              trace,
              opened,
              appended,
              assertions: { readAbsent, firstStartedCommit, lateSecondRead },
              bounds: { rendezvous: opened.rendezvous === true, cleanup: true },
            }),
          );
        });
        let parked: Awaited<ReturnType<typeof parkedActivity>>;
        try {
          opened.admitted = await bounded(duplicateAdmitted.promise);
          // The parked duplicate holds no transaction ID, so neither copy waits on it.
          parked = await parkedActivity(() => secondAppended.settled);
          expect(parked).toContainEqual(
            expect.objectContaining({
              application_name: "payments-saved-instrument-attempt-replica",
              state: "idle in transaction",
              backend_xid: null,
            }),
          );
          expect(parked.filter((backend) => backend.blocked_by.length > 0)).toEqual([]);
          await expect(first).resolves.toMatchObject({ instrument_id: "sci_SYNTHETIC_B", is_default: true });
          await primary.services.setSavedCheckoutInstrumentDefault(
            { accountId, instrumentId: "sci_SYNTHETIC_A", attemptId: freshAttemptId() },
            context,
          );
          expect(await defaults()).toEqual(["sci_SYNTHETIC_A"]);
        } finally {
          releaseDuplicate.resolve();
        }

        await copiesSettled;
        expect(await eventTypes(primary.eventStore, command.attemptId)).toEqual([
          SAVED_CHECKOUT_INSTRUMENT_ATTEMPT_STARTED,
          SAVED_CHECKOUT_INSTRUMENT_ATTEMPT_COMPLETED,
        ]);
        if (appended.length !== 2) lateSecondRead = true;
        expect(readAbsent).toEqual({ primary: true, replica: true });
        expect(firstStartedCommit).toBeDefined();
        expect(lateSecondRead).toBe(false);
        await expect(duplicate).resolves.toMatchObject({ instrument_id: "sci_SYNTHETIC_B", is_default: false });
        expect(await defaults()).toEqual(["sci_SYNTHETIC_A"]);
        expect(writes.filter(isDefaultWrite)).toHaveLength(2);
        expect(await auditRows("sci_SYNTHETIC_B")).toEqual([{ action: "set-default" }]);
        expect(await auditRows("sci_SYNTHETIC_A")).toEqual([{ action: "set-default" }]);
        expect(await publications()).toBe(2);
        expect(appended).toEqual(firstAppender === "replica" ? ["replica", "primary"] : ["primary", "replica"]);
        expect(opened).toEqual({ order: true, rendezvous: true, admitted: true, first: true, duplicate: true });
        const parkedReplica = parked.find(
          (backend) => backend.application_name === "payments-saved-instrument-attempt-replica",
        );
        expect(parkedReplica).toBeDefined();
        for (const field of ["state", "wait_event_type", "wait_event", "backend_xid", "blocked_by"] as const) {
          expect(parkedReplica).toHaveProperty(field);
        }
        trace.push({ event: "assertions", detail: { readAbsent, firstStartedCommit, lateSecondRead } });
        console.info(
          "saved-instrument-race",
          JSON.stringify({
            firstAppender,
            trace,
            opened,
            appended,
            captures: { parkedReplica },
            assertions: { readAbsent, firstStartedCommit, lateSecondRead },
            bounds: { rendezvous: opened.rendezvous === true, cleanup: true },
          }),
        );
      },
    );

    type Interruption = (statement: Statement, attemptId: string, locked: ReadonlySet<number>) => boolean;
    it.each<readonly [string, Interruption, "before" | "after"]>([
      [
        "the default update",
        (statement) => /INSERT INTO payments_saved_checkout_instrument_audit/.test(statement.sql),
        "before",
      ],
      ["the audit row", (statement) => streamUpsert(statement, `payments.checkout-affordances-${accountId}`), "before"],
      [
        "the publication",
        (statement, attemptId, locked) =>
          locked.has(statement.client) && streamUpsert(statement, streamIdFor(attemptId)),
        "before",
      ],
      [
        "the completion, before COMMIT",
        (statement, _id, locked) => locked.has(statement.client) && statement.sql === "COMMIT",
        "before",
      ],
      [
        "COMMIT, once it committed",
        (statement, _id, locked) => locked.has(statement.client) && statement.sql === "COMMIT",
        "after",
      ],
    ])(
      "an interruption after %s leaves started-only with no effect, or completed with one; replay converges once",
      async (_label, interrupts, timing) => {
        const { services, eventStore } = harness();
        const attemptId = freshAttemptId();
        const locked = new Set<number>();
        let interrupted = false;
        intercept = async (statement, run) => {
          if (isAttemptLock(statement, attemptId)) locked.add(statement.client);
          if (interrupted || !interrupts(statement, attemptId, locked)) return run();
          interrupted = true;
          if (timing === "after") await run();
          throw new Error("SYNTHETIC_PRIVATE_INTERRUPTION");
        };
        const command = { accountId, instrumentId: "sci_SYNTHETIC_B", attemptId };

        const failure = await services
          .setSavedCheckoutInstrumentDefault(command, context)
          .catch((error: Error) => error);
        expect(failure).toMatchObject({ code: "attempt_unconfirmed" });
        expect(String((failure as Error).message)).not.toContain("SYNTHETIC_PRIVATE");
        const committed = timing === "after";
        expect(await eventTypes(eventStore, attemptId)).toEqual(
          committed
            ? [SAVED_CHECKOUT_INSTRUMENT_ATTEMPT_STARTED, SAVED_CHECKOUT_INSTRUMENT_ATTEMPT_COMPLETED]
            : [SAVED_CHECKOUT_INSTRUMENT_ATTEMPT_STARTED],
        );
        expect(await defaults()).toEqual([committed ? "sci_SYNTHETIC_B" : "sci_SYNTHETIC_A"]);
        expect(await auditRows("sci_SYNTHETIC_B")).toHaveLength(committed ? 1 : 0);
        expect(await publications()).toBe(committed ? 1 : 0);

        intercept = passThrough;
        const before = writes.length;
        await expect(services.setSavedCheckoutInstrumentDefault(command, context)).resolves.toMatchObject({
          is_default: true,
        });
        expect(writes.slice(before).filter(isDefaultWrite)).toHaveLength(committed ? 0 : 1);
        expect(await defaults()).toEqual(["sci_SYNTHETIC_B"]);
        expect(await auditRows("sci_SYNTHETIC_B")).toEqual([{ action: "set-default" }]);
        expect(await publications()).toBe(1);
        expect(await eventTypes(eventStore, attemptId)).toEqual([
          SAVED_CHECKOUT_INSTRUMENT_ATTEMPT_STARTED,
          SAVED_CHECKOUT_INSTRUMENT_ATTEMPT_COMPLETED,
        ]);
      },
    );
  });

  describe("F3 a failed started append is attempt_unconfirmed, never private text", () => {
    it.each([
      ["default", "before"],
      ["default", "after"],
      ["remove", "before"],
      ["remove", "after"],
    ] as const)(
      "%s: an append failing %s its commit replays without a second processor write",
      async (kind, timing) => {
        const { calls, services, eventStore } = harness();
        await seedInstrument("sci_SYNTHETIC_A", "ready", true);
        await seedInstrument("sci_SYNTHETIC_B");
        const attemptId = freshAttemptId();
        const appending = new Set<number>();
        let failed = false;
        intercept = async (statement, run) => {
          if (!failed && streamUpsert(statement, streamIdFor(attemptId))) {
            if (timing === "before") {
              failed = true;
              throw new Error("SYNTHETIC_PRIVATE_STORAGE_DETAIL");
            }
            appending.add(statement.client);
          }
          if (!failed && appending.has(statement.client) && statement.sql === "COMMIT") {
            failed = true;
            await run();
            throw new Error("SYNTHETIC_PRIVATE_STORAGE_DETAIL");
          }
          return run();
        };
        const command = () =>
          kind === "default"
            ? services.setSavedCheckoutInstrumentDefault(
                { accountId, instrumentId: "sci_SYNTHETIC_B", attemptId },
                context,
              )
            : services.removeSavedCheckoutInstrument(
                { accountId, instrumentId: "sci_SYNTHETIC_B", attemptId },
                context,
              );

        const failure = await command().catch((error: Error) => error);
        expect(failure).toMatchObject({ code: "attempt_unconfirmed" });
        expect(JSON.stringify({ message: (failure as Error).message, failure })).not.toContain("SYNTHETIC_PRIVATE");
        expect(await streamEvents(eventStore, attemptId)).toHaveLength(timing === "after" ? 1 : 0);
        expect(calls.detach).toBe(0);

        intercept = passThrough;
        const replay = await command().catch((error: Error) => error);
        if (kind === "remove" && timing === "after") {
          // A started remove never re-sends its detach; it stays unconfirmed for provider convergence.
          expect(replay).toMatchObject({ code: "attempt_unconfirmed" });
        } else {
          expect(replay).toMatchObject(kind === "default" ? { is_default: true } : { readiness: "removed" });
        }
        expect(calls.detach).toBe(kind === "remove" && timing === "before" ? 1 : 0);
      },
    );
  });
});
