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
import { buildTransportEvent } from "@chase-sets/event-core/test-support";
import { module as channelsModule } from "../../../index";
import { createChannelCompositionProfileRegistry } from "../domain/canonical";
import { createChannelListingCompositionRuntime } from "../api/runtime";
import { testContext } from "../../connections/tests/test-support";
import { buildChannelOwnedDesiredStateReactionHandlers } from "../integrations/reactions";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) throw new Error("TEST_DATABASE_URL is required for Channels DB tests in CI.");
const describeDb = databaseBaseUrl ? describe : describe.skip;
let pools: Readonly<Record<"channels", PgTransactionalPool>>;

describeDb("channel-publication-configuration-commands real DB", () => {
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(
      databaseBaseUrl!,
      ["channels"],
      "channel_publication_configuration",
    );
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await bootstrapContextDatabase(channelsModule, pools.channels);
  });
  afterAll(async () => closeMultiContextTestPools(pools));

  it("keeps versioned settings and review decisions idempotent and enqueues once per successful append", async () => {
    const services = createChannelListingCompositionRuntime({
      db: pools.channels,
      eventStore: createPostgresEventStore({ pool: pools.channels }),
      profiles: createChannelCompositionProfileRegistry(),
    });
    const settings = {
      titlePrefix: "",
      titleSuffix: "",
      descriptionFooter: "",
      categoryAllowlist: ["cards"],
      excludedListingIds: [],
    };
    await expect(
      services.replaceChannelConnectionPublicationSettings(
        {
          connectionId: "connection-1",
          settings,
          expectedStreamVersion: 0,
        },
        testContext,
      ),
    ).resolves.toMatchObject({ kind: "applied", streamVersion: 1 });
    await expect(
      services.replaceChannelConnectionPublicationSettings(
        {
          connectionId: "connection-1",
          settings,
          expectedStreamVersion: 1,
        },
        testContext,
      ),
    ).resolves.toMatchObject({ kind: "unchanged", streamVersion: 1 });
    await expect(
      services.recordChannelMappingCandidates(
        {
          connectionId: "connection-1",
          provenance: "compose-discovered",
          candidates: [
            {
              dimension: "category",
              sourceKey: "catalog-category:cards",
              proposedTargetKey: "trading-cards",
              confidenceTier: "high",
              evidence: { listingId: "listing-1", derivedFrom: "assigned category cards" },
            },
          ],
        },
        testContext,
      ),
    ).resolves.toMatchObject({ kind: "applied", streamVersion: 2 });
    await expect(
      services.recordChannelMappingCandidates(
        {
          connectionId: "connection-1",
          provenance: "export-discovered",
          candidates: [
            {
              dimension: "category",
              sourceKey: "catalog-category:cards",
              proposedTargetKey: "other",
              confidenceTier: "low",
              evidence: { listingId: "listing-1", derivedFrom: "export row" },
            },
          ],
        },
        testContext,
      ),
    ).resolves.toMatchObject({ kind: "unchanged", streamVersion: 2 });
    await expect(
      services.decideChannelMappingReview(
        {
          connectionId: "connection-1",
          dimension: "category",
          sourceKey: "catalog-category:cards",
          decision: "accept",
          targetKey: "trading-cards",
          expectedStreamVersion: 2,
        },
        testContext,
      ),
    ).resolves.toMatchObject({ kind: "applied", streamVersion: 3 });
    await expect(
      services.decideChannelMappingReview(
        {
          connectionId: "connection-1",
          dimension: "category",
          sourceKey: "catalog-category:cards",
          decision: "reject",
          targetKey: null,
          expectedStreamVersion: 2,
        },
        testContext,
      ),
    ).resolves.toEqual({ kind: "refused", code: "stream-version-conflict" });
    const configurationEvents = await pools.channels.query<{
      event_type: string;
      payload: Record<string, unknown>;
      stream_id: string;
      stream_version: number;
      global_position: string;
    }>(
      `SELECT event_type,payload,stream_id,stream_version,global_position::text
       FROM event_store_events WHERE event_type LIKE 'channels.channel-publication-configuration.%'
       ORDER BY stream_version`,
    );
    const reactions = buildChannelOwnedDesiredStateReactionHandlers(services);
    for (const event of configurationEvents.rows) {
      await reactions[event.event_type]!(
        buildTransportEvent(event.event_type, event.payload, {
          streamId: event.stream_id,
          streamVersion: event.stream_version,
          globalPosition: event.global_position,
        }),
      );
    }
    const counts = await pools.channels.query<{ event_type: string; count: string }>(
      `SELECT event_type,COUNT(*)::text AS count FROM event_store_events
       WHERE event_type LIKE 'channels.channel-publication-configuration.%'
          OR event_type='channels.channel-listing-reconciliation.run-enqueued'
       GROUP BY event_type ORDER BY event_type`,
    );
    expect(counts.rows).toEqual([
      { event_type: "channels.channel-listing-reconciliation.run-enqueued", count: "3" },
      { event_type: "channels.channel-publication-configuration.mapping-candidate-recorded", count: "1" },
      { event_type: "channels.channel-publication-configuration.mapping-review-decided", count: "1" },
      { event_type: "channels.channel-publication-configuration.settings-replaced", count: "1" },
    ]);
  });
});
