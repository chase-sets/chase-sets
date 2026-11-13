import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import {
  createPostgresEventStore,
  createPostgresProjectionStore,
  type PgTransactionalPool,
} from "@chase-sets/event-core-postgres";
import { createEventStoreError, type EventStore } from "@chase-sets/event-core/event-store";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { JsonObject } from "@chase-sets/primitives/json";
import { toTransportEvent } from "@chase-sets/event-core/transport";
import { module as marketplaceModule } from "../../../index";
import { buildMarketplaceInventoryProjectionHandlers } from "../integrations/supply/supply-projection";
import { buildMarketplaceListingProjectionHandlers } from "../read-model/projection";
import { createMarketplaceListingRuntime } from "../api/runtime";
import { attemptListingId, listingAttempt, stampListingAttemptEvents } from "../api/listing-attempt";
import { listingBatchStreamId } from "../api/listing-batch";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) throw new Error("TEST_DATABASE_URL is required for Listing attempt DB proof.");
const describeDb = databaseBaseUrl ? describe : describe.skip;
const context: EventStoreContext = {
  tenantId: "tnt_test" as never,
  audit: { performedByUserId: "usr_seller" as never, forAccountId: "acc_seller" as never },
};
const measure = {
  catalogItemId: "cat_test",
  productId: "cat_test::",
  selectedOptions: [],
  measureVersion: "pm_test",
  unitLengthInches: 3.5,
  unitWidthInches: 2.5,
  unitHeightInches: 0.01,
  unitWeightOunces: 0.1,
  physicalFlags: ["raw-card"],
  stackBehavior: "stackable-thickness",
  source: "profile",
  confidence: "measured",
};
const address = {
  name: "Seller",
  line1: "1 Main St",
  city: "Chicago",
  state: "IL",
  postalCode: "60601",
  country: "US",
};
const key = (label: string) => `${label}_attempt_0000000000000001`;

describeDb("Listing attempts on PostgreSQL", () => {
  let pools: Readonly<Record<"marketplace", PgTransactionalPool>>;
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, ["marketplace"], "marketplace_listing_attempts");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await pools.marketplace.query(marketplaceModule.schemaSql);
  });
  afterAll(async () => {
    if (pools) await closeMultiContextTestPools(pools);
  });

  it("returns the first receipt for exact create/publish/edit/unpublish/withdraw retries with zero appends", async () => {
    const f = await fixture(pools.marketplace);
    const create = {
      accountId: "acc_seller" as never,
      inventoryItemId: "inv_one",
      priceAmount: "10.00",
      priceCurrencyCode: "USD",
      quantityCap: 1,
      idempotencyKey: key("create"),
    };
    const first = await f.listings.createListing(create, context);
    expect(first.listingId).toBe(attemptListingId("acc_seller", key("create")));
    await f.expectNoAppend(async () =>
      expect(await f.restart().createListing(create, context)).toMatchObject({
        listingId: first.listingId,
        version: first.version,
      }),
    );
    expect((await f.eventTypes(first.listingId)).filter((type) => type === "marketplace.listing.created")).toHaveLength(
      1,
    );
    expect(await f.listingCount()).toBe(1);

    const listingId = first.listingId;
    const commands = [
      () => f.listings.publishListing({ accountId: "acc_seller", listingId, idempotencyKey: key("publish") }, context),
      () =>
        f.listings.updateListingPrice(
          {
            accountId: "acc_seller",
            listingId,
            priceAmount: "12.00",
            priceCurrencyCode: "USD",
            idempotencyKey: key("price"),
          },
          context,
        ),
      () => f.listings.pauseListing({ accountId: "acc_seller", listingId, idempotencyKey: key("pause") }, context),
      () =>
        f.listings.withdrawListing({ accountId: "acc_seller", listingId, idempotencyKey: key("withdraw") }, context),
    ];
    for (const command of commands) {
      const committed = await command();
      // Commit-then-loss: the caller never saw `committed` and retries the identical command a day later.
      await f.expectNoAppend(async () =>
        expect(await command()).toMatchObject({ listingId, version: committed.version }),
      );
    }
    // An equal amount in another decimal spelling is the same canonical request.
    await f.expectNoAppend(async () =>
      f.restart().updateListingPrice(
        {
          accountId: "acc_seller",
          listingId,
          priceAmount: "12",
          priceCurrencyCode: "USD",
          idempotencyKey: key("price"),
        },
        context,
      ),
    );
  });

  it("coalesces concurrent identical Listing edits into one terminal event", async () => {
    const f = await fixture(pools.marketplace);
    const listingId = await f.activeListing("lst_concurrent");
    const command = {
      accountId: "acc_seller",
      listingId,
      priceAmount: "11.00",
      priceCurrencyCode: "USD",
      idempotencyKey: key("concurrent-price"),
    };
    const results = await Promise.allSettled([
      f.listings.updateListingPrice(command, context),
      f.restart().updateListingPrice(command, context),
    ]);
    expect(results.every((result) => result.status === "fulfilled")).toBe(true);
    expect(results.map((result) => (result.status === "fulfilled" ? result.value.version : null))).toEqual([4, 4]);
    expect((await f.eventTypes(listingId)).filter((type) => type === "marketplace.listing.price-updated")).toHaveLength(
      1,
    );
  });

  it("rejects a stale owner-stream writer and preserves the newer generation", async () => {
    const f = await fixture(pools.marketplace);
    const listingId = await f.activeListing("lst_interleaving");
    const streamId = `marketplace.listing-${listingId}`;
    const store = createPostgresEventStore({ pool: pools.marketplace });
    const loaded = await store.readStream({ streamId });
    const newer = await store.appendToStream({
      streamId,
      expectedVersion: loaded.length,
      context,
      events: [{ eventType: "marketplace.listing.evidence-requirements-refreshed", payload: {} }],
    });
    const guardStream = "marketplace.listing-atomic-guard";
    await store.appendToStream({
      streamId: guardStream,
      expectedVersion: "any",
      context,
      events: [{ eventType: "marketplace.listing.evidence-requirements-refreshed", payload: {} }],
    });
    const conflict = await (async () => {
      try {
        await store.appendToStreams!([
          {
            streamId,
            expectedVersion: loaded.length,
            context,
            events: [
              {
                eventType: "marketplace.listing.price-updated",
                payload: { priceAmount: "11.00", priceCurrencyCode: "USD" },
              },
            ],
          },
          { streamId: guardStream, expectedVersion: 1, context, events: [] },
        ]);
        return null;
      } catch (error) {
        return error;
      }
    })();
    expect(conflict).toMatchObject({
      code: "concurrency_conflict",
      details: { streamId, expectedVersion: loaded.length },
    });
    /*
     * The Listing writer is current; only the guard's stale expected version
     * should reject this atomic append.
     */
    await expect(
      store.appendToStreams!([
        {
          streamId,
          expectedVersion: loaded.length,
          context,
          events: [
            {
              eventType: "marketplace.listing.price-updated",
              payload: { priceAmount: "11.00", priceCurrencyCode: "USD" },
            },
          ],
        },
        { streamId: guardStream, expectedVersion: 1, context, events: [] },
      ]),
    ).rejects.toMatchObject({ code: "concurrency_conflict" });
    expect((await store.readStream({ streamId })).at(-1)?.eventId).toBe(newer.at(-1)?.eventId);
    expect((await store.readStream({ streamId: guardStream })).length).toBe(1);
  });

  it("refuses poisoned Listing attempt histories without appending", async () => {
    const f = await fixture(pools.marketplace);
    const listingId = await f.activeListing("lst_poisoned");
    const store = createPostgresEventStore({ pool: pools.marketplace });
    const baseRequest = { listingId, priceAmount: "11.00", priceCurrencyCode: "USD" };
    const cases = [
      {
        name: "missing terminal",
        context,
        event: { eventType: "marketplace.listing.evidence-requirements-refreshed", payload: {} },
      },
      {
        name: "wrong actor",
        context: { ...context, audit: { ...context.audit, forAccountId: "acc_other" as never } },
        event: {
          eventType: "marketplace.listing.price-updated",
          payload: { priceAmount: "11.00", priceCurrencyCode: "USD" },
        },
      },
    ] as const;
    for (const poisoned of cases) {
      const attemptKey = key(`poison-${poisoned.name.replaceAll(" ", "-")}`);
      const attempt = listingAttempt({
        idempotencyKey: attemptKey,
        mutationKind: "listing.update-price",
        accountId: "acc_seller",
        targetId: listingId,
        request: baseRequest,
      });
      const before = (await store.readStream({ streamId: attempt.streamId })).length;
      await store.appendToStream({
        streamId: attempt.streamId,
        expectedVersion: before,
        context: poisoned.context,
        events: stampListingAttemptEvents(attempt, [poisoned.event]),
      });
      const after = (await store.readStream({ streamId: attempt.streamId })).length;
      await expect(
        f
          .restart()
          .updateListingPrice({ ...baseRequest, accountId: "acc_seller", idempotencyKey: attemptKey }, context),
      ).rejects.toMatchObject({
        code: expect.any(String),
      });
      expect((await store.readStream({ streamId: attempt.streamId })).length).toBe(after);
    }
  });

  it("refuses a Listing attempt whose recorded request hash was poisoned", async () => {
    const f = await fixture(pools.marketplace);
    const listingId = await f.activeListing("lst_poisoned_hash");
    const store = createPostgresEventStore({ pool: pools.marketplace });
    const attemptKey = key("poison-hash");
    const request = { listingId, priceAmount: "11.00", priceCurrencyCode: "USD" };
    const attempt = listingAttempt({
      idempotencyKey: attemptKey,
      mutationKind: "listing.update-price",
      accountId: "acc_seller",
      targetId: listingId,
      request,
    });
    const stamped = stampListingAttemptEvents(attempt, [
      { eventType: "marketplace.listing.price-updated", payload: request },
    ]);
    const poisoned = {
      ...stamped[0]!,
      metadata: {
        ...(stamped[0]!.metadata ?? {}),
        marketplaceAttempt: {
          ...((stamped[0]!.metadata as Record<string, unknown>).marketplaceAttempt as Record<string, unknown>),
          requestHash: "f".repeat(64),
        },
      },
    } as never;
    const before = (await store.readStream({ streamId: attempt.streamId })).length;
    await store.appendToStream({ streamId: attempt.streamId, expectedVersion: before, context, events: [poisoned] });
    const after = (await store.readStream({ streamId: attempt.streamId })).length;
    await expect(
      f.restart().updateListingPrice({ ...request, accountId: "acc_seller", idempotencyKey: attemptKey }, context),
    ).rejects.toMatchObject({
      code: "attempt_conflict",
    });
    expect((await store.readStream({ streamId: attempt.streamId })).length).toBe(after);
  });

  it.each([
    ["a currency-only change", { priceCurrencyCode: "CAD" }],
    ["an amount change", { priceAmount: "10.01" }],
    ["a quantity change", { quantityCap: 2 }],
  ])("conflicts with zero appends and no second Listing on create under %s", async (_label, change) => {
    const f = await fixture(pools.marketplace);
    const create = {
      accountId: "acc_seller" as never,
      inventoryItemId: "inv_one",
      priceAmount: "10.00",
      priceCurrencyCode: "USD",
      quantityCap: 1,
      idempotencyKey: key("create"),
    };
    await f.listings.createListing(create, context);
    await f.expectNoAppend(() =>
      expect(f.restart().createListing({ ...create, ...change }, context)).rejects.toMatchObject({
        code: "attempt_conflict",
      }),
    );
    expect(await f.listingCount()).toBe(1);
  });

  it.each([
    ["a currency-only change", { priceAmount: "12.00", priceCurrencyCode: "CAD" }],
    ["an amount change", { priceAmount: "12.01", priceCurrencyCode: "USD" }],
  ])("conflicts with zero appends for an edit under %s with the same key", async (_label, change) => {
    const f = await fixture(pools.marketplace);
    const listingId = await f.activeListing("lst_edit");
    await f.listings.updateListingPrice(
      {
        accountId: "acc_seller",
        listingId,
        priceAmount: "12.00",
        priceCurrencyCode: "USD",
        idempotencyKey: key("price"),
      },
      context,
    );
    await f.expectNoAppend(() =>
      expect(
        f.listings.updateListingPrice(
          { accountId: "acc_seller", listingId, ...change, idempotencyKey: key("price") },
          context,
        ),
      ).rejects.toMatchObject({ code: "attempt_conflict" }),
    );
    expect((await f.listings.loadListingState(listingId)).priceAmount).toBe("12.00");
  });

  it("never replays a succeeded bulk price target and runs only the target the lost batch never recorded", async () => {
    const f = await fixture(pools.marketplace);
    const one = await f.activeListing("lst_bulk_one");
    const two = await f.activeListing("lst_bulk_two");
    const batch = (listingId: string, priceAmount: string, priceCurrencyCode = "USD") => ({
      listingId,
      priceAmount,
      priceCurrencyCode,
      idempotencyKey: key("batch"),
    });
    // First send commits only the first target, then the response is lost.
    const firstSend = await f.listings.applyBulkListingPriceUpdates(
      { accountId: "acc_seller", updates: [batch(one, "11.00")] },
      context,
    );
    expect(firstSend).toMatchObject([{ listingId: one, outcome: "applied" }]);
    const before = await f.streamLengths([one, two]);
    const retried = await f.listings.applyBulkListingPriceUpdates(
      { accountId: "acc_seller", updates: [batch(one, "11.00"), batch(two, "11.00")] },
      context,
    );
    expect(retried).toMatchObject([
      { listingId: one, outcome: "applied", version: firstSend[0]!.version },
      { listingId: two, outcome: "applied" },
    ]);
    const after = await f.streamLengths([one, two]);
    expect(after[one]).toBe(before[one]);
    expect(after[two]).toBeGreaterThan(before[two]!);
    // A day-after retry of the whole vector (one amount respelled) appends nothing.
    await f.expectNoAppend(async () => {
      const replay = await f
        .restart()
        .applyBulkListingPriceUpdates(
          { accountId: "acc_seller", updates: [batch(one, "11"), batch(two, "11.00")] },
          context,
        );
      expect(replay.map((item) => item.outcome)).toEqual(["applied", "applied"]);
    });
    // A currency-only change under the same batch target conflicts.
    await f.expectNoAppend(async () =>
      expect(
        await f.listings.applyBulkListingPriceUpdates(
          { accountId: "acc_seller", updates: [batch(one, "11.00", "CAD")] },
          context,
        ),
      ).toMatchObject([{ listingId: one, outcome: "conflict" }]),
    );
  });

  it.each(["pause", "withdraw"] as const)(
    "never re-runs a succeeded bulk %s target and runs each unknown target once",
    async (action) => {
      const f = await fixture(pools.marketplace);
      const one = await f.activeListing(`lst_${action}_one`);
      const two = await f.activeListing(`lst_${action}_two`);
      const send = (listingId: string, runtime = f.listings) =>
        action === "pause"
          ? runtime.pauseListing({ accountId: "acc_seller", listingId, idempotencyKey: key("batch") }, context)
          : runtime.withdrawListing({ accountId: "acc_seller", listingId, idempotencyKey: key("batch") }, context);
      const committed = await send(one);
      const before = await f.streamLengths([one, two]);
      // The retry carries the target the vector left unknown; a replayed terminal target still appends nothing.
      const restarted = f.restart();
      await expect(send(one, restarted)).resolves.toMatchObject({ version: committed.version });
      await send(two, restarted);
      const after = await f.streamLengths([one, two]);
      expect(after[one]).toBe(before[one]);
      expect(after[two]).toBeGreaterThan(before[two]!);
      await f.expectNoAppend(async () => {
        await send(one);
        await send(two);
      });
    },
  );

  it("persists one terminal bulk vector and re-drives only its explicit unknown target", async () => {
    const f = await fixture(pools.marketplace);
    const ok = await f.activeListing("lst_vector_ok");
    const clash = await f.activeListing("lst_vector_clash");
    const lost = await f.activeListing("lst_vector_lost");
    const missing = "lst_vector_missing";
    const batchId = key("vector");
    // The batch id bound to `clash` already recorded a different pause request.
    await f.listings.pauseListing(
      { accountId: "acc_seller", listingId: clash, reason: "policy-input-missing", idempotencyKey: batchId },
      context,
    );
    const store = createPostgresEventStore({ pool: pools.marketplace });
    const lostStream = `marketplace.listing-${lost}`;
    let phase: "commit" | "unreadable" | "done" = "commit";
    // Commit-then-loss: the append commits, its response is lost, and the immediate receipt re-read fails too.
    const lossy: EventStore = {
      ...store,
      appendToStream: async (input) => {
        const stored = await store.appendToStream(input);
        if (phase === "commit" && input.streamId === lostStream) {
          phase = "unreadable";
          throw createEventStoreError("infrastructure_failure", "Synthetic response loss after the commit.");
        }
        return stored;
      },
      readStream: async (input) => {
        if (phase === "unreadable" && input.streamId === lostStream) {
          phase = "done";
          throw createEventStoreError("infrastructure_failure", "Synthetic unreadable receipt.");
        }
        return store.readStream(input);
      },
    };
    const input = {
      accountId: "acc_seller",
      batchId,
      family: "listing.pause",
      listingIds: [ok, clash, missing, lost],
    } as const;
    // Counts the targets a batch actually drives: the batch runs each target through the runtime's own service.
    const driven = (runtime: ReturnType<typeof f.restart>) => {
      const sent: string[] = [];
      const pause = runtime.pauseListing;
      (runtime as { pauseListing: typeof pause }).pauseListing = async (params, eventContext) => {
        sent.push(params.listingId);
        return pause(params, eventContext);
      };
      return sent;
    };

    const firstRuntime = f.restart(lossy);
    const firstSent = driven(firstRuntime);
    const first = await firstRuntime.applyListingBatch(input, context);
    expect(first.items.map((item) => [item.targetId, item.outcome])).toEqual([
      [ok, "succeeded"],
      [clash, "conflict"],
      [missing, "error"],
      [lost, "unknown"],
    ]);
    expect(firstSent).toEqual([ok, clash, missing, lost]);
    await expect(
      f.listings.lookupListingBatch({ accountId: "acc_seller", family: "listing.pause", batchId }),
    ).resolves.toMatchObject({
      items: [
        { targetId: ok, outcome: "succeeded" },
        { targetId: clash, outcome: "conflict" },
        { targetId: missing, outcome: "error" },
        { targetId: lost, outcome: "unknown" },
      ],
    });
    const listingLengths = await f.streamLengths([ok, clash, lost]);

    // The retry re-drives only the explicit unknown target, whose committed pause replays with zero appends.
    const retryRuntime = f.restart();
    const retrySent = driven(retryRuntime);
    const retried = await retryRuntime.applyListingBatch(input, context);
    expect(retrySent).toEqual([lost]);
    expect(retried.items.map((item) => item.outcome)).toEqual(["succeeded", "conflict", "error", "succeeded"]);
    expect(await f.streamLengths([ok, clash, lost])).toEqual(listingLengths);

    // Resend mutant: once every target is terminal, a resend drives nothing and appends nothing.
    const resendRuntime = f.restart();
    const resendSent = driven(resendRuntime);
    await f.expectNoAppend(() => resendRuntime.applyListingBatch(input, context));
    expect(resendSent).toEqual([]);

    // The bulk price family keeps its own vector under the same batch id and re-sends nothing terminal.
    const repriced = await f.activeListing("lst_vector_price");
    const priceInput = {
      accountId: "acc_seller",
      batchId,
      updates: [{ listingId: repriced, priceAmount: "12.00", priceCurrencyCode: "USD" }],
    };
    const priced = await f.listings.applyBulkListingPriceUpdates(priceInput, context);
    expect(priced).toMatchObject([{ listingId: repriced, outcome: "applied" }]);
    await f.expectNoAppend(async () =>
      expect(await f.restart().applyBulkListingPriceUpdates(priceInput, context)).toMatchObject([
        { listingId: repriced, outcome: "applied", version: priced[0]!.version },
      ]),
    );
    await expect(
      f.listings.lookupListingBatch({ accountId: "acc_seller", family: "listing.update-price", batchId }),
    ).resolves.toMatchObject({ items: [{ targetId: repriced, outcome: "succeeded" }] });
  });

  it("refuses empty, partial, draft-only, terminal-mismatched, promoted-only and wrong-target histories", async () => {
    const f = await fixture(pools.marketplace);
    const store = createPostgresEventStore({ pool: pools.marketplace });
    const listingId = await f.activeListing("lst_history_owned");
    const owned = await f.listings.readAuthoritativeListing({ accountId: "acc_seller", listingId });
    expect(owned).toMatchObject({ kind: "present", state: { status: "active" } });

    // Empty: no aggregate is absent, never a default state a keyed write could decide from.
    await expect(
      f.listings.readAuthoritativeListing({ accountId: "acc_seller", listingId: "lst_history_empty" }),
    ).resolves.toEqual({ kind: "absent" });
    await f.expectNoAppend(() =>
      expect(
        f.listings.pauseListing(
          { accountId: "acc_seller", listingId: "lst_history_empty", idempotencyKey: key("empty"), expectedVersion: 0 },
          context,
        ),
      ).rejects.toBeDefined(),
    );

    // Wrong target: the owner reads another account's Listing as unusable rather than as its own.
    await expect(f.listings.readAuthoritativeListing({ accountId: "acc_other", listingId })).rejects.toMatchObject({
      code: "history_incomplete",
    });

    // Promoted-only: a later fact without the opening creation is unusable history.
    await store.appendToStream({
      streamId: "marketplace.listing-lst_history_promoted",
      expectedVersion: "no_stream",
      context,
      events: [{ eventType: "marketplace.listing.paused", payload: { listingId: "lst_history_promoted" } }],
    });
    await expect(
      f.listings.readAuthoritativeListing({ accountId: "acc_seller", listingId: "lst_history_promoted" }),
    ).rejects.toMatchObject({ code: "history_incomplete" });

    // Presence-only mutant: a dark-inbound pause written by another attempt is not this attempt's pause.
    const observed = owned.kind === "present" ? owned.version : 0;
    await f.listings.pauseListing(
      { accountId: "acc_seller", listingId, reason: "channel-inbound-dark", idempotencyKey: key("other-run") },
      context,
    );
    await f.expectNoAppend(() =>
      expect(
        f.restart().pauseListing(
          {
            accountId: "acc_seller",
            listingId,
            reason: "channel-inbound-dark",
            idempotencyKey: key("this-run"),
            expectedVersion: observed,
          },
          context,
        ),
      ).rejects.toMatchObject({ code: "concurrency_conflict" }),
    );

    // Partial and draft-only vector histories: a stamped non-terminal fact for the batch target is ambiguous,
    // so the batch reports the target unknown and appends nothing.
    const draft = "lst_history_draft";
    await f.listings.createListing(
      {
        accountId: "acc_seller" as never,
        inventoryItemId: "inv_one",
        priceAmount: "10.00",
        priceCurrencyCode: "USD",
        quantityCap: 1,
        listingIdOverride: draft as never,
      },
      context,
    );
    const partialBatch = key("partial");
    const partialAttempt = listingAttempt({
      idempotencyKey: partialBatch,
      mutationKind: "listing.pause",
      accountId: "acc_seller",
      targetId: draft,
      request: { listingId: draft, reason: "seller" },
    });
    const draftLength = (await f.streamLengths([draft]))[draft]!;
    await store.appendToStream({
      streamId: partialAttempt.streamId,
      expectedVersion: draftLength,
      context,
      events: stampListingAttemptEvents(partialAttempt, [
        { eventType: "marketplace.listing.evidence-requirements-refreshed", payload: {} },
      ]),
    });
    const partialInput = {
      accountId: "acc_seller",
      batchId: partialBatch,
      family: "listing.pause",
      listingIds: [draft],
    } as const;
    const partialLength = (await f.streamLengths([draft]))[draft];
    const partial = await f.restart().applyListingBatch(partialInput, context);
    expect(partial.items).toMatchObject([{ targetId: draft, outcome: "unknown" }]);
    expect((await f.streamLengths([draft]))[draft]).toBe(partialLength);

    // Terminal-mismatched vector: a later fact re-recording a terminal target differently poisons the vector.
    const withdrawn = await f.activeListing("lst_history_withdrawn");
    const mismatchBatch = key("mismatch");
    const mismatchInput = {
      accountId: "acc_seller",
      batchId: mismatchBatch,
      family: "listing.withdraw",
      listingIds: [withdrawn],
    } as const;
    await f.listings.applyListingBatch(mismatchInput, context);
    const batchStreamId = listingBatchStreamId({
      accountId: "acc_seller",
      family: "listing.withdraw",
      batchId: mismatchBatch,
    });
    const recorded = await store.readStream({ streamId: batchStreamId });
    const fact = recorded[0]!.payload as { entries: { outcome: string }[] };
    await store.appendToStream({
      streamId: batchStreamId,
      expectedVersion: recorded.length,
      context,
      events: [
        {
          eventType: recorded[0]!.eventType,
          payload: { ...fact, entries: fact.entries.map((entry) => ({ ...entry, outcome: "conflict" })) },
        },
      ],
    });
    await expect(
      f.listings.lookupListingBatch({ accountId: "acc_seller", family: "listing.withdraw", batchId: mismatchBatch }),
    ).rejects.toMatchObject({ code: "history_incomplete" });
    await f.expectNoAppend(async () => {
      const result = await f.restart().applyListingBatch(mismatchInput, context);
      expect(result.items).toMatchObject([{ targetId: withdrawn, outcome: "unknown" }]);
    });
  });

  it("replays seller availability, away and capacity attempts and conflicts on a changed field", async () => {
    const f = await fixture(pools.marketplace);
    const disable = {
      accountId: "acc_seller",
      reasonCategory: null,
      availableAgainOn: null,
      availableAgainAt: null,
      idempotencyKey: key("availability"),
    };
    const disabled = await f.listings.disableSellerListingAvailability(disable, context);
    await f.expectNoAppend(async () =>
      expect(await f.restart().disableSellerListingAvailability(disable, context)).toMatchObject({
        version: disabled.version,
      }),
    );
    await f.expectNoAppend(() =>
      expect(
        f.listings.disableSellerListingAvailability({ ...disable, availableAgainOn: "2031-01-01" }, context),
      ).rejects.toMatchObject({ code: "attempt_conflict" }),
    );
    const enable = { accountId: "acc_seller", idempotencyKey: key("enable") };
    const enabled = await f.listings.enableSellerListingAvailability(enable, context);
    await f.expectNoAppend(async () =>
      expect(await f.listings.enableSellerListingAvailability(enable, context)).toMatchObject({
        version: enabled.version,
      }),
    );

    const away = {
      accountId: "acc_seller",
      startsAt: "2031-01-01T00:00:00.000Z",
      endsAt: "2031-01-08T00:00:00.000Z",
      reasonCategory: "travel" as const,
      idempotencyKey: key("away"),
    };
    const scheduled = await f.listings.scheduleSellerAwayWindow(away, context);
    await f.expectNoAppend(async () =>
      expect(await f.restart().scheduleSellerAwayWindow(away, context)).toMatchObject({ version: scheduled.version }),
    );
    await f.expectNoAppend(() =>
      expect(
        f.listings.scheduleSellerAwayWindow({ ...away, endsAt: "2031-01-09T00:00:00.000Z" }, context),
      ).rejects.toMatchObject({ code: "attempt_conflict" }),
    );

    const capacity = { accountId: "acc_seller", maxOpenOrders: 5, idempotencyKey: key("capacity") };
    const set = await f.listings.setSellerOrderCapacity(capacity, context);
    await f.expectNoAppend(async () =>
      expect(await f.restart().setSellerOrderCapacity(capacity, context)).toMatchObject({ version: set.version }),
    );
    await f.expectNoAppend(() =>
      expect(f.listings.setSellerOrderCapacity({ ...capacity, maxOpenOrders: 6 }, context)).rejects.toMatchObject({
        code: "attempt_conflict",
      }),
    );
  });
});

async function fixture(pool: PgTransactionalPool) {
  const store = createPostgresEventStore({ pool });
  const restart = (eventStore: EventStore = store) =>
    createMarketplaceListingRuntime({
      eventStore,
      db: pool,
      checkpointStore: createPostgresProjectionStore({ db: pool }),
      commercialTermsResolver: {
        resolveListingTerms: async ({ amount, accountId }: { amount: string; accountId: string }) => ({
          accountId,
          accountType: "business",
          basisAmount: amount,
          marketplaceSalesFeeUnitAmount: "0.50",
          sellerNetUnitAmount: "9.50",
          scheduleId: "cts_test",
          agreementId: null,
          resolvedAt: "2026-10-28T00:00:00.000Z",
        }),
        openListingTermsSession: async ({ accountId }: { accountId: string }) => ({
          accountId,
          accountType: "business" as const,
          scheduleId: "cts_test",
          agreementId: null,
          resolvedAt: "2026-10-28T00:00:00.000Z",
          quote: (amount: string) => ({
            accountId,
            accountType: "business" as const,
            basisAmount: amount,
            marketplaceSalesFeeUnitAmount: "0.50",
            sellerNetUnitAmount: "9.50",
            scheduleId: "cts_test",
            agreementId: null,
            resolvedAt: "2026-10-28T00:00:00.000Z",
          }),
        }),
      } as never,
    });
  const listings = restart();
  const handlers = buildMarketplaceListingProjectionHandlers(pool);
  const projected = new Set<string>();
  async function project() {
    let afterGlobalPosition;
    for (;;) {
      const page = await store.readAll({ afterGlobalPosition, limit: 500 });
      for (const event of page) {
        if (handlers[event.eventType] && !projected.has(event.eventId)) {
          await handlers[event.eventType]!(toTransportEvent(event));
          projected.add(event.eventId);
        }
      }
      if (page.length < 500) break;
      afterGlobalPosition = page.at(-1)!.globalPosition;
    }
  }
  async function emit(type: string, payload: JsonObject, streamId: string) {
    const previous = await store.readStream({ streamId });
    const appended = await store.appendToStream({
      streamId,
      expectedVersion: previous.length,
      context,
      events: [{ eventType: type, payload }],
    });
    const supply = buildMarketplaceInventoryProjectionHandlers(pool, {
      onInventoryItemChanged: listings.reconcileInventoryCapacity,
    });
    await supply[type]!(toTransportEvent(appended[0]!));
    await project();
  }
  const eventCount = async () =>
    Number((await pool.query<{ count: string }>("SELECT count(*) AS count FROM event_store_events")).rows[0]!.count);
  await pool.query(
    "INSERT INTO marketplace_catalog_items (catalog_item_id, title, status, product_measure_snapshots) VALUES ('cat_test', 'Test Card', 'published', $1)",
    [JSON.stringify([measure])],
  );
  await emit(
    "inventory.storage-location.created",
    {
      storageLocationId: "loc_test",
      accountId: "acc_seller",
      name: "Main",
      shipFromCode: "CHI",
      shipFromAddress: address,
    },
    "inventory.storage-location-loc_test",
  );
  await emit(
    "inventory.item.created",
    {
      itemId: "inv_one",
      accountId: "acc_seller",
      catalogItemId: "cat_test",
      productId: "cat_test::",
      selectedOptions: [],
      gradedCard: null,
      storageLocationId: "loc_test",
      totalQuantity: 10,
      acquisitionCostAmount: null,
    },
    "inventory.item-inv_one",
  );
  return {
    listings,
    restart,
    /** Runs `action` and proves the event store gained no event, whatever the action returned or threw. */
    expectNoAppend: async (action: () => Promise<unknown>) => {
      const before = await eventCount();
      await action();
      expect(await eventCount()).toBe(before);
    },
    eventTypes: async (listingId: string) =>
      (await store.readStream({ streamId: `marketplace.listing-${listingId}` })).map((event) => event.eventType),
    streamLengths: async (listingIds: readonly string[]) =>
      Object.fromEntries(
        await Promise.all(
          listingIds.map(
            async (listingId) =>
              [listingId, (await store.readStream({ streamId: `marketplace.listing-${listingId}` })).length] as const,
          ),
        ),
      ) as Record<string, number>,
    listingCount: async () =>
      Number(
        (
          await pool.query<{ count: string }>(
            "SELECT count(DISTINCT stream_id) AS count FROM event_store_events WHERE event_type = 'marketplace.listing.created'",
          )
        ).rows[0]!.count,
      ),
    /** An internal-exempt (no attempt) active Listing for edit and bulk cases. */
    activeListing: async (listingId: string) => {
      await listings.createListing(
        {
          accountId: "acc_seller" as never,
          inventoryItemId: "inv_one",
          priceAmount: "10.00",
          priceCurrencyCode: "USD",
          quantityCap: 1,
          listingIdOverride: listingId as never,
        },
        context,
      );
      await listings.publishListing({ accountId: "acc_seller", listingId }, context);
      await project();
      return listingId;
    },
  };
}
