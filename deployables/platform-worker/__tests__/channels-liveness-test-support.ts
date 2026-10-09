import { beforeEach, expect, vi } from "vitest";
import {
  createProjectionAwarePool,
  resolveModuleProjectionGroups,
  resolveModuleSubscriptions,
  syncProjectionGroup,
  type ContextProjectionGroup,
} from "@chase-sets/bounded-context-runtime";
import { module as channelsModule, createChannelProviderRegistry } from "@chase-sets/channels";
import { transportDatabase } from "./channels-liveness-fixture";
import type { PgQueryable, PgTransactionalPool } from "@chase-sets/event-core-postgres";
import {
  bootstrapPlatformControlPlane,
  createPostgresPlatformControlPlane,
} from "@chase-sets/platform-runtime/control-plane";
import { createPostgresWorkSignalStore } from "@chase-sets/platform-runtime/work-signal-store";
import { livenessConfig } from "./channels-liveness-config";
import { createRegisteredScheduledRunners } from "../src/scheduled-runners";

export { describeDb, target, seller, transportContext } from "./channels-liveness-fixture";
export const runnerName = "channels.connector-liveness-sweep";

export function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

export function livenessWorkerDatabase(name: string) {
  const h = transportDatabase(name);
  let group: ContextProjectionGroup;
  let beforeQuery: (sql: string, values: readonly unknown[]) => Promise<void> = async () => {};
  function wrapQuery(db: PgQueryable): PgQueryable["query"] {
    return async <Row>(sql: string, values?: readonly unknown[]) => {
      await beforeQuery(sql, values ?? []);
      return db.query<Row>(sql, values);
    };
  }
  beforeEach(async () => {
    beforeQuery = async () => {};
    const pool: PgTransactionalPool = {
      query: wrapQuery(h.db),
      connect: async () => {
        const client = await h.db.connect();
        return { query: wrapQuery(client), release: client.release.bind(client) };
      },
    };
    const services = channelsModule.createServices(createProjectionAwarePool(pool), {
      channelSaleRecorder: async () => {
        throw new Error("no sale in projection replay");
      },
    });
    const projector = services.projectors.find((entry) => entry.projectionName === "channel-connection-projection");
    if (!projector) throw new Error("missing-connection-projector");
    const declared = (channelsModule.buildProjectionGroups?.(services) ?? channelsModule.projectionGroups ?? []).find(
      (entry) => entry.projectionName === projector.projectionName,
    );
    if (!declared) throw new Error("missing-connection-group");
    const entry = {
      contextName: "channels",
      module: {
        ...channelsModule,
        buildSubscriptions: undefined,
        eventSubscriptions: [],
        eventReactions: [],
        buildProjectionGroups: undefined,
        projectionGroups: [declared],
      },
      services,
      pool,
      projectionHandlerSets: [projector],
    };
    [group] = resolveModuleProjectionGroups([entry], resolveModuleSubscriptions([entry]));
    await syncProjectionGroup(group);
    await bootstrapPlatformControlPlane(h.db);
  });
  const controlPlane = () => createPostgresPlatformControlPlane(h.db);
  function runners(interval: number | null = 1) {
    return createRegisteredScheduledRunners({
      services: { channels: h.services },
      config: { ...livenessConfig, channelsConnectorLivenessSweepIntervalMs: interval },
      controlPlane: controlPlane(),
      logger: { info: () => {}, warn: () => {} },
      workSignalCleanup: () => ({ workSignalStore: createPostgresWorkSignalStore(h.db), intervalMs: 60_000 }),
      retentionSweep: () => ({ targets: [] }),
    }).filter((runner) => runner.name === runnerName);
  }
  return {
    h,
    runners,
    controlPlane,
    get group() {
      return group;
    },
    get runtime() {
      return { projectionGroups: [group] };
    },
    interceptQuery(callback: typeof beforeQuery) {
      beforeQuery = callback;
    },
    async sweep(at = "2026-10-07T12:01:00.000Z") {
      vi.setSystemTime(new Date(at));
      await h.db.query(
        "UPDATE platform_scheduled_runners SET next_run_at=now()-interval '1 minute' WHERE runner_name=$1",
        [runnerName],
      );
      const registered = runners();
      expect(registered).toHaveLength(1);
      return registered[0]!.runOnce();
    },
    async poll(connectionId?: string, token?: string) {
      const response = await h.request("claim", {}, { connectionId, token });
      expect(response.status).toBe(200);
      return response.json();
    },
    async livenessRows() {
      return (
        await h.db.query(
          "SELECT observation FROM channel_health_observations WHERE source_kind='connector-liveness' ORDER BY source_work_id,source_attempt,result_ordinal",
        )
      ).rows;
    },
    async operations() {
      return (
        await h.db.query(
          "SELECT operation_id,status,attempt_count FROM channel_outbound_operations ORDER BY operation_id",
        )
      ).rows;
    },
    async status(connectionId: string) {
      return (
        await h.db.query<{ status: string }>("SELECT status FROM channel_connections WHERE connection_id=$1", [
          connectionId,
        ])
      ).rows[0]?.status;
    },
  };
}

export function syntheticInlineRegistry() {
  const write = vi.fn(async () => ({ kind: "succeeded" as const, externalListingId: "synthetic-external-listing" }));
  const fetchChannelState = vi.fn(async () => ({
    kind: "complete" as const,
    items: [],
    collectedCount: 0,
    authorityTotal: 0,
    pageCount: 1,
  }));
  const fetchSales = vi.fn(async () => ({
    kind: "complete" as const,
    lines: [],
    collectedCount: 0,
    authorityTotal: 0,
    pageCount: 1,
  }));
  const registry = createChannelProviderRegistry([
    {
      identity: { providerKey: "tcgplayer", environment: "sandbox" },
      setup: {
        providerKey: "tcgplayer",
        environment: "sandbox",
        requirements: { credential: "not-required", requiredPolicyKeys: [], binding: "one-or-more-current" },
      },
      publication: {
        execution: "inline",
        publishListing: write,
        updatePriceQuantity: write,
        delistListing: write,
        fetchChannelState,
        fetchSales,
      },
    },
  ]);
  return { registry, write, fetchChannelState, fetchSales };
}
