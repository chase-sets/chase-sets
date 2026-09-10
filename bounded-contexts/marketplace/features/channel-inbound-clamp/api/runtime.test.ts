import { describe, expect, it, vi } from "vitest";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { createMarketplaceChannelInboundClampRuntime } from "./runtime";

const context: EventStoreContext = {
  tenantId: "tenant-synthetic" as never,
  audit: { performedByUserId: "user-synthetic" as never, forAccountId: "account-synthetic" as never },
};

describe("marketplace-channel-inbound-clamp membership reconciliation", () => {
  it("fails closed when the independently counted membership drifts from the paged candidates", async () => {
    const client = queryClient({ total: 2, pages: [candidateRows(1)] });
    const listings = unreachableListings();
    const runtime = createMarketplaceChannelInboundClampRuntime(pool(client) as never, listings);

    await expect(runtime.engage(input(), context)).rejects.toMatchObject({
      code: "listing-membership-incomplete",
    });
    expect(client.release).toHaveBeenCalledOnce();
    expect(listings.commandHandler).not.toHaveBeenCalled();
  });

  it("pages across the 250-row keyset boundary and requires current ownership for every counted Listing", async () => {
    const rows = candidateRows(251, { clampState: "engaged", pausedStreamVersion: 2 });
    const client = queryClient({ total: 251, pages: [rows.slice(0, 250), rows.slice(250)] });
    const database = pool(client);
    database.query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT stream.current_version")) return { rows: [{ current_version: 2 }] };
      if (sql.includes("SELECT count(*) AS covered")) {
        return { rows: [{ covered: 251, unowned: 0 }] };
      }
      throw new Error(`Unexpected outer query: ${sql}`);
    });
    const listings = {
      commandHandler: vi.fn(),
      publishListing: vi.fn(),
      loadListingState: vi.fn(async (listingId: string) => ({
        listingId,
        accountId: "account-synthetic",
        status: "paused",
        pauseReason: "channel-inbound-dark",
      })),
    };
    const runtime = createMarketplaceChannelInboundClampRuntime(database as never, listings as never);

    await expect(runtime.engage(input(), context)).resolves.toEqual({
      kind: "engaged",
      requestedListingCount: 1,
      affectedListingCount: 251,
      clampedListingCount: 251,
      recoveryListingCount: 0,
    });
    expect(client.pageCursors).toEqual(["", "listing-0249"]);
    expect(listings.commandHandler).not.toHaveBeenCalled();
  });
});

function input() {
  return {
    accountId: "account-synthetic",
    connectionId: "connection-synthetic",
    runId: "run-synthetic",
    listingIds: ["listing-requested"],
  } as const;
}

function candidateRows(
  count: number,
  overrides: Readonly<{ clampState?: "engaged"; pausedStreamVersion?: number }> = {},
) {
  return Array.from({ length: count }, (_, index) => ({
    listing_id: `listing-${String(index).padStart(4, "0")}`,
    inventory_item_id: "inventory-shared",
    status: overrides.clampState ? "paused" : "active",
    current_version: overrides.pausedStreamVersion ?? 1,
    updated_at: "2026-09-10T12:00:00.000Z",
    clamp_state: overrides.clampState ?? null,
    paused_stream_version: overrides.pausedStreamVersion ?? null,
    shared_observed_stream_version: overrides.clampState ? 1 : null,
    shared_paused_stream_version: overrides.pausedStreamVersion ?? null,
  }));
}

function queryClient(options: Readonly<{ total: number; pages: readonly (readonly unknown[])[] }>) {
  let page = 0;
  const pageCursors: string[] = [];
  return {
    pageCursors,
    query: vi.fn(async (sql: string, parameters?: readonly unknown[]) => {
      if (sql.startsWith("BEGIN") || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
      if (sql.includes("WITH requested AS")) {
        return { rows: [{ listing_id: "listing-requested", inventory_item_id: "inventory-shared" }] };
      }
      if (sql.includes("SELECT count(*) AS total")) return { rows: [{ total: options.total }] };
      if (sql.includes("shared.observed_stream_version")) {
        pageCursors.push(String(parameters?.[4] ?? ""));
        return { rows: options.pages[page++] ?? [] };
      }
      throw new Error(`Unexpected transaction query: ${sql}`);
    }),
    release: vi.fn(),
  };
}

function pool(client: ReturnType<typeof queryClient>) {
  return { connect: vi.fn(async () => client), query: vi.fn() };
}

function unreachableListings() {
  return {
    commandHandler: vi.fn(async () => {
      throw new Error("not reached");
    }),
    loadListingState: vi.fn(async () => {
      throw new Error("not reached");
    }),
    publishListing: vi.fn(async () => {
      throw new Error("not reached");
    }),
  };
}
