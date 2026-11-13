import { describe, expect, it, vi } from "vitest";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { MARKETPLACE_CHANNEL_INBOUND_CLAMP_MAX_LISTINGS } from "../domain/contracts";
import { channelInboundClampAttemptKey, createMarketplaceChannelInboundClampRuntime } from "./runtime";

const context: EventStoreContext = {
  tenantId: "tenant-synthetic" as never,
  audit: { performedByUserId: "user-synthetic" as never, forAccountId: "account-synthetic" as never },
};

describe("marketplace-channel-inbound-clamp membership reconciliation", () => {
  it("refuses membership 1000001 before opening a database snapshot", async () => {
    const database = { connect: vi.fn(), query: vi.fn() };
    const runtime = createMarketplaceChannelInboundClampRuntime(database as never, unreachableListings());

    await expect(
      runtime.engage(
        {
          ...input(),
          listingIds: new Array(MARKETPLACE_CHANNEL_INBOUND_CLAMP_MAX_LISTINGS + 1).fill("listing-unread"),
        },
        context,
      ),
    ).rejects.toMatchObject({ code: "invalid-input" });
    expect(database.connect).not.toHaveBeenCalled();
    expect(database.query).not.toHaveBeenCalled();
  });

  it("fails closed when the independently counted membership drifts from the paged candidates", async () => {
    const client = queryClient({ total: 2, pages: [candidateRows(1)] });
    const listings = unreachableListings();
    const runtime = createMarketplaceChannelInboundClampRuntime(pool(client) as never, listings);

    await expect(runtime.engage(input(), context)).rejects.toMatchObject({
      code: "listing-membership-incomplete",
    });
    expect(client.release).toHaveBeenCalledOnce();
    expect(listings.pauseListing).not.toHaveBeenCalled();
  });

  it("pages across the 250-row keyset boundary and requires current ownership for every counted Listing", async () => {
    const rows = candidateRows(251, { clampState: "engaged", pausedStreamVersion: 2 });
    const client = queryClient({ total: 251, pages: [rows.slice(0, 250), rows.slice(250)] });
    const database = pool(client);
    database.query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT count(*) AS covered")) {
        return { rows: [{ covered: 251, unowned: 0 }] };
      }
      throw new Error(`Unexpected outer query: ${sql}`);
    });
    const listings = {
      pauseListing: vi.fn(),
      publishListing: vi.fn(),
      readAuthoritativeListing: vi.fn(async ({ listingId }: { listingId: string }) => ({
        kind: "present",
        version: 2,
        state: { listingId, accountId: "account-synthetic", status: "paused", pauseReason: "channel-inbound-dark" },
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
    expect(listings.pauseListing).not.toHaveBeenCalled();
    expect(listings.readAuthoritativeListing).toHaveBeenCalledTimes(251);
  });
});

describe("marketplace-channel-inbound-clamp keyed pause and release convergence", () => {
  it.each(["pause", "publish"] as const)(
    "retries the saved %s attempt after commit loss and an unreadable receipt",
    async (kind) => {
      const world = clampWorld();
      const runtime = createMarketplaceChannelInboundClampRuntime(world.pool as never, world.listings as never);
      if (kind === "publish") await runtime.engage(input(), context);
      world.loseResponse(kind);
      const resume = () => (kind === "pause" ? runtime.engage(input(), context) : runtime.recover(input(), context));
      await expect(resume()).resolves.toMatchObject({ kind: "recovery" });
      expect(world.clamp()).toMatchObject({ state: kind === "pause" ? "pending" : "engaged" });
      await expect(runtime.recover(input(), context)).resolves.toMatchObject({ kind: "recovery" });
      if (kind === "publish") {
        await expect(runtime.engage(input(), context)).resolves.toMatchObject({ kind: "recovery" });
        expect(world.clamp()).toMatchObject({ state: "engaged", paused: 2 });
      }
      await expect(resume()).resolves.toMatchObject({ kind: "recovery" });
      world.restoreReceipts();
      await expect(resume()).resolves.toMatchObject({ kind: kind === "pause" ? "engaged" : "released" });
      expect(world.writes.filter((write) => write.startsWith(kind))).toHaveLength(1);
      const calls =
        kind === "pause" ? world.listings.pauseListing.mock.calls : world.listings.publishListing.mock.calls;
      expect(new Set(calls.map(([params]) => params.idempotencyKey)).size).toBe(1);
      expect(calls.every(([params]) => params.expectedVersion === (kind === "pause" ? 1 : 2))).toBe(true);
    },
  );

  it("keeps an engaged pause resumable when its authoritative confirmation is temporarily unreadable", async () => {
    const world = clampWorld();
    const runtime = createMarketplaceChannelInboundClampRuntime(world.pool as never, world.listings as never);
    await runtime.engage(input(), context);
    world.listings.readAuthoritativeListing.mockRejectedValueOnce(new Error("synthetic read outage"));
    await expect(runtime.engage(input(), context)).resolves.toMatchObject({ kind: "recovery" });
    expect(world.clamp()).toMatchObject({ state: "engaged", paused: 2 });
    await expect(runtime.engage(input(), context)).resolves.toMatchObject({ kind: "engaged" });
    expect(world.writes).toHaveLength(1);
  });

  it("retires a proven malformed pause history rather than retrying it indefinitely", async () => {
    const world = clampWorld();
    world.listings.pauseListing.mockRejectedValueOnce(
      Object.assign(new Error("synthetic malformed history"), {
        code: "history_incomplete",
        historyDisposition: "unsafe",
      }),
    );
    const runtime = createMarketplaceChannelInboundClampRuntime(world.pool as never, world.listings as never);
    await expect(runtime.engage(input(), context)).resolves.toMatchObject({ kind: "recovery" });
    expect(world.clamp()).toMatchObject({ state: "recovery" });
    await expect(runtime.recover(input(), context)).resolves.toMatchObject({
      kind: "recovery",
      releasedListingCount: 0,
    });
    expect(world.writes).toEqual([]);
  });

  it("resumes a pause that committed before the crash from its receipt and never pauses twice", async () => {
    const world = clampWorld();
    const runtime = createMarketplaceChannelInboundClampRuntime(world.pool as never, world.listings as never);

    world.crashOn("SET state='engaged'");
    await expect(runtime.engage(input(), context)).rejects.toThrow("synthetic crash");
    expect(world.clamp()).toMatchObject({ state: "pending", observed: 1, paused: null });
    expect(world.stream).toMatchObject({ version: 2, status: "paused" });

    world.restart();
    await expect(runtime.engage(input(), context)).resolves.toMatchObject({ kind: "engaged", clampedListingCount: 1 });
    await expect(runtime.engage(input(), context)).resolves.toMatchObject({ kind: "engaged", clampedListingCount: 1 });
    expect(world.writes).toEqual([`pause@1:${channelInboundClampAttemptKey("pause", input(), LISTING, 1)}`]);
    expect(world.clamp()).toMatchObject({ state: "engaged", observed: 1, paused: 2 });
    const pauseKeys = world.listings.pauseListing.mock.calls.map(([params]) => params.idempotencyKey);
    expect(new Set(pauseKeys).size).toBe(1);
    expect(world.listings.pauseListing.mock.calls.every(([params]) => params.expectedVersion === 1)).toBe(true);
  });

  it("refuses another writer's dark pause at the observed-plus-one version instead of adopting it by presence", async () => {
    const world = clampWorld();
    const runtime = createMarketplaceChannelInboundClampRuntime(world.pool as never, world.listings as never);

    world.crashOn("pauseListing");
    await expect(runtime.engage(input(), context)).rejects.toThrow("synthetic crash");
    expect(world.clamp()).toMatchObject({ state: "pending", observed: 1 });
    world.restart();
    // Presence alone (paused, dark-inbound reason, observed+1) is exactly what the run's own pause would look like.
    world.foreignPause();

    await expect(runtime.engage(input(), context)).resolves.toMatchObject({
      kind: "recovery",
      clampedListingCount: 0,
    });
    expect(world.clamp()).toMatchObject({ state: "recovery" });
    expect(world.writes).toEqual(["foreign-pause@1"]);
    await expect(runtime.recover(input(), context)).resolves.toMatchObject({ examinedListingCount: 0 });
    expect(world.listings.publishListing).not.toHaveBeenCalled();
  });

  it("resumes a release that published before the crash from its receipt and never publishes twice", async () => {
    const world = clampWorld();
    const runtime = createMarketplaceChannelInboundClampRuntime(world.pool as never, world.listings as never);
    await expect(runtime.engage(input(), context)).resolves.toMatchObject({ kind: "engaged" });

    world.crashOn("SET state='released'");
    await expect(runtime.recover(input(), context)).rejects.toThrow("synthetic crash");
    expect(world.stream).toMatchObject({ version: 3, status: "active" });
    expect(world.clamp()).toMatchObject({ state: "engaged", paused: 2 });

    world.restart();
    await expect(runtime.recover(input(), context)).resolves.toMatchObject({
      kind: "released",
      releasedListingCount: 1,
      recoveryListingCount: 0,
    });
    await expect(runtime.recover(input(), context)).resolves.toMatchObject({ examinedListingCount: 0 });
    expect(world.writes).toEqual([
      `pause@1:${channelInboundClampAttemptKey("pause", input(), LISTING, 1)}`,
      `publish@2:${channelInboundClampAttemptKey("release", input(), LISTING, 2)}`,
    ]);
    expect(world.clamp()).toMatchObject({ state: "released" });
  });

  it("keeps a seller change after the clamp pause in recovery without publishing", async () => {
    const world = clampWorld();
    const runtime = createMarketplaceChannelInboundClampRuntime(world.pool as never, world.listings as never);
    await expect(runtime.engage(input(), context)).resolves.toMatchObject({ kind: "engaged" });
    world.foreignPause();

    await expect(runtime.recover(input(), context)).resolves.toMatchObject({
      kind: "recovery",
      releasedListingCount: 0,
      recoveryListingCount: 1,
    });
    expect(world.writes.filter((write) => write.startsWith("publish"))).toEqual([]);
    expect(world.clamp()).toMatchObject({ state: "recovery" });
  });
});

const LISTING = "listing-requested";

/**
 * One Listing stream and this run's clamp row. The Listing fake honors the C1 contract the clamp relies on: a
 * recorded attempt replays its receipt with zero appends, and an unrecorded one appends only at `expectedVersion`.
 */
function clampWorld() {
  const stream = { version: 1, status: "active" as string, pauseReason: null as string | null };
  const receipts = new Map<string, number>();
  const writes: string[] = [];
  let row: { state: string; observed: number; paused: number | null } | null = null;
  const crashes = new Set<string>();
  let lossKind: "pause" | "publish" | null = null;
  let receiptsUnreadable = false;
  let crashed = false;
  const trip = (point: string) => {
    if (crashed) throw new Error("synthetic crash: process is down");
    if (crashes.has(point)) {
      crashes.delete(point);
      crashed = true;
      throw new Error(`synthetic crash at ${point}`);
    }
  };
  const keyed = async (
    kind: "pause" | "publish",
    params: { idempotencyKey?: string; expectedVersion?: number; reason?: string },
  ) => {
    trip(`${kind}Listing`);
    const key = params.idempotencyKey ?? "";
    if (receiptsUnreadable)
      throw Object.assign(new Error("synthetic unreadable receipt"), { code: "history_incomplete" });
    const receipt = receipts.get(key);
    if (receipt !== undefined) return { listingId: LISTING, version: receipt };
    if (params.expectedVersion !== stream.version)
      throw Object.assign(new Error("Listing changed"), { code: "concurrency_conflict" });
    writes.push(`${kind}@${stream.version}:${key}`);
    stream.version += 1;
    stream.status = kind === "pause" ? "paused" : "active";
    stream.pauseReason = kind === "pause" ? (params.reason ?? "seller") : null;
    receipts.set(key, stream.version);
    if (lossKind === kind) {
      lossKind = null;
      receiptsUnreadable = true;
      throw Object.assign(new Error("synthetic commit then response loss"), { code: "history_incomplete" });
    }
    return { listingId: LISTING, version: stream.version };
  };
  const listings = {
    pauseListing: vi.fn(async (params: { idempotencyKey?: string; expectedVersion?: number; reason?: string }) =>
      keyed("pause", params),
    ),
    publishListing: vi.fn(async (params: { idempotencyKey?: string; expectedVersion?: number }) =>
      keyed("publish", params),
    ),
    readAuthoritativeListing: vi.fn(async ({ accountId }: { accountId: string }) => {
      trip("readAuthoritativeListing");
      return {
        kind: "present",
        version: stream.version,
        state: { listingId: LISTING, accountId, status: stream.status, pauseReason: stream.pauseReason },
      };
    }),
  };
  const query = vi.fn(async (sql: string, parameters: readonly unknown[] = []) => {
    if (sql.startsWith("BEGIN") || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
    const transition = /SET state='([a-z]+)'/.exec(sql)?.[1];
    trip(transition ? `SET state='${transition}'` : "query");
    const live = row !== null && ["pending", "engaged", "recovery"].includes(row.state) ? row : null;
    if (sql.includes("WITH requested AS")) return { rows: [{ listing_id: LISTING, inventory_item_id: "inventory-1" }] };
    if (sql.includes("SELECT count(*) AS total"))
      return { rows: [{ total: stream.status === "active" || live !== null ? 1 : 0 }] };
    if (sql.includes("shared.observed_stream_version")) {
      if (parameters[4] !== "" || !(stream.status === "active" || live !== null)) return { rows: [] };
      return {
        rows: [
          {
            listing_id: LISTING,
            inventory_item_id: "inventory-1",
            status: stream.status,
            current_version: stream.version,
            updated_at: "2026-09-10T12:00:00.000Z",
            clamp_state: live?.state ?? null,
            observed_stream_version: live?.observed ?? null,
            paused_stream_version: live?.paused ?? null,
            shared_observed_stream_version: null,
            shared_paused_stream_version: null,
          },
        ],
      };
    }
    if (sql.includes("'pending',$6,NULL")) {
      if (row) return { rows: [], rowCount: 0 };
      row = { state: "pending", observed: Number(parameters[5]), paused: null };
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("SET state='engaged'")) {
      if (row?.state !== "pending" || row.observed !== parameters[5]) return { rows: [], rowCount: 0 };
      row = { ...row, state: "engaged", paused: Number(parameters[4]) };
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("SET state='recovery'")) {
      if (!row || row.state === "released" || (row.observed !== parameters[4] && row.paused !== parameters[4]))
        return { rows: [], rowCount: 0 };
      row = { ...row, state: "recovery", paused: null };
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("SET state='released'")) {
      if (row?.state !== "engaged" || row.paused !== parameters[4]) return { rows: [], rowCount: 0 };
      row = { ...row, state: "released", paused: null };
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("SELECT count(*) AS covered")) {
      const owned = row?.state === "engaged" && row.paused === stream.version;
      return { rows: [{ covered: 1, unowned: owned ? 0 : 1 }] };
    }
    if (sql.includes("SELECT listing_id,paused_stream_version")) {
      return { rows: row?.state === "engaged" ? [{ listing_id: LISTING, paused_stream_version: row.paused }] : [] };
    }
    if (sql.includes("SELECT count(*) AS unresolved"))
      return { rows: [{ unresolved: row && row.state !== "released" ? 1 : 0 }] };
    if (sql.includes("NOT (owner.connection_id=$3 AND owner.run_id=$4)")) return { rows: [] };
    throw new Error(`Unexpected clamp query: ${sql}`);
  });
  const client = { query, release: vi.fn() };
  return {
    stream,
    writes,
    listings,
    pool: { connect: vi.fn(async () => client), query },
    clamp: () => row,
    loseResponse: (kind: "pause" | "publish") => {
      lossKind = kind;
    },
    restoreReceipts: () => {
      receiptsUnreadable = false;
    },
    crashOn: (point: string) => crashes.add(point),
    restart: () => {
      crashed = false;
      crashes.clear();
    },
    foreignPause: () => {
      writes.push(`foreign-pause@${stream.version}`);
      stream.version += 1;
      stream.status = "paused";
      stream.pauseReason = "channel-inbound-dark";
    },
  };
}

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
    observed_stream_version: overrides.clampState ? 1 : null,
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
    pauseListing: vi.fn(async () => {
      throw new Error("not reached");
    }),
    readAuthoritativeListing: vi.fn(async () => {
      throw new Error("not reached");
    }),
    publishListing: vi.fn(async () => {
      throw new Error("not reached");
    }),
  };
}
