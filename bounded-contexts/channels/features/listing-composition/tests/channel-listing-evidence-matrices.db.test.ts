import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { buildTransportEvent } from "@chase-sets/event-core/test-support";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { module as channelsModule } from "../../../index";
import { composeChannelListingPublication } from "../domain/compose";
import {
  channelPublicationBlockingReasons,
  type ChannelListingCompositionInput,
  type ChannelPublicationBlockingReason,
} from "../domain/contracts";
import { parseChannelListingCompositionInput } from "../domain/parse";
import {
  buildChannelCatalogFactsProjectionHandlers,
  buildChannelConnectionFactsProjectionHandlers,
  buildChannelInventoryFactsProjectionHandlers,
  buildChannelMarketplaceFactsProjectionHandlers,
} from "../read-model/facts-projection";
import { readChannelListingCompositionFacts, resolveChannelPublishableQuantity } from "../read-model/queries";
import { buildChannelListingStateProjectionHandlers } from "../read-model/state-projection";
import { syntheticProfile } from "./test-support";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) throw new Error("TEST_DATABASE_URL is required for Channels DB tests in CI.");
const describeDb = databaseBaseUrl ? describe : describe.skip;
let pools: Readonly<Record<"channels", PgTransactionalPool>>;

describeDb("channel-listing-exhaustive-db-evidence", () => {
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, ["channels"], "channel_listing_matrices");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await bootstrapContextDatabase(channelsModule, pools.channels);
  });
  afterAll(async () => closeMultiContextTestPools(pools));

  it("channel-projection-concurrent-write preserves the newer write on all twelve tables", async () => {
    const marketplace = buildChannelMarketplaceFactsProjectionHandlers(pools.channels);
    const catalog = buildChannelCatalogFactsProjectionHandlers(pools.channels);
    const inventory = buildChannelInventoryFactsProjectionHandlers(pools.channels);
    const connections = buildChannelConnectionFactsProjectionHandlers(pools.channels);
    const state = buildChannelListingStateProjectionHandlers(pools.channels);

    await marketplace["marketplace.listing.created"]!(
      event("marketplace.listing.created", listingCreated("EUR"), "marketplace.listing-listing-matrix", 2),
    );
    await marketplace["marketplace.listing.created"]!(
      event("marketplace.listing.created", listingCreated("USD"), "marketplace.listing-listing-matrix", 1),
    );
    await marketplace["marketplace.seller-listing-availability.disabled"]!(
      event(
        "marketplace.seller-listing-availability.disabled",
        { accountId: "account-matrix", reasonCategory: "risk", availableAgainAt: null },
        "marketplace.seller-listing-availability-account-matrix",
        2,
      ),
    );
    await marketplace["marketplace.seller-listing-availability.enabled"]!(
      event(
        "marketplace.seller-listing-availability.enabled",
        { accountId: "account-matrix" },
        "marketplace.seller-listing-availability-account-matrix",
        1,
      ),
    );
    await inventory["inventory.item.created"]!(
      event(
        "inventory.item.created",
        { itemId: "item-matrix", accountId: "account-matrix", catalogItemId: "catalog-matrix", totalQuantity: 4 },
        "inventory.item-item-matrix",
        2,
      ),
    );
    await inventory["inventory.item.created"]!(
      event(
        "inventory.item.created",
        { itemId: "item-matrix", accountId: "account-matrix", catalogItemId: "catalog-matrix", totalQuantity: 99 },
        "inventory.item-item-matrix",
        1,
      ),
    );
    await inventory["inventory.hold.placed"]!(
      event(
        "inventory.hold.placed",
        { holdId: "hold-matrix", itemId: "item-matrix", quantity: 2 },
        "inventory.hold-hold-matrix",
        2,
      ),
    );
    await inventory["inventory.hold.placed"]!(
      event(
        "inventory.hold.placed",
        { holdId: "hold-matrix", itemId: "item-matrix", quantity: 9 },
        "inventory.hold-hold-matrix",
        1,
      ),
    );
    await catalog["catalog.catalog-item.category-removed"]!(
      event("catalog.catalog-item.category-removed", { categoryId: "cards" }, "catalog.catalog-item-catalog-matrix", 2),
    );
    await catalog["catalog.catalog-item.category-assigned"]!(
      event(
        "catalog.catalog-item.category-assigned",
        { categoryId: "cards" },
        "catalog.catalog-item-catalog-matrix",
        1,
      ),
    );
    await catalog["catalog.catalog-item.external-product-reference-unlinked"]!(
      event(
        "catalog.catalog-item.external-product-reference-unlinked",
        { providerKey: "synthetic-provider", externalKey: "sku:matrix" },
        "catalog.catalog-item-catalog-matrix",
        2,
      ),
    );
    await catalog["catalog.catalog-item.external-product-reference-linked"]!(
      event(
        "catalog.catalog-item.external-product-reference-linked",
        { providerKey: "synthetic-provider", externalKey: "sku:matrix", selectedOptions: [] },
        "catalog.catalog-item-catalog-matrix",
        1,
      ),
    );
    await catalog["catalog.catalog-item.external-catalog-item-reference-unlinked"]!(
      event(
        "catalog.catalog-item.external-catalog-item-reference-unlinked",
        { providerKey: "synthetic-provider", externalKey: "product:matrix" },
        "catalog.catalog-item-catalog-matrix",
        2,
      ),
    );
    await catalog["catalog.catalog-item.external-catalog-item-reference-linked"]!(
      event(
        "catalog.catalog-item.external-catalog-item-reference-linked",
        { providerKey: "synthetic-provider", externalKey: "product:matrix" },
        "catalog.catalog-item-catalog-matrix",
        1,
      ),
    );
    await connections["channels.connection.connected"]!(
      event(
        "channels.connection.connected",
        connectionCreated("new-account"),
        "channels.connection-connection-matrix",
        2,
      ),
    );
    await connections["channels.connection.connected"]!(
      event(
        "channels.connection.connected",
        connectionCreated("old-account"),
        "channels.connection-connection-matrix",
        1,
      ),
    );
    await state["channels.channel-publication-configuration.settings-replaced"]!(
      event(
        "channels.channel-publication-configuration.settings-replaced",
        { connectionId: "connection-matrix", settings: settings("new") },
        "channels.channel-publication-configuration-connection-matrix",
        2,
      ),
    );
    await state["channels.channel-publication-configuration.settings-replaced"]!(
      event(
        "channels.channel-publication-configuration.settings-replaced",
        { connectionId: "connection-matrix", settings: settings("old") },
        "channels.channel-publication-configuration-connection-matrix",
        1,
      ),
    );
    await state["channels.channel-publication-configuration.mapping-candidate-recorded"]!(
      event(
        "channels.channel-publication-configuration.mapping-candidate-recorded",
        {
          connectionId: "connection-matrix",
          provenance: "compose-discovered",
          candidates: [mappingCandidate()],
        },
        "channels.channel-publication-configuration-connection-matrix",
        1,
      ),
    );
    await state["channels.channel-publication-configuration.mapping-review-decided"]!(
      event(
        "channels.channel-publication-configuration.mapping-review-decided",
        mappingDecision("accepted", "new-target"),
        "channels.channel-publication-configuration-connection-matrix",
        3,
      ),
    );
    await state["channels.channel-publication-configuration.mapping-review-decided"]!(
      event(
        "channels.channel-publication-configuration.mapping-review-decided",
        mappingDecision("rejected", null),
        "channels.channel-publication-configuration-connection-matrix",
        2,
      ),
    );
    await state["channels.channel-listing.desired-state-changed"]!(
      event(
        "channels.channel-listing.desired-state-changed",
        desired("connection-matrix", "listing-matrix", "cl_matrix", 2, "2"),
        "channels.channel-listing-cl_matrix",
        2,
      ),
    );
    await state["channels.channel-listing.publication-blocked"]!(
      event(
        "channels.channel-listing.publication-blocked",
        {
          connectionId: "connection-matrix",
          listingId: "listing-matrix",
          channelListingId: "cl_matrix",
          listingRevision: 1,
          reasons: ["listing-not-active"],
        },
        "channels.channel-listing-cl_matrix",
        1,
      ),
    );
    await state["channels.channel-listing-reconciliation.run-enqueued"]!(
      event(
        "channels.channel-listing-reconciliation.run-enqueued",
        { runId: "run-matrix", connectionId: "connection-matrix", scope: "connection", scopeKey: "connection-matrix" },
        "channels.channel-listing-reconciliation-run-matrix",
        2,
      ),
    );
    await state["channels.channel-listing-reconciliation.run-enqueued"]!(
      event(
        "channels.channel-listing-reconciliation.run-enqueued",
        { runId: "run-matrix", connectionId: "connection-matrix", scope: "connection", scopeKey: "connection-matrix" },
        "channels.channel-listing-reconciliation-run-matrix",
        1,
      ),
    );

    const versions = await projectionVersions();
    expect(versions).toEqual({
      listing: 2,
      availability: 2,
      item: 2,
      hold: 2,
      category: 2,
      productReference: 2,
      catalogReference: 2,
      connection: 2,
      settings: 2,
      mapping: 3,
      link: 2,
      run: 2,
    });
    await expectRow("channels_listing_publication_facts", "price_currency_code", "EUR");
    await expectRow("channels_seller_availability_facts", "status", "unavailable");
    await expectRow("channels_inventory_item_facts", "total_quantity", 4);
    await expectRow("channels_inventory_hold_facts", "quantity", 2);
    await expectRow("channels_catalog_item_category_facts", "assigned", false);
    await expectRow("channels_external_product_reference_facts", "link_state", "unlinked");
    await expectRow("channels_external_catalog_item_reference_facts", "link_state", "unlinked");
    await expectRow("channels_connection_facts", "account_id", "new-account");
    await expectRow("channels_connection_publication_settings", "title_suffix", "new");
    await expectRow("channels_channel_mappings", "review_status", "accepted");
    await expectRow("channels_channel_listing_links", "publish_state", "pending");
    await expectRow("channels_listing_reconciliation_runs", "restart_required", false);
  });

  it("channel-listing-link-reason-persistence writes and clears every one of the 31 reasons", async () => {
    const handlers = buildChannelListingStateProjectionHandlers(pools.channels);
    for (const [index, reason] of channelPublicationBlockingReasons.entries()) {
      const listingId = `listing-reason-${index}`;
      const channelListingId = `cl_reason_${index}`;
      await handlers["channels.channel-listing.publication-blocked"]!(
        event(
          "channels.channel-listing.publication-blocked",
          {
            connectionId: "connection-reasons",
            channelListingId,
            listingId,
            listingRevision: 1,
            reasons: [reason],
          },
          `channels.channel-listing-${channelListingId}`,
          1,
        ),
      );
    }
    const blocked = await pools.channels.query<{
      listing_id: string;
      blocking_reason_codes: readonly ChannelPublicationBlockingReason[];
    }>(
      `SELECT listing_id,blocking_reason_codes FROM channels_channel_listing_links
       WHERE connection_id='connection-reasons' ORDER BY listing_id`,
    );
    expect(blocked.rows).toHaveLength(31);
    expect(new Set(blocked.rows.flatMap((row) => row.blocking_reason_codes))).toEqual(
      new Set(channelPublicationBlockingReasons),
    );

    for (const [index] of channelPublicationBlockingReasons.entries()) {
      const listingId = `listing-reason-${index}`;
      const channelListingId = `cl_reason_${index}`;
      await handlers["channels.channel-listing.desired-state-changed"]!(
        event(
          "channels.channel-listing.desired-state-changed",
          desired("connection-reasons", listingId, channelListingId, 2, index.toString(16)),
          `channels.channel-listing-${channelListingId}`,
          2,
        ),
      );
    }
    const cleared = await pools.channels.query<{ publish_state: string; blocking_reason_codes: readonly string[] }>(
      `SELECT publish_state,blocking_reason_codes FROM channels_channel_listing_links
       WHERE connection_id='connection-reasons'`,
    );
    expect(cleared.rows).toHaveLength(31);
    expect(cleared.rows.every((row) => row.publish_state === "pending" && row.blocking_reason_codes.length === 0)).toBe(
      true,
    );
  });

  it("channel-publication-eligibility-matrix distinguishes absent, empty, status, scope and reference states", async () => {
    await seedEligibilityFacts();
    await expectComposition("publishable");
    const absentAvailability = await readChannelListingCompositionFacts(pools.channels, eligibilityIdentity);
    expect(absentAvailability?.listing).toMatchObject({ kind: "present", sellerAvailabilityStatus: "available" });

    await pools.channels.query(
      `INSERT INTO channels_seller_availability_facts
       (account_id,status,reason_category,available_again_at,updated_at,availability_stream_version)
       VALUES ('account-eligibility','unavailable','risk',NULL,now(),1)`,
    );
    await expectComposition("seller-unavailable");
    await pools.channels.query(`DELETE FROM channels_seller_availability_facts`);

    await pools.channels.query(`DELETE FROM channels_inventory_item_facts`);
    await expectComposition("inventory-facts-unavailable");
    await seedInventoryItem();

    for (const status of ["pending-setup", "paused", "disconnected"] as const) {
      await pools.channels.query(`UPDATE channels_connection_facts SET status=$1`, [status]);
      await expectComposition("connection-not-active");
    }
    await pools.channels.query(`UPDATE channels_connection_facts SET status='active'`);

    await pools.channels.query(`DELETE FROM channels_connection_publication_settings`);
    await expectComposition("publication-settings-missing");
    await seedSettings();
    await pools.channels.query(`UPDATE channels_connection_publication_settings SET category_allowlist='[]'::jsonb`);
    await expectComposition("category-not-allowed");
    await pools.channels.query(
      `UPDATE channels_connection_publication_settings
       SET category_allowlist='["cards"]'::jsonb,excluded_listing_ids='["listing-eligibility"]'::jsonb`,
    );
    await expectComposition("listing-excluded");
    await pools.channels.query(`UPDATE channels_connection_publication_settings SET excluded_listing_ids='[]'::jsonb`);

    await pools.channels.query(`UPDATE channels_external_product_reference_facts SET link_state='unlinked'`);
    await expectComposition("provider-product-reference-unlinked");
    await pools.channels.query(`UPDATE channels_external_product_reference_facts SET link_state='linked'`);
    await pools.channels.query(
      `INSERT INTO channels_external_product_reference_facts
       (provider_key,external_key,catalog_item_id,selected_options,selected_option_key,link_state,updated_at,reference_stream_version)
       VALUES ('synthetic-provider','sku:eligibility-2','catalog-eligibility','[]'::jsonb,'condition:near-mint','linked',now(),1)`,
    );
    await expectComposition("provider-product-reference-ambiguous");
    await pools.channels.query(
      `DELETE FROM channels_external_product_reference_facts WHERE external_key='sku:eligibility-2'`,
    );

    await pools.channels.query(`UPDATE channels_external_catalog_item_reference_facts SET link_state='unlinked'`);
    await expectComposition("provider-catalog-item-reference-unlinked");
    await pools.channels.query(`UPDATE channels_external_catalog_item_reference_facts SET link_state='linked'`);
    await pools.channels.query(
      `INSERT INTO channels_external_catalog_item_reference_facts
       (provider_key,external_key,catalog_item_id,link_state,updated_at,reference_stream_version)
       VALUES ('synthetic-provider','product:eligibility-2','catalog-eligibility','linked',now(),1)`,
    );
    await expectComposition("provider-catalog-item-reference-ambiguous");
    await pools.channels.query(
      `DELETE FROM channels_external_catalog_item_reference_facts WHERE external_key='product:eligibility-2'`,
    );

    await pools.channels.query(
      `UPDATE channels_channel_mappings SET review_status='proposed' WHERE dimension='category'`,
    );
    await expectComposition("category-unmapped");
    await pools.channels.query(`DELETE FROM channels_channel_mappings WHERE dimension='category'`);
    await expectComposition("category-unmapped");
    await seedCategoryMapping();

    const current = await compositionInput();
    expect(current.connection.publicationScopeState).toEqual({ kind: "not-applicable" });
    expect(composeChannelListingPublication(current).kind).toBe("publishable");
    const stale: ChannelListingCompositionInput = {
      ...current,
      connection: { ...current.connection, publicationScopeState: { kind: "stale" } },
    };
    expect(composeChannelListingPublication(stale)).toEqual({
      kind: "blocked",
      reasons: ["provider-scope-not-current"],
    });
  });

  it("channel-publishable-quantity-availability emits a real published sold-out delist and distinguishes absence", async () => {
    expect(await resolveChannelPublishableQuantity(pools.channels, { listingId: "missing" })).toEqual({
      kind: "listing-facts-unavailable",
    });
    await seedEligibilityFacts({ includeInventory: false });
    expect(await resolveChannelPublishableQuantity(pools.channels, eligibilityIdentity)).toEqual({
      kind: "inventory-facts-unavailable",
    });
    await seedInventoryItem(0);
    await pools.channels.query(
      `INSERT INTO channels_channel_listing_links
       (connection_id,listing_id,channel_listing_id,external_listing_id,external_offer_id,provider_revision,
        last_desired_state_sequence,last_desired_listing_revision,last_desired_state_hash,last_desired_intent,
        last_desired_payload,last_pushed_listing_revision,last_pushed_price_amount_minor,last_pushed_price_currency,
        last_pushed_quantity,publish_state,blocking_reason_codes,failure_reason,drift_status,operation_bindings,
        updated_at,last_stream_version)
       VALUES ('connection-eligibility','listing-eligibility','cl_eligibility','external-listing','external-offer','r1',
        1,7,$1,'publish',$2::jsonb,7,2000,'USD',3,'published','[]'::jsonb,NULL,NULL,'{}'::jsonb,now(),2)`,
      [
        "a".repeat(64),
        JSON.stringify(desired("connection-eligibility", "listing-eligibility", "cl_eligibility", 1, "a")),
      ],
    );
    const result = composeChannelListingPublication(await compositionInput());
    expect(result).toMatchObject({
      kind: "publishable",
      intent: "delist",
      delist: {
        channelListingId: "cl_eligibility",
        lastPublishedPrice: { amountMinor: 2_000, currency: "USD" },
        lastPublishedQuantity: 3,
        delistReasons: ["sold-out"],
      },
    });
  });

  it("channel-listing-external-reference-retention keeps external identity across every retained state", async () => {
    const handlers = buildChannelListingStateProjectionHandlers(pools.channels);
    const stream = "channels.channel-listing-cl_retention";
    await handlers["channels.channel-listing.desired-state-changed"]!(
      event(
        "channels.channel-listing.desired-state-changed",
        desired("connection-retention", "listing-retention", "cl_retention", 1, "a"),
        stream,
        1,
      ),
    );
    await handlers["channels.channel-listing.publication-recorded"]!(
      event(
        "channels.channel-listing.publication-recorded",
        publicationRecorded(1, "a", "operation-publish", { kind: "succeeded" }),
        stream,
        2,
      ),
    );
    await expectRetained("published", 3);

    await handlers["channels.channel-listing.desired-state-changed"]!(
      event(
        "channels.channel-listing.desired-state-changed",
        desiredDelist("connection-retention", "listing-retention", "cl_retention", 3, "b"),
        stream,
        3,
      ),
    );
    await handlers["channels.channel-listing.publication-recorded"]!(
      event(
        "channels.channel-listing.publication-recorded",
        publicationRecorded(3, "b", "operation-delist", { kind: "succeeded" }),
        stream,
        4,
      ),
    );
    await expectRetained("delisted", 0);

    await handlers["channels.channel-listing.desired-state-changed"]!(
      event(
        "channels.channel-listing.desired-state-changed",
        desired("connection-retention", "listing-retention", "cl_retention", 5, "c", 2),
        stream,
        5,
      ),
    );
    await handlers["channels.channel-listing.publication-recorded"]!(
      event(
        "channels.channel-listing.publication-recorded",
        publicationRecorded(5, "c", "operation-rejected", { kind: "rejected" }),
        stream,
        6,
      ),
    );
    await expectRetained("failed", 0);
    await handlers["channels.channel-listing.publication-blocked"]!(
      event(
        "channels.channel-listing.publication-blocked",
        {
          connectionId: "connection-retention",
          channelListingId: "cl_retention",
          listingId: "listing-retention",
          listingRevision: 7,
          reasons: ["seller-unavailable"],
        },
        stream,
        7,
      ),
    );
    await expectRetained("blocked", 0);
    await handlers["channels.channel-listing.desired-state-changed"]!(
      event(
        "channels.channel-listing.desired-state-changed",
        desired("connection-retention", "listing-retention", "cl_retention", 8, "d", 2),
        stream,
        8,
      ),
    );
    await expectRetained("pending", 0);
  });
});

const eligibilityIdentity = { connectionId: "connection-eligibility", listingId: "listing-eligibility" } as const;

async function seedEligibilityFacts(options: Readonly<{ includeInventory?: boolean }> = {}): Promise<void> {
  await pools.channels.query(
    `INSERT INTO channels_connection_facts
     (connection_id,account_id,provider_key,environment,status,updated_at,connection_stream_version)
     VALUES ('connection-eligibility','account-eligibility','synthetic-provider','sandbox','active',now(),1);
     INSERT INTO channels_listing_publication_facts
     (listing_id,account_id,inventory_item_id,catalog_item_id,price_amount,price_currency_code,quantity_cap,
      selected_options,selected_option_key,listing_status,pause_reason,item_title,item_subtitle,product_summary,
      graded_card,updated_at,listing_stream_version)
     VALUES ('listing-eligibility','account-eligibility','item-eligibility','catalog-eligibility','20.00','USD',10,
      '[{"dimensionId":"condition","optionId":"near-mint"}]'::jsonb,'condition:near-mint','active',NULL,
      'Synthetic card',NULL,'Synthetic description',NULL,now(),7);
     INSERT INTO channels_catalog_item_category_facts
     (catalog_item_id,category_id,assigned,updated_at,catalog_item_stream_version)
     VALUES ('catalog-eligibility','cards',true,now(),1);
     INSERT INTO channels_external_product_reference_facts
     (provider_key,external_key,catalog_item_id,selected_options,selected_option_key,link_state,updated_at,reference_stream_version)
     VALUES ('synthetic-provider','sku:eligibility','catalog-eligibility','[]'::jsonb,'condition:near-mint','linked',now(),1);
     INSERT INTO channels_external_catalog_item_reference_facts
     (provider_key,external_key,catalog_item_id,link_state,updated_at,reference_stream_version)
     VALUES ('synthetic-provider','product:eligibility','catalog-eligibility','linked',now(),1)`,
  );
  if (options.includeInventory !== false) await seedInventoryItem();
  await seedSettings();
  await seedCategoryMapping();
  await pools.channels.query(
    `INSERT INTO channels_channel_mappings
     (connection_id,dimension,source_key,target_key,confidence_tier,review_status,provenance,evidence,updated_at,last_stream_version)
     VALUES ('connection-eligibility','condition','selected-option:condition:near-mint','near-mint','manual','accepted',
      'operator','{"listingId":"listing-eligibility","derivedFrom":"eligibility matrix"}'::jsonb,now(),1)`,
  );
}

async function seedInventoryItem(totalQuantity = 3): Promise<void> {
  await pools.channels.query(
    `INSERT INTO channels_inventory_item_facts
     (item_id,account_id,catalog_item_id,total_quantity,updated_at,item_stream_version)
     VALUES ('item-eligibility','account-eligibility','catalog-eligibility',$1,now(),1)`,
    [totalQuantity],
  );
}

async function seedSettings(): Promise<void> {
  await pools.channels.query(
    `INSERT INTO channels_connection_publication_settings
     (connection_id,title_prefix,title_suffix,description_footer,category_allowlist,excluded_listing_ids,updated_at,last_stream_version)
     VALUES ('connection-eligibility','','','','["cards"]'::jsonb,'[]'::jsonb,now(),1)`,
  );
}

async function seedCategoryMapping(): Promise<void> {
  await pools.channels.query(
    `INSERT INTO channels_channel_mappings
     (connection_id,dimension,source_key,target_key,confidence_tier,review_status,provenance,evidence,updated_at,last_stream_version)
     VALUES ('connection-eligibility','category','catalog-category:cards','trading-cards','manual','accepted',
      'operator','{"listingId":"listing-eligibility","derivedFrom":"eligibility matrix"}'::jsonb,now(),1)`,
  );
}

async function compositionInput(): Promise<ChannelListingCompositionInput> {
  const facts = await readChannelListingCompositionFacts(pools.channels, eligibilityIdentity);
  if (!facts) throw new Error("Expected eligibility facts.");
  const candidate: ChannelListingCompositionInput = {
    ...facts,
    profile: { kind: "registered", profile: syntheticProfile },
  };
  const parsed = parseChannelListingCompositionInput(candidate);
  if (parsed.kind !== "valid") throw new Error(`Eligibility input rejected: ${parsed.programmingError}`);
  return parsed.input;
}

async function expectComposition(expected: "publishable" | ChannelPublicationBlockingReason): Promise<void> {
  const result = composeChannelListingPublication(await compositionInput());
  if (expected === "publishable") expect(result.kind).toBe("publishable");
  else expect(result).toEqual({ kind: "blocked", reasons: [expected] });
}

async function projectionVersions(): Promise<Record<string, number>> {
  const definitions = [
    ["listing", "channels_listing_publication_facts", "listing_stream_version"],
    ["availability", "channels_seller_availability_facts", "availability_stream_version"],
    ["item", "channels_inventory_item_facts", "item_stream_version"],
    ["hold", "channels_inventory_hold_facts", "hold_stream_version"],
    ["category", "channels_catalog_item_category_facts", "catalog_item_stream_version"],
    ["productReference", "channels_external_product_reference_facts", "reference_stream_version"],
    ["catalogReference", "channels_external_catalog_item_reference_facts", "reference_stream_version"],
    ["connection", "channels_connection_facts", "connection_stream_version"],
    ["settings", "channels_connection_publication_settings", "last_stream_version"],
    ["mapping", "channels_channel_mappings", "last_stream_version"],
    ["link", "channels_channel_listing_links", "last_stream_version"],
    ["run", "channels_listing_reconciliation_runs", "last_stream_version"],
  ] as const;
  const entries = await Promise.all(
    definitions.map(async ([name, table, column]) => {
      const result = await pools.channels.query<{ version: string | number }>(
        `SELECT ${column} AS version FROM ${table} LIMIT 1`,
      );
      return [name, Number(result.rows[0]?.version)] as const;
    }),
  );
  return Object.fromEntries(entries);
}

async function expectRow(table: string, column: string, expected: unknown): Promise<void> {
  const result = await pools.channels.query<{ value: unknown }>(`SELECT ${column} AS value FROM ${table} LIMIT 1`);
  expect(result.rows[0]?.value).toEqual(expected);
}

async function expectRetained(publishState: string, lastPushedQuantity: number): Promise<void> {
  const result = await pools.channels.query<{
    publish_state: string;
    external_listing_id: string;
    external_offer_id: string;
    provider_revision: string;
    last_pushed_quantity: number;
  }>(
    `SELECT publish_state,external_listing_id,external_offer_id,provider_revision,last_pushed_quantity
     FROM channels_channel_listing_links WHERE channel_listing_id='cl_retention'`,
  );
  expect(result.rows[0]).toEqual({
    publish_state: publishState,
    external_listing_id: "external-listing",
    external_offer_id: "external-offer",
    provider_revision: "provider-r1",
    last_pushed_quantity: lastPushedQuantity,
  });
}

function listingCreated(currency: string) {
  return {
    listingId: "listing-matrix",
    accountId: "account-matrix",
    inventoryItemId: "item-matrix",
    catalogItemId: "catalog-matrix",
    priceAmount: "20.00",
    priceCurrencyCode: currency,
    quantityCap: 10,
    selectedOptions: [],
    itemTitle: "Card",
    itemSubtitle: null,
    productSummary: null,
    gradedCard: null,
  };
}

function connectionCreated(accountId: string) {
  return {
    connectionId: "connection-matrix",
    accountId,
    providerKey: "synthetic-provider",
    environment: "sandbox",
  };
}

function settings(titleSuffix: string) {
  return { titlePrefix: "", titleSuffix, descriptionFooter: "", categoryAllowlist: [], excludedListingIds: [] };
}

function mappingCandidate() {
  return {
    dimension: "category",
    sourceKey: "catalog-category:cards",
    proposedTargetKey: "candidate",
    confidenceTier: "high",
    evidence: { listingId: "listing-matrix", derivedFrom: "projection matrix" },
  };
}

function mappingDecision(reviewStatus: "accepted" | "rejected", targetKey: string | null) {
  return {
    connectionId: "connection-matrix",
    dimension: "category",
    sourceKey: "catalog-category:cards",
    targetKey,
    confidenceTier: "manual",
    reviewStatus,
    evidence: { listingId: "listing-matrix", derivedFrom: "projection matrix" },
  };
}

function desired(
  connectionId: string,
  listingId: string,
  channelListingId: string,
  sequence: number,
  hashSeed: string,
  quantity = 3,
) {
  return {
    connectionId,
    channelListingId,
    listingId,
    listingRevision: 7,
    desiredStateSequence: sequence,
    desiredStateHash: hashSeed.padEnd(64, hashSeed || "0").slice(0, 64),
    intent: sequence === 1 ? "publish" : "update",
    draft: publicationDraft(channelListingId, quantity),
  };
}

function desiredDelist(
  connectionId: string,
  listingId: string,
  channelListingId: string,
  sequence: number,
  hashSeed: string,
) {
  return {
    connectionId,
    channelListingId,
    listingId,
    listingRevision: 7,
    desiredStateSequence: sequence,
    desiredStateHash: hashSeed.repeat(64).slice(0, 64),
    intent: "delist",
    delist: {
      channelListingId,
      listingRevision: 7,
      lastPublishedPrice: { amountMinor: 2_000, currency: "USD" },
      lastPublishedQuantity: 3,
      delistReasons: ["seller-unavailable"],
    },
  };
}

function publicationDraft(channelListingId: string, quantity = 3) {
  return {
    channelListingId,
    listingRevision: 7,
    title: "Synthetic card",
    description: "Synthetic description",
    categoryKey: "trading-cards",
    conditionKey: "near-mint",
    price: { amountMinor: 2_000, currency: "USD" },
    quantity,
    attributes: [],
  };
}

function publicationRecorded(
  sequence: number,
  hashSeed: string,
  operationId: string,
  outcome: Readonly<{ kind: "succeeded" | "rejected" }>,
) {
  return {
    connectionId: "connection-retention",
    channelListingId: "cl_retention",
    operationId,
    reportedDesiredStateSequence: sequence,
    reportedListingRevision: 7,
    reportedDesiredStateHash: hashSeed.repeat(64).slice(0, 64),
    outcome:
      outcome.kind === "succeeded"
        ? {
            kind: "succeeded",
            externalListingId: "external-listing",
            externalOfferId: "external-offer",
            providerRevision: "provider-r1",
          }
        : { kind: "rejected", code: "validation" },
    adoption: outcome.kind === "succeeded" ? "identity-and-state-applied" : "none",
  };
}

function event(type: string, data: Record<string, unknown>, streamId: string, streamVersion: number) {
  return buildTransportEvent(type, data, { streamId, streamVersion, globalPosition: `${streamId}:${streamVersion}` });
}
