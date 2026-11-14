import { beforeEach, describe, expect, it, vi } from "vitest";
import { Readable, Writable } from "node:stream";
import { demoIdentitySeedIds } from "@chase-sets/identity-seed";
import { assertBrowserRecoveryFixtureInput, createBrowserRecoveryFixture } from "./browser-recovery-fixture";
import {
  createManualSyncBrowserRecovery,
  ownedRecoveryDatabaseUrls,
  parseOwnedRecoveryRequest,
  runOwnedRecoveryStdin,
} from "../../../support/seed-support/manual-sync-browser";

const h = vi.hoisted(() => ({
  streams: new Map<string, unknown[]>(),
  append: vi.fn(),
  query: vi.fn(),
  pool: vi.fn(),
  channels: vi.fn(),
  marketplace: vi.fn(),
  drain: vi.fn(),
}));
vi.mock("@chase-sets/event-core/complete-stream", () => ({
  readCompleteStream: async (_store: unknown, input: { streamId: string }) => h.streams.get(input.streamId) ?? [],
}));
vi.mock("@chase-sets/event-core-postgres", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@chase-sets/event-core-postgres")>()),
  createPostgresEventStore: () => ({ appendToStreamInTransaction: h.append }),
  withPgTransaction: async (_pool: unknown, run: (db: unknown) => unknown) => run({ query: h.query }),
  createPgPool: h.pool,
}));
vi.mock("@chase-sets/bounded-context-runtime", () => ({
  runInProjectionDbContext: (_db: unknown, run: () => unknown) => run(),
  drainLocalProjectionHandlerSets: h.drain,
}));
vi.mock("../../../index", () => ({ module: { createServices: h.channels } }));
vi.mock("@chase-sets/marketplace", () => ({ module: { createServices: h.marketplace } }));
vi.mock("@chase-sets/inventory/server", () => ({ createInventoryExternalChannelSaleRecorderForPool: vi.fn() }));

const input = {
  ownershipId: "12345678-1234-4123-8123-123456789abc",
  connectionId: "chn_owned",
  listingId: "lst_owned",
  inventoryItemId: "itm_owned",
  createdAfter: "2026-11-06T10:00:00.000Z",
};
const createdAt = "2026-11-06T10:01:00.000Z";
const accountId = demoIdentitySeedIds.accountId;
const runId = `run-browser-recovery-${input.ownershipId}`;

function setup() {
  const listing = { listingId: input.listingId, inventoryItemId: input.inventoryItemId, accountId, status: "active" };
  h.streams.set(`marketplace.listing-${input.listingId}`, [
    {
      eventType: "marketplace.listing.created",
      payload: { accountId, inventoryItemId: input.inventoryItemId },
      occurredAt: createdAt,
    },
  ]);
  h.streams.set(`marketplace.inventory-listing-capacity-${input.inventoryItemId}`, [
    {
      eventType: "marketplace.inventory-listing-capacity.committed",
      payload: { inventoryItemId: input.inventoryItemId, listingId: input.listingId, quantityCap: 1 },
    },
  ]);
  const connected = {
    eventType: "channels.connection.connected",
    payload: {
      connectionId: input.connectionId,
      accountId,
      providerKey: "tcgplayer",
      environment: "sandbox",
      createdAt,
    },
  };
  const activated = {
    eventType: "channels.connection.activated",
    streamVersion: 2,
    streamId: `channels.connection-${input.connectionId}`,
    eventId: "evt_owned",
    globalPosition: "1",
    occurredAt: createdAt,
    payload: {
      connectionId: input.connectionId,
      credentialReference: null,
      bindings: [{ storageLocationId: "loc_owned", revision: 1 }],
    },
  };
  h.streams.set(`channels.connection-${input.connectionId}`, [connected, activated]);
  const reservation = {
    reservationId: "reservation-owned",
    connectionId: input.connectionId,
    claimant: { claimantKind: "manual", claimantId: demoIdentitySeedIds.userId },
    reservedAt: createdAt,
    leaseExpiresAt: "2026-11-06T10:31:00.000Z",
    operations: [
      {
        operationId: "operation-owned",
        attemptId: "attempt-owned",
        claimGeneration: 1,
        listingId: input.listingId,
        channelListingId: `channel-listing-browser-recovery-${input.ownershipId}`,
        desiredStateSequence: 2,
        listingRevision: 1,
        payloadDigest: "a".repeat(64),
      },
    ],
  };
  const services = {
    outboundSync: {
      enqueueDesiredState: vi.fn(),
      reserveClaimedOutboundOperationsInTransaction: vi.fn(async () => reservation),
    },
  };
  const marketplace = { pool: {} as never, listings: { loadListingState: vi.fn(async () => listing as never) } };
  const run = () => createBrowserRecoveryFixture({} as never, services as never, marketplace, input);
  return { run, listing, connected, activated, reservation, services, marketplace };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.streams.clear();
  h.query.mockResolvedValue({ rows: [] });
  h.append.mockImplementation(async (_db, value) => {
    h.streams.set(value.streamId, value.events);
  });
  h.drain.mockResolvedValue(undefined);
});

describe("finite recovery Node entry", () => {
  const databases = {
    channels: "postgresql://cs_owned_channels:cs_owned_channels@localhost:5432/cs_owned_channels",
    catalog: "postgresql://cs_owned_catalog:cs_owned_catalog@localhost:5432/cs_owned_catalog",
  };
  const request = () => ({ version: 1, fixture: { ...input }, databases: { ...databases } });
  const parse = (value: unknown) => parseOwnedRecoveryRequest(Buffer.from(JSON.stringify(value)));
  function composition() {
    const fixture = setup();
    const ends = [vi.fn(async () => {}), vi.fn(async () => {}), vi.fn(async () => {})];
    let index = 0;
    h.pool.mockImplementation(() => ({ end: ends[index++] }));
    h.marketplace.mockReturnValue({ listings: fixture.marketplace.listings });
    h.channels.mockReturnValue({
      ...fixture.services,
      projectors: [],
      manualSync: {
        readPanel: vi.fn(async () => ({ run: { runId, revision: 0, state: "composed" }, attentionReason: "recovery" })),
      },
    });
    return ends;
  }
  it("accepts only the complete closed request and producer roles", () => {
    expect(parse(request())).toEqual({ fixture: input, databases });
    expect(h.pool).not.toHaveBeenCalled();
  });
  it.each([
    null,
    [],
    {},
    { ...request(), version: 2 },
    { ...request(), extra: true },
    { ...request(), fixture: null },
    { ...request(), fixture: [] },
    { ...request(), fixture: { ...input, extra: true } },
    { ...request(), fixture: { ...input, ownershipId: "12345678-1234-4123-8123-123456789ABC" } },
    { ...request(), fixture: { ...input, ownershipId: "------------------------------------" } },
    { ...request(), fixture: { ...input, createdAfter: "2026-02-30T00:00:00.000Z" } },
    { ...request(), fixture: { ...input, createdAfter: "2026-11-06T10:00:00Z" } },
    { ...request(), fixture: { ...input, connectionId: "chn_" + "x".repeat(157) } },
    { ...request(), fixture: { ...input, listingId: "lst_" + "x".repeat(157) } },
    { ...request(), fixture: { ...input, inventoryItemId: "itm_" + "x".repeat(157) } },
    { ...request(), databases: null },
    { ...request(), databases: [] },
    { ...request(), databases: { ...databases, extra: true } },
    { ...request(), databases: { channels: databases.channels } },
    { ...request(), databases: { ...databases, channels: databases.catalog } },
    { ...request(), databases: { ...databases, channels: databases.channels + "?options=private-marker" } },
    { ...request(), databases: { ...databases, catalog: databases.catalog + "#private-marker" } },
  ])("refuses incomplete, malformed or unknown nested authority %#", (value) => {
    expect(() => parse(value)).toThrow(/owned-recovery-/);
    expect(h.pool).not.toHaveBeenCalled();
  });
  it("accepts largest IDs and exact input/URL caps, rejecting cap+1 and malformed UTF-8/trailing JSON", () => {
    const value = request();
    value.fixture.connectionId = "chn_" + "x".repeat(156);
    value.fixture.listingId = "lst_" + "x".repeat(156);
    value.fixture.inventoryItemId = "itm_" + "x".repeat(156);
    const bytes = Buffer.from(JSON.stringify(value));
    expect(parseOwnedRecoveryRequest(Buffer.concat([bytes, Buffer.alloc(8192 - bytes.length, 32)]))).toEqual({
      fixture: value.fixture,
      databases,
    });
    expect(() => parseOwnedRecoveryRequest(Buffer.concat([bytes, Buffer.alloc(8193 - bytes.length, 32)]))).toThrow();
    expect(() => parseOwnedRecoveryRequest(Buffer.from([255]))).toThrow();
    expect(() => parseOwnedRecoveryRequest(Buffer.from(JSON.stringify(value) + "{}"))).toThrow();
    expect(() => parseOwnedRecoveryRequest(Buffer.from("{"))).toThrow();
    expect(() => ownedRecoveryDatabaseUrls("x".repeat(2049), databases.catalog)).toThrow();
    const role = "cs_" + "x".repeat(640) + "_catalog";
    const base = `postgresql://${role}:${role}@localhost:5432/${role}`;
    const url = base.replace(":5432", ":" + "0".repeat(2048 - base.length) + "5432");
    expect(Buffer.byteLength(url)).toBe(2048);
    const channels = base.replaceAll("_catalog", "_channels");
    expect(ownedRecoveryDatabaseUrls(channels, url).channels.pathname).toBe(new URL(channels).pathname);
    expect(() => ownedRecoveryDatabaseUrls(channels, url + " ")).toThrow();
  });
  it("closes all owned pools before the exact initial receipt", async () => {
    const ends = composition();
    await expect(createManualSyncBrowserRecovery(input, databases)).resolves.toEqual({
      version: 1,
      ownershipId: input.ownershipId,
      connectionId: input.connectionId,
      listingId: input.listingId,
      runId,
      runRevision: 0,
    });
    for (const end of ends) expect(end).toHaveBeenCalledOnce();
    expect(h.drain).toHaveBeenCalledTimes(2);
  });
  it.each([
    null,
    { run: null, attentionReason: "recovery" },
    { run: { runId: "run_foreign", revision: 0, state: "composed" }, attentionReason: "recovery" },
    { run: { runId, revision: 1, state: "composed" }, attentionReason: "recovery" },
    { run: { runId, revision: 0, state: "claimed" }, attentionReason: "recovery" },
    { run: { runId, revision: 0, state: "composed" }, attentionReason: null },
  ])("refuses nullable or noninitial panel state before dereference %# and closes every pool", async (panel) => {
    const ends = composition();
    h.channels.mockReturnValueOnce({
      ...setup().services,
      projectors: [],
      manualSync: { readPanel: vi.fn(async () => panel) },
    });
    await expect(createManualSyncBrowserRecovery(input, databases)).rejects.toThrow(
      "owned-recovery-initial-state-required",
    );
    for (const end of ends) expect(end).toHaveBeenCalledOnce();
  });
  it("returns only the fixed failure marker for null panel stdin and closes every pool", async () => {
    const ends = composition();
    h.channels.mockReturnValueOnce({
      ...setup().services,
      projectors: [],
      manualSync: { readPanel: vi.fn(async () => null) },
    });
    const out: string[] = [];
    const err: string[] = [];
    const sink = (target: string[]) =>
      new Writable({
        write(chunk, _encoding, done) {
          target.push(chunk.toString());
          done();
        },
      });
    await expect(
      runOwnedRecoveryStdin(Readable.from([Buffer.from(JSON.stringify(request()))]), sink(out), sink(err)),
    ).resolves.toBe(1);
    expect(out).toEqual([]);
    expect(err.join("")).toBe("OWNED_RECOVERY_FAILED\n");
    for (const end of ends) expect(end).toHaveBeenCalledOnce();
  });
  it("requires matching local origins and each context's own role, including both query/hash refusals", () => {
    for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
      for (const protocol of ["postgres:", "postgresql:"]) {
        const channel = new URL(databases.channels);
        const catalog = new URL(databases.catalog);
        channel.hostname = catalog.hostname = host;
        channel.protocol = catalog.protocol = protocol;
        expect(ownedRecoveryDatabaseUrls(channel.toString(), catalog.toString()).marketplace.username).toBe(
          "cs_owned_marketplace",
        );
      }
    }
    for (const [key, replacement] of [
      ["channels", databases.channels.replace(":5432", ":5433")],
      ["channels", databases.channels.replace("postgresql:", "http:")],
      ["channels", databases.channels.replace("localhost", "remote.invalid")],
      ["catalog", databases.catalog.replace("cs_owned_catalog:cs_owned_catalog", "shared:shared")],
      ["channels", databases.channels + "?options=private-marker"],
      ["catalog", databases.catalog + "?options=private-marker"],
      ["channels", databases.channels + "#private-marker"],
      ["catalog", databases.catalog + "#private-marker"],
    ]) {
      const value = { ...databases, [key!]: replacement };
      expect(() => ownedRecoveryDatabaseUrls(value.channels, value.catalog)).toThrow(/owned-recovery-database/);
    }
  });
  it("closes partial construction and rejects any closure or noninitial authoritative state", async () => {
    const ends = composition();
    h.pool
      .mockImplementationOnce(() => ({ end: ends[0] }))
      .mockImplementationOnce(() => {
        throw new Error("private-marker");
      });
    await expect(createManualSyncBrowserRecovery(input, databases)).rejects.toThrow();
    expect(ends[0]).toHaveBeenCalledOnce();
    composition();
    h.append.mockImplementationOnce(async () => {});
    await expect(createManualSyncBrowserRecovery(input, databases)).rejects.toThrow(
      "owned-recovery-initial-state-required",
    );
    const close = composition();
    h.streams.delete(`channels.tcgplayer-sync-run-${runId}`);
    close[0]!.mockRejectedValueOnce(new Error("private-marker") as never);
    await expect(createManualSyncBrowserRecovery(input, databases)).rejects.toThrow("owned-recovery-close-failed");
    for (const end of close) expect(end).toHaveBeenCalledOnce();
  });
  it("bounds repeated/endless-shaped finite input and serializes only a fixed failure code", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const sink = (target: string[]) =>
      new Writable({
        write(chunk, _encoding, done) {
          target.push(chunk.toString());
          done();
        },
      });
    let yielded = 0;
    const stream = Readable.from(
      (function* () {
        for (let i = 0; i < 20; i++) {
          yielded++;
          yield Buffer.alloc(1024, 120);
        }
      })(),
    );
    await expect(runOwnedRecoveryStdin(stream, sink(out), sink(err))).resolves.toBe(1);
    expect(out).toEqual([]);
    expect(err.join("")).toBe("OWNED_RECOVERY_FAILED\n");
    expect(stream.destroyed).toBe(true);
    expect(h.pool).not.toHaveBeenCalled();
    expect(yielded).toBeLessThan(20);
    composition();
    h.marketplace.mockImplementationOnce(() => {
      throw new Error("private-marker postgresql://private-marker");
    });
    await expect(
      runOwnedRecoveryStdin(Readable.from([Buffer.from(JSON.stringify(request()))]), sink(out), sink(err)),
    ).resolves.toBe(1);
    expect(JSON.stringify({ out, err })).not.toContain("private-marker");
  });
  it("emits the bound receipt only after EOF and all pool closures at the input cap", async () => {
    const ends = composition();
    const out: string[] = [];
    const err: string[] = [];
    const sink = (target: string[]) =>
      new Writable({
        write(chunk, _encoding, done) {
          target.push(chunk.toString());
          done();
        },
      });
    const bytes = Buffer.from(JSON.stringify(request()));
    const inputStream = new Readable({ read() {} });
    const result = runOwnedRecoveryStdin(inputStream, sink(out), sink(err));
    inputStream.push(Buffer.concat([bytes, Buffer.alloc(8192 - bytes.length, 32)]));
    await Promise.resolve();
    expect(out).toEqual([]);
    expect(h.pool).not.toHaveBeenCalled();
    inputStream.push(null);
    await expect(result).resolves.toBe(0);
    expect(JSON.parse(out.join(""))).toEqual({
      version: 1,
      ownershipId: input.ownershipId,
      connectionId: input.connectionId,
      listingId: input.listingId,
      runId,
      runRevision: 0,
    });
    expect(err).toEqual([]);
    expect(inputStream.destroyed).toBe(true);
    for (const end of ends) expect(end).toHaveBeenCalledOnce();
  });
});

describe("owned browser recovery fixture", () => {
  it("authors only the exact owned run/member and recovery status after native prerequisites", async () => {
    const fixture = setup();
    await expect(fixture.run()).resolves.toEqual({
      connectionId: input.connectionId,
      runId,
      listingId: input.listingId,
    });
    expect(h.append).toHaveBeenCalledOnce();
    expect(h.append.mock.calls[0]![1]).toMatchObject({
      streamId: `channels.tcgplayer-sync-run-${runId}`,
      expectedVersion: "no_stream",
      events: [
        {
          eventType: "channels.tcgplayer-sync-run.composed",
          payload: {
            run: {
              runId,
              connectionId: input.connectionId,
              state: "composed",
              membershipCompleteness: { kind: "complete", total: 1 },
              members: [{ listingId: input.listingId, reservationId: "reservation-owned" }],
            },
          },
        },
      ],
    });
    expect(h.query.mock.calls.at(-1)![1]).toEqual([runId, input.connectionId, accountId]);
  });
  it.each([
    { ownershipId: "not-owned" },
    { connectionId: "connection-seed-tcgplayer-manual" },
    { listingId: "not-a-listing" },
    { inventoryItemId: "foreign" },
    { createdAfter: "invalid" },
  ])("refuses malformed or shared seed inputs before writes: %j", (change) => {
    expect(() => assertBrowserRecoveryFixtureInput({ ...input, ...change })).toThrow("owned-recovery-input-required");
    expect(h.append).not.toHaveBeenCalled();
  });
  it.each(["foreign", "production", "partial", "old", "credential", "absent"])(
    "refuses %s connections without writing",
    async (kind) => {
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
    },
  );
  it.each(["foreign", "inactive", "inventory", "absent", "sibling", "capacity-absent"])(
    "refuses %s listing inputs, including stale-projection sibling collisions",
    async (kind) => {
      const f = setup();
      if (kind === "foreign") f.listing.accountId = "acc_foreign" as typeof accountId;
      if (kind === "inactive") f.listing.status = "withdrawn";
      if (kind === "inventory") f.listing.inventoryItemId = "itm_foreign";
      if (kind === "absent") h.streams.delete(`marketplace.listing-${input.listingId}`);
      const key = `marketplace.inventory-listing-capacity-${input.inventoryItemId}`;
      if (kind === "sibling")
        h.streams.get(key)!.push({
          eventType: "marketplace.inventory-listing-capacity.committed",
          payload: { inventoryItemId: input.inventoryItemId, listingId: "lst_other", quantityCap: 1 },
        });
      if (kind === "capacity-absent") h.streams.delete(key);
      await expect(f.run()).rejects.toThrow();
      expect(f.services.outboundSync.enqueueDesiredState).not.toHaveBeenCalled();
    },
  );
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
    const catalog = "postgresql://cs_owned_catalog:cs_owned_catalog@127.0.0.1:5432/cs_owned_catalog";
    const channels = catalog.replaceAll("_catalog", "_channels");
    const urls = ownedRecoveryDatabaseUrls(channels, catalog);
    expect(urls.marketplace.pathname).toBe("/cs_owned_marketplace");
    expect(urls.marketplace.username).toBe("cs_owned_marketplace");
    expect(urls.marketplace.password).toBe("cs_owned_marketplace");
    expect(urls.inventory.pathname).toBe("/cs_owned_inventory");
    expect(urls.inventory.username).toBe("cs_owned_inventory");
    expect(urls.inventory.password).toBe("cs_owned_inventory");
    for (const bad of [
      undefined,
      "malformed",
      channels.replace("127.0.0.1", "remote.invalid"),
      channels.replace("cs_owned", "cs_foreign"),
      catalog,
      channels.replaceAll("cs_owned_channels:", "cs_owned_catalog:"),
      channels.replace("cs_owned_channels@", "cs_owned_catalog@"),
      channels + "?options=secret-marker",
      channels + "#secret-marker",
    ])
      expect(() => ownedRecoveryDatabaseUrls(bad, catalog)).toThrow(/owned-recovery-database/);
  });
});
