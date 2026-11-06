import { beforeEach, describe, expect, it, vi } from "vitest";
import { demoIdentitySeedIds } from "@chase-sets/identity-seed";
import { assertBrowserRecoveryFixtureInput, createBrowserRecoveryFixture } from "./browser-recovery-fixture";
import { ownedRecoveryDatabaseUrls } from "../../../support/seed-support/manual-sync-browser";

const h = vi.hoisted(() => ({ streams: new Map<string, unknown[]>(), append: vi.fn(), query: vi.fn() }));
vi.mock("@chase-sets/event-core/complete-stream", () => ({
  readCompleteStream: async (_store: unknown, input: { streamId: string }) => h.streams.get(input.streamId) ?? [],
}));
vi.mock("@chase-sets/event-core-postgres", () => ({
  createPostgresEventStore: () => ({ appendToStreamInTransaction: h.append }),
  withPgTransaction: async (_pool: unknown, run: (db: unknown) => unknown) => run({ query: h.query }),
  createPgPool: vi.fn(),
}));
vi.mock("@chase-sets/bounded-context-runtime", () => ({
  runInProjectionDbContext: (_db: unknown, run: () => unknown) => run(),
}));
vi.mock("../../../index", () => ({ module: {} }));
vi.mock("@chase-sets/marketplace", () => ({ module: {} }));
vi.mock("@chase-sets/inventory/server", () => ({ createInventoryExternalChannelSaleRecorderForPool: vi.fn() }));

const input = {
  ownershipId: "12345678-1234-4123-8123-123456789abc", connectionId: "chn_owned",
  listingId: "lst_owned", inventoryItemId: "itm_owned", createdAfter: "2026-11-06T10:00:00.000Z",
};
const createdAt = "2026-11-06T10:01:00.000Z";
const accountId = demoIdentitySeedIds.accountId;
const runId = `run-browser-recovery-${input.ownershipId}`;

function setup() {
  const listing = { listingId: input.listingId, inventoryItemId: input.inventoryItemId, accountId, status: "active" };
  h.streams.set(`marketplace.listing-${input.listingId}`, [{
    eventType: "marketplace.listing.created", payload: { accountId, inventoryItemId: input.inventoryItemId }, occurredAt: createdAt,
  }]);
  h.streams.set(`marketplace.inventory-listing-capacity-${input.inventoryItemId}`, [{
    eventType: "marketplace.inventory-listing-capacity.committed",
    payload: { inventoryItemId: input.inventoryItemId, listingId: input.listingId, quantityCap: 1 },
  }]);
  const connected = {
    eventType: "channels.connection.connected",
    payload: { connectionId: input.connectionId, accountId, providerKey: "tcgplayer", environment: "sandbox", createdAt },
  };
  const activated = {
    eventType: "channels.connection.activated", streamVersion: 2, streamId: `channels.connection-${input.connectionId}`,
    eventId: "evt_owned", globalPosition: "1", occurredAt: createdAt,
    payload: { connectionId: input.connectionId, credentialReference: null, bindings: [{ storageLocationId: "loc_owned", revision: 1 }] },
  };
  h.streams.set(`channels.connection-${input.connectionId}`, [connected, activated]);
  const reservation = {
    reservationId: "reservation-owned", connectionId: input.connectionId,
    claimant: { claimantKind: "manual", claimantId: demoIdentitySeedIds.userId },
    reservedAt: createdAt, leaseExpiresAt: "2026-11-06T10:31:00.000Z",
    operations: [{ operationId: "operation-owned", attemptId: "attempt-owned", claimGeneration: 1,
      listingId: input.listingId, channelListingId: `channel-listing-browser-recovery-${input.ownershipId}`,
      desiredStateSequence: 2, listingRevision: 1, payloadDigest: "a".repeat(64) }],
  };
  const services = { outboundSync: {
    enqueueDesiredState: vi.fn(), reserveClaimedOutboundOperationsInTransaction: vi.fn(async () => reservation),
  } };
  const marketplace = { pool: {} as never, listings: { loadListingState: vi.fn(async () => listing as never) } };
  const run = () => createBrowserRecoveryFixture({} as never, services as never, marketplace, input);
  return { run, listing, connected, activated, reservation, services, marketplace };
}

beforeEach(() => { vi.clearAllMocks(); h.streams.clear(); h.query.mockResolvedValue({ rows: [] }); });

describe("owned browser recovery fixture", () => {
  it("authors only the exact owned run/member and recovery status after native prerequisites", async () => {
    const fixture = setup();
    await expect(fixture.run()).resolves.toEqual({ connectionId: input.connectionId, runId, listingId: input.listingId });
    expect(h.append).toHaveBeenCalledOnce();
    expect(h.append.mock.calls[0]![1]).toMatchObject({ streamId: `channels.tcgplayer-sync-run-${runId}`, expectedVersion: "no_stream",
      events: [{ eventType: "channels.tcgplayer-sync-run.composed", payload: { run: {
        runId, connectionId: input.connectionId, state: "composed", membershipCompleteness: { kind: "complete", total: 1 },
        members: [{ listingId: input.listingId, reservationId: "reservation-owned" }],
      } } }],
    });
    expect(h.query.mock.calls.at(-1)![1]).toEqual([runId, input.connectionId, accountId]);
  });
  it.each([
    { ownershipId: "not-owned" }, { connectionId: "connection-seed-tcgplayer-manual" },
    { listingId: "not-a-listing" }, { inventoryItemId: "foreign" }, { createdAfter: "invalid" },
  ])("refuses malformed or shared seed inputs before writes: %j", (change) => {
    expect(() => assertBrowserRecoveryFixtureInput({ ...input, ...change })).toThrow("owned-recovery-input-required");
    expect(h.append).not.toHaveBeenCalled();
  });
  it.each(["foreign", "production", "partial", "old", "credential", "absent"])("refuses %s connections without writing", async (kind) => {
    const f = setup();
    if (kind === "foreign") f.connected.payload.accountId = "acc_foreign" as typeof accountId;
    if (kind === "production") f.connected.payload.environment = "production";
    if (kind === "old") f.connected.payload.createdAt = "2026-11-05T00:00:00.000Z";
    if (kind === "credential") Object.assign(f.activated.payload, { credentialReference: "credential_other" });
    if (kind === "partial") h.streams.set(`channels.connection-${input.connectionId}`, [f.connected]);
    if (kind === "absent") h.streams.delete(`channels.connection-${input.connectionId}`);
    await expect(f.run()).rejects.toThrow();
    expect(f.services.outboundSync.enqueueDesiredState).not.toHaveBeenCalled();
    expect(h.append).not.toHaveBeenCalled();
  });
  it.each(["foreign", "inactive", "inventory", "absent", "sibling", "capacity-absent"])("refuses %s listing inputs, including stale-projection sibling collisions", async (kind) => {
    const f = setup();
    if (kind === "foreign") f.listing.accountId = "acc_foreign" as typeof accountId;
    if (kind === "inactive") f.listing.status = "withdrawn";
    if (kind === "inventory") f.listing.inventoryItemId = "itm_foreign";
    if (kind === "absent") h.streams.delete(`marketplace.listing-${input.listingId}`);
    const key = `marketplace.inventory-listing-capacity-${input.inventoryItemId}`;
    if (kind === "sibling") h.streams.get(key)!.push({ eventType: "marketplace.inventory-listing-capacity.committed",
      payload: { inventoryItemId: input.inventoryItemId, listingId: "lst_other", quantityCap: 1 } });
    if (kind === "capacity-absent") h.streams.delete(key);
    await expect(f.run()).rejects.toThrow();
    expect(f.services.outboundSync.enqueueDesiredState).not.toHaveBeenCalled();
  });
  it.each(["interrupted", "completed", "day-after"])("never resets a colliding %s run", async (state) => {
    const f = setup();
    h.streams.set(`channels.tcgplayer-sync-run-${runId}`, [{ eventType: state }]);
    await expect(f.run()).rejects.toThrow("owned-recovery-run-collision");
    expect(f.services.outboundSync.enqueueDesiredState).not.toHaveBeenCalled();
  });
  it("refuses a wrong reservation member and surfaces append failures", async () => {
    const f = setup();
    f.reservation.operations[0]!.listingId = "lst_other";
    await expect(f.run()).rejects.toThrow("owned-recovery-member-required");
    expect(h.append).not.toHaveBeenCalled();
    f.reservation.operations[0]!.listingId = input.listingId;
    h.append.mockRejectedValueOnce(new Error("interrupted append"));
    await expect(f.run()).rejects.toThrow("interrupted append");
  });
  it("requires exact local worktree database siblings without exposing connection values", () => {
    const catalog = "postgresql://test:test@127.0.0.1:5432/cs_owned_catalog";
    const channels = catalog.replace("_catalog", "_channels");
    expect(ownedRecoveryDatabaseUrls(channels, catalog).marketplace.pathname).toBe("/cs_owned_marketplace");
    for (const bad of [undefined, "malformed", channels.replace("127.0.0.1", "remote.invalid"), channels.replace("cs_owned", "cs_foreign")])
      expect(() => ownedRecoveryDatabaseUrls(bad, catalog)).toThrow(/owned-recovery-database/);
  });
});
