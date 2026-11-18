import { readFileSync } from "node:fs";
import http from "node:http";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import { describe, expect, it, vi } from "vitest";
import { createListingRecovery } from "../api/listing-recovery";
import { listingRecoveryIdentitySchema } from "./contracts";
import { ambiguousListingRecovery, listingRecoveryUrl, loadListingRecovery } from "./listing-batch";

const accountId = "acc_seller";
const context = {
  tenantId: "tnt_synthetic" as never,
  audit: { performedByUserId: "usr_synthetic" as never, forAccountId: accountId as never },
};

describe("opaque Listing recovery reference", () => {
  it.each([250, 500])("serves a %i-target recovery reference through the default HTTP parser", async (count) => {
    const { eventStore, allEvents } = createInMemoryEventStore();
    const recovery = createListingRecovery(eventStore);
    const preparation = await recovery.prepareListingRecovery(
      accountId,
      {
        intent: "bulk-pause-listings",
        idempotencyKey: "synthetic_transport_000001",
        listingId: null,
        listingIds: Array.from({ length: count }, (_, index) => `lst_${String(index).padStart(26, "0")}`),
        fields: {},
      },
      context,
    );
    if (!("reference" in preparation) || !preparation.reference) throw new Error("Expected prepared reference");
    const path = listingRecoveryUrl("/account/listings", preparation.reference);
    const api = { recoverListingBatch: vi.fn((reference) => recovery.recoverListingBatch(accountId, reference)) };
    let reopened: Awaited<ReturnType<typeof loadListingRecovery>>;
    const server = http.createServer((request, response) => {
      void loadListingRecovery(api, new Request(`http://127.0.0.1${request.url}`)).then(
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
      expect(reopened!.identity).toEqual(preparation.reference);
      expect(reopened!.retryTargetIds).toHaveLength(count);
      expect(api.recoverListingBatch).toHaveBeenCalledExactlyOnceWith(preparation.reference);
      expect(JSON.stringify(allEvents)).not.toMatch(/priceAmount|reason|csv/);
      expect(allEvents.every((event) => event.eventType === "marketplace.listing-batch.recorded")).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("rejects storage and request-byte mutants without relying on filenames or a budget exception", () => {
    const assertPrivate = (source: string) =>
      expect(source).not.toMatch(
        /(?:localStorage|sessionStorage|indexedDB|document\.cookie|history\.(?:pushState|replaceState))/,
      );
    for (const file of ["listing-batch.ts", "listing-batch-recovery.tsx", "listing-command-form.tsx"])
      assertPrivate(readFileSync(new URL(file, import.meta.url), "utf8"));
    expect(() => assertPrivate('localStorage.setItem("batch", csv)')).toThrow();
    const target = { id: "lst_one", requestHash: "1".repeat(64) };
    const identity = {
      batchId: "listing_recovery_storage_00001_bulk-pause-listings",
      mutationKind: "listing.pause",
      bulk: true,
      targets: [target],
    };
    for (const invalid of [
      { ...identity, csv: "private bytes" },
      { ...identity, targets: [{ ...target, path: "/private/file.csv" }] },
      { ...identity, targets: [target, target] },
    ])
      expect(listingRecoveryIdentitySchema.safeParse(invalid).success).toBe(false);
  });

  it("does not call the API for a malformed reference or expose retry when the read is lost", async () => {
    const api = {
      recoverListingBatch: vi.fn(async () => {
        throw new TypeError("read lost");
      }),
    };
    const malformed = new Request("https://example.test/account/listings?listingRecovery=broken");
    expect(await loadListingRecovery(api, malformed)).toEqual(ambiguousListingRecovery);
    expect(api.recoverListingBatch).not.toHaveBeenCalled();
    const valid = listingRecoveryUrl("/account/listings", {
      batchId: "listing_recovery_storage_00001_bulk-pause-listings",
      mutationKind: "listing.pause",
      bulk: true,
    });
    expect(await loadListingRecovery(api, new Request(`https://example.test${valid}`))).toEqual(
      ambiguousListingRecovery,
    );
    expect(api.recoverListingBatch).toHaveBeenCalledOnce();
  });
});
