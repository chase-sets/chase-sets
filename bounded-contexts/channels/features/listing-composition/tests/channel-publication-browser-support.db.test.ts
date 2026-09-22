import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootstrapContextDatabase, drainLocalProjectionHandlerSets } from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { demoIdentitySeedIds } from "@chase-sets/identity-seed";
import { module as channelsModule } from "../../../index";
import { createChannelConnectionRuntime } from "../../connections/api/runtime";
import { manualSyncScenarioSeed, seedManualSyncScenario } from "../../manual-sync/api/seed";
import { createChannelListingCompositionRuntime } from "../api/runtime";
import { createChannelCompositionProfileRegistry } from "../domain/canonical";
import {
  ChannelPublicationBrowserSupportError,
  createChannelPublicationBrowserSupport,
} from "../test-support/channel-publication-browser";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) throw new Error("TEST_DATABASE_URL is required for Channels DB tests in CI.");
const describeDb = databaseBaseUrl ? describe : describe.skip;
let pool: PgTransactionalPool;
let channelsDatabaseUrl: string;

describeDb("channel publication browser support", () => {
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(
      databaseBaseUrl!,
      ["channels"],
      "channel_publication_browser_support",
    );
    channelsDatabaseUrl = urls.channels;
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pool = createMultiContextTestPools(urls).channels;
  });

  beforeEach(async () => {
    delete process.env.PLAYWRIGHT_SKIP_WEB_SERVER;
    await resetMultiContextTestSchemas({ channels: pool });
    await bootstrapContextDatabase(channelsModule, pool);
  });

  afterEach(() => {
    delete process.env.PLAYWRIGHT_SKIP_WEB_SERVER;
  });

  afterAll(async () => closeMultiContextTestPools({ channels: pool }));

  it("channel-publication-browser-support-authors-through-runtime", async () => {
    await seedOwnedConnection();
    const pump = startProjectionPump();
    const support = await createChannelPublicationBrowserSupport({ channelsDatabaseUrl });
    try {
      expect(support.candidate).toMatchObject({
        dimension: "category",
        sourceKey: expect.stringMatching(/^synthetic-browser-publication-source-/),
        targetKey: expect.stringMatching(/^synthetic-browser-publication-target-/),
      });
      const authored = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM event_store_events
         WHERE event_type='channels.channel-publication-configuration.mapping-candidate-recorded'
           AND payload->'candidates' @> $1::jsonb`,
        [JSON.stringify([{ dimension: "category", sourceKey: support.candidate.sourceKey }])],
      );
      expect(authored.rows[0]?.count).toBe("1");
      expect(await mappingRow(support.candidate.sourceKey)).toEqual({
        source_key: support.candidate.sourceKey,
        target_key: support.candidate.targetKey,
        review_status: "proposed",
      });
    } finally {
      await support.cleanup();
      await support.cleanup();
      await pump.stop();
    }
    expect(await mappingRow(support.candidate.sourceKey)).toEqual({
      source_key: support.candidate.sourceKey,
      target_key: support.candidate.targetKey,
      review_status: "accepted",
    });
  });

  it("channel-publication-browser-support-holds-only-selected-row", async () => {
    await seedOwnedConnection();
    const runtime = createRuntime();
    const controlSourceKey = "synthetic-browser-publication-control-row";
    await expect(
      runtime.recordChannelMappingCandidates(
        {
          connectionId: manualSyncScenarioSeed.connectionId,
          provenance: "compose-discovered",
          candidates: [
            {
              dimension: "category",
              sourceKey: controlSourceKey,
              proposedTargetKey: "synthetic-browser-publication-control-target",
              confidenceTier: "high",
              evidence: { listingId: "synthetic-control-listing", derivedFrom: "synthetic browser control" },
            },
          ],
        },
        testContext,
      ),
    ).resolves.toMatchObject({ kind: "applied" });
    await drainLocalProjectionHandlerSets("channels", pool, runtime.projectors);

    const pump = startProjectionPump();
    const support = await createChannelPublicationBrowserSupport({ channelsDatabaseUrl });
    try {
      await expect(
        runtime.decideChannelMappingReview(
          {
            accountId: demoIdentitySeedIds.accountId,
            connectionId: support.connectionId,
            dimension: support.candidate.dimension,
            sourceKey: support.candidate.sourceKey,
            decision: "accept",
            targetKey: support.candidate.targetKey,
            expectedStreamVersion: support.configurationStreamVersion,
          },
          testContext,
        ),
      ).resolves.toMatchObject({ kind: "applied" });
      await waitForBlockedMappingProjection();

      const reader = await pool.connect();
      try {
        await reader.query("SET statement_timeout = '500ms'");
        await expect(
          reader.query<{ source_key: string }>(
            `SELECT source_key FROM channels_channel_mappings
             WHERE connection_id=$1 AND dimension='category' AND source_key=$2`,
            [manualSyncScenarioSeed.connectionId, controlSourceKey],
          ),
        ).resolves.toMatchObject({ rows: [{ source_key: controlSourceKey }] });
      } finally {
        reader.release();
      }
      expect(await mappingRow(support.candidate.sourceKey)).toMatchObject({ review_status: "proposed" });

      await support.release();
      await waitForMappingStatus(support.candidate.sourceKey, "accepted");
      await support.cleanup();
    } finally {
      await support.release();
      await pump.stop();
    }
    expect(await mappingRow(controlSourceKey)).toMatchObject({ review_status: "proposed" });
  });

  it("channel-publication-browser-support-repeats-without-reset", async () => {
    await seedOwnedConnection();
    const pump = startProjectionPump();
    try {
      const first = await createChannelPublicationBrowserSupport({ channelsDatabaseUrl });
      await first.cleanup();
      const second = await createChannelPublicationBrowserSupport({ channelsDatabaseUrl });
      await second.cleanup();
      expect(second.candidate.sourceKey).not.toBe(first.candidate.sourceKey);
      const accepted = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM channels_channel_mappings
         WHERE connection_id=$1 AND source_key LIKE 'synthetic-browser-publication-source-%'
           AND review_status='accepted'`,
        [manualSyncScenarioSeed.connectionId],
      );
      expect(accepted.rows[0]?.count).toBe("2");
    } finally {
      await pump.stop();
    }
  });

  it("fails closed for direct calls outside the owned local seed", async () => {
    await expectSupportError({ channelsDatabaseUrl: null }, "database-url-required");
    await expectSupportError(
      { channelsDatabaseUrl: "postgresql://postgres:postgres@database.example/channels" },
      "database-url-not-local",
    );
    process.env.PLAYWRIGHT_SKIP_WEB_SERVER = "true";
    await expectSupportError({ channelsDatabaseUrl }, "skip-web-server");
    delete process.env.PLAYWRIGHT_SKIP_WEB_SERVER;
    await expectSupportError({ channelsDatabaseUrl }, "seed-connection-absent");

    await authorPendingConnection("account-foreign-synthetic");
    await expectSupportError({ channelsDatabaseUrl }, "seed-connection-foreign");

    await resetMultiContextTestSchemas({ channels: pool });
    await bootstrapContextDatabase(channelsModule, pool);
    await authorPendingConnection(demoIdentitySeedIds.accountId);
    await expectSupportError({ channelsDatabaseUrl }, "seed-projection-incomplete");
  });

  it("surfaces candidate-projection-incomplete without an ordinary projection worker", async () => {
    await seedOwnedConnection();
    await expectSupportError({ channelsDatabaseUrl }, "candidate-projection-incomplete");
  });

  it("surfaces mapping-row-lock-failed when the exact candidate row cannot be acquired", async () => {
    await seedOwnedConnection();
    const supportPromise = createChannelPublicationBrowserSupport({ channelsDatabaseUrl });
    const sourceKey = await waitForSyntheticCandidateEvent();
    await drainLocalProjectionHandlerSets("channels", pool, createRuntime().projectors);
    const blocker = await pool.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query(
        `SELECT source_key FROM channels_channel_mappings
         WHERE connection_id=$1 AND dimension='category' AND source_key=$2
         FOR UPDATE`,
        [manualSyncScenarioSeed.connectionId, sourceKey],
      );
      await expect(supportPromise).rejects.toMatchObject({ code: "mapping-row-lock-failed" });
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
    }
  });

  it("surfaces target-required and closes after the early cleanup refusal", async () => {
    await seedOwnedConnection();
    const pump = startProjectionPump();
    const support = await createChannelPublicationBrowserSupport({ channelsDatabaseUrl, cleanupTargetKey: null });
    try {
      await expect(support.cleanup()).rejects.toMatchObject({ code: "target-required" });
      await expect(support.cleanup()).rejects.toMatchObject({ code: "target-required" });
    } finally {
      await support.release();
      await pump.stop();
    }
  });

  it("surfaces stream-version-conflict after exactly one cleanup retry", async () => {
    await seedOwnedConnection();
    const runtime = createRuntime();
    const pump = startProjectionPump();
    const support = await createChannelPublicationBrowserSupport({ channelsDatabaseUrl });
    await pump.stop();
    await expect(
      runtime.recordChannelMappingCandidates(
        {
          connectionId: support.connectionId,
          provenance: "compose-discovered",
          candidates: [
            {
              dimension: "category",
              sourceKey: "synthetic-browser-publication-conflict-control",
              proposedTargetKey: "synthetic-browser-publication-conflict-target",
              confidenceTier: "high",
              evidence: { listingId: "synthetic-conflict-listing", derivedFrom: "synthetic conflict control" },
            },
          ],
        },
        testContext,
      ),
    ).resolves.toMatchObject({ kind: "applied" });
    await expect(support.cleanup()).rejects.toMatchObject({ code: "stream-version-conflict" });
    await expect(support.cleanup()).rejects.toMatchObject({ code: "stream-version-conflict" });
    const cleanupEvents = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM event_store_events
       WHERE event_type='channels.channel-publication-configuration.mapping-review-decided'
         AND payload->>'sourceKey'=$1`,
      [support.candidate.sourceKey],
    );
    expect(cleanupEvents.rows[0]?.count).toBe("0");
  });
});

const testContext: EventStoreContext = {
  tenantId: "tnt_channel_publication_browser_test" as never,
  audit: {
    performedByUserId: demoIdentitySeedIds.userId,
    forAccountId: demoIdentitySeedIds.accountId,
  },
};

function createRuntime() {
  return createChannelListingCompositionRuntime({
    db: pool,
    eventStore: createPostgresEventStore({ pool }),
    profiles: createChannelCompositionProfileRegistry(),
  });
}

async function seedOwnedConnection() {
  await seedManualSyncScenario(pool);
  await drainLocalProjectionHandlerSets("channels", pool, createRuntime().projectors);
}

function startProjectionPump() {
  const runtime = createRuntime();
  let running = true;
  const completed = (async () => {
    while (running) {
      await drainLocalProjectionHandlerSets("channels", pool, runtime.projectors);
      await sleep(20);
    }
  })();
  return {
    stop: async () => {
      running = false;
      await completed;
    },
  };
}

async function authorPendingConnection(accountId: string) {
  const connections = createChannelConnectionRuntime(
    { db: pool, eventStore: createPostgresEventStore({ pool }) },
    {
      setupResolver: {
        resolve: async ({ providerKey, environment }) => ({
          providerKey,
          environment,
          requirements: { credential: "not-required", requiredPolicyKeys: [], binding: "one-or-more-current" },
        }),
      },
    },
  );
  await connections.connectChannel(
    { connectionId: manualSyncScenarioSeed.connectionId, accountId, providerKey: "tcgplayer" },
    { deploymentEnvironment: "local" },
    {
      tenantId: "tnt_synthetic_foreign_seed" as never,
      audit: { performedByUserId: demoIdentitySeedIds.userId, forAccountId: accountId as never },
    },
  );
  await drainLocalProjectionHandlerSets("channels", pool, createRuntime().projectors);
}

async function mappingRow(sourceKey: string) {
  const result = await pool.query<{ source_key: string; target_key: string | null; review_status: string }>(
    `SELECT source_key,target_key,review_status FROM channels_channel_mappings
     WHERE connection_id=$1 AND dimension='category' AND source_key=$2`,
    [manualSyncScenarioSeed.connectionId, sourceKey],
  );
  return result.rows[0] ?? null;
}

async function waitForMappingStatus(sourceKey: string, reviewStatus: string) {
  await waitFor(async () => (await mappingRow(sourceKey))?.review_status === reviewStatus);
}

async function waitForBlockedMappingProjection() {
  await waitFor(async () => {
    const result = await pool.query<{ blocked: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_stat_activity
         WHERE datname=current_database() AND wait_event_type='Lock'
           AND query LIKE '%UPDATE channels_channel_mappings SET target_key%'
       ) AS blocked`,
    );
    return result.rows[0]?.blocked === true;
  });
}

async function waitForSyntheticCandidateEvent() {
  let sourceKey = "";
  await waitFor(async () => {
    const result = await pool.query<{ source_key: string }>(
      `SELECT candidate->>'sourceKey' AS source_key
       FROM event_store_events, LATERAL jsonb_array_elements(payload->'candidates') AS candidate
       WHERE event_type='channels.channel-publication-configuration.mapping-candidate-recorded'
         AND candidate->>'sourceKey' LIKE 'synthetic-browser-publication-source-%'
       ORDER BY global_position DESC LIMIT 1`,
    );
    sourceKey = result.rows[0]?.source_key ?? "";
    return sourceKey !== "";
  });
  return sourceKey;
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  do {
    if (await check()) return;
    await sleep(20);
  } while (Date.now() < deadline);
  throw new Error("bounded-wait-expired");
}

async function expectSupportError(
  input: Parameters<typeof createChannelPublicationBrowserSupport>[0],
  code: ChannelPublicationBrowserSupportError["code"],
) {
  await expect(createChannelPublicationBrowserSupport(input)).rejects.toMatchObject({ code });
}

function sleep(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
