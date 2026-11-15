import { vi } from "vitest";
import { module as channelsModule } from "@chase-sets/channels";
import { getWorkerHostEntries, type WorkerHostRuntime } from "@chase-sets/platform-runtime/worker";
import type { PlatformControlPlane } from "@chase-sets/platform-runtime/control-plane";
import { workerContextRegistry } from "../src/context-registry";
import { loadConfig, type PlatformWorkerConfig } from "../src/config";
import { createNoopNotificationAdapter } from "@chase-sets/outbound-messaging";

// Services are deliberately inert. Composition may inspect capabilities, but
// any database access during construction is a regression.
export function censusInput(profile: "landing" | "proof" | "public", enabled = true) {
  vi.stubEnv("DATABASE_URL", "postgresql://synthetic:synthetic@localhost:1/census");
  vi.stubEnv("CHASE_SETS_RUNTIME_PROFILE", profile);
  const unavailable = async (): Promise<never> => {
    throw new Error("census must not access a database");
  };
  const pool = { query: unavailable, connect: unavailable };
  const nested = (): unknown =>
    new Proxy(
      Object.assign(() => Promise.resolve(0), { kind: "available" }),
      {
        get: (target, key) =>
          key === "then"
            ? undefined
            : key === "kind"
              ? "available"
              : Reflect.has(target, key)
                ? Reflect.get(target, key)
                : nested(),
        has: () => true,
      },
    );
  const service = (): unknown =>
    new Proxy({}, { get: (_target, key) => (key === "then" ? undefined : nested()), has: () => true });
  const entries = getWorkerHostEntries(workerContextRegistry, "platform-worker", profile);
  const services = Object.fromEntries(entries.map((entry) => [entry.contextName, service()]));
  if (services.channels) services.channels = channelsModule.createServices(pool, { channelSaleRecorder: unavailable });
  const config: PlatformWorkerConfig = { ...loadConfig(), workerId: "census-worker", leaseTtlMs: 1000 };
  for (const key of Object.keys(config)) {
    if (
      key.endsWith("IntervalMs") &&
      (config[key as keyof PlatformWorkerConfig] === null ||
        typeof config[key as keyof PlatformWorkerConfig] === "number")
    ) {
      Reflect.set(config, key, enabled ? 43210 : null);
    }
    if (key.endsWith("LaneCount")) Reflect.set(config, key, 2);
  }
  Reflect.set(config, "googleMerchant", { ...config.googleMerchant, syncEnabled: enabled, dryRun: true });
  const claims: Array<{ runnerName: string; intervalMs: number }> = [];
  const controlPlane = {
    claimScheduledRunner: vi.fn(async (claim: { runnerName: string; intervalMs: number }) => {
      claims.push(claim);
      return false;
    }),
    recordScheduledRunnerCompleted: vi.fn(),
  } as unknown as PlatformControlPlane;
  const runtime: WorkerHostRuntime = {
    services,
    mountedContexts: entries.map((entry) => ({
      contextName: entry.contextName,
      module: entry.module,
      services: services[entry.contextName],
      pool,
      projectionHandlerSets: [],
    })),
    projectionGroups: [],
    subscriptionRunners: [],
  };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return {
    services,
    runtime,
    config,
    controlPlane,
    logger,
    claims,
    notification: {
      emailAdapter: createNoopNotificationAdapter("email"),
      mobileMessageAdapters: () => [],
      outboxContextNames: new Set<string>(
        workerContextRegistry
          .filter((entry) => entry.manifest.hostPorts?.some((port) => port.portName === "notificationOutbox"))
          .map((entry) => entry.contextName),
      ),
    },
  };
}

export const censusRetention = {
  workSignalCleanup: () => ({
    workSignalStore: {
      cleanupExpiredWorkSignals: async () => ({
        expiredWakeIntents: 0,
        prunedWakeIntents: 0,
        prunedCheckpointReadiness: 0,
        prunedCheckpointWaiters: 0,
        reclaimedPinnedWakeIntents: 0,
        reclaimedOrphanTransactions: 0,
        remainingPinnedWakeIntents: 0,
      }),
    },
    intervalMs: 12345,
  }),
  retentionSweep: () => ({ targets: [] }),
};
