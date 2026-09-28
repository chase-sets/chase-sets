import { describe, expect, it, vi } from "vitest";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { assertListingReadFreshness, createListingCurrentReads } from "./target-queries";

const input = {
  accountId: "account-synthetic",
  targets: [{ listingId: "listing-synthetic", target: { kind: "native-marketplace" as const } }],
};
function row(overrides: Record<string, unknown> = {}) {
  return {
    ordinal: 0,
    listing_id: "listing-synthetic",
    account_id: input.accountId,
    target_key: "native-marketplace",
    accepted_price: {
      schemaVersion: 1,
      accountId: input.accountId,
      listingId: "listing-synthetic",
      target: input.targets[0]!.target,
      priceAmount: "10.00",
      priceCurrencyCode: "USD",
      targetPriceRevision: 1,
      listingRevision: 1,
      acceptedByUserId: "user-synthetic",
      acceptedAt: "2026-09-01T00:00:00.000Z",
      sourceEventId: "event-price-synthetic",
      decision: { kind: "seller-reference" },
      connectionAuthority: null,
    },
    activation_revision: null,
    listing_revision: 2,
    native_visibility: "enabled",
    visibility_revision: 1,
    publication_revision: 2,
    status: "active",
    source_event_id: "event-synthetic",
    source_global_position: "42",
    active_generation: "1",
    generated_at: new Date().toISOString(),
    source_current: true,
    ...overrides,
  };
}
function database(rows: readonly unknown[]) {
  const query = vi.fn(async (_sql: string, _values?: readonly unknown[]) => ({ rows }));
  return { db: { query } as unknown as PgQueryable, query };
}

describe("bounded Listing current reads", () => {
  it("uses one set-based statement for 100 targets with source and checkpoint fences", async () => {
    const { db, query } = database(Array.from({ length: 100 }, (_, ordinal) => row({ ordinal })));
    const results = await createListingCurrentReads(db).readAcceptedListingTargetPrices({
      ...input,
      targets: Array.from({ length: 100 }, () => input.targets[0]!),
    });
    expect(results).toHaveLength(100);
    expect(query).toHaveBeenCalledOnce();
    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain("jsonb_to_recordset");
    expect(sql).toContain("authority.listing_revision=stream.current_version");
    expect(sql).toContain("checkpoint.last_global_position >= source.global_position");
    expect(sql).toContain("event_projection_blocked_streams");
  });
  it("rejects oversized membership before SQL", async () => {
    const { db, query } = database([]);
    await expect(
      createListingCurrentReads(db).readAcceptedListingTargetPrices({
        ...input,
        targets: Array.from({ length: 101 }, () => input.targets[0]!),
      }),
    ).rejects.toThrow("100");
    expect(query).not.toHaveBeenCalled();
  });
  it.each([[], [row({ account_id: "foreign-synthetic" })], [row({ ordinal: 1 })]].map((rows) => ({ rows })))(
    "rejects missing or foreign membership",
    async ({ rows }) => {
      await expect(createListingCurrentReads(database(rows).db).readAcceptedListingTargetPrices(input)).rejects.toThrow(
        "membership",
      );
    },
  );
  it("never serves stale accepted prices as current", async () => {
    await expect(
      createListingCurrentReads(database([row({ source_current: false })]).db).readAcceptedListingTargetPrices(input),
    ).rejects.toThrow("stale");
  });
  it("reports missing target acceptance without a native fallback", async () => {
    const read = await createListingCurrentReads(
      database([row({ accepted_price: null })]).db,
    ).readAcceptedListingTargetPrices(input);
    expect(read[0]?.acceptedTargetPrice).toBeNull();
  });
  it("does not promote a current active Listing to native eligibility without current readiness", async () => {
    const read = await createListingCurrentReads(database([row()]).db).readNativeListingEligibility({
      accountId: input.accountId,
      listingIds: ["listing-synthetic"],
    });
    expect(read[0]).toMatchObject({ eligible: false, blockingReason: "source-stale" });
  });
  it("combines the exact revision with current owner readiness in one batch", async () => {
    const readiness = vi.fn(async () => [
      {
        listingId: "listing-synthetic",
        listingRevision: 2,
        ready: true,
        generatedAt: new Date().toISOString(),
        validBefore: new Date(Date.now() + 1000).toISOString(),
      },
    ]);
    const read = await createListingCurrentReads(database([row()]).db, readiness).readNativeListingEligibility({
      accountId: input.accountId,
      listingIds: ["listing-synthetic"],
    });
    expect(readiness).toHaveBeenCalledOnce();
    expect(read[0]).toMatchObject({ eligible: true, blockingReason: null });
  });
  it("rejects old generations and below-checkpoint retained responses", () => {
    const read = { generatedAt: "2026-09-01T00:00:00.000Z", sourceGlobalPosition: "42", projectionGeneration: "2" };
    const now = new Date("2026-09-01T00:00:01.000Z");
    expect(() =>
      assertListingReadFreshness(read, { now, maxAgeMs: 1000, minimumSourceGlobalPosition: "42" }),
    ).not.toThrow();
    expect(() => assertListingReadFreshness(read, { now, maxAgeMs: 999 })).toThrow("stale");
    expect(() => assertListingReadFreshness(read, { now, maxAgeMs: 1000, expectedProjectionGeneration: "3" })).toThrow(
      "stale",
    );
    expect(() => assertListingReadFreshness(read, { now, maxAgeMs: 1000, minimumSourceGlobalPosition: "43" })).toThrow(
      "checkpoint",
    );
  });

  it.each(["old-revision", "expired", "old-generation", "duplicate"])(
    "rejects %s native readiness overlays",
    async (failure) => {
      const source = row();
      const overlay = {
        listingId: "listing-synthetic",
        listingRevision: failure === "old-revision" ? 1 : 2,
        ready: true,
        generatedAt: failure === "old-generation" ? "2000-01-01T00:00:00.000Z" : new Date().toISOString(),
        validBefore: new Date(Date.now() + (failure === "expired" ? -1000 : 1000)).toISOString(),
      };
      const read = await createListingCurrentReads(database([source]).db, async () =>
        failure === "duplicate" ? [overlay, overlay] : [overlay],
      ).readNativeListingEligibility({ accountId: input.accountId, listingIds: ["listing-synthetic"] });
      expect(read[0]).toMatchObject({ eligible: false, blockingReason: "source-stale" });
    },
  );
});
