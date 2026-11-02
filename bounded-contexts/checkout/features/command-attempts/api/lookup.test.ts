import { describe, expect, it, vi } from "vitest";
import { createAccountUserTestActor, createTestApp } from "@chase-sets/bounded-context-runtime/test-support";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { CheckoutApiEnv } from "../../../api";
import { createCheckoutCartRuntime } from "../../cart/api/runtime";
import {
  CHECKOUT_COMMAND_ATTEMPT_COMPLETED,
  checkoutCommandAttemptFingerprint,
  checkoutCommandAttemptStreamId,
} from "./attempt-history";
import type { CheckoutCartAttemptRequest } from "./cart-attempt";
import { computeCheckoutCommandAttemptRequestHash, parseCheckoutCommandAttemptResult } from "./contracts";
import { createAccountCommandAttemptRoutes, createGuestCommandAttemptRoutes } from "./route";

const OWNER = "acc_synthetic_lookup_owner";
const STRANGER = "acc_synthetic_lookup_stranger";
const DEVICE = "anon_synthetic_lookup_device_key";
const context: EventStoreContext = {
  tenantId: "tnt_test" as never,
  audit: { performedByUserId: "usr_synthetic_lookup" as never, forAccountId: OWNER as never },
};

function catalogDb(): PgQueryable {
  return {
    query: vi.fn(async (sql: string) => ({
      rows: sql.includes("FROM checkout_catalog_items")
        ? [{ catalog_item_id: "cat_synthetic_lookup", language_code: "en", status: "active", product_schema: null }]
        : [],
    })) as never,
  };
}

/** The real in-memory store behind a write counter; poisoned history is planted on `memory` directly. */
function harness() {
  const memory = createInMemoryEventStore();
  const writes = { appendToStream: 0, appendToStreams: 0 };
  const eventStore: EventStore = {
    ...memory.eventStore,
    appendToStream: async (input) => {
      writes.appendToStream += 1;
      return memory.eventStore.appendToStream(input);
    },
    appendToStreams: async (inputs) => {
      writes.appendToStreams += 1;
      return memory.eventStore.appendToStreams!(inputs);
    },
  };
  const runtime = createCheckoutCartRuntime({ eventStore, checkpointStore: {} as never, db: catalogDb() });
  return { memory, runtime, writes };
}

async function addRequest(ownerKey: string, attemptId: string): Promise<CheckoutCartAttemptRequest> {
  const commands = [
    {
      type: "add" as const,
      catalogItemId: "cat_synthetic_lookup",
      productId: "cat_synthetic_lookup::",
      itemTitle: "Synthetic lookup item",
      itemSubtitle: null,
      itemImageUrl: null,
      selectedOptions: [],
      productSummary: null,
      quantity: 1,
    },
  ];
  return {
    ownerKey,
    attemptId,
    kind: "cart.add-line",
    target: "cart",
    requestHash: await computeCheckoutCommandAttemptRequestHash({ commands }),
    commands,
  };
}

function lookupOf(request: CheckoutCartAttemptRequest, ownerKey = request.ownerKey) {
  return {
    ownerKey,
    attemptId: request.attemptId,
    kind: request.kind,
    target: request.target,
    requestHash: request.requestHash,
  };
}

function attemptStream(request: CheckoutCartAttemptRequest) {
  return checkoutCommandAttemptStreamId(
    checkoutCommandAttemptFingerprint({
      ownerKey: request.ownerKey,
      kind: request.kind,
      target: request.target,
      attemptId: request.attemptId,
    }),
  );
}

describe("checkout command attempt lookup", () => {
  it("returns the committed attempt as a closed payload and writes nothing", async () => {
    const h = harness();
    const request = await addRequest(OWNER, "lookup-attempt-committed-0001");
    const executed = await h.runtime.executeCartAttempt(request, context);
    const writesAfterCommit = { ...h.writes };

    const found = await h.runtime.lookupCartAttempt(lookupOf(request));

    expect(found).toEqual(executed.result);
    expect(parseCheckoutCommandAttemptResult(found)).toEqual(found);
    expect(JSON.stringify(found)).not.toContain(request.attemptId);
    expect(JSON.stringify(found)).not.toContain(OWNER);
    expect(h.writes).toEqual(writesAfterCommit);
  });

  it("answers missing, wrong-owner and unmatched attempts with one identical not-observed payload", async () => {
    const h = harness();
    const request = await addRequest(OWNER, "lookup-attempt-foreign-0001");
    await h.runtime.executeCartAttempt(request, context);

    const missing = await h.runtime.lookupCartAttempt({
      ...lookupOf(request),
      attemptId: "lookup-attempt-never-sent-01",
    });
    const wrongOwner = await h.runtime.lookupCartAttempt(lookupOf(request, STRANGER));
    const unmatched = await h.runtime.lookupCartAttempt({ ...lookupOf(request), kind: "cart.commands" });

    for (const answer of [missing, wrongOwner, unmatched]) {
      expect(answer.ownerStatus).toBe("not-observed");
      expect(Object.keys(answer).sort()).toEqual(
        ["actorBinding", "fingerprint", "kind", "ownerStatus", "requestHash", "schemaVersion", "target"].sort(),
      );
      expect(parseCheckoutCommandAttemptResult(answer)).toEqual(answer);
    }
    // A foreign presenter is bound to its own actor digest, so nothing in the
    // answer names, or depends on, the owner it was not.
    expect(wrongOwner.actorBinding).not.toEqual(missing.actorBinding);
    expect(wrongOwner).not.toHaveProperty("vector");
  });

  it.each([
    [
      "a second event",
      [
        { eventType: CHECKOUT_COMMAND_ATTEMPT_COMPLETED, payload: {} },
        { eventType: CHECKOUT_COMMAND_ATTEMPT_COMPLETED, payload: {} },
      ],
    ],
    ["an unknown event type", [{ eventType: "checkout.command-attempt.started", payload: {} }]],
  ] as const)("treats a stream with %s as ambiguous history and decides nothing", async (_label, events) => {
    const h = harness();
    const request = await addRequest(OWNER, "lookup-attempt-poisoned-0001");
    await h.memory.eventStore.appendToStream({
      streamId: attemptStream(request),
      expectedVersion: "no_stream",
      context,
      events: events.map((event) => ({ ...event, payload: { ...event.payload } })),
    });

    const looked = await h.runtime.lookupCartAttempt(lookupOf(request));
    const executed = await h.runtime.executeCartAttempt(request, context);

    expect(looked).toMatchObject({ ownerStatus: "ambiguous", reason: "history-incomplete" });
    expect(executed.result).toMatchObject({ ownerStatus: "ambiguous", reason: "history-incomplete" });
    expect(await h.memory.eventStore.readStream({ streamId: `checkout.cart-${OWNER}` })).toEqual([]);
  });

  it("rejects a poisoned payload nested anywhere in the recorded result", async () => {
    const h = harness();
    const request = await addRequest(OWNER, "lookup-attempt-nested-poison");
    const fingerprint = checkoutCommandAttemptFingerprint({
      ownerKey: OWNER,
      kind: request.kind,
      target: request.target,
      attemptId: request.attemptId,
    });
    const recorded = {
      schemaVersion: 1,
      kind: request.kind,
      fingerprint,
      actorBinding: { kind: "account", digest: "1".repeat(64) },
      target: request.target,
      requestHash: request.requestHash,
      ownerStatus: "committed",
      vector: [
        {
          index: 0,
          command: "add",
          outcome: "succeeded",
          lineId: "cli_synthetic",
          status: "added",
          version: 1,
          message: null,
          rawAttemptId: request.attemptId,
        },
      ],
    };
    await h.memory.eventStore.appendToStream({
      streamId: attemptStream(request),
      expectedVersion: "no_stream",
      context,
      events: [{ eventType: CHECKOUT_COMMAND_ATTEMPT_COMPLETED, payload: recorded }],
    });

    expect(await h.runtime.lookupCartAttempt(lookupOf(request))).toMatchObject({
      ownerStatus: "ambiguous",
      reason: "history-incomplete",
    });
    expect(parseCheckoutCommandAttemptResult(recorded)).toBeNull();
    expect(parseCheckoutCommandAttemptResult({ ...recorded, vector: [] })).toBeNull();
    expect(
      parseCheckoutCommandAttemptResult({ ...recorded, actorBinding: { ...recorded.actorBinding, cookie: DEVICE } }),
    ).toBeNull();
  });

  it("serves the lookup over HTTP for the authenticated or presented owner only, uncached", async () => {
    const h = harness();
    const request = await addRequest(DEVICE, "lookup-attempt-guest-http-01");
    await h.runtime.executeCartAttempt(request, context);
    const app = createTestApp<CheckoutApiEnv>({
      actor: createAccountUserTestActor({
        sessionId: "ses_lookup",
        userId: "usr_lookup",
        accountId: STRANGER,
        membershipId: "mbr_lookup",
        permissions: ["orders.view", "orders.manage"],
      }) as never,
      routes: (routes) => {
        routes.route(
          "/account",
          createAccountCommandAttemptRoutes({
            lookupCartAttempt: h.runtime.lookupCartAttempt,
            lookupEntryAttempt: async () => {
              throw new Error("A cart lookup never reads an entry attempt.");
            },
          }),
        );
        routes.route("/guest", createGuestCommandAttemptRoutes(h.runtime));
      },
    });
    const query = new URLSearchParams({ kind: request.kind, target: request.target, requestHash: request.requestHash });

    const guest = await app.request(`/guest/command-attempts/${request.attemptId}?${query}`, {
      headers: { "x-checkout-anonymous-cart-id": DEVICE },
    });
    const account = await app.request(`/account/command-attempts/${request.attemptId}?${query}`);
    const malformed = await app.request(`/account/command-attempts/short?${query}`);

    const guestBody = (await guest.json()) as { attempt: unknown };
    expect(guest.status).toBe(200);
    expect(guest.headers.get("cache-control")).toBe("no-store");
    expect(parseCheckoutCommandAttemptResult(guestBody.attempt)).toMatchObject({ ownerStatus: "committed" });
    expect(JSON.stringify(guestBody)).not.toContain(DEVICE);
    expect(JSON.stringify(guestBody)).not.toContain(request.attemptId);
    expect(((await account.json()) as { attempt: { ownerStatus: string } }).attempt.ownerStatus).toBe("not-observed");
    expect(malformed.status).toBe(400);
    expect(h.writes).toEqual({ appendToStream: 0, appendToStreams: 1 });
  });
});
