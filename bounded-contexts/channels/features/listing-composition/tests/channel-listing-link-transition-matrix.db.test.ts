import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { module as channelsModule } from "../../../index";
import { createChannelListingCompositionRuntime } from "../api/runtime";
import { createChannelCompositionProfileRegistry } from "../domain/canonical";
import { syntheticProfile } from "./test-support";
import { testContext } from "../../connections/tests/test-support";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) throw new Error("TEST_DATABASE_URL is required for Channels DB tests in CI.");
const describeDb = databaseBaseUrl ? describe : describe.skip;
let pools: Readonly<Record<"channels", PgTransactionalPool>>;
type LinkEventRow = Readonly<{
  event_type: string;
  payload: Readonly<{
    desiredStateSequence?: number;
    listingRevision?: number;
    desiredStateHash?: string;
    intent?: string;
    adoption?: string;
    draft?: Readonly<{ quantity: number }>;
    delist?: unknown;
  }>;
}>;

describeDb("channel-listing-link-transition-matrix real DB", () => {
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, ["channels"], "channel_listing_link_transition");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await bootstrapContextDatabase(channelsModule, pools.channels);
    await seedFacts(pools.channels);
  });
  afterAll(async () => closeMultiContextTestPools(pools));

  it("channel-listing-stale-success-identity-adoption uses sequence when listing revision is equal", async () => {
    const services = runtime();
    const first = await services.recordChannelListingDesiredState(
      { connectionId: "connection-synthetic", listingId: "listing-synthetic" },
      testContext,
    );
    expect(first).toMatchObject({ kind: "applied", streamVersion: 1 });
    if (first.kind === "refused") throw new Error("Expected first desire.");
    await pools.channels.query(
      `UPDATE channels_inventory_item_facts SET total_quantity=2,item_stream_version=2 WHERE item_id='item-synthetic'`,
    );
    const second = await services.recordChannelListingDesiredState(
      { connectionId: "connection-synthetic", listingId: "listing-synthetic" },
      testContext,
    );
    expect(second).toMatchObject({ kind: "applied", streamVersion: 2 });
    const desired = await linkEvents();
    expect(
      desired
        .slice(0, 2)
        .map((row) => [row.payload.desiredStateSequence, row.payload.listingRevision, row.payload.draft?.quantity]),
    ).toEqual([
      [1, 7, 3],
      [2, 7, 2],
    ]);
    const report = await services.recordChannelListingPublicationOutcome(
      {
        connectionId: "connection-synthetic",
        channelListingId: first.value.channelListingId,
        operationId: "operation-r1",
        reportedDesiredStateSequence: 1,
        reportedListingRevision: 7,
        reportedDesiredStateHash: String(desired[0]!.payload.desiredStateHash),
        outcome: { kind: "succeeded", externalListingId: "external-listing", externalOfferId: "external-offer" },
        expectedStreamVersion: 2,
      },
      testContext,
    );
    expect(report).toMatchObject({ kind: "applied", streamVersion: 3 });
    const events = await linkEvents();
    expect(events.map((row) => row.event_type)).toEqual([
      "channels.channel-listing.desired-state-changed",
      "channels.channel-listing.desired-state-changed",
      "channels.channel-listing.publication-recorded",
      "channels.channel-listing.desired-state-changed",
    ]);
    expect(events[2]!.payload.adoption).toBe("identity-adopted");
    expect(events[3]!.payload.intent).toBe("update");
    expect(events[3]!.payload.listingRevision).toBe(7);
    expect(events[3]!.payload.desiredStateSequence).toBe(4);
  });

  it("admits current success after blocked and immediately recomposes to delist", async () => {
    const services = runtime();
    const first = await services.recordChannelListingDesiredState(
      { connectionId: "connection-synthetic", listingId: "listing-synthetic" },
      testContext,
    );
    if (first.kind === "refused") throw new Error("Expected first desire.");
    const initialEvents = await linkEvents();
    await pools.channels.query(
      `INSERT INTO channels_seller_availability_facts
       (account_id,status,reason_category,available_again_at,updated_at,availability_stream_version)
       VALUES ('account-synthetic','unavailable','away',NULL,now(),1)`,
    );
    await expect(
      services.recordChannelListingDesiredState(
        { connectionId: "connection-synthetic", listingId: "listing-synthetic" },
        testContext,
      ),
    ).resolves.toMatchObject({
      kind: "applied",
      streamVersion: 2,
    });
    await expect(
      services.recordChannelListingPublicationOutcome(
        {
          connectionId: "connection-synthetic",
          channelListingId: first.value.channelListingId,
          operationId: "operation-current",
          reportedDesiredStateSequence: 1,
          reportedListingRevision: 7,
          reportedDesiredStateHash: String(initialEvents[0]!.payload.desiredStateHash),
          outcome: { kind: "succeeded", externalListingId: "external-listing" },
          expectedStreamVersion: 2,
        },
        testContext,
      ),
    ).resolves.toMatchObject({ kind: "applied", streamVersion: 3 });
    const events = await linkEvents();
    expect(events.map((row) => row.event_type)).toEqual([
      "channels.channel-listing.desired-state-changed",
      "channels.channel-listing.publication-blocked",
      "channels.channel-listing.publication-recorded",
      "channels.channel-listing.desired-state-changed",
    ]);
    expect(events[2]!.payload.adoption).toBe("identity-and-state-applied");
    expect(events[3]!.payload).toMatchObject({ intent: "delist", desiredStateSequence: 4, listingRevision: 7 });
    expect(events[3]!.payload.delist).toMatchObject({
      lastPublishedPrice: { amountMinor: 2_000, currency: "USD" },
      lastPublishedQuantity: 3,
      delistReasons: ["seller-unavailable"],
    });
  });

  it("refuses an injected digest collision against a different persisted source pair", async () => {
    const digest = "a".repeat(64);
    await pools.channels.query(
      `INSERT INTO channels_channel_listing_links
       (connection_id,listing_id,channel_listing_id,publish_state,blocking_reason_codes,operation_bindings,updated_at,last_stream_version)
       VALUES ('other-connection','other-listing',$1,'pending','[]'::jsonb,'{}'::jsonb,now(),1)`,
      [`cl_${digest}`],
    );
    const services = createChannelListingCompositionRuntime({
      db: pools.channels,
      eventStore: createPostgresEventStore({ pool: pools.channels }),
      profiles: createChannelCompositionProfileRegistry([syntheticProfile]),
      listingIdDigest: () => digest,
    });
    await expect(
      services.recordChannelListingDesiredState(
        { connectionId: "connection-synthetic", listingId: "listing-synthetic" },
        testContext,
      ),
    ).resolves.toEqual({ kind: "refused", code: "channel-listing-id-collision" });
  });

  function runtime() {
    return createChannelListingCompositionRuntime({
      db: pools.channels,
      eventStore: createPostgresEventStore({ pool: pools.channels }),
      profiles: createChannelCompositionProfileRegistry([syntheticProfile]),
    });
  }
  async function linkEvents() {
    const result = await pools.channels.query<LinkEventRow>(
      `SELECT event_type,payload FROM event_store_events
       WHERE stream_id LIKE 'channels.channel-listing-cl_%' ORDER BY stream_version`,
    );
    return result.rows;
  }
});

async function seedFacts(db: PgTransactionalPool): Promise<void> {
  await db.query(`
    INSERT INTO channels_connection_facts VALUES
      ('connection-synthetic','account-synthetic','synthetic-provider','sandbox','active',now(),2);
    INSERT INTO channels_listing_publication_facts
      (listing_id,account_id,inventory_item_id,catalog_item_id,price_amount,price_currency_code,quantity_cap,
       selected_options,selected_option_key,listing_status,pause_reason,item_title,item_subtitle,product_summary,graded_card,
       updated_at,listing_stream_version)
    VALUES ('listing-synthetic','account-synthetic','item-synthetic','catalog-synthetic','20.00','USD',10,
      '[{"dimensionId":"condition","optionId":"near-mint"}]'::jsonb,'condition:near-mint','active',NULL,
      'Synthetic card',NULL,'Synthetic description',NULL,now(),7);
    INSERT INTO channels_inventory_item_facts VALUES
      ('item-synthetic','account-synthetic','catalog-synthetic',3,now(),1);
    INSERT INTO channels_catalog_item_category_facts VALUES
      ('catalog-synthetic','cards',true,now(),1);
    INSERT INTO channels_external_product_reference_facts VALUES
      ('synthetic-provider','sku:synthetic','catalog-synthetic','[{"dimensionId":"condition","optionId":"near-mint"}]'::jsonb,
       'condition:near-mint','linked',now(),1);
    INSERT INTO channels_external_catalog_item_reference_facts VALUES
      ('synthetic-provider','product:synthetic','catalog-synthetic','linked',now(),1);
    INSERT INTO channels_connection_publication_settings VALUES
      ('connection-synthetic','','','','["cards"]'::jsonb,'[]'::jsonb,now(),1);
    INSERT INTO channels_channel_mappings VALUES
      ('connection-synthetic','category','catalog-category:cards','trading-cards','manual','accepted','operator',
       '{"listingId":"listing-synthetic","derivedFrom":"assigned category cards"}'::jsonb,now(),1),
      ('connection-synthetic','condition','selected-option:condition:near-mint','near-mint','manual','accepted','operator',
       '{"listingId":"listing-synthetic","derivedFrom":"selected condition"}'::jsonb,now(),1);
  `);
}
