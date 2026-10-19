import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
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

describe("saved-instrument-attempt (synthetic DB proof)", () => {
  let pools: Readonly<Record<"payments", PgTransactionalPool>>;
  let writes: string[] = [];
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseUrl, ["payments"], "saved_instrument_attempt");
    await ensureMultiContextTestDatabases(databaseUrl, urls);
    pools = createMultiContextTestPools(urls);
    // Counts Payments saved-instrument read-model writes made through the shared pool.
    const query = pools.payments.query.bind(pools.payments);
    (pools.payments as { query: unknown }).query = (...args: Parameters<typeof query>) => {
      const sql = typeof args[0] === "string" ? args[0] : "";
      if (/^\s*(INSERT|UPDATE|DELETE|WITH)\b/i.test(sql) && /payments_saved_checkout/.test(sql)) writes.push(sql);
      return query(...args);
    };
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await bootstrapContextDatabase(paymentsModule, pools.payments);
    writes = [];
  });
  afterAll(async () => {
    if (pools) await closeMultiContextTestPools(pools);
  });

  function harness(overrides: Partial<PaymentProcessorGateway> = {}) {
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
    const services = createPaymentsServices(pools.payments, { processorGateway }).payments;
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
});
