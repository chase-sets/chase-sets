import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { marketplaceAttemptBinding, hashMarketplaceRequest } from "../../mutation-recovery/api/attempt";
import {
  listingRecoveryForForm,
  listingRecoveryIdentitySchema,
  listingRecoveryResult,
  listingRecoveryUrl,
  loadListingRecovery,
  recoverListingBatch,
} from "./listing-batch";

const accountId = "acc_seller";
const identity = {
  batchId: "listing_batch_unit_0000001",
  mutationKind: "listing.pause" as const,
  bulk: true,
  targets: [{ id: "lst_one", requestHash: hashMarketplaceRequest({ listingId: "lst_one", reason: "seller" }) }],
};
function owner(ownerStatus: "committed" | "not-observed" | "ambiguous" = "not-observed") {
  return {
    ...marketplaceAttemptBinding({
      attemptId: identity.batchId,
      mutationKind: identity.mutationKind,
      accountId,
      target: { kind: "listing", id: "lst_one" },
      request: null,
    }),
    canonicalRequestHash: identity.targets[0]!.requestHash,
    ownerStatus,
    ...(ownerStatus === "committed" ? { ownerReceipt: { id: "lst_one", version: 2 } } : {}),
  };
}

describe("opaque Listing recovery model", () => {
  it("rejects storage and request-byte mutants without relying on filenames or a budget exception", () => {
    const files = ["listing-batch.ts", "listing-batch-recovery.tsx", "listing-command-form.tsx"];
    const assertPrivate = (source: string) =>
      expect(source).not.toMatch(
        /(?:localStorage|sessionStorage|indexedDB|document\.cookie|history\.(?:pushState|replaceState))/,
      );
    for (const file of files) assertPrivate(readFileSync(new URL(file, import.meta.url), "utf8"));
    expect(() => assertPrivate('localStorage.setItem("batch", csv)')).toThrow();
    expect(listingRecoveryIdentitySchema.safeParse({ ...identity, csv: "private bytes" }).success).toBe(false);
    expect(
      listingRecoveryIdentitySchema.safeParse({
        ...identity,
        targets: [{ ...identity.targets[0], path: "/private/file.csv" }],
      }).success,
    ).toBe(false);
  });

  it.each(["actorBinding", "target", "canonicalRequestHash", "attemptKeyFingerprint", "mutationKind"] as const)(
    "fails closed on a poisoned %s, with exactly one lookup",
    async (field) => {
      const result = owner("committed");
      const poisoned = {
        ...result,
        [field]:
          field === "actorBinding"
            ? { accountId: "acc_other" }
            : field === "target"
              ? { kind: "listing", id: "lst_other" }
              : field === "mutationKind"
                ? "listing.withdraw"
                : "0".repeat(64),
      };
      const api = { lookupListingAttempt: vi.fn(async () => poisoned), lookupListingBatch: vi.fn(async () => null) };
      expect((await recoverListingBatch(api, identity, accountId)).phase).toBe("ambiguous");
      expect(api.lookupListingAttempt).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["prepared", "partial", "ambiguous"])("never treats %s history as explicit unknown", async (ownerStatus) => {
    const api = {
      lookupListingAttempt: vi.fn(async () => ({ ...owner(), ownerStatus })),
      lookupListingBatch: vi.fn(async () => null),
    };
    expect((await recoverListingBatch(api, identity, accountId)).items[0]?.outcome).toBe("ambiguous");
  });

  it("distinguishes unavailable vector history from an absent batch and rejects presence-only success", async () => {
    const lookupListingAttempt = vi.fn(async () => owner());
    expect(
      (
        await recoverListingBatch(
          { lookupListingAttempt, lookupListingBatch: vi.fn(async () => null) },
          identity,
          accountId,
        )
      ).items[0]?.outcome,
    ).toBe("unknown");
    expect(
      (
        await recoverListingBatch(
          {
            lookupListingAttempt,
            lookupListingBatch: vi.fn(async () => {
              throw new Error("Incomplete vector");
            }),
          },
          identity,
          accountId,
        )
      ).phase,
    ).toBe("ambiguous");
    expect(
      (
        await recoverListingBatch(
          {
            lookupListingAttempt: vi.fn(async () => ({ ...owner(), ownerReceipt: { id: "lst_one", version: 2 } })),
            lookupListingBatch: vi.fn(async () => null),
          },
          identity,
          accountId,
        )
      ).phase,
    ).toBe("ambiguous");
  });

  it("accepts only schema-validated opaque URL references and no request or path additions", async () => {
    const api = { lookupListingAttempt: vi.fn(async () => owner()), lookupListingBatch: vi.fn(async () => null) };
    const request = new Request(`https://example.test${listingRecoveryUrl("/account/listings", identity)}`);
    expect((await loadListingRecovery(api, request, accountId))?.items).toEqual([
      { targetId: "lst_one", outcome: "unknown" },
    ]);
    expect(
      await loadListingRecovery(
        api,
        new Request("https://example.test/account/listings?listingRecovery=broken"),
        accountId,
      ),
    ).toEqual(listingRecoveryResult(null, []));
    expect(
      listingRecoveryIdentitySchema.safeParse({ ...identity, targets: [...identity.targets, ...identity.targets] })
        .success,
    ).toBe(false);
  });

  it("hashes the same canonical single Listing request as the owner", async () => {
    const form = new FormData();
    form.set("intent", "update-quantity-cap");
    form.set("quantityCap", "5");
    form.set("idempotencyKey", "listing_form_unit_00000001");
    const result = await listingRecoveryForForm(form, "lst_one", accountId);
    expect(result?.targets[0]?.requestHash).toBe(
      hashMarketplaceRequest({ listingId: "lst_one", quantityCap: 5, purchaseLimits: null }),
    );
    expect(result?.batchId).toBe("listing_form_unit_00000001_updateListingQuantityCap");
  });
});
