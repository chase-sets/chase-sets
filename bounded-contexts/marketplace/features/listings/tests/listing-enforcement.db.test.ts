import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { EventStoreContext, ReadStreamInput } from "@chase-sets/event-core/storage";
import {
  createPostgresAggregateSnapshotStore,
  createPostgresEventStore,
  createPostgresProjectionStore,
  type PgTransactionalPool,
} from "@chase-sets/event-core-postgres";
import { createId } from "@chase-sets/primitives/typed-ids";
import { createMarketplaceCommercialTermsResolver } from "../../../api";
import { module as marketplaceModule } from "../../../index";
import { createMarketplaceReportRuntime } from "../../reports/api/runtime";
import { createMarketplaceListingRuntime } from "../api/runtime";
import {
  decideMarketplaceListing,
  evolveMarketplaceListing,
  initialMarketplaceListingState,
  type CreateListingCommand,
  type MarketplaceListingCommand,
  type MarketplaceListingEvent,
  type MarketplaceListingState,
  type PublishListingCommand,
} from "../domain/domain";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
const describeDb = databaseBaseUrl ? describe : describe.skip;
const contextNames = ["marketplace"] as const;
const SNAPSHOT_EVERY_N_EVENTS = 100;
/** The schema version this change introduces; pinned literally rather than read from the runtime under test. */
const CANDIDATE_SNAPSHOT_SCHEMA_VERSION = 7;
/**
 * The adjacent previous reader at base 77c7e42a67: listing snapshots were schema 6,
 * `auto-unlisted` folded to paused without reading its payload, and any unknown event
 * type reached `assertNever`. Event types this change leaves untouched use the current fold.
 */
const IMMUTABLE_BASE_SNAPSHOT_SCHEMA_VERSION = 6;

function evolveImmutableBaseListing(
  state: MarketplaceListingState,
  event: MarketplaceListingEvent,
): MarketplaceListingState {
  switch (event.type) {
    case "marketplace.listing.auto-unlisted":
      return { ...state, status: "paused" };
    case "marketplace.listing.operator-unlisted":
      throw new Error(`Unhandled variant: ${JSON.stringify(event)}`);
    default:
      return evolveMarketplaceListing(state, event);
  }
}

describeDb("listing enforcement identity on the real event and snapshot stores", () => {
  let pools: Readonly<Record<"marketplace", PgTransactionalPool>>;

  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, contextNames, "marketplace_listing_enforcement");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await pools.marketplace.query(marketplaceModule.schemaSql);
  });
  afterAll(async () => closeMultiContextTestPools(pools));

  it("appends owner-attributed removals and never appends invalid identity, time, owner or source", async () => {
    const { listings, eventStore } = createRuntime(pools.marketplace);
    await seedActiveListing(listings, "lst_owner_a", "acc_owner_a");
    await seedActiveListing(listings, "lst_owner_b", "acc_owner_b");
    const rca = createId("rca");
    const lea = createId("lea");

    const operator = await listings.commandHandler({
      streamId: "marketplace.listing-lst_owner_a",
      command: {
        type: "OperatorUnlistListing",
        reportedContentActionId: rca,
        listingEnforcementActionId: lea,
        recordedAt: "2026-10-06T09:00:00.000-05:00",
      },
      context: contextFor("acc_owner_b"),
    });
    const automatic = await listings.commandHandler({
      streamId: "marketplace.listing-lst_owner_b",
      command: autoUnlist(createId("rpt"), createId("lea")),
      context: contextFor("acc_owner_a"),
    });

    expect(operator.version).toBe(3);
    expect(await storedEvents(pools.marketplace, "lst_owner_a")).toContainEqual({
      eventType: "marketplace.listing.operator-unlisted",
      payload: {
        listingEnforcement: {
          version: 1,
          listingEnforcementActionId: lea,
          accountId: "acc_owner_a",
          source: "operator-unlist",
          sourceActionId: rca,
          occurredAt: "2026-10-06T09:00:00.000-05:00",
        },
      },
    });
    expect(automatic.state.listingEnforcement).toMatchObject({ accountId: "acc_owner_b" });
    expect((await listings.loadListingState("lst_owner_a")).status).toBe("paused");

    await seedActiveListing(listings, "lst_invalid", "acc_owner_a");
    for (const command of [
      autoUnlist("rpt_1", createId("lea")),
      autoUnlist(createId("rca") as never, createId("lea")),
      autoUnlist(createId("rpt"), createId("enf") as never),
      { ...autoUnlist(createId("rpt"), createId("lea")), autoUnlistedAt: "2026-10-06" },
      {
        type: "OperatorUnlistListing",
        reportedContentActionId: createId("rca"),
        listingEnforcementActionId: createId("lea"),
        recordedAt: "2026-10-06T09:00:00",
      },
    ] as MarketplaceListingCommand[]) {
      await expect(
        listings.commandHandler({
          streamId: "marketplace.listing-lst_invalid",
          command,
          context: contextFor("acc_owner_a"),
        }),
      ).rejects.toThrow();
      expect(await streamVersion(pools.marketplace, "lst_invalid")).toBe(2);
      expect(await listings.loadListingState("lst_invalid")).toMatchObject({
        status: "active",
        listingEnforcement: null,
        appliedListingEnforcements: [],
      });
    }

    await appendStored(eventStore, "lst_owner_b", 3, [
      { type: "marketplace.listing.published", data: {} },
      {
        type: "marketplace.listing.operator-unlisted",
        data: {
          listingEnforcement: {
            version: 1,
            listingEnforcementActionId: createId("lea"),
            accountId: "acc_owner_a",
            source: "operator-unlist",
            sourceActionId: createId("rca"),
            occurredAt: "2026-10-06T09:30:00.000Z",
          },
        },
      },
    ]);
    await expect(listings.loadListingState("lst_owner_b")).rejects.toThrow(
      "Stored listing removal owner does not match the listing.",
    );
  });

  it("drives removal, republish, redelivery, distinct sources and day-after commands through the real stream", async () => {
    const { listings, eventStore } = createRuntime(pools.marketplace);
    const reports = createMarketplaceReportRuntime({ eventStore, db: pools.marketplace });
    await seedActiveListing(listings, "lst_lifecycle", "acc_seller");
    const reportId = await reportToThreshold(reports, "lst_lifecycle");
    const removed = await listings.loadListingState("lst_lifecycle");
    expect(removed).toMatchObject({
      status: "paused",
      listingEnforcement: { source: "automatic-report-threshold", sourceActionId: reportId, accountId: "acc_seller" },
    });
    const automaticLea = removed.listingEnforcement!.listingEnforcementActionId;

    await command(listings, "lst_lifecycle", publishListingCommand);
    const republishedVersion = await streamVersion(pools.marketplace, "lst_lifecycle");
    const redelivered = await command(listings, "lst_lifecycle", autoUnlist(reportId, createId("lea")));
    expect(redelivered).toMatchObject({ version: republishedVersion, newEvents: [] });
    expect(await streamVersion(pools.marketplace, "lst_lifecycle")).toBe(republishedVersion);

    const rca = createId("rca");
    const operatorLea = createId("lea");
    await command(listings, "lst_lifecycle", operatorUnlist(rca, operatorLea));
    await command(listings, "lst_lifecycle", publishListingCommand);
    const relistedVersion = await streamVersion(pools.marketplace, "lst_lifecycle");
    for (const redelivery of [operatorUnlist(rca, createId("lea")), autoUnlist(reportId, createId("lea"))]) {
      await expect(command(listings, "lst_lifecycle", redelivery)).resolves.toMatchObject({ newEvents: [] });
    }
    expect(await streamVersion(pools.marketplace, "lst_lifecycle")).toBe(relistedVersion);

    for (const dayAfter of [
      { type: "UpdateListingPurchaseLimits", purchaseLimits: { maxUnitsPerOrder: 1 } },
      { type: "PauseListing" },
      publishListingCommand,
    ] satisfies MarketplaceListingCommand[]) {
      await command(listings, "lst_lifecycle", dayAfter);
    }
    const dayAfterState = await listings.loadListingState("lst_lifecycle");
    expect(dayAfterState).toMatchObject({
      status: "active",
      listingEnforcement: { listingEnforcementActionId: operatorLea, sourceActionId: rca },
      appliedListingEnforcements: [
        { sourceActionId: reportId, listingEnforcementActionId: automaticLea },
        { sourceActionId: rca, listingEnforcementActionId: operatorLea },
      ],
    });
    expect(
      (await storedEvents(pools.marketplace, "lst_lifecycle")).filter(({ eventType }) =>
        eventType.endsWith("-unlisted"),
      ),
    ).toHaveLength(2);

    for (const [listingId, first, second] of [
      [
        "lst_auto_first",
        autoUnlist(createId("rpt"), createId("lea")),
        operatorUnlist(createId("rca"), createId("lea")),
      ],
      [
        "lst_operator_first",
        operatorUnlist(createId("rca"), createId("lea")),
        autoUnlist(createId("rpt"), createId("lea")),
      ],
    ] as const) {
      await seedActiveListing(listings, listingId, "acc_seller");
      await command(listings, listingId, first);
      await expect(command(listings, listingId, second)).resolves.toMatchObject({ newEvents: [] });
      expect(
        (await storedEvents(pools.marketplace, listingId)).filter(({ eventType }) => eventType.endsWith("-unlisted")),
      ).toHaveLength(1);
    }
  });

  it("replays empty, legacy, modern, mixed, repeated, conflicting and poisoned histories from the real stream", async () => {
    const { listings, eventStore } = createRuntime(pools.marketplace);
    const created = decideMarketplaceListing(
      initialMarketplaceListingState,
      createListingCommand("lst_history", "acc_seller"),
    );
    const published: MarketplaceListingEvent = { type: "marketplace.listing.published", data: {} };
    const legacy: MarketplaceListingEvent = {
      type: "marketplace.listing.auto-unlisted",
      data: { reportId: "rpt_legacy", reportCount: 3, threshold: 3, autoUnlistedAt: "2026-07-01T00:00:00.000Z" },
    };
    const activeState = [...created, published].reduce(evolveMarketplaceListing, initialMarketplaceListingState);
    const [modern] = decideMarketplaceListing(activeState, autoUnlist(createId("rpt"), createId("lea")));
    const [operator] = decideMarketplaceListing(activeState, operatorUnlist(createId("rca"), createId("lea")));
    const operatorData = operator!.data as Extract<
      MarketplaceListingEvent,
      { type: "marketplace.listing.operator-unlisted" }
    >["data"];

    await expect(command(listings, "lst_empty", operatorUnlist(createId("rca"), createId("lea")))).rejects.toThrow(
      "Listing must be created first.",
    );
    expect(await streamVersion(pools.marketplace, "lst_empty")).toBeNaN();

    const accepted = {
      legacy: [...created, published, legacy],
      modern: [...created, published, modern!],
      mixed: [...created, published, legacy, published, modern!, published, operator!],
    };
    for (const [name, events] of Object.entries(accepted)) {
      await appendStored(eventStore, `lst_${name}`, 0, events);
      expect(await listings.loadListingState(`lst_${name}`)).toEqual(
        events.reduce(evolveMarketplaceListing, initialMarketplaceListingState),
      );
    }
    expect(await listings.loadListingState("lst_legacy")).toMatchObject({ status: "paused", listingEnforcement: null });
    expect((await listings.loadListingState("lst_mixed")).appliedListingEnforcements).toHaveLength(2);

    const poisoned = {
      repeated: [...created, published, modern!, published, modern!],
      conflicting: [
        ...created,
        published,
        modern!,
        published,
        {
          type: "marketplace.listing.operator-unlisted",
          data: {
            listingEnforcement: {
              ...operatorData.listingEnforcement,
              listingEnforcementActionId: (
                modern!.data as { listingEnforcement: { listingEnforcementActionId: never } }
              ).listingEnforcement.listingEnforcementActionId,
            },
          },
        },
      ],
      spoofed: [
        ...created,
        published,
        {
          type: "marketplace.listing.operator-unlisted",
          data: { listingEnforcement: { ...operatorData.listingEnforcement, accountId: "acc_other" } },
        },
      ],
      unexpected: [...created, modern!],
      partial: [
        ...created,
        published,
        { type: "marketplace.listing.auto-unlisted", data: { ...legacy.data, listingEnforcement: null } },
      ],
    } as Record<string, MarketplaceListingEvent[]>;
    for (const [name, events] of Object.entries(poisoned)) {
      await appendStored(eventStore, `lst_${name}`, 0, events);
      await expect(listings.loadListingState(`lst_${name}`), name).rejects.toThrow();
    }
  });

  it("round-trips a production-created snapshot through PostgreSQL JSON and suppresses redeliveries from it", async () => {
    const pool = pools.marketplace;
    const writer = createRuntime(pool);
    const reports = createMarketplaceReportRuntime({ eventStore: writer.eventStore, db: pool });
    await seedActiveListing(writer.listings, "lst_snapshot", "acc_seller");
    const reportId = await reportToThreshold(reports, "lst_snapshot");
    const automaticLea = (await writer.listings.loadListingState("lst_snapshot")).listingEnforcement!
      .listingEnforcementActionId;
    await command(writer.listings, "lst_snapshot", publishListingCommand);
    const rca = createId("rca");
    const operatorLea = createId("lea");
    await command(writer.listings, "lst_snapshot", operatorUnlist(rca, operatorLea));
    await command(writer.listings, "lst_snapshot", publishListingCommand);
    await advanceToSnapshot(writer.listings, pool, "lst_snapshot");

    const row = await snapshotRow(pool, "lst_snapshot");
    const applied = [
      { sourceActionId: reportId, listingEnforcementActionId: automaticLea },
      { sourceActionId: rca, listingEnforcementActionId: operatorLea },
    ];
    expect(row).toMatchObject({
      streamVersion: SNAPSHOT_EVERY_N_EVENTS,
      schemaVersion: CANDIDATE_SNAPSHOT_SCHEMA_VERSION,
      status: "active",
      appliedListingEnforcements: applied,
      currentListingEnforcementActionId: operatorLea,
    });

    const fresh = createRuntime(pool);
    const loaded = await fresh.listings.loadListingState("lst_snapshot");
    expect(fresh.reads("lst_snapshot")).toEqual([SNAPSHOT_EVERY_N_EVENTS + 1]);
    expect(loaded).toEqual(await fullReplay(pool, "lst_snapshot"));
    expect(loaded).toMatchObject({
      status: "active",
      listingEnforcement: { listingEnforcementActionId: operatorLea, sourceActionId: rca },
      appliedListingEnforcements: applied,
    });
    for (const redelivery of [operatorUnlist(rca, createId("lea")), autoUnlist(reportId, createId("lea"))]) {
      await expect(command(fresh.listings, "lst_snapshot", redelivery)).resolves.toMatchObject({
        version: SNAPSHOT_EVERY_N_EVENTS,
        newEvents: [],
      });
    }
    expect(await streamVersion(pool, "lst_snapshot")).toBe(SNAPSHOT_EVERY_N_EVENTS);

    // Mutant control: a save that dropped the applied identities would let the same redelivery remove again.
    await pool.query(
      `UPDATE event_store_aggregate_snapshots
       SET state = jsonb_set(state, '{appliedListingEnforcements}', '[]'::jsonb)
       WHERE stream_id = $1`,
      ["marketplace.listing-lst_snapshot"],
    );
    const mutantState = await createRuntime(pool).listings.loadListingState("lst_snapshot");
    expect(decideMarketplaceListing(mutantState, operatorUnlist(rca, createId("lea")))).toHaveLength(1);
  });

  it("ignores an old-shape snapshot over old events and equals full replay", async () => {
    const pool = pools.marketplace;
    const { eventStore } = createRuntime(pool);
    const events = [
      ...decideMarketplaceListing(
        initialMarketplaceListingState,
        createListingCommand("lst_old_snapshot", "acc_seller"),
      ),
      { type: "marketplace.listing.published", data: {} },
      {
        type: "marketplace.listing.auto-unlisted",
        data: { reportId: "rpt_legacy", reportCount: 3, threshold: 3, autoUnlistedAt: "2026-07-01T00:00:00.000Z" },
      },
    ] as MarketplaceListingEvent[];
    await appendStored(eventStore, "lst_old_snapshot", 0, events);
    const {
      listingEnforcement: _absent,
      appliedListingEnforcements: _absentToo,
      ...oldShape
    } = events.slice(0, 2).reduce(evolveImmutableBaseListing, initialMarketplaceListingState);
    await createPostgresAggregateSnapshotStore({ db: pool }).save({
      streamId: "marketplace.listing-lst_old_snapshot",
      streamVersion: 2,
      schemaVersion: IMMUTABLE_BASE_SNAPSHOT_SCHEMA_VERSION,
      state: oldShape as MarketplaceListingState,
    });

    const fresh = createRuntime(pool);
    const loaded = await fresh.listings.loadListingState("lst_old_snapshot");

    expect(fresh.reads("lst_old_snapshot")).toEqual([1]);
    expect(loaded).toEqual(await fullReplay(pool, "lst_old_snapshot"));
    expect(loaded).toMatchObject({ status: "paused", listingEnforcement: null, appliedListingEnforcements: [] });
  });

  it("adjacent-version partial revert", async () => {
    const pool = pools.marketplace;
    const writer = createRuntime(pool);
    const reports = createMarketplaceReportRuntime({ eventStore: writer.eventStore, db: pool });
    await seedActiveListing(writer.listings, "lst_revert", "acc_seller");
    const reportId = await reportToThreshold(reports, "lst_revert");
    await command(writer.listings, "lst_revert", publishListingCommand);
    await advanceToSnapshot(writer.listings, pool, "lst_revert");
    expect(await snapshotRow(pool, "lst_revert")).toMatchObject({
      schemaVersion: CANDIDATE_SNAPSHOT_SCHEMA_VERSION,
      streamVersion: SNAPSHOT_EVERY_N_EVENTS,
    });

    const oldReader = createImmutableBaseReader(pool);
    const oldLoad = await oldReader.load("lst_revert");
    expect(oldReader.reads("lst_revert")).toEqual([1]);
    expect(oldLoad).toMatchObject({ version: SNAPSHOT_EVERY_N_EVENTS, state: { status: "active" } });
    expect(oldLoad.events.filter((event) => event.type === "marketplace.listing.auto-unlisted")).toHaveLength(1);

    const newLoad = await writer.listings.loadListingState("lst_revert");
    expect(newLoad.appliedListingEnforcements.map(({ sourceActionId }) => sourceActionId)).toEqual([reportId]);

    const legacyReader = createRuntime(pool);
    await appendStored(legacyReader.eventStore, "lst_revert_legacy", 0, [
      ...decideMarketplaceListing(
        initialMarketplaceListingState,
        createListingCommand("lst_revert_legacy", "acc_seller"),
      ),
      { type: "marketplace.listing.published", data: {} },
      {
        type: "marketplace.listing.auto-unlisted",
        data: { reportId: "rpt_legacy", reportCount: 3, threshold: 3, autoUnlistedAt: "2026-07-01T00:00:00.000Z" },
      },
    ] as MarketplaceListingEvent[]);
    expect(await legacyReader.listings.loadListingState("lst_revert_legacy")).toMatchObject({ status: "paused" });

    await command(writer.listings, "lst_revert", operatorUnlist(createId("rca"), createId("lea")));
    await expect(createImmutableBaseReader(pool).load("lst_revert")).rejects.toThrow("Unhandled variant");
    expect((await createRuntime(pool).listings.loadListingState("lst_revert")).status).toBe("paused");

    expect(productionFilesNaming("OperatorUnlistListing")).toEqual(["features/listings/domain/domain.ts"]);
  });
});

function createRuntime(pool: PgTransactionalPool) {
  const inner = createPostgresEventStore({ pool });
  const cursors: { streamId: string; fromVersion: number | undefined }[] = [];
  const eventStore: EventStore = {
    ...inner,
    readStream: (input: ReadStreamInput) => {
      cursors.push({ streamId: input.streamId, fromVersion: input.fromVersion });
      return inner.readStream(input);
    },
  };
  const listings = createMarketplaceListingRuntime({
    eventStore,
    checkpointStore: createPostgresProjectionStore({ db: pool }),
    db: pool,
    commercialTermsResolver: createMarketplaceCommercialTermsResolver(pool),
  });
  return { listings, eventStore, reads: (listingId: string) => firstReads(cursors, listingId) };
}

function createImmutableBaseReader(pool: PgTransactionalPool) {
  const inner = createPostgresEventStore({ pool });
  const cursors: { streamId: string; fromVersion: number | undefined }[] = [];
  const { repository } = createAggregateCommandHandler({
    eventStore: {
      ...inner,
      readStream: (input: ReadStreamInput) => {
        cursors.push({ streamId: input.streamId, fromVersion: input.fromVersion });
        return inner.readStream(input);
      },
    },
    codec: createPassthroughDomainEventCodec<MarketplaceListingEvent>(),
    initialState: () => initialMarketplaceListingState,
    evolve: evolveImmutableBaseListing,
    decide: decideMarketplaceListing,
    snapshots: {
      store: createPostgresAggregateSnapshotStore<MarketplaceListingState>({ db: pool }),
      schemaVersion: IMMUTABLE_BASE_SNAPSHOT_SCHEMA_VERSION,
      everyNEvents: SNAPSHOT_EVERY_N_EVENTS,
    },
  });
  return {
    load: (listingId: string) => repository.load(`marketplace.listing-${listingId}`),
    reads: (listingId: string) => firstReads(cursors, listingId),
  };
}

/** The first page cursor of each stream load; later pages of one load continue from it. */
function firstReads(cursors: readonly { streamId: string; fromVersion: number | undefined }[], listingId: string) {
  return cursors
    .filter(({ streamId }) => streamId === `marketplace.listing-${listingId}`)
    .slice(0, 1)
    .map(({ fromVersion }) => fromVersion);
}

type ListingRuntime = ReturnType<typeof createRuntime>["listings"];

function command(listings: ListingRuntime, listingId: string, listingCommand: MarketplaceListingCommand) {
  return listings.commandHandler({
    streamId: `marketplace.listing-${listingId}`,
    command: listingCommand,
    context: contextFor("acc_seller"),
  });
}

async function seedActiveListing(listings: ListingRuntime, listingId: string, accountId: string) {
  await listings.commandHandler({
    streamId: `marketplace.listing-${listingId}`,
    command: createListingCommand(listingId, accountId),
    context: contextFor(accountId),
  });
  await listings.commandHandler({
    streamId: `marketplace.listing-${listingId}`,
    command: publishListingCommand,
    context: contextFor(accountId),
  });
}

/** Submits distinct visitor reports until the production dispatcher removes the listing; returns the source report. */
async function reportToThreshold(reports: ReturnType<typeof createMarketplaceReportRuntime>, listingId: string) {
  for (let index = 1; ; index += 1) {
    const result = await reports.reportListing(
      {
        listingId,
        reporterKind: "visitor",
        reporterKey: `anon_${listingId}_${index}`,
        reporterAccountId: null,
        reporterUserId: null,
        reason: "counterfeit-concern",
        details: null,
        sourceRoutePath: `/listings/${listingId}`,
      },
      contextFor("acc_reporter"),
    );
    if (result.autoUnlisted) {
      return result.reportId;
    }
    expect(index).toBeLessThan(3);
  }
}

/** Seller pause/publish pairs through the production handler until its write-behind snapshot lands at version 100. */
async function advanceToSnapshot(listings: ListingRuntime, pool: PgTransactionalPool, listingId: string) {
  for (let version = await streamVersion(pool, listingId); version < SNAPSHOT_EVERY_N_EVENTS; version += 1) {
    const { status } = await listings.loadListingState(listingId);
    await command(listings, listingId, status === "active" ? { type: "PauseListing" } : publishListingCommand);
  }
  expect(await streamVersion(pool, listingId)).toBe(SNAPSHOT_EVERY_N_EVENTS);
  await vi.waitFor(async () => expect(await snapshotRow(pool, listingId)).not.toBeNull(), { timeout: 5_000 });
}

async function snapshotRow(pool: PgTransactionalPool, listingId: string) {
  const result = await pool.query<{
    stream_version: string | number;
    schema_version: string | number;
    status: string;
    applied: unknown;
    current_lea: string | null;
  }>(
    `SELECT stream_version, schema_version, state->>'status' AS status,
            state->'appliedListingEnforcements' AS applied,
            state->'listingEnforcement'->>'listingEnforcementActionId' AS current_lea
     FROM event_store_aggregate_snapshots WHERE stream_id = $1`,
    [`marketplace.listing-${listingId}`],
  );
  const row = result.rows[0];
  return row
    ? {
        streamVersion: Number(row.stream_version),
        schemaVersion: Number(row.schema_version),
        status: row.status,
        appliedListingEnforcements: row.applied,
        currentListingEnforcementActionId: row.current_lea,
      }
    : null;
}

async function fullReplay(pool: PgTransactionalPool, listingId: string) {
  const events = await storedEvents(pool, listingId);
  return events
    .map(({ eventType, payload }) => ({ type: eventType, data: payload }) as MarketplaceListingEvent)
    .reduce(evolveMarketplaceListing, initialMarketplaceListingState);
}

async function storedEvents(pool: PgTransactionalPool, listingId: string) {
  const result = await pool.query<{ event_type: string; payload: unknown }>(
    "SELECT event_type, payload FROM event_store_events WHERE stream_id = $1 ORDER BY stream_version",
    [`marketplace.listing-${listingId}`],
  );
  return result.rows.map((row) => ({ eventType: row.event_type, payload: row.payload }));
}

async function streamVersion(pool: PgTransactionalPool, listingId: string) {
  const result = await pool.query<{ current_version: string | number }>(
    "SELECT current_version FROM event_store_streams WHERE stream_id = $1",
    [`marketplace.listing-${listingId}`],
  );
  return Number(result.rows[0]?.current_version);
}

async function appendStored(
  eventStore: EventStore,
  listingId: string,
  expectedVersion: number,
  events: readonly MarketplaceListingEvent[],
) {
  await eventStore.appendToStream({
    streamId: `marketplace.listing-${listingId}` as never,
    expectedVersion,
    context: contextFor("acc_seller"),
    events: events.map((event) => ({ eventType: event.type, payload: event.data })),
  });
}

/** Marketplace production sources naming `term`, relative to the context root. */
function productionFilesNaming(term: string): readonly string[] {
  const root = path.resolve(import.meta.dirname, "../../..");
  const walk = (directory: string): string[] =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        return entry.name === "node_modules" ? [] : walk(entryPath);
      }
      return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [entryPath] : [];
    });
  return walk(root)
    .filter((file) => readFileSync(file, "utf8").includes(term))
    .map((file) => path.relative(root, file).replaceAll("\\", "/"))
    .sort();
}

function autoUnlist(reportId: string, listingEnforcementActionId: `lea_${string}`): MarketplaceListingCommand {
  return {
    type: "AutoUnlistListing",
    reportId,
    reportCount: 3,
    threshold: 3,
    autoUnlistedAt: new Date().toISOString(),
    listingEnforcementActionId,
  };
}

function operatorUnlist(
  reportedContentActionId: `rca_${string}`,
  listingEnforcementActionId: `lea_${string}`,
): MarketplaceListingCommand {
  return {
    type: "OperatorUnlistListing",
    reportedContentActionId,
    listingEnforcementActionId,
    recordedAt: new Date().toISOString(),
  };
}

function contextFor(accountId: string): EventStoreContext {
  return {
    tenantId: "tnt_test" as never,
    audit: { performedByUserId: "usr_test" as never, forAccountId: accountId as never },
  };
}

const evidenceRequirements = {
  policyId: null,
  policyVersion: null,
  policyHash: "sha256:policy",
  evaluatedAt: "2026-10-06T12:00:00.000Z",
  requirementHash: "sha256:requirements",
  matchedRuleIds: [],
  explanationCodes: [],
  requirements: { minimumPhotoCount: 0, requiredSlots: [], sellerTrustRequirements: [], buyerAcknowledgment: "none" },
} as const;

const publishListingCommand = {
  type: "PublishListing",
  readiness: {
    ready: true,
    requirementHash: evidenceRequirements.requirementHash,
    unmetCodes: [],
    coverage: { complete: true, unmetCodes: [], slots: [], activePhotoCount: 0, minimumPhotoCount: 0 },
  },
} satisfies PublishListingCommand;

function createListingCommand(listingId: string, accountId: string): CreateListingCommand {
  return {
    type: "CreateListing",
    listingId: listingId as never,
    accountId: accountId as never,
    inventoryItemId: `itm_${listingId}`,
    catalogItemId: "cat_test",
    productId: "cat_test::" as never,
    itemLanguageCode: "en",
    itemTitle: "Test Card",
    itemSubtitle: null,
    selectedOptions: [],
    productSummary: null,
    productMeasureSnapshot: {
      catalogItemId: "cat_test",
      productId: "cat_test::",
      selectedOptions: [],
      measureVersion: "pm_test_v1",
      unitLengthInches: 3.5,
      unitWidthInches: 2.5,
      unitHeightInches: 0.01,
      unitWeightOunces: 0.1,
      physicalFlags: ["raw-card"],
      stackBehavior: "stackable-thickness",
      source: "profile",
      confidence: "measured",
    },
    storageLocationName: "Main",
    shipFromCode: "CHI",
    shipFromAddress: {
      name: "Seller",
      company: null,
      line1: "1 Main St",
      line2: null,
      city: "Chicago",
      state: "IL",
      postalCode: "60601",
      country: "US",
      phone: null,
      email: null,
    },
    priceAmount: "10.00",
    priceCurrencyCode: "USD",
    feeLock: {
      unitCount: 1,
      terms: {
        marketplaceSalesFeePercentageBps: 500,
        marketplaceSalesFeeFixedAmount: "0.00",
        marketplaceSalesFeeCapAmount: "25.00",
        shippingAllowancePercentageBps: 500,
        termsScheduleId: "cts_standard",
        termsAgreementId: null,
        termsResolvedAt: "2026-10-06T12:00:00.000Z",
      },
      marketplaceSalesFeeUnitAmount: "0.50",
      sellerNetUnitAmount: "9.50",
      feeQuoteFingerprint: "fee_test",
    },
    quantityCap: 1,
    evidenceRequirements,
  };
}
