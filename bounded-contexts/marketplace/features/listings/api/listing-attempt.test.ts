import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { AccountId, TenantId, UserId } from "@chase-sets/primitives/typed-ids";
import { hashMarketplaceRequest } from "../../mutation-recovery/api/attempt";
import { marketplaceCanonicalRequest } from "../../mutation-recovery/domain/contracts";
import {
  attemptListingId,
  createListingMutationLookup,
  listingAttempt,
  readListingAttemptReceipt,
  runListingAttempt,
  stampListingAttemptEvents,
} from "./listing-attempt";
import { createAccountListingRoutes } from "./route";
import type { MarketplaceListingServices } from "./runtime";
import type { MarketplaceApiEnv } from "../../../api";

const context = (accountId: string): EventStoreContext => ({
  tenantId: "tnt_test" as TenantId,
  audit: { performedByUserId: "usr_test" as UserId, forAccountId: accountId as AccountId },
});
const priceRequest = { listingId: "lst_1", priceAmount: "10.00", priceCurrencyCode: "USD" };
const priceAttempt = (request: Record<string, unknown> = priceRequest, key = "browser_attempt_00000001") =>
  listingAttempt({
    idempotencyKey: key,
    mutationKind: "listing.update-price",
    accountId: "acc_seller",
    targetId: "lst_1",
    request,
  });

async function commitPrice(store: ReturnType<typeof createInMemoryEventStore>, attempt = priceAttempt()) {
  await store.eventStore.appendToStream({
    streamId: "marketplace.listing-lst_1",
    expectedVersion: "any",
    context: context("acc_seller"),
    events: stampListingAttemptEvents(attempt, [
      { eventType: "marketplace.listing.price-updated", payload: { priceAmount: "10.00", priceCurrencyCode: "USD" } },
    ]),
  });
}

describe("Listing attempt carrier", () => {
  it("returns the first receipt for an exact retry and treats 10 and 10.00 as the same amount", async () => {
    const store = createInMemoryEventStore();
    await commitPrice(store);
    await expect(readListingAttemptReceipt(store.eventStore, priceAttempt())).resolves.toMatchObject({
      id: "lst_1",
      version: 1,
    });
    await expect(
      readListingAttemptReceipt(store.eventStore, priceAttempt({ ...priceRequest, priceAmount: "10" })),
    ).resolves.toMatchObject({ version: 1 });
  });

  it.each([
    ["a currency-only change", { ...priceRequest, priceCurrencyCode: "EUR" }],
    ["an amount change", { ...priceRequest, priceAmount: "10.01" }],
  ])("conflicts with zero appends for %s under the same key", async (_label, changed) => {
    const store = createInMemoryEventStore();
    await commitPrice(store);
    const run = vi.fn(async () => ({ listingId: "lst_1", version: 99 }));
    await expect(
      runListingAttempt(
        store.eventStore,
        priceAttempt(changed),
        (receipt) => ({ listingId: "lst_1", ...receipt }),
        run,
      ),
    ).rejects.toMatchObject({ code: "attempt_conflict" });
    expect(run).not.toHaveBeenCalled();
    expect(store.allEvents).toHaveLength(1);
  });

  it("replays a committed attempt without running the command, and runs a never-recorded one once", async () => {
    const store = createInMemoryEventStore();
    const run = vi.fn(async () => {
      await commitPrice(store);
      return { listingId: "lst_1", version: 1 };
    });
    const replay = (receipt: { version: number }) => ({ listingId: "lst_1", version: receipt.version });
    await runListingAttempt(store.eventStore, priceAttempt(), replay, run);
    await expect(runListingAttempt(store.eventStore, priceAttempt(), replay, run)).resolves.toMatchObject({
      version: 1,
    });
    expect(run).toHaveBeenCalledTimes(1);
    expect(store.allEvents).toHaveLength(1);
  });

  it("adopts the first receipt when an identical concurrent retry lost the append race", async () => {
    const store = createInMemoryEventStore();
    const run = vi.fn(async () => {
      await commitPrice(store);
      throw Object.assign(new Error("concurrency"), { code: "concurrency_conflict" });
    });
    await expect(
      runListingAttempt(store.eventStore, priceAttempt(), (receipt) => ({ listingId: "lst_1", ...receipt }), run),
    ).resolves.toMatchObject({ version: 1 });
  });

  it("never replays another account's or another Listing's events under the same key", async () => {
    const store = createInMemoryEventStore();
    await commitPrice(store);
    const otherAccount = listingAttempt({
      idempotencyKey: "browser_attempt_00000001",
      mutationKind: "listing.update-price",
      accountId: "acc_other",
      targetId: "lst_1",
      request: priceRequest,
    });
    await expect(readListingAttemptReceipt(store.eventStore, otherAccount)).resolves.toBeNull();
    expect(otherAccount.eventIdPrefix).not.toBe(priceAttempt().eventIdPrefix);
  });

  it("keeps legacy repricing histories valid by comparing their recorded amount and currency", async () => {
    const store = createInMemoryEventStore();
    const key = "repricing:evt_1:prod_1:lst_1";
    await store.eventStore.appendToStream({
      streamId: "marketplace.listing-lst_1",
      expectedVersion: "any",
      context: context("acc_seller"),
      events: [
        {
          eventId: `${key}:0` as never,
          eventType: "marketplace.listing.price-updated",
          payload: { priceAmount: "10.00", priceCurrencyCode: "USD" },
        },
      ],
    });
    await expect(readListingAttemptReceipt(store.eventStore, priceAttempt(priceRequest, key))).resolves.toMatchObject({
      version: 1,
    });
    await expect(
      readListingAttemptReceipt(store.eventStore, priceAttempt({ ...priceRequest, priceCurrencyCode: "CAD" }, key)),
    ).rejects.toMatchObject({ code: "attempt_conflict" });
  });

  it("binds one create attempt to exactly one Listing id", () => {
    expect(attemptListingId("acc_seller", "create_attempt_000000001")).toBe(
      attemptListingId("acc_seller", "create_attempt_000000001"),
    );
    expect(attemptListingId("acc_seller", "create_attempt_000000001")).not.toBe(
      attemptListingId("acc_seller", "create_attempt_000000002"),
    );
    expect(attemptListingId("acc_seller", "create_attempt_000000001")).toMatch(/^lst_[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
  });

  it("looks up a committed attempt by the client's canonical hash and refuses other owners", async () => {
    const store = createInMemoryEventStore();
    await commitPrice(store);
    const lookup = createListingMutationLookup(store.eventStore);
    const requestHash = hashMarketplaceRequest(marketplaceCanonicalRequest("listing.update-price", priceRequest));
    const input = {
      attemptId: "browser_attempt_00000001",
      accountId: "acc_seller",
      mutationKind: "listing.update-price" as const,
      target: { kind: "listing" as const, id: "lst_1" },
      requestHash,
    };
    await expect(lookup(input)).resolves.toMatchObject({
      ownerStatus: "committed",
      ownerReceipt: { id: "lst_1", version: 1 },
    });
    await expect(lookup({ ...input, requestHash: "f".repeat(64) })).resolves.toMatchObject({
      ownerStatus: "not-observed",
    });
    await expect(lookup({ ...input, accountId: "acc_other" })).resolves.toMatchObject({ ownerStatus: "not-observed" });
  });

  it("refuses a browser or API Listing command without its attempt before any service call", async () => {
    const services = { pauseListing: vi.fn(), publishListing: vi.fn() } as unknown as MarketplaceListingServices;
    const app = new Hono<MarketplaceApiEnv>();
    app.use("*", async (c, next) => {
      c.set("actor", { accountId: "acc_seller", userId: "usr_test", permissions: ["listings.manage"] } as never);
      c.set("context", context("acc_seller") as never);
      await next();
    });
    app.route("/account", createAccountListingRoutes(services));
    const pause = await app.request("/account/listings/lst_1/pause", { method: "POST" });
    const publish = await app.request("/account/listings/lst_1/publish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ idempotencyKey: "repricing:evt_1:prod_1:lst_1" }),
    });
    expect([pause.status, publish.status]).toEqual([400, 400]);
    await expect(pause.json()).resolves.toMatchObject({ error: { code: "invalid_attempt" } });
    expect(services.pauseListing).not.toHaveBeenCalled();
    expect(services.publishListing).not.toHaveBeenCalled();
  });
});
