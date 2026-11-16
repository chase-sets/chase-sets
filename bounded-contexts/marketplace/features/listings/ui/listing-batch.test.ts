import { readFileSync } from "node:fs";
import http from "node:http";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import { lookupListingBatch, prepareListingBatch } from "../api/listing-batch";
import { createListingMutationLookup } from "../api/listing-attempt";
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
  it.each([250, 500])("serves a %i-target recovery reference through the default HTTP parser", async (count) => {
    const form = new FormData();
    form.set("intent", "bulk-pause-listings");
    form.set("idempotencyKey", "synthetic_transport_000001");
    for (let index = 0; index < count; index++) form.append("listingIds", `lst_${String(index).padStart(26, "0")}`);
    const prepared = (await listingRecoveryForForm(form, null, accountId))!;
    const { eventStore, allEvents } = createInMemoryEventStore();
    await prepareListingBatch(eventStore, accountId, prepared, {
      tenantId: "tnt_synthetic" as never,
      audit: { performedByUserId: "usr_synthetic" as never, forAccountId: accountId as never },
    });
    const api = {
      lookupListingBatch: async () =>
        lookupListingBatch(eventStore, { accountId, batchId: prepared.batchId, family: prepared.mutationKind }),
      lookupListingAttempt: vi.fn((attemptId: string, _mutationKind: string, id: string, requestHash: string) =>
        createListingMutationLookup(eventStore)({
          attemptId,
          mutationKind: prepared.mutationKind,
          accountId,
          target: { kind: "listing", id },
          requestHash,
        }),
      ),
    };
    const path = listingRecoveryUrl("/account/listings", prepared);
    let reopened: Awaited<ReturnType<typeof loadListingRecovery>>;
    const server = http.createServer((request, response) => {
      void loadListingRecovery(api, new Request(`http://127.0.0.1${request.url}`), accountId).then(
        (result) => {
          reopened = result;
          response.end("ok");
        },
        (error: unknown) => response.destroy(error instanceof Error ? error : new Error("Recovery lookup failed")),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const status = await new Promise<number | string>((resolve) => {
        http
          .get(
            { hostname: "127.0.0.1", port: (server.address() as { port: number }).port, path, agent: false },
            (response) => {
              response.resume();
              response.on("end", () => resolve(response.statusCode!));
            },
          )
          .on("error", (error: NodeJS.ErrnoException) => resolve(error.code!));
      });
      expect(status).toBe(200);
      expect(Buffer.byteLength(path)).toBeLessThan(1024);
      expect(prepared.targets).toHaveLength(count);
      expect(reopened!.identity).toEqual(prepared);
      expect(reopened!.items).toHaveLength(count);
      expect(api.lookupListingAttempt).toHaveBeenCalledTimes(count);
      expect(JSON.stringify(allEvents)).not.toMatch(/priceAmount|reason|csv/);
      expect(allEvents.every((event) => event.eventType === "marketplace.listing-batch.recorded")).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("preserves a bound authoritative no-op without manufacturing an owner receipt", async () => {
    const result = owner();
    const api = {
      lookupListingAttempt: vi.fn(async () => result),
      lookupListingBatch: vi.fn(async () => ({
        batchId: identity.batchId,
        family: identity.mutationKind,
        items: [
          {
            targetId: "lst_one",
            outcome: "succeeded" as const,
            version: 2,
            noOp: true as const,
            requestHash: result.canonicalRequestHash,
            attemptKeyFingerprint: result.attemptKeyFingerprint,
          },
        ],
      })),
    };
    expect((await recoverListingBatch(api, identity, accountId)).phase).toBe("succeeded");
    expect(api.lookupListingAttempt).toHaveBeenCalledTimes(1);
  });

  it.each(["requestHash", "attemptKeyFingerprint"] as const)("rejects a poisoned no-op %s", async (field) => {
    const result = owner();
    const api = {
      lookupListingAttempt: vi.fn(async () => result),
      lookupListingBatch: vi.fn(async () => ({
        batchId: identity.batchId,
        family: identity.mutationKind,
        items: [
          {
            targetId: "lst_one",
            outcome: "succeeded" as const,
            version: 2,
            noOp: true as const,
            requestHash: result.canonicalRequestHash,
            attemptKeyFingerprint: result.attemptKeyFingerprint,
            [field]: "0".repeat(64),
          },
        ],
      })),
    };
    expect((await recoverListingBatch(api, identity, accountId)).phase).toBe("ambiguous");
    expect(api.lookupListingAttempt).toHaveBeenCalledTimes(1);
  });

  it("reconciles mixed eventful success, bound no-op and unknown with exactly one owner lookup each", async () => {
    const targets = ["lst_eventful", "lst_noop", "lst_unknown"].map((id) => ({
      id,
      requestHash: hashMarketplaceRequest({ listingId: id, reason: "seller" }),
    }));
    const mixed = { ...identity, targets };
    const lookupListingAttempt = vi.fn(async (_attempt: string, _kind: string, id: string, requestHash: string) => ({
      ...marketplaceAttemptBinding({
        accountId,
        attemptId: identity.batchId,
        mutationKind: identity.mutationKind,
        target: { kind: "listing", id },
        request: null,
      }),
      canonicalRequestHash: requestHash,
      ownerStatus: id === "lst_eventful" ? "committed" : "not-observed",
      ...(id === "lst_eventful" ? { ownerReceipt: { id, version: 2 } } : {}),
    }));
    const items = targets.map((target) => ({
      targetId: target.id,
      requestHash: target.requestHash,
      attemptKeyFingerprint: marketplaceAttemptBinding({
        accountId,
        attemptId: identity.batchId,
        mutationKind: identity.mutationKind,
        target: { kind: "listing", id: target.id },
        request: null,
      }).attemptKeyFingerprint,
      outcome: target.id === "lst_unknown" ? ("unknown" as const) : ("succeeded" as const),
      version: 2,
      ...(target.id === "lst_noop" ? { noOp: true as const } : {}),
    }));
    const recovered = await recoverListingBatch(
      {
        lookupListingAttempt,
        lookupListingBatch: async () => ({ batchId: identity.batchId, family: identity.mutationKind, items }),
      },
      mixed,
      accountId,
    );
    expect(recovered.phase).toBe("partial");
    expect(recovered.items.map((item) => item.outcome)).toEqual(["succeeded", "succeeded", "unknown"]);
    expect(lookupListingAttempt.mock.calls.map((call) => call[2])).toEqual(targets.map((target) => target.id));
  });
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
    const binding = owner();
    const api = {
      lookupListingAttempt: vi.fn(async () => binding),
      lookupListingBatch: vi.fn(async () => ({
        batchId: identity.batchId,
        family: identity.mutationKind,
        items: [
          {
            targetId: "lst_one",
            outcome: "unknown" as const,
            version: 0,
            requestHash: binding.canonicalRequestHash,
            attemptKeyFingerprint: binding.attemptKeyFingerprint,
          },
        ],
      })),
    };
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
