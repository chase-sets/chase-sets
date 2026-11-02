import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPgPool, createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { catalogScenarioItems, catalogSeedIds } from "@chase-sets/catalog-seed";
import { identitySeedIds } from "@chase-sets/identity-seed";
import { module as checkoutModule } from "../../../index";
import { seedCheckoutDatabase } from "../../../support/runtime-support/seed";
import { createCheckoutCartRuntime } from "../../cart/api/runtime";
import {
  CHECKOUT_COMMAND_ATTEMPT_COMPLETED,
  checkoutCommandAttemptFingerprint,
  checkoutCommandAttemptStreamId,
  checkoutOrderCartCleanupAttemptId,
} from "./attempt-history";
import type { CheckoutCartAttemptRequest, CheckoutCartLineCommandInput } from "./cart-attempt";
import { computeCheckoutCommandAttemptRequestHash, type CheckoutCartAttemptKind } from "./contracts";

/**
 * Exactly-once Cart attempts against real PostgreSQL: one attempt stream per
 * cart write, appended with its cart events in one `appendToStreams`, at the
 * cart streams' loaded versions.
 */

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
const describeDb = databaseBaseUrl ? describe : describe.skip;
const contextNames = ["checkout"] as const;
const ACCOUNT = "acc_synthetic_attempt_buyer";
const ANONYMOUS = "anon_synthetic_attempt_device";
let pools: Readonly<Record<(typeof contextNames)[number], PgTransactionalPool>> | undefined;
let pool: PgTransactionalPool;
let databaseUrl: string;

const context: EventStoreContext = {
  tenantId: "tnt_test" as never,
  audit: { performedByUserId: "usr_synthetic_attempt" as never, forAccountId: ACCOUNT as never },
};

function requireDatabaseBaseUrl() {
  if (!databaseBaseUrl) throw new Error("TEST_DATABASE_URL is required for checkout cart attempt DB tests.");
  return databaseBaseUrl;
}

function addCommand(catalogItemId: string, quantity = 1): CheckoutCartLineCommandInput {
  return {
    type: "add",
    catalogItemId,
    productId: `${catalogItemId}::`,
    itemTitle: `Synthetic ${catalogItemId}`,
    itemSubtitle: null,
    itemImageUrl: null,
    selectedOptions: [],
    productSummary: null,
    quantity,
  };
}

let attemptSequence = 0;
async function attempt(
  ownerKey: string,
  kind: CheckoutCartAttemptKind,
  target: string,
  commands: readonly CheckoutCartLineCommandInput[],
  overrides: Partial<CheckoutCartAttemptRequest> = {},
): Promise<CheckoutCartAttemptRequest> {
  attemptSequence += 1;
  return {
    ownerKey,
    attemptId: `db-attempt-${String(attemptSequence).padStart(8, "0")}-synthetic`,
    kind,
    target,
    requestHash: await computeCheckoutCommandAttemptRequestHash({ commands }),
    commands,
    ...overrides,
  };
}

/**
 * Wraps the real store so a test can commit an append and then lose its
 * acknowledgement, fail before any append, or count which append primitive the
 * attempt used. Nothing here changes what PostgreSQL stores.
 */
function instrumentedStore(target: PgTransactionalPool) {
  const store = createPostgresEventStore({ pool: target });
  const faults = { loseNextAcknowledgement: false, failBeforeNextAppend: false };
  const calls = { appendToStream: 0, appendToStreams: 0, readStream: 0 };
  const eventStore: EventStore = {
    ...store,
    appendToStream: async (input) => {
      calls.appendToStream += 1;
      return store.appendToStream(input);
    },
    appendToStreams: async (inputs) => {
      calls.appendToStreams += 1;
      if (faults.failBeforeNextAppend) {
        faults.failBeforeNextAppend = false;
        throw new Error("synthetic failure before append");
      }
      const stored = await store.appendToStreams!(inputs);
      if (faults.loseNextAcknowledgement) {
        faults.loseNextAcknowledgement = false;
        throw new Error("synthetic connection reset after commit");
      }
      return stored;
    },
    readStream: async (input) => {
      calls.readStream += 1;
      return store.readStream(input);
    },
  };
  return {
    eventStore,
    faults,
    calls,
    runtime: createCheckoutCartRuntime({ eventStore, checkpointStore: {} as never, db: target }),
  };
}

async function streamEvents(streamId: string) {
  return readCompleteStream(createPostgresEventStore({ pool }), { streamId });
}

async function cartEventTypes(ownerKey: string) {
  return (await streamEvents(`checkout.cart-${ownerKey}`)).map((event) => event.eventType);
}

async function attemptEvents(request: CheckoutCartAttemptRequest) {
  return streamEvents(
    checkoutCommandAttemptStreamId(
      checkoutCommandAttemptFingerprint({
        ownerKey: request.ownerKey,
        kind: request.kind,
        target: request.target,
        attemptId: request.attemptId,
      }),
    ),
  );
}

async function cartLines(ownerKey: string) {
  const events = await streamEvents(`checkout.cart-${ownerKey}`);
  const lines = new Map<string, { quantity: number; fulfillmentMode: string }>();
  for (const event of events) {
    const data = event.payload as Record<string, unknown>;
    if (event.eventType === "checkout.cart.line-added") {
      lines.set(String(data.lineId), {
        quantity: Number(data.quantity),
        fulfillmentMode: String(data.fulfillmentMode ?? "optimize"),
      });
    } else if (event.eventType === "checkout.cart.line-quantity-set") {
      lines.set(String(data.lineId), { ...lines.get(String(data.lineId))!, quantity: Number(data.quantity) });
    } else if (event.eventType === "checkout.cart.line-fulfillment-set") {
      lines.set(String(data.lineId), {
        ...lines.get(String(data.lineId))!,
        fulfillmentMode: String(data.fulfillmentMode),
      });
    } else if (event.eventType === "checkout.cart.line-removed") {
      lines.delete(String(data.lineId));
    } else if (event.eventType === "checkout.cart.checked-out") {
      lines.clear();
    }
  }
  return lines;
}

async function seedCatalog(itemIds: readonly string[]) {
  for (const catalogItemId of itemIds) {
    await pool.query(
      `INSERT INTO checkout_catalog_items (catalog_item_id, title, subtitle, blueprint_id, status, product_schema, language_code, updated_at)
       VALUES ($1, $2, NULL, NULL, 'active', NULL, 'en', now())`,
      [catalogItemId, `Synthetic ${catalogItemId}`],
    );
  }
}

describeDb("checkout cart attempts against real PostgreSQL", () => {
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(requireDatabaseBaseUrl(), contextNames, "cart_attempt");
    await ensureMultiContextTestDatabases(requireDatabaseBaseUrl(), urls);
    pools = createMultiContextTestPools(urls);
    pool = pools.checkout;
    databaseUrl = urls.checkout;
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas({ checkout: pool });
    await bootstrapContextDatabase(checkoutModule, pool);
    await seedCatalog([
      "cat_synthetic_a",
      "cat_synthetic_b",
      ...Array.from({ length: 250 }, (_, index) => `cat_synthetic_bulk_${index}`),
    ]);
  });

  afterAll(async () => {
    if (pools) await closeMultiContextTestPools(pools);
    pools = undefined;
  });

  describe.each([
    ["account", ACCOUNT],
    ["anonymous", ANONYMOUS],
  ] as const)("commit-then-loss for the %s cart", (_label, owner) => {
    it("replays a lost new-line add exactly once", async () => {
      const h = instrumentedStore(pool);
      const request = await attempt(owner, "cart.add-line", "cart", [addCommand("cat_synthetic_a", 2)]);
      h.faults.loseNextAcknowledgement = true;
      await expect(h.runtime.executeCartAttempt(request, context)).rejects.toThrow(
        "synthetic connection reset after commit",
      );
      const committed = await cartEventTypes(owner);

      const retried = await h.runtime.executeCartAttempt(request, context);

      expect(retried.replayed).toBe(true);
      expect(retried.result.ownerStatus).toBe("committed");
      expect(retried.result.vector).toMatchObject([{ outcome: "succeeded", status: "added" }]);
      expect(await cartEventTypes(owner)).toEqual(committed);
      expect((await attemptEvents(request)).map((event) => event.eventType)).toEqual([
        CHECKOUT_COMMAND_ATTEMPT_COMPLETED,
      ]);
      expect([...(await cartLines(owner)).values()].map((line) => line.quantity)).toEqual([2]);
    });

    it("replays a lost merge without merging twice", async () => {
      const h = instrumentedStore(pool);
      await h.runtime.executeCartAttempt(
        await attempt(owner, "cart.add-line", "cart", [addCommand("cat_synthetic_a", 1)]),
        context,
      );
      const merge = await attempt(owner, "cart.add-line", "cart", [addCommand("cat_synthetic_a", 3)]);
      h.faults.loseNextAcknowledgement = true;
      await expect(h.runtime.executeCartAttempt(merge, context)).rejects.toThrow();

      const retried = await h.runtime.executeCartAttempt(merge, context);
      const again = await h.runtime.executeCartAttempt(merge, context);

      // A merge-twice mutant would apply 1 + 3 + 3; the attempt applies 3 once.
      expect([...(await cartLines(owner)).values()].map((line) => line.quantity)).toEqual([4]);
      expect(retried.result.vector).toMatchObject([{ status: "merged" }]);
      expect(again.result).toEqual(retried.result);
      expect(await cartEventTypes(owner)).toEqual(["checkout.cart.line-added", "checkout.cart.line-quantity-set"]);
    });

    it("replays lost quantity, fulfillment and remove writes and refuses a changed request", async () => {
      const h = instrumentedStore(pool);
      const added = await h.runtime.executeCartAttempt(
        await attempt(owner, "cart.add-line", "cart", [addCommand("cat_synthetic_a")]),
        context,
      );
      const lineId = added.result.vector![0]!.lineId! as never;
      for (const [kind, command] of [
        ["cart.set-quantity", { type: "quantity", lineId, quantity: 5 }],
        [
          "cart.set-fulfillment",
          { type: "fulfillment", lineId, fulfillmentMode: "locked-listing", lockedListingId: "lst_synthetic_attempt" },
        ],
        ["cart.remove-line", { type: "remove", lineId }],
      ] as const) {
        const request = await attempt(owner, kind, lineId, [command as CheckoutCartLineCommandInput]);
        h.faults.loseNextAcknowledgement = true;
        await expect(h.runtime.executeCartAttempt(request, context)).rejects.toThrow();
        const before = await cartEventTypes(owner);

        const retried = await h.runtime.executeCartAttempt(request, context);
        const changed = await h.runtime.executeCartAttempt({ ...request, requestHash: "f".repeat(64) }, context);

        expect(retried).toMatchObject({ replayed: true, result: { ownerStatus: "committed" } });
        expect(changed.result.ownerStatus).toBe("conflict");
        expect(await cartEventTypes(owner)).toEqual(before);
        expect(await attemptEvents(request)).toHaveLength(1);
      }
      expect(await cartLines(owner)).toEqual(new Map());
    });
  });

  it("applies one event set when exact requests race on separate connections", async () => {
    const contenderPool = createPgPool(databaseUrl);
    try {
      const first = instrumentedStore(pool);
      const second = instrumentedStore(contenderPool);
      const request = await attempt(ACCOUNT, "cart.add-line", "cart", [addCommand("cat_synthetic_b", 2)]);

      const [left, right] = await Promise.all([
        first.runtime.executeCartAttempt(request, context),
        second.runtime.executeCartAttempt(request, context),
      ]);

      expect([left.replayed, right.replayed].sort()).toEqual([false, true]);
      expect({ ...left.result, commitReceipt: undefined }).toEqual({ ...right.result, commitReceipt: undefined });
      expect(await cartEventTypes(ACCOUNT)).toEqual(["checkout.cart.line-added"]);
      expect(await attemptEvents(request)).toHaveLength(1);
    } finally {
      await (contenderPool as unknown as { end: () => Promise<void> }).end();
    }
  });

  it("replays a derived Session cleanup step instead of removing or checking out twice", async () => {
    const h = instrumentedStore(pool);
    const added = await h.runtime.executeCartAttempt(
      await attempt(ACCOUNT, "cart.add-line", "cart", [addCommand("cat_synthetic_a")]),
      context,
    );
    await h.runtime.executeCartAttempt(
      await attempt(ACCOUNT, "cart.add-line", "cart", [addCommand("cat_synthetic_b")]),
      context,
    );
    const lineId = added.result.vector![0]!.lineId!;
    const cleanup = async (target: string, commands: readonly CheckoutCartLineCommandInput[]) =>
      h.runtime.executeCartAttempt(
        {
          ownerKey: ACCOUNT,
          attemptId: checkoutOrderCartCleanupAttemptId("chk_synthetic_cleanup", ACCOUNT, target),
          kind: "cart.session-cleanup",
          target,
          requestHash: await computeCheckoutCommandAttemptRequestHash({ commands }),
          commands,
        },
        context,
      );

    h.faults.loseNextAcknowledgement = true;
    await expect(cleanup(lineId, [{ type: "remove", lineId: lineId as never }])).rejects.toThrow();
    const resumedRemove = await cleanup(lineId, [{ type: "remove", lineId: lineId as never }]);
    const firstCheckout = await cleanup("checkout", [{ type: "checkout" }]);
    const resumedCheckout = await cleanup("checkout", [{ type: "checkout" }]);

    expect(resumedRemove.replayed).toBe(true);
    expect(resumedCheckout).toMatchObject({ replayed: true, result: firstCheckout.result });
    expect(await cartEventTypes(ACCOUNT)).toEqual([
      "checkout.cart.line-added",
      "checkout.cart.line-added",
      "checkout.cart.line-removed",
      "checkout.cart.checked-out",
    ]);
  });

  describe("batch attempts", () => {
    it("applies a 250-line bulk add in one append with a closed vector and replays it", async () => {
      const h = instrumentedStore(pool);
      const request = await attempt(
        ACCOUNT,
        "cart.add-lines",
        "cart",
        Array.from({ length: 250 }, (_, index) => addCommand(`cat_synthetic_bulk_${index}`)),
      );

      const first = await h.runtime.executeCartAttempt(request, context);
      const replay = await h.runtime.executeCartAttempt(request, context);

      // A per-line-append mutant would call the store once per line.
      expect(h.calls).toMatchObject({ appendToStreams: 1, appendToStream: 0 });
      expect(first.result.vector).toHaveLength(250);
      expect(first.result.vector!.every((line) => line.outcome === "succeeded" && line.status === "added")).toBe(true);
      expect(replay).toMatchObject({ replayed: true, result: { vector: first.result.vector } });
      expect(await cartEventTypes(ACCOUNT)).toHaveLength(250);
    });

    it("leaves zero events when the append fails before writing", async () => {
      const h = instrumentedStore(pool);
      const request = await attempt(ACCOUNT, "cart.add-lines", "cart", [
        addCommand("cat_synthetic_a"),
        addCommand("cat_synthetic_b"),
      ]);
      h.faults.failBeforeNextAppend = true;

      await expect(h.runtime.executeCartAttempt(request, context)).rejects.toThrow("synthetic failure before append");

      expect(await cartEventTypes(ACCOUNT)).toEqual([]);
      expect(await attemptEvents(request)).toEqual([]);
    });

    it("refuses 251 line commands before any read", async () => {
      const h = instrumentedStore(pool);
      const request = await attempt(
        ACCOUNT,
        "cart.add-lines",
        "cart",
        Array.from({ length: 251 }, (_, index) => addCommand(`cat_synthetic_bulk_${index % 250}`)),
      );

      await expect(h.runtime.executeCartAttempt(request, context)).rejects.toMatchObject({
        code: "cart_attempt_too_large",
      });

      expect(h.calls).toEqual({ appendToStream: 0, appendToStreams: 0, readStream: 0 });
    });

    it("consolidates all or nothing and records a closed partial vector", async () => {
      const h = instrumentedStore(pool);
      const first = await h.runtime.executeCartAttempt(
        await attempt(ACCOUNT, "cart.add-line", "cart", [addCommand("cat_synthetic_a")]),
        context,
      );
      const primary = first.result.vector![0]!.lineId! as never;
      const consolidate = await attempt(ACCOUNT, "cart.commands", "cart", [
        { type: "quantity", lineId: primary, quantity: 3 },
        { type: "quantity", lineId: "cli_synthetic_missing" as never, quantity: 2 },
      ]);

      const result = await h.runtime.executeCartAttempt(consolidate, context);

      expect(result.result.vector!.map((line) => line.outcome)).toEqual(["succeeded", "conflict"]);
      expect([...(await cartLines(ACCOUNT)).values()].map((line) => line.quantity)).toEqual([3]);
      expect(await cartEventTypes(ACCOUNT)).toEqual(["checkout.cart.line-added", "checkout.cart.line-quantity-set"]);
    });
  });

  it("appends nothing on a day-after replay from every retained state", async () => {
    const h = instrumentedStore(pool);
    const committed = await attempt(ACCOUNT, "cart.add-line", "cart", [addCommand("cat_synthetic_a")]);
    await h.runtime.executeCartAttempt(committed, context);
    const lineId = (await h.runtime.executeCartAttempt(committed, context)).result.vector![0]!.lineId! as never;
    const partial = await attempt(ACCOUNT, "cart.commands", "cart", [
      { type: "quantity", lineId, quantity: 2 },
      { type: "remove", lineId: "cli_synthetic_absent" as never },
      { type: "quantity", lineId: "cli_synthetic_absent" as never, quantity: 2 },
    ]);
    await h.runtime.executeCartAttempt(partial, context);

    // Failed-safe: every decision loses its cart-stream race, so the attempt is
    // recorded failed-safe with zero cart events.
    const failedSafe = await attempt(ACCOUNT, "cart.set-quantity", lineId, [{ type: "quantity", lineId, quantity: 9 }]);
    const racing = instrumentedStore(pool);
    const original = racing.eventStore.appendToStreams!;
    let raced = 0;
    const racingStore: EventStore = {
      ...racing.eventStore,
      appendToStreams: async (inputs) => {
        if (inputs.some((input) => input.streamId === `checkout.cart-${ACCOUNT}`)) {
          raced += 1;
          await h.runtime.executeCartAttempt(
            await attempt(ACCOUNT, "cart.set-quantity", lineId, [{ type: "quantity", lineId, quantity: 10 + raced }]),
            context,
          );
        }
        return original(inputs);
      },
    };
    const failedSafeResult = await createCheckoutCartRuntime({
      eventStore: racingStore,
      checkpointStore: {} as never,
      db: pool,
    }).executeCartAttempt(failedSafe, context);
    expect(failedSafeResult.result).toMatchObject({ ownerStatus: "failed-safe", reason: "cart-changed" });
    const conflict = { ...committed, requestHash: "e".repeat(64) };

    const before = await cartEventTypes(ACCOUNT);
    const dayAfter = instrumentedStore(pool);
    const replays = await Promise.all(
      [committed, partial, failedSafe, conflict].map((request) =>
        dayAfter.runtime.executeCartAttempt(request, context),
      ),
    );

    expect(replays.map((replay) => replay.result.ownerStatus)).toEqual([
      "committed",
      "committed",
      "failed-safe",
      "conflict",
    ]);
    expect(replays.every((replay) => replay.replayed)).toBe(true);
    expect(replays[1]!.result.vector!.map((line) => line.outcome)).toEqual(["succeeded", "succeeded", "conflict"]);
    expect(dayAfter.calls).toMatchObject({ appendToStream: 0, appendToStreams: 0 });
    expect(await cartEventTypes(ACCOUNT)).toEqual(before);
  });

  it("boots the seed twice without a second cart event", async () => {
    const form = catalogSeedIds.dimensions.form;
    const condition = catalogSeedIds.dimensions.condition;
    const schema = {
      canonicalDimensionOrder: [
        { dimensionId: form.dimensionId, dimensionName: "Form" },
        { dimensionId: condition.dimensionId, dimensionName: "Condition" },
      ],
      dimensions: [
        {
          dimensionId: form.dimensionId,
          dimensionName: "Form",
          required: true,
          appliesWhen: [],
          allowedOptions: [{ optionId: form.optionIds.raw, code: "raw", label: "Raw" }],
        },
        {
          dimensionId: condition.dimensionId,
          dimensionName: "Condition",
          required: true,
          appliesWhen: [],
          allowedOptions: [
            { optionId: condition.optionIds.nearMint, code: "near-mint", label: "Near Mint" },
            { optionId: condition.optionIds.excellent, code: "excellent", label: "Excellent" },
          ],
        },
      ],
    };
    for (const catalogItemId of [catalogScenarioItems.charizardBaseSet, catalogScenarioItems.pikachuJungle]) {
      await pool.query(
        `INSERT INTO checkout_catalog_items (catalog_item_id, title, subtitle, blueprint_id, status, product_schema, language_code, updated_at)
         VALUES ($1, 'Seed item', NULL, NULL, 'active', $2::jsonb, 'en', now())`,
        [catalogItemId, JSON.stringify(schema)],
      );
    }
    const buyer = identitySeedIds.collector.accountId;

    await seedCheckoutDatabase(pool);
    const firstBoot = await cartEventTypes(buyer);
    await seedCheckoutDatabase(pool);

    expect(firstBoot).toEqual(["checkout.cart.line-added", "checkout.cart.line-added"]);
    expect(await cartEventTypes(buyer)).toEqual(firstBoot);
  });
});
