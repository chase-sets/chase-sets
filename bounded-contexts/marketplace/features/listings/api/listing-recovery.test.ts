import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import { describe, expect, it, vi } from "vitest";
import { hashMarketplaceRequest, marketplaceAttemptBinding } from "../../mutation-recovery/api/attempt";
import type { MarketplaceMutationRecoveryResult } from "../../mutation-recovery/domain/contracts";
import type {
  ListingRecoveryPreparation,
  ListingRecoveryReference,
  MarketplaceListingBatchItem,
} from "../ui/contracts";
import { createListingRecovery, listingRecoveryForCommand, recoverListingBatch } from "./listing-recovery";

const accountId = "acc_seller";
const key = "listing_recovery_test_000001";
const reference = { batchId: `${key}_bulk-pause-listings`, mutationKind: "listing.pause", bulk: true } as const;
const context = {
  tenantId: "tnt_test" as never,
  audit: { performedByUserId: "usr_test" as never, forAccountId: accountId as never },
};
const input = (intent: string, fields: ListingRecoveryPreparation["fields"] = {}): ListingRecoveryPreparation => ({
  intent,
  idempotencyKey: key,
  listingId: "lst_one",
  listingIds: ["lst_one", "lst_two", "lst_one"],
  fields,
});

describe("Listing recovery preparation", () => {
  it.each([
    ["bulk-pause-listings", "bulk-pause-listings", "listing.pause", { listingId: "lst_one", reason: "seller" }],
    ["bulk-withdraw-listings", "bulk-withdraw-listings", "listing.withdraw", { listingId: "lst_one" }],
    ["publish", "publishListing", "listing.publish", { listingId: "lst_one" }],
    ["pause", "pauseListing", "listing.pause", { listingId: "lst_one", reason: "seller" }],
    ["withdraw", "withdrawListing", "listing.withdraw", { listingId: "lst_one" }],
    [
      "update-price",
      "updateListingPrice",
      "listing.update-price",
      { listingId: "lst_one", priceAmount: "12.5", priceCurrencyCode: "USD" },
    ],
    [
      "update-quantity-cap",
      "updateListingQuantityCap",
      "listing.update-quantity",
      { listingId: "lst_one", quantityCap: 5, purchaseLimits: null },
    ],
    [
      "update-purchase-limits",
      "updateListingPurchaseLimits",
      "listing.update-purchase-limits",
      {
        listingId: "lst_one",
        purchaseLimits: { maxUnitsPerOrder: 2, maxUnitsPerDay: null, maxUnitsPerCustomerAccount: 3 },
      },
    ],
    [
      "disable-listing-availability",
      "disableSellerListingAvailability",
      "seller.availability",
      {
        status: "unavailable",
        reasonCategory: "travel",
        availableAgainOn: "2026-12-10",
        availableAgainAt: "2026-12-10T06:00:00.000Z",
      },
    ],
    [
      "enable-listing-availability",
      "enableSellerListingAvailability",
      "seller.availability",
      { status: "available", reasonCategory: null, availableAgainOn: null, availableAgainAt: null },
    ],
    [
      "schedule-away-window",
      "scheduleSellerAwayWindow",
      "seller.away",
      {
        action: "schedule",
        reasonCategory: "other",
        startsAt: "2026-12-08T06:00:00.000Z",
        endsAt: "2026-12-10T06:00:00.000Z",
      },
    ],
    [
      "cancel-away-window",
      "cancelScheduledAwayWindow",
      "seller.away",
      { action: "cancel", reasonCategory: null, startsAt: null, endsAt: null },
    ],
    ["set-order-capacity", "setSellerOrderCapacity", "seller.order-capacity", { maxOpenOrders: 17 }],
    ["clear-order-capacity", "clearSellerOrderCapacity", "seller.order-capacity", { maxOpenOrders: null }],
  ] as const)(
    "binds %s to the same canonical command and attempt key as the owner",
    (intent, command, mutationKind, request) => {
      const prepared = listingRecoveryForCommand(
        input(intent, {
          priceAmount: "012.50",
          priceCurrencyCode: "USD",
          quantityCap: "5",
          maxUnitsPerOrder: "2",
          maxUnitsPerDay: "",
          maxUnitsPerCustomerAccount: "3",
          reasonCategory: "travel",
          availableAgainOn: "2026-12-10",
          availableAgainAt: "2026-12-10T06:00:00.000Z",
          awayWindowReasonCategory: "other",
          awayWindowStartsAt: "2026-12-08T06:00:00.000Z",
          awayWindowEndsAt: "2026-12-10T06:00:00.000Z",
          maxOpenOrders: "17",
        }),
        accountId,
      );
      const bulk = intent.startsWith("bulk-");
      expect(prepared).toEqual({
        batchId: `${key}_${command}`,
        mutationKind,
        bulk,
        targets: [
          {
            id: mutationKind.startsWith("seller.") ? accountId : "lst_one",
            requestHash: hashMarketplaceRequest(request),
          },
          ...(bulk
            ? [{ id: "lst_two", requestHash: hashMarketplaceRequest({ ...request, listingId: "lst_two" }) }]
            : []),
        ],
      });
    },
  );

  it("persists only the binding, returns an opaque reference and refuses a changed replay without appending", async () => {
    const { eventStore, allEvents } = createInMemoryEventStore();
    const api = createListingRecovery(eventStore);
    const command = input("update-quantity-cap", { quantityCap: "5" });
    const result = await api.prepareListingRecovery(accountId, command, context);
    const reference = {
      batchId: `${key}_updateListingQuantityCap`,
      mutationKind: "listing.update-quantity",
      bulk: false,
    } as const;
    expect(result).toEqual({ reference });
    expect(await api.prepareListingRecovery(accountId, command, context)).toEqual(result);
    expect(await api.prepareListingRecovery(accountId, { ...command, retained: reference }, context)).toEqual(result);
    const changed = { ...command, fields: { quantityCap: "6" } };
    expect(await api.prepareListingRecovery(accountId, { ...changed, retained: reference }, context)).toMatchObject({
      recovery: { phase: "failed-safe", retryTargetIds: [] },
    });
    await expect(api.prepareListingRecovery(accountId, changed, context)).rejects.toMatchObject({
      code: "history_incomplete",
    });
    expect(await api.recoverListingBatch("acc_other", reference)).toMatchObject({ identity: null, phase: "ambiguous" });
    expect(
      await api.prepareListingRecovery("acc_other", { ...command, idempotencyKey: null, retained: reference }, context),
    ).toMatchObject({ recovery: { phase: "ambiguous", retryTargetIds: [] } });
    expect(allEvents).toHaveLength(1);
    expect(JSON.stringify(allEvents)).not.toMatch(/quantityCap|update-quantity-cap|listing_recovery_test_000001/);
  });

  it("binds blank seller fields to the same nulls as the command API", () => {
    const disabled = listingRecoveryForCommand(
      input("disable-listing-availability", {
        reasonCategory: " travel ",
        availableAgainOn: "",
        availableAgainAt: "",
      }),
      accountId,
    );
    expect(disabled?.targets[0]?.requestHash).toBe(
      hashMarketplaceRequest({
        status: "unavailable",
        reasonCategory: "travel",
        availableAgainOn: null,
        availableAgainAt: null,
      }),
    );
    const scheduled = listingRecoveryForCommand(
      input("schedule-away-window", {
        awayWindowStartsAt: "2026-12-08T06:00:00.000Z",
        awayWindowEndsAt: "",
        awayWindowReasonCategory: "travel",
      }),
      accountId,
    );
    expect(scheduled?.targets[0]?.requestHash).toBe(
      hashMarketplaceRequest({
        action: "schedule",
        reasonCategory: "travel",
        startsAt: "2026-12-08T06:00:00.000Z",
        endsAt: null,
      }),
    );
  });
});

function owner(
  id = "lst_one",
  ownerStatus: MarketplaceMutationRecoveryResult["ownerStatus"] = "not-observed",
): MarketplaceMutationRecoveryResult {
  return {
    ...marketplaceAttemptBinding({
      accountId,
      attemptId: reference.batchId,
      mutationKind: reference.mutationKind,
      target: { kind: "listing", id },
      request: { listingId: id, reason: "seller" },
    }),
    ownerStatus,
    ...(ownerStatus === "committed" ? { ownerReceipt: { id, version: 2 } } : {}),
  };
}
function entry(id: string, outcome: MarketplaceListingBatchItem["outcome"], noOp?: true): MarketplaceListingBatchItem {
  const { canonicalRequestHash, attemptKeyFingerprint } = owner(id);
  return {
    targetId: id,
    outcome,
    version: 2,
    requestHash: canonicalRequestHash,
    attemptKeyFingerprint,
    ...(noOp ? { noOp } : {}),
  };
}
function vector(...items: MarketplaceListingBatchItem[]) {
  return { batchId: reference.batchId, family: reference.mutationKind, items };
}

describe("Listing owner recovery", () => {
  it("reads every target once and allows retry only for bound, unobserved targets", async () => {
    const lookup = vi.fn(async ({ target }: { target: { id: string } }) =>
      owner(target.id, target.id === "lst_committed" ? "committed" : "not-observed"),
    );
    const result = await recoverListingBatch(
      reference,
      accountId,
      vector(
        entry("lst_committed", "succeeded"),
        entry("lst_noop", "succeeded", true),
        entry("lst_conflict", "conflict"),
        entry("lst_error", "error"),
        entry("lst_unknown", "unknown"),
      ),
      lookup,
    );
    expect(result.phase).toBe("partial");
    expect(result.items.map(({ outcome }) => outcome)).toEqual([
      "succeeded",
      "succeeded",
      "conflict",
      "error",
      "unknown",
    ]);
    expect(result.retryTargetIds).toEqual(["lst_unknown"]);
    expect(lookup.mock.calls.map(([{ target }]) => target.id)).toEqual([
      "lst_committed",
      "lst_noop",
      "lst_conflict",
      "lst_error",
      "lst_unknown",
    ]);
    await expect(lookup.mock.results[1]!.value).resolves.not.toHaveProperty("ownerReceipt");
  });

  it.each([
    { actorBinding: { accountId: "acc_other" } },
    { target: { kind: "seller", id: "lst_one" } },
    { target: { kind: "listing", id: "lst_other" } },
    { canonicalRequestHash: "0".repeat(64) },
    { attemptKeyFingerprint: "0".repeat(64) },
    { mutationKind: "listing.withdraw" },
    { ownerReceipt: { id: "lst_other", version: 2 } },
    { ownerReceipt: { id: "lst_one", version: 3 } },
    { ownerStatus: "prepared" },
    { ownerStatus: "partial" },
    { ownerStatus: "ambiguous" },
    { reason: "history-incomplete" },
  ] as const)("fails closed on mismatched or incomplete owner evidence %j", async (poisoned) => {
    const lookup = vi.fn(async () => ({ ...owner("lst_one", "committed"), ...poisoned }));
    expect(
      await recoverListingBatch(reference, accountId, vector(entry("lst_one", "succeeded")), lookup),
    ).toMatchObject({
      phase: "ambiguous",
      items: [{ targetId: "lst_one", outcome: "ambiguous" }],
      retryTargetIds: [],
    });
    expect(lookup).toHaveBeenCalledOnce();
  });

  it.each(["requestHash", "attemptKeyFingerprint"] as const)("rejects a poisoned no-op %s", async (field) => {
    const bad = { ...entry("lst_one", "succeeded", true), [field]: "0".repeat(64) };
    const lookup = vi.fn(async () => owner());
    expect(await recoverListingBatch(reference, accountId, vector(bad), lookup)).toMatchObject({ phase: "ambiguous" });
    expect(lookup).toHaveBeenCalledOnce();
  });

  it("never infers success from a receipt alone or exposes retry from an absent, duplicated or forged vector", async () => {
    const unknown = entry("lst_one", "unknown");
    const lookup = vi.fn(async () => ({ ...owner(), ownerReceipt: { id: "lst_one", version: 2 } }));
    expect(await recoverListingBatch(reference, accountId, vector(unknown), lookup)).toMatchObject({
      phase: "ambiguous",
      retryTargetIds: [],
    });
    for (const [ref, recorded] of [
      [reference, null],
      [reference, vector(unknown, unknown)],
      [{ ...reference, bulk: false }, vector(unknown)],
    ] satisfies [ListingRecoveryReference, ReturnType<typeof vector> | null][]) {
      expect(await recoverListingBatch(ref, accountId, recorded, lookup)).toMatchObject({
        phase: "ambiguous",
        retryTargetIds: [],
      });
    }
    expect(lookup).toHaveBeenCalledOnce();
  });
});
