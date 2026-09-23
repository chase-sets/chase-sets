import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fakes = vi.hoisted(() => {
  let sourceKey: string | null = null;
  const rollbackError = new Error("synthetic-rollback-failed");
  const client = {
    query: vi.fn(async (sql: string) => {
      if (sql === "ROLLBACK") throw rollbackError;
      if (sql.includes("FOR UPDATE")) {
        return { rows: [{ source_key: sourceKey, review_status: "proposed" }] };
      }
      return { rows: [] };
    }),
    release: vi.fn(),
  };
  const pool = {
    connect: vi.fn(async () => client),
    query: vi.fn(async (sql: string) => {
      if (sql.includes("FROM channels_connection_facts")) {
        return {
          rows: [
            { account_id: "account-synthetic", provider_key: "tcgplayer", environment: "sandbox", status: "active" },
          ],
        };
      }
      throw new Error(`unexpected synthetic pool query: ${sql}`);
    }),
    end: vi.fn(async (): Promise<void> => undefined),
  };
  const runtime = {
    recordChannelMappingCandidates: vi.fn(async (input: { candidates: Array<{ sourceKey: string }> }) => {
      sourceKey = input.candidates[0]!.sourceKey;
      return { kind: "applied", streamVersion: 1 };
    }),
    readChannelPublicationConnection: vi.fn(async () => ({
      connection: { connectionStatus: "active" },
      mappingReview: {
        items: sourceKey ? [{ dimension: "category", sourceKey, reviewStatus: "proposed" }] : [],
      },
      configurationStreamVersion: 1,
    })),
    decideChannelMappingReview: vi.fn(),
  };
  return { client, pool, runtime, rollbackError, resetSourceKey: () => (sourceKey = null) };
});

vi.mock("@chase-sets/event-core-postgres", () => ({
  createPgPool: () => fakes.pool,
  createPostgresEventStore: () => ({}),
}));
vi.mock("@chase-sets/identity-seed", () => ({
  demoIdentitySeedIds: { accountId: "account-synthetic", userId: "user-synthetic" },
}));
vi.mock("@chase-sets/platform-runtime/source-context-wake-registry", () => ({
  createEventStoreWakeNotificationConfigForSourceContext: () => ({}),
}));
vi.mock("../features/manual-sync/api/seed", () => ({
  manualSyncScenarioSeed: { connectionId: "connection-synthetic" },
}));
vi.mock("../features/listing-composition/api/runtime", () => ({
  createChannelListingCompositionRuntime: () => fakes.runtime,
}));
vi.mock("../features/listing-composition/domain/canonical", () => ({
  createChannelCompositionProfileRegistry: () => ({}),
}));

import { createChannelPublicationBrowserSupport } from "../support/seed-support/channel-publication-browser";

describe("synthetic cleanup release failure control", () => {
  beforeEach(() => {
    vi.stubEnv("PLAYWRIGHT_SKIP_WEB_SERVER", "false");
    fakes.resetSourceKey();
    vi.clearAllMocks();
  });

  afterEach(() => vi.unstubAllEnvs());

  it("preserves the rollback rejection and awaits one pool close across repeated cleanup", async () => {
    let finishClose!: () => void;
    let startClose!: () => void;
    const closeFinished = new Promise<void>((resolve) => {
      finishClose = resolve;
    });
    const closeStarted = new Promise<void>((resolve) => {
      startClose = resolve;
    });
    fakes.pool.end.mockImplementationOnce(async () => {
      startClose();
      await closeFinished;
    });
    const support = await createChannelPublicationBrowserSupport({
      channelsDatabaseUrl: "postgresql://postgres:postgres@127.0.0.1/channels_synthetic",
    });

    const first = support.cleanup();
    const repeated = support.cleanup();
    let settled = false;
    const observed = first
      .catch((error: unknown) => error)
      .finally(() => {
        settled = true;
      });
    try {
      await Promise.race([closeStarted, observed]);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(repeated).toBe(first);
      expect(fakes.client.release).toHaveBeenCalledExactlyOnceWith(fakes.rollbackError);
      expect(fakes.pool.end).toHaveBeenCalledTimes(1);
      expect(settled).toBe(false);
      expect(fakes.runtime.decideChannelMappingReview).not.toHaveBeenCalled();
    } finally {
      finishClose();
      await observed;
    }
    await expect(first).rejects.toBe(fakes.rollbackError);
    await expect(repeated).rejects.toBe(fakes.rollbackError);
    await expect(support.cleanup()).rejects.toBe(fakes.rollbackError);
    expect(fakes.client.release).toHaveBeenCalledTimes(1);
    expect(fakes.pool.end).toHaveBeenCalledTimes(1);
  });
});
