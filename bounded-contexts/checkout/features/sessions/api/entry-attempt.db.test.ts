import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createPgPool, createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { OrderId, PaymentId } from "@chase-sets/primitives/typed-ids";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import type { CheckoutApiEnv } from "../../../api";
import { module as checkoutModule } from "../../../index";
import { createCheckoutCartRuntime } from "../../cart/api/runtime";
import {
  CHECKOUT_COMMAND_ATTEMPT_COMPLETED,
  checkoutCommandAttemptFingerprint,
  checkoutCommandAttemptStreamId,
} from "../../command-attempts/api/attempt-history";
import type { CheckoutSessionCommand } from "../domain/domain";

const { mockPreviewBuyNowCheckoutSupplyThroughOrdering } = vi.hoisted(() => ({
  mockPreviewBuyNowCheckoutSupplyThroughOrdering: vi.fn(),
}));

// Ordering's supply preview is the only owner call a buy-now entry makes; the event store is real.
vi.mock("../../../support/request-support/checkout-confirmation", async () => {
  const actual = await vi.importActual<typeof import("../../../support/request-support/checkout-confirmation")>(
    "../../../support/request-support/checkout-confirmation",
  );
  return { ...actual, previewBuyNowCheckoutSupplyThroughOrdering: mockPreviewBuyNowCheckoutSupplyThroughOrdering };
});

import { createAccountCheckoutSessionRoutes } from "./route";
import { createCheckoutSessionRuntime } from "./runtime";

/**
 * Checkout Session entry attempts (#9994) against real PostgreSQL: the entry
 * attempt is appended with the Session's started event in one
 * `appendToStreams`, both at `no_stream`, through the real session route.
 */

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
const describeDb = databaseBaseUrl ? describe : describe.skip;
const contextNames = ["checkout"] as const;
const ACCOUNT = "acc_synthetic_entry_buyer";
const CATALOG_ITEM = "cat_synthetic_entry";
const LISTING = "lst_synthetic_entry";
let pools: Readonly<Record<(typeof contextNames)[number], PgTransactionalPool>> | undefined;
let pool: PgTransactionalPool;
let databaseUrl: string;

const actor = {
  sessionId: "ses_synthetic_entry",
  tenantId: "tnt_test",
  userId: "usr_synthetic_entry",
  accountId: ACCOUNT,
  membershipId: "mbr_synthetic_entry",
  roleKey: "owner",
  permissions: ["orders.view", "orders.manage"],
} as unknown as NonNullable<CheckoutApiEnv["Variables"]["actor"]>;

const context: EventStoreContext = {
  tenantId: "tnt_test" as never,
  audit: { performedByUserId: "usr_synthetic_entry" as never, forAccountId: ACCOUNT as never },
};

/** A contact-less guest-buyer, as a followed guest entry presents it. */
const GUEST_ACCOUNT = "acc_synthetic_entry_guest";
const guestActor = {
  sessionId: "guest:tok_synthetic_entry",
  tenantId: "tnt_test",
  userId: "usr_synthetic_entry_guest",
  accountId: GUEST_ACCOUNT,
  membershipId: "guest:tok_synthetic_entry",
  roleKey: "guest-buyer",
  permissions: ["guest-checkout.manage"],
} as unknown as NonNullable<CheckoutApiEnv["Variables"]["actor"]>;

const guestContext: EventStoreContext = {
  tenantId: "tnt_test" as never,
  audit: { performedByUserId: "usr_synthetic_entry_guest" as never, forAccountId: GUEST_ACCOUNT as never },
};

function requireDatabaseBaseUrl() {
  if (!databaseBaseUrl) throw new Error("TEST_DATABASE_URL is required for checkout entry attempt DB tests.");
  return databaseBaseUrl;
}

let keySequence = 0;
/** One caller-created key per deliberate submission, shaped like the loaders' minted keys. */
function entryKey() {
  keySequence += 1;
  return `chkentry_db_synthetic_${String(keySequence).padStart(8, "0")}`;
}

/** The body Discovery's public-listing Buy sends: key, canonical source and display-only fields. */
function publicListingBuy(entryAttemptKey: string | null, overrides: Record<string, unknown> = {}) {
  return {
    ...(entryAttemptKey === null ? {} : { entryAttemptKey }),
    source: {
      type: "buy-now",
      listingId: LISTING,
      lockedListingId: LISTING,
      fulfillmentMode: "locked-listing",
      catalogItemId: CATALOG_ITEM,
      productId: `${CATALOG_ITEM}::`,
      itemTitle: "Synthetic entry card",
      itemSubtitle: null,
      selectedOptions: [],
      productSummary: null,
      quantity: 1,
      priceAmount: "12.00",
      priceCurrencyCode: "USD",
      sellerName: "Synthetic seller",
      ...overrides,
    },
  };
}

function offerIntent(entryAttemptKey: string) {
  return {
    entryAttemptKey,
    source: {
      type: "offer-intent",
      catalogItemId: CATALOG_ITEM,
      productId: `${CATALOG_ITEM}::`,
      itemTitle: "Synthetic entry card",
      selectedOptions: [],
      offerPriceAmount: "10.00",
      offerPriceCurrencyCode: "USD",
      quantity: 1,
    },
  };
}

function readyPreview() {
  return {
    revision: "synthetic_entry_preview",
    readyLineKeys: [`${LISTING}:0`],
    unavailableLineKeys: [],
    unavailableLines: [],
    sellerGroups: [],
    materialChangeReasons: [],
    totals: {
      itemSubtotalAmount: "12.00",
      shippingAmount: "0.00",
      salesTaxAmount: "0.00",
      totalAmount: "12.00",
      packageCount: 1,
    },
  };
}

/** Holds the first appends until `size` of them arrive, so racing entries both reach the atomic append. */
let appendBarrier: { size: number; arrived: Array<() => void> } | null = null;

/** The real store, counting appends; nothing here changes what PostgreSQL stores. */
function entryHarness(
  target: PgTransactionalPool,
  presenter: { actor: typeof actor; context: EventStoreContext } = { actor, context },
) {
  const store = createPostgresEventStore({ pool: target });
  const calls = { appendToStream: 0, appendToStreams: 0 };
  const eventStore: EventStore = {
    ...store,
    appendToStream: async (input) => {
      calls.appendToStream += 1;
      return store.appendToStream(input);
    },
    appendToStreams: async (inputs) => {
      calls.appendToStreams += 1;
      const gate = appendBarrier;
      if (gate) {
        await new Promise<void>((release) => {
          gate.arrived.push(release);
          if (gate.arrived.length >= gate.size) {
            for (const arrived of gate.arrived) arrived();
          }
          // Never hang the suite if a contender stops before its append.
          setTimeout(release, 5_000);
        });
      }
      return store.appendToStreams!(inputs);
    },
  };
  const cart = createCheckoutCartRuntime({ eventStore, checkpointStore: {} as never, db: target });
  const sessions = createCheckoutSessionRuntime({ eventStore, checkpointStore: {} as never, db: target, cart });
  const app = new Hono<CheckoutApiEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", presenter.actor);
    c.set("context", presenter.context as never);
    await next();
  });
  app.route("/account", createAccountCheckoutSessionRoutes(sessions));
  const enter = async (body: unknown) => {
    const response = await app.fetch(
      new Request("http://checkout.test/account/checkout-sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  const apply = (sessionId: string, command: CheckoutSessionCommand) =>
    sessions.commandHandler({ streamId: `checkout.session-${sessionId}`, command, context: presenter.context });
  return { calls, enter, apply };
}

async function sessionEventTypes(sessionId: string) {
  return (
    await readCompleteStream(createPostgresEventStore({ pool }), { streamId: `checkout.session-${sessionId}` })
  ).map((event) => event.eventType);
}

async function entryAttemptEventTypes(attemptId: string, ownerKey = ACCOUNT) {
  const fingerprint = checkoutCommandAttemptFingerprint({
    ownerKey,
    kind: "checkout-entry",
    target: "session",
    attemptId,
  });
  return (
    await readCompleteStream(createPostgresEventStore({ pool }), {
      streamId: checkoutCommandAttemptStreamId(fingerprint),
    })
  ).map((event) => event.eventType);
}

const recordedAt = "2026-10-31T00:00:00.000Z";
const shippingAddress = {
  name: "Synthetic Buyer",
  company: null,
  line1: "100 Synthetic Street",
  line2: null,
  city: "Chicago",
  state: "IL",
  postalCode: "60601",
  country: "US",
};

describeDb("checkout entry attempts against real PostgreSQL", () => {
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(requireDatabaseBaseUrl(), contextNames, "entry_attempt");
    await ensureMultiContextTestDatabases(requireDatabaseBaseUrl(), urls);
    pools = createMultiContextTestPools(urls);
    pool = pools.checkout;
    databaseUrl = urls.checkout;
  });

  beforeEach(async () => {
    appendBarrier = null;
    mockPreviewBuyNowCheckoutSupplyThroughOrdering.mockReset();
    mockPreviewBuyNowCheckoutSupplyThroughOrdering.mockResolvedValue(readyPreview());
    await resetMultiContextTestSchemas({ checkout: pool });
    await bootstrapContextDatabase(checkoutModule, pool);
    await pool.query(
      `INSERT INTO checkout_catalog_items (catalog_item_id, title, subtitle, blueprint_id, status, product_schema, language_code, updated_at)
       VALUES ($1, 'Synthetic entry card', NULL, NULL, 'active', NULL, 'en', now())`,
      [CATALOG_ITEM],
    );
  });

  afterAll(async () => {
    if (pools) await closeMultiContextTestPools(pools);
    pools = undefined;
  });

  it("opens one Session when exact entries race on separate connections", async () => {
    const contenderPool = createPgPool(databaseUrl);
    try {
      const first = entryHarness(pool);
      const second = entryHarness(contenderPool);
      const key = entryKey();
      appendBarrier = { size: 2, arrived: [] };

      const [left, right] = await Promise.all([
        first.enter(publicListingBuy(key)),
        second.enter(publicListingBuy(key)),
      ]);
      appendBarrier = null;

      expect([left.status, right.status]).toEqual([201, 201]);
      expect(right.body.session_id).toBe(left.body.session_id);
      // Both contenders reached the atomic append; exactly one committed.
      expect(first.calls.appendToStreams + second.calls.appendToStreams).toBe(2);
      expect(await sessionEventTypes(String(left.body.session_id))).toEqual(["checkout.session.started"]);
      expect(await entryAttemptEventTypes(key)).toEqual([CHECKOUT_COMMAND_ATTEMPT_COMPLETED]);
    } finally {
      await (contenderPool as unknown as { end: () => Promise<void> }).end();
    }
  });

  it("replays a public-listing entry with only new display labels and refuses a changed quantity or listing", async () => {
    const h = entryHarness(pool);
    const key = entryKey();
    const opened = await h.enter(publicListingBuy(key));
    const before = { ...h.calls };
    const previews = mockPreviewBuyNowCheckoutSupplyThroughOrdering.mock.calls.length;

    const exact = await h.enter(publicListingBuy(key));
    const relabeled = await h.enter(
      publicListingBuy(key, {
        itemTitle: "Synthetic entry card (relabeled)",
        priceAmount: "13.00",
        sellerName: "Renamed",
      }),
    );
    const changedQuantity = await h.enter(publicListingBuy(key, { quantity: 2 }));
    const changedListing = await h.enter(
      publicListingBuy(key, { listingId: "lst_synthetic_other", lockedListingId: "lst_synthetic_other" }),
    );

    expect(opened.status).toBe(201);
    expect([exact.status, relabeled.status]).toEqual([201, 201]);
    expect(exact.body.session_id).toBe(opened.body.session_id);
    expect(relabeled.body.session_id).toBe(opened.body.session_id);
    for (const conflict of [changedQuantity, changedListing]) {
      expect(conflict.status).toBe(409);
      expect(conflict.body).toMatchObject({ error: { code: "checkout_attempt_conflict" } });
    }
    expect(h.calls).toEqual(before);
    expect(mockPreviewBuyNowCheckoutSupplyThroughOrdering).toHaveBeenCalledTimes(previews);
    expect(await sessionEventTypes(String(opened.body.session_id))).toEqual(["checkout.session.started"]);
    expect(await entryAttemptEventTypes(key)).toEqual([CHECKOUT_COMMAND_ATTEMPT_COMPLETED]);
  });

  it("replays a guest-buyer's exact entry to its first Session with zero appends, on the guest's own attempt stream", async () => {
    const guest = entryHarness(pool, { actor: guestActor, context: guestContext });
    const key = entryKey();
    const opened = await guest.enter(publicListingBuy(key));
    const before = { ...guest.calls };
    const previews = mockPreviewBuyNowCheckoutSupplyThroughOrdering.mock.calls.length;

    // The exact retry after a lost response: the browser already holds the guest cookie.
    const replayed = await guest.enter(publicListingBuy(key));

    expect([opened.status, replayed.status]).toEqual([201, 201]);
    expect(replayed.body.session_id).toBe(opened.body.session_id);
    expect(before.appendToStreams).toBeGreaterThan(0);
    expect(guest.calls).toEqual(before);
    expect(mockPreviewBuyNowCheckoutSupplyThroughOrdering).toHaveBeenCalledTimes(previews);
    expect(await sessionEventTypes(String(opened.body.session_id))).toEqual(["checkout.session.started"]);
    expect(await entryAttemptEventTypes(key, GUEST_ACCOUNT)).toEqual([CHECKOUT_COMMAND_ATTEMPT_COMPLETED]);
    expect(await entryAttemptEventTypes(key, ACCOUNT)).toEqual([]);
  });

  it("refuses a keyless or malformed non-cart entry with 400 and zero appends", async () => {
    const h = entryHarness(pool);

    const keyless = await h.enter(publicListingBuy(null));
    const malformed = await h.enter(publicListingBuy("short"));

    for (const refused of [keyless, malformed]) {
      expect(refused.status).toBe(400);
      expect(refused.body).toMatchObject({ error: { code: "checkout_attempt_required" } });
    }
    expect(h.calls).toEqual({ appendToStream: 0, appendToStreams: 0 });
    expect(mockPreviewBuyNowCheckoutSupplyThroughOrdering).not.toHaveBeenCalled();
  });

  it("replays a day-after entry from every Session state with zero owner writes", async () => {
    const h = entryHarness(pool);
    const states: Array<{ state: string; body: ReturnType<typeof publicListingBuy> | ReturnType<typeof offerIntent> }> =
      [];
    const open = async (state: string, body: ReturnType<typeof publicListingBuy> | ReturnType<typeof offerIntent>) => {
      const opened = await h.enter(body);
      expect(opened.status).toBe(201);
      states.push({ state, body });
      return String(opened.body.session_id);
    };
    const setAddress: CheckoutSessionCommand = { type: "SetShippingAddress", shippingAddress, selectedAt: recordedAt };
    const ordersCreated: CheckoutSessionCommand = {
      type: "RecordOrdersCreated",
      orderIds: ["ord_synthetic_entry" as OrderId],
      recordedAt,
    };

    await open("no orders", publicListingBuy(entryKey()));
    const ordersOnly = await open("orders only", publicListingBuy(entryKey()));
    await h.apply(ordersOnly, setAddress);
    await h.apply(ordersOnly, ordersCreated);
    const paymentStarted = await open("payment started", publicListingBuy(entryKey()));
    await h.apply(paymentStarted, setAddress);
    await h.apply(paymentStarted, ordersCreated);
    await h.apply(paymentStarted, {
      type: "RecordPaymentStarted",
      paymentId: "pay_synthetic_entry" as PaymentId,
      recordedAt,
    });
    const offerSubmitted = await open("Offer submitted", offerIntent(entryKey()));
    await h.apply(offerSubmitted, setAddress);
    await h.apply(offerSubmitted, { type: "RecordOfferSubmitted", offerId: "off_synthetic_entry", recordedAt });
    const cancelled = await open("cancelled", publicListingBuy(entryKey()));
    await h.apply(cancelled, { type: "CancelCheckoutSession", cancelledAt: recordedAt });

    const firstSessions = new Map<string, string>();
    for (const { state, body } of states) {
      firstSessions.set(state, String((await h.enter(body)).body.session_id));
    }
    const streamsBefore = await Promise.all([...firstSessions.values()].map(sessionEventTypes));
    const callsBefore = { ...h.calls };
    const previewsBefore = mockPreviewBuyNowCheckoutSupplyThroughOrdering.mock.calls.length;

    const dayAfter = entryHarness(pool);
    const replays = await Promise.all(states.map(({ body }) => dayAfter.enter(body)));

    expect(replays.map((replay) => replay.status)).toEqual(states.map(() => 201));
    expect(replays.map((replay) => replay.body.session_id)).toEqual(
      states.map(({ state }) => firstSessions.get(state)),
    );
    expect(dayAfter.calls).toEqual({ appendToStream: 0, appendToStreams: 0 });
    expect(h.calls).toEqual(callsBefore);
    expect(mockPreviewBuyNowCheckoutSupplyThroughOrdering).toHaveBeenCalledTimes(previewsBefore);
    expect(await Promise.all([...firstSessions.values()].map(sessionEventTypes))).toEqual(streamsBefore);
  });
});
