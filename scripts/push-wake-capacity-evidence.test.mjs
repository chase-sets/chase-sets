import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildPushWakeCapacityEvidence,
  loadPushWakeCapacityInputs,
  parseSourceContextWakeRegistryEntries,
  PUSH_WAKE_CAPACITY_EVIDENCE_VERSION,
  readPendingRegistrationLockPoolMax,
  readSourceContextWakeRegistryShards,
  renderPushWakeCapacityMarkdown,
} from "./push-wake-capacity-evidence.mjs";

const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("push wake capacity evidence", () => {
  it("computes current staging and production connection-budget posture from checked-in sources", () => {
    const input = loadPushWakeCapacityInputs();
    const evidence = buildPushWakeCapacityEvidence({ ...input, checkedAt: "2026-06-24T00:00:00.000Z" });

    expect(evidence.schemaVersion).toBe(PUSH_WAKE_CAPACITY_EVIDENCE_VERSION);
    expect(evidence.terraformDefaults.directListenerContexts).toEqual([
      "checkout",
      "identity",
      "inventory",
      "marketplace",
      "ordering",
      "payments",
      "public-presence",
    ]);
    expect(evidence.terraformDefaults.apiWaiterContexts).toEqual(["catalog", "discovery", "inventory", "marketplace"]);
    expect(evidence.terraformDefaults.connectionBudgetUpgradeTriggerPercent).toBe(80);
    expect(evidence.terraformDefaults.activeRegistryRelayContexts).toEqual([
      "catalog",
      "checkout",
      "commercial-terms",
      "identity",
      "inventory",
      "marketplace",
      "ordering",
      "payments",
      "platform-operations",
      "public-presence",
      "settlement",
    ]);

    expect(evidence.environments.staging).toMatchObject({ upgradeTriggerPercent: 80, upgradeTrigger: 75 });
    expect(evidence.environments.staging.authPendingRegistrationLocks).toEqual({
      poolMax: 2,
      apiInstances: 2,
      steadyState: 4,
      deployOverlap: 8,
    });
    expect(evidence.environments.staging.steadyState).toMatchObject({
      base: 55,
      locks: 4,
      total: 59,
      limit: 94,
      headroom: 35,
    });
    // Runtime-only rolling overlap: the envelope adds worker startup pools.
    expect(evidence.environments.staging.deployOverlap).toMatchObject({
      base: 70,
      locks: 8,
      total: 78,
      limit: 94,
      headroom: 16,
      upgradeTriggerHeadroom: 5,
      allowance: "Auth pending-registration direct locks",
      additionalDirectListenerContextsBeforeUpgradeTrigger: 2,
    });
    expect(evidence.terraformDefaults.doksStagingWorkerDatabasePoolMax).toBe(12);
    expect(evidence.environments.doksStaging).toMatchObject({
      queryConnectionMode: "transaction-pool",
      apiPoolDemand: 12,
      workerPoolDemand: 12,
      upgradeTriggerPercent: 80,
      upgradeTrigger: 75,
      apiWaiterListenerDemand: 8,
      workerCapacity: {
        previousDatabasePoolMax: 8,
        databasePoolMax: 12,
        configuredRunnerConcurrency: 12,
        wakeMaxConcurrentRunners: 3,
        wakeStandardLaneRunnerCount: 2,
        steadyStatePoolDelta: 0,
        deployOverlapPoolDelta: 0,
      },
      steadyState: { base: 55, locks: 4, total: 59, limit: 94, headroom: 35 },
      deployOverlap: {
        base: 70,
        locks: 8,
        total: 78,
        limit: 94,
        headroom: 16,
        allowance: "Auth pending-registration direct locks",
        additionalDirectListenerContextsBeforeUpgradeTrigger: 2,
      },
    });
    // #4655 converged production query traffic onto managed transaction pools:
    // production now uses the PgBouncer server-side allocation branch (summed
    // production pool sizes = 33) instead of direct database bindings, so
    // apiPoolDemand/workerPoolDemand are client-side only and the pooled
    // rolling-deploy overlap base (55) no longer moves when worker/API
    // instances scale. Only the capped direct Auth lock pool grows with API
    // instances: 2 per process, 4 across a rollout's two generations.
    expect(evidence.environments.production).toMatchObject({
      apiPoolDemand: 6,
      workerPoolDemand: 8,
      pgbouncerServerBackendAllocation: 33,
      upgradeTriggerPercent: 80,
      upgradeTrigger: 75,
      apiWaiterListenerDemand: 4,
      authPendingRegistrationLocks: { poolMax: 2, apiInstances: 1, steadyState: 2, deployOverlap: 4 },
      steadyState: { base: 44, locks: 2, total: 46, limit: 94, headroom: 48 },
      deployOverlap: {
        base: 55,
        locks: 4,
        total: 59,
        limit: 94,
        headroom: 35,
        upgradeTriggerHeadroom: 16,
        allowance: null,
        additionalDirectListenerContextsAtCurrentTier: 17,
        additionalDirectListenerContextsBeforeUpgradeTrigger: 8,
      },
    });
  });

  it("records the wave-2 listener tier decision without claiming live volume proof", () => {
    const input = loadPushWakeCapacityInputs();
    const evidence = buildPushWakeCapacityEvidence({ ...input, checkedAt: "2026-06-24T00:00:00.000Z" });

    expect(evidence.registryToInfrastructureGap.activeRelayContextsWithoutDirectListenerUrls).toEqual([
      "catalog",
      "commercial-terms",
      "platform-operations",
      "settlement",
    ]);
    expect(evidence.registryToInfrastructureGap.wave2ContextsWithoutDirectListenerUrls).toEqual([
      "catalog",
      "commercial-terms",
      "fulfillment",
    ]);
    expect(evidence.expansionDecision.posture).toBe("wave-2-direct-listeners-fit-current-tier");
    expect(evidence.expansionDecision.wave2DirectListenerExpansion).toMatchObject({
      additionalListenerContextCount: 3,
      additionalOverlapDemand: 6,
      expandedOverlapDemand: 65,
      fitsCurrentTier: true,
      requiredDatabaseSize: null,
    });
    expect(evidence.volumeLoadProofPosture.posture).toBe("not-proven-by-this-ci-evidence");

    const markdown = renderPushWakeCapacityMarkdown(evidence);
    expect(markdown).toContain(
      "Rolling-deploy overlap: 59/94 (base 55 + 4 Auth pending-registration direct locks; headroom 35)",
    );
    expect(markdown).toContain(
      "Rolling-deploy overlap: 78/94 (base 70 + 8 Auth pending-registration direct locks; headroom 16)",
    );
    expect(markdown).toContain("non-lock headroom 5, allowance `Auth pending-registration direct locks`");
    expect(markdown).toContain("Worker pool: 8 -> 12; wake max 3; standard lane 2");
    expect(markdown).toContain("Query connection mode: `transaction-pool`");
    expect(markdown).toContain("Tier-upgrade trigger: 75/94 (80%; headroom 16, no allowance)");
    expect(markdown).toContain("Posture: **wave-2-direct-listeners-fit-current-tier**");
    expect(markdown).toContain("Production-like volume load proof for #1363 still requires live load evidence");
  });

  it("counts the Auth lock pool only from a factory that applies its cap after every override", () => {
    const source = readFileSync(resolve("deployables/platform-api/src/database-pools.ts"), "utf8");
    expect(readPendingRegistrationLockPoolMax(source)).toBe(2);
    expect(
      readPendingRegistrationLockPoolMax(
        source.replace(
          "...defined, max: PENDING_REGISTRATION_LOCK_POOL_MAX }",
          "max: PENDING_REGISTRATION_LOCK_POOL_MAX, ...defined }",
        ),
      ),
    ).toBeNaN();
    expect(
      readPendingRegistrationLockPoolMax(
        source.replace("PENDING_REGISTRATION_LOCK_POOL_MAX = 2;", "PENDING_REGISTRATION_LOCK_POOL_MAX = 0;"),
      ),
    ).toBeNaN();

    const input = loadPushWakeCapacityInputs();
    expect(() =>
      buildPushWakeCapacityEvidence({
        ...input,
        defaults: { ...input.defaults, authPendingRegistrationLockPoolMax: NaN },
      }),
    ).toThrow("lock pool cap is unverified");
    const threeLocks = buildPushWakeCapacityEvidence({
      ...input,
      defaults: { ...input.defaults, authPendingRegistrationLockPoolMax: 3 },
    });
    expect(threeLocks.environments.doksStaging.deployOverlap).toMatchObject({ base: 70, locks: 12, total: 82 });
    expect(threeLocks.environments.production.deployOverlap).toMatchObject({ base: 55, locks: 6, total: 61 });
  });

  it("parses registry entries without importing TypeScript runtime code", () => {
    const entries = parseSourceContextWakeRegistryEntries(`
      registryEntry({
        sourceContextName: "catalog",
        rolloutState: "staging-enabled",
        rolloutWave: "wave-2-commerce-dependencies",
        enablement: {
          eventStoreWakeNotifications: true,
          relayFanOut: true,
        },
      }),
      registryEntry({
        sourceContextName: "auth",
        rolloutState: "not-eligible",
        rolloutWave: "wave-4-deferred-or-not-eligible",
        enablement: {
          eventStoreWakeNotifications: false,
          relayFanOut: false,
        },
      }),
    `);

    expect(entries).toEqual([
      {
        sourceContextName: "catalog",
        rolloutState: "staging-enabled",
        rolloutWave: "wave-2-commerce-dependencies",
        eventStoreWakeNotificationsEnabled: true,
        relayFanOutEnabled: true,
      },
      {
        sourceContextName: "auth",
        rolloutState: "not-eligible",
        rolloutWave: "wave-4-deferred-or-not-eligible",
        eventStoreWakeNotificationsEnabled: false,
        relayFanOutEnabled: false,
      },
    ]);
  });

  it("parses a per-context shard module whose entry is bound to an export", () => {
    // Shards assign the call to a named export, so the entry no longer starts
    // a line. The grammar must key off the `registryEntry({` call alone.
    expect(
      parseSourceContextWakeRegistryEntries(
        [
          'import { registryEntry } from "../source-context-wake-registry-entry";',
          "",
          "export const catalogWakeRegistryEntry = registryEntry({",
          '  sourceContextName: "catalog",',
          '  rolloutState: "staging-enabled",',
          '  rolloutWave: "wave-2-commerce-dependencies",',
          "  enablement: {",
          "    eventStoreWakeNotifications: true,",
          "    relayFanOut: true,",
          "  },",
          "});",
          "",
        ].join("\n"),
      ),
    ).toEqual([
      {
        sourceContextName: "catalog",
        rolloutState: "staging-enabled",
        rolloutWave: "wave-2-commerce-dependencies",
        eventStoreWakeNotificationsEnabled: true,
        relayFanOutEnabled: true,
      },
    ]);
  });

  it("reads every checked-in registry shard module from the shard directory", () => {
    const shardSources = readSourceContextWakeRegistryShards(
      resolve("infrastructure/platform-runtime/source-context-wake-registry"),
    );
    const entries = shardSources.flatMap((shardSource) => parseSourceContextWakeRegistryEntries(shardSource));

    expect(shardSources.length).toBeGreaterThan(0);
    expect(entries).toHaveLength(shardSources.length);
    expect(entries.map((entry) => entry.sourceContextName)).toContain("checkout");
    expect(new Set(entries.map((entry) => entry.sourceContextName)).size).toBe(entries.length);
  });

  it("writes a redacted JSON evidence record from the CLI", () => {
    const directory = mkdtempSync(join(tmpdir(), "push-wake-capacity-"));
    temporaryDirectories.push(directory);
    const outPath = join(directory, "evidence.json");

    execFileSync(
      process.execPath,
      ["./scripts/push-wake-capacity-evidence.mjs", "--checked-at", "2026-06-24T00:00:00.000Z", "--out", outPath],
      { stdio: "pipe" },
    );

    const evidence = JSON.parse(readFileSync(outPath, "utf8"));
    expect(evidence.redaction).toEqual({
      secrets: "not-read",
      databaseUrls: "not-read",
      liveEnvironmentAccess: "not-used",
    });
    expect(evidence.expansionDecision.recommendedDatabaseSize).toBeNull();
  });
});
