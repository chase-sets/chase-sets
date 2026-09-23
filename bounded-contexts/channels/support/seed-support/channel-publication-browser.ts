import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { createPostgresEventStore, createPgPool, type PgPoolClient } from "@chase-sets/event-core-postgres";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { demoIdentitySeedIds } from "@chase-sets/identity-seed";
import { createEventStoreWakeNotificationConfigForSourceContext } from "@chase-sets/platform-runtime/source-context-wake-registry";
import { manualSyncScenarioSeed } from "../../features/manual-sync/api/seed";
import {
  createChannelListingCompositionRuntime,
  type ChannelListingCompositionServices,
} from "../../features/listing-composition/api/runtime";
import { createChannelCompositionProfileRegistry } from "../../features/listing-composition/domain/canonical";

const projectionPollIntervalMs = 100;
const projectionPollTimeoutMs = 10_000;
const rowLockTimeoutMs = 750;
const maximumHoldMs = 25_000;
const syntheticSourcePrefix = "synthetic-browser-publication-source-";
const syntheticTargetPrefix = "synthetic-browser-publication-target-";

export type ChannelPublicationBrowserSupportErrorCode =
  | "skip-web-server"
  | "database-url-required"
  | "database-url-not-local"
  | "seed-connection-absent"
  | "seed-connection-foreign"
  | "seed-projection-incomplete"
  | "candidate-authoring-failed"
  | "candidate-projection-incomplete"
  | "mapping-row-lock-failed"
  | "target-required"
  | "stream-version-conflict"
  | "cleanup-projection-incomplete";

export class ChannelPublicationBrowserSupportError extends Error {
  public constructor(public readonly code: ChannelPublicationBrowserSupportErrorCode) {
    super(code);
    this.name = "ChannelPublicationBrowserSupportError";
  }
}

export type ChannelPublicationBrowserSupport = Readonly<{
  accountId: string;
  connectionId: string;
  candidate: Readonly<{
    dimension: "category";
    sourceKey: string;
    targetKey: string;
  }>;
  configurationStreamVersion: number;
  release: () => Promise<void>;
  cleanup: () => Promise<void>;
}>;

/**
 * Holds one mapping row. The Channels worker projects its configuration stream transactionally,
 * so the bounded hold can stall the whole listing-state projection until release.
 */
export async function createChannelPublicationBrowserSupport(
  input: Readonly<{
    channelsDatabaseUrl?: string | null;
    cleanupTargetKey?: null;
  }>,
): Promise<ChannelPublicationBrowserSupport> {
  if (process.env.PLAYWRIGHT_SKIP_WEB_SERVER === "true") {
    throw new ChannelPublicationBrowserSupportError("skip-web-server");
  }
  const channelsDatabaseUrl = requireLocalChannelsDatabaseUrl(input.channelsDatabaseUrl);
  const identity = randomUUID();
  const sourceKey = `${syntheticSourcePrefix}${identity}`;
  const generatedTargetKey = `${syntheticTargetPrefix}${identity}`;
  const cleanupTargetKey = input.cleanupTargetKey === null ? null : generatedTargetKey;

  const pool = createPgPool(channelsDatabaseUrl, {
    max: 4,
    connectionTimeoutMillis: 3_000,
    idleInTransactionSessionTimeoutMillis: 28_000,
  });
  const eventStore = createPostgresEventStore({
    pool,
    wakeNotifications: createEventStoreWakeNotificationConfigForSourceContext({ sourceContextName: "channels" }),
  });
  const runtime = createChannelListingCompositionRuntime({
    db: pool,
    eventStore,
    profiles: createChannelCompositionProfileRegistry(),
  });
  let lockClient: PgPoolClient | null = null;
  let lockReleased = false;
  let poolClosed = false;
  let cleanupPromise: Promise<void> | null = null;
  let holdTimer: ReturnType<typeof setTimeout> | null = null;
  let authoredVersion: number | null = null;

  const closePool = async () => {
    if (poolClosed) return;
    poolClosed = true;
    await (pool as unknown as Pool).end();
  };

  const release = async () => {
    if (lockReleased) return;
    lockReleased = true;
    if (holdTimer) {
      clearTimeout(holdTimer);
      holdTimer = null;
    }
    const heldClient = lockClient;
    lockClient = null;
    if (!heldClient) return;
    const client: PgPoolClient = heldClient;
    let releaseError: unknown;
    try {
      await client.query("ROLLBACK");
    } catch (error) {
      releaseError = error;
      throw error;
    } finally {
      client.release(releaseError);
    }
  };

  const cleanup = (): Promise<void> => {
    cleanupPromise ??= (async () => {
      try {
        await release();
        await acceptCandidateForCleanup(runtime, {
          sourceKey,
          targetKey: cleanupTargetKey,
        });
      } finally {
        await closePool();
      }
    })();
    return cleanupPromise;
  };

  try {
    await assertOwnedSeedProjection(runtime, pool);
    const authored = await runtime.recordChannelMappingCandidates(
      {
        connectionId: manualSyncScenarioSeed.connectionId,
        provenance: "compose-discovered",
        candidates: [
          {
            dimension: "category",
            sourceKey,
            proposedTargetKey: generatedTargetKey,
            confidenceTier: "high",
            evidence: {
              listingId: `synthetic-browser-publication-listing-${identity}`,
              derivedFrom: "synthetic browser publication freshness support",
            },
          },
        ],
      },
      browserSupportContext,
    );
    if (authored.kind !== "applied") {
      throw new ChannelPublicationBrowserSupportError("candidate-authoring-failed");
    }
    authoredVersion = authored.streamVersion;
    const detail = await waitForCandidate(runtime, sourceKey);
    if (!detail) throw new ChannelPublicationBrowserSupportError("candidate-projection-incomplete");

    const client: PgPoolClient = await pool.connect();
    lockClient = client;
    try {
      await client.query("BEGIN");
      await client.query(`SET LOCAL lock_timeout = '${rowLockTimeoutMs}ms'`);
      const locked = await client.query<{
        source_key: string;
        review_status: string;
      }>(
        `SELECT source_key,review_status FROM channels_channel_mappings
         WHERE connection_id=$1 AND dimension=$2 AND source_key=$3
         FOR UPDATE`,
        [manualSyncScenarioSeed.connectionId, "category", sourceKey],
      );
      if (
        locked.rows.length !== 1 ||
        locked.rows[0]?.source_key !== sourceKey ||
        locked.rows[0].review_status !== "proposed"
      ) {
        throw new ChannelPublicationBrowserSupportError("mapping-row-lock-failed");
      }
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // The original exact-row-lock failure remains authoritative.
      }
      client.release(error);
      lockClient = null;
      lockReleased = true;
      if (error instanceof ChannelPublicationBrowserSupportError) throw error;
      throw new ChannelPublicationBrowserSupportError("mapping-row-lock-failed");
    }

    holdTimer = setTimeout(() => {
      void cleanup().catch(() => undefined);
    }, maximumHoldMs);
    holdTimer.unref?.();

    return {
      accountId: demoIdentitySeedIds.accountId,
      connectionId: manualSyncScenarioSeed.connectionId,
      candidate: { dimension: "category", sourceKey, targetKey: generatedTargetKey },
      configurationStreamVersion: detail.configurationStreamVersion,
      release,
      cleanup,
    };
  } catch (error) {
    try {
      await release();
      if (authoredVersion !== null) {
        await runtime.decideChannelMappingReview(
          {
            accountId: demoIdentitySeedIds.accountId,
            connectionId: manualSyncScenarioSeed.connectionId,
            dimension: "category",
            sourceKey,
            decision: "accept",
            targetKey: generatedTargetKey,
            expectedStreamVersion: authoredVersion,
          },
          browserSupportContext,
        );
      }
    } catch {
      // Preserve the entry failure while still releasing every owned resource.
    } finally {
      await closePool();
    }
    throw error;
  }
}

const browserSupportContext: EventStoreContext = {
  tenantId: "tnt_synthetic_browser_publication" as never,
  audit: {
    performedByUserId: demoIdentitySeedIds.userId,
    forAccountId: demoIdentitySeedIds.accountId,
  },
};

function requireLocalChannelsDatabaseUrl(value: string | null | undefined): string {
  if (!value) throw new ChannelPublicationBrowserSupportError("database-url-required");
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ChannelPublicationBrowserSupportError("database-url-not-local");
  }
  if (parsed.protocol !== "postgresql:" || !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)) {
    throw new ChannelPublicationBrowserSupportError("database-url-not-local");
  }
  return value;
}

async function assertOwnedSeedProjection(
  runtime: ChannelListingCompositionServices,
  db: Readonly<{ query: PgPoolClient["query"] }>,
): Promise<void> {
  const result = await db.query<{
    account_id: string;
    provider_key: string;
    environment: string;
    status: string;
  }>(
    `SELECT account_id,provider_key,environment,status FROM channels_connection_facts
     WHERE connection_id=$1`,
    [manualSyncScenarioSeed.connectionId],
  );
  const connection = result.rows[0];
  if (!connection) throw new ChannelPublicationBrowserSupportError("seed-connection-absent");
  if (connection.account_id !== demoIdentitySeedIds.accountId) {
    throw new ChannelPublicationBrowserSupportError("seed-connection-foreign");
  }
  if (
    connection.provider_key !== "tcgplayer" ||
    connection.environment !== "sandbox" ||
    connection.status !== "active"
  ) {
    throw new ChannelPublicationBrowserSupportError("seed-projection-incomplete");
  }
  const detail = await runtime.readChannelPublicationConnection({
    accountId: demoIdentitySeedIds.accountId,
    connectionId: manualSyncScenarioSeed.connectionId,
    limit: 200,
  });
  if (!detail || detail.connection.connectionStatus !== "active") {
    throw new ChannelPublicationBrowserSupportError("seed-projection-incomplete");
  }
}

async function waitForCandidate(runtime: ChannelListingCompositionServices, sourceKey: string) {
  return poll(
    async () =>
      runtime.readChannelPublicationConnection({
        accountId: demoIdentitySeedIds.accountId,
        connectionId: manualSyncScenarioSeed.connectionId,
        limit: 200,
      }),
    (detail) =>
      detail?.mappingReview.items.some(
        (item) => item.dimension === "category" && item.sourceKey === sourceKey && item.reviewStatus === "proposed",
      ) === true,
    "candidate-projection-incomplete",
  );
}

async function acceptCandidateForCleanup(
  runtime: ChannelListingCompositionServices,
  input: Readonly<{ sourceKey: string; targetKey: string | null }>,
): Promise<void> {
  if (input.targetKey === null) throw new ChannelPublicationBrowserSupportError("target-required");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const detail = await runtime.readChannelPublicationConnection({
      accountId: demoIdentitySeedIds.accountId,
      connectionId: manualSyncScenarioSeed.connectionId,
      limit: 200,
    });
    if (!detail) throw new ChannelPublicationBrowserSupportError("seed-projection-incomplete");
    const queued = detail.mappingReview.items.some(
      (item) => item.dimension === "category" && item.sourceKey === input.sourceKey,
    );
    if (!queued) return;
    const result = await runtime.decideChannelMappingReview(
      {
        accountId: demoIdentitySeedIds.accountId,
        connectionId: manualSyncScenarioSeed.connectionId,
        dimension: "category",
        sourceKey: input.sourceKey,
        decision: "accept",
        targetKey: input.targetKey,
        expectedStreamVersion: detail.configurationStreamVersion,
      },
      browserSupportContext,
    );
    if (result.kind === "applied" || result.kind === "unchanged") {
      await waitForQueueRemoval(runtime, input.sourceKey);
      return;
    }
    if (result.code !== "stream-version-conflict") {
      if (result.code === "target-required") throw new ChannelPublicationBrowserSupportError("target-required");
      await waitForQueueRemoval(runtime, input.sourceKey);
      return;
    }
  }
  try {
    await waitForQueueRemoval(runtime, input.sourceKey, 1_000);
  } catch {
    throw new ChannelPublicationBrowserSupportError("stream-version-conflict");
  }
}

async function waitForQueueRemoval(
  runtime: ChannelListingCompositionServices,
  sourceKey: string,
  timeoutMs = projectionPollTimeoutMs,
): Promise<void> {
  await poll(
    async () =>
      runtime.readChannelPublicationConnection({
        accountId: demoIdentitySeedIds.accountId,
        connectionId: manualSyncScenarioSeed.connectionId,
        limit: 200,
      }),
    (detail) =>
      detail !== null &&
      !detail.mappingReview.items.some((item) => item.dimension === "category" && item.sourceKey === sourceKey),
    "cleanup-projection-incomplete",
    timeoutMs,
  );
}

async function poll<T>(
  read: () => Promise<T>,
  accepted: (value: T) => boolean,
  failureCode: Extract<
    ChannelPublicationBrowserSupportErrorCode,
    "candidate-projection-incomplete" | "cleanup-projection-incomplete"
  >,
  timeoutMs = projectionPollTimeoutMs,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  do {
    const value = await read();
    if (accepted(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, projectionPollIntervalMs));
  } while (Date.now() < deadline);
  throw new ChannelPublicationBrowserSupportError(failureCode);
}
