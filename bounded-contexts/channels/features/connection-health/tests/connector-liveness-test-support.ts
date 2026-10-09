import { beforeEach, expect, vi } from "vitest";
import { createPostgresEventStore } from "@chase-sets/event-core-postgres";
import {
  createProjectionAwarePool,
  createSubscriptionRunner,
  resolveModuleProjectionGroups,
  syncProjectionGroup,
  type ContextProjectionGroup,
} from "@chase-sets/bounded-context-runtime";
import { module as channelsModule } from "../../../index";
import { buildChannelConnectionProjectionHandlers } from "../../connections/read-model/projection";
import { target, transportDatabase } from "../../connector-feed/tests/transport-test-support";
import { createConnectionHealthRuntime, type ConnectionHealthDependencies } from "../api/runtime";
import { resolveChannelHealthPolicy } from "../api/policy";

export { describeDb, seller, target, transportContext } from "../../connector-feed/tests/transport-test-support";

export function livenessDatabase(name: string) {
  const h = transportDatabase(name);
  let group: ContextProjectionGroup;
  let health: ReturnType<typeof createConnectionHealthRuntime>;
  let dependencies: ConnectionHealthDependencies;
  beforeEach(async () => {
    const declared = (channelsModule.buildProjectionGroups?.(h.services) ?? channelsModule.projectionGroups ?? []).find(
      (entry) => entry.projectionName === "channel-connection-projection",
    );
    if (!declared) throw new Error("missing-connection-projection");
    const handlers = buildChannelConnectionProjectionHandlers(createProjectionAwarePool(h.db));
    const runner = createSubscriptionRunner("channels", h.db, h.db, {
      subscriptionName: "channels.channel-connection-projection",
      sourceContextName: "channels",
      projectionName: declared.projectionName,
      subscriptionVersion: 1,
      handlers,
      eventTypes: Object.keys(handlers),
      streamPrefixes: ["channels.connection-"],
    });
    [group] = resolveModuleProjectionGroups(
      [
        {
          contextName: "channels",
          module: { ...channelsModule, buildProjectionGroups: undefined, projectionGroups: [declared] },
          services: h.services,
          pool: h.db,
          projectionHandlerSets: [],
        },
      ],
      [runner],
    );
    await syncProjectionGroup(group);
    const eventStore = createPostgresEventStore({ pool: h.db });
    dependencies = {
      db: h.db,
      eventStore,
      connectorLiveness: h.services.connectorFeed,
      resolvePolicy: (db, at) => resolveChannelHealthPolicy(eventStore, db, at),
    };
    health = createConnectionHealthRuntime(dependencies);
  });
  return {
    h,
    get dependencies() {
      return dependencies;
    },
    get group() {
      return group;
    },
    get health() {
      return health;
    },
    async sweep(at = "2026-10-07T12:01:00.000Z", limit = 100) {
      vi.setSystemTime(new Date(at));
      return health.sweepConnectorLiveness({ now: at, limit });
    },
    async open() {
      return (await health.listOpenReasonGenerations(target)).find(
        (reason) => reason.reasonCode === "connector-liveness",
      );
    },
    async poll() {
      expect((await h.request("claim")).status).toBe(200);
    },
    async effects() {
      const result = await h.db.query<{ snapshot: unknown }>(`SELECT jsonb_build_object(
        'health',(SELECT jsonb_agg(to_jsonb(h)) FROM channel_connection_health h),
        'observations',(SELECT count(*) FROM channel_health_observations),
        'attention',(SELECT jsonb_agg(to_jsonb(a) ORDER BY connection_id,reason_code,reason_generation) FROM channel_connection_attention a),
        'events',(SELECT count(*) FROM event_store_events)) AS snapshot`);
      return result.rows[0].snapshot;
    },
    async observations() {
      return (
        await h.db.query<{ observation: unknown }>(
          "SELECT observation FROM channel_health_observations WHERE source_kind='connector-liveness' ORDER BY source_work_id,source_attempt,result_ordinal",
        )
      ).rows.map((row) => row.observation);
    },
  };
}

export function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
