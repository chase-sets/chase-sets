import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  buildPushWakeCapacityEvidence,
  loadPushWakeCapacityInputs,
  parseSourceContextWakeRegistryEntries,
  PUSH_WAKE_CAPACITY_EVIDENCE_VERSION,
  renderPushWakeCapacityMarkdown,
} from "./push-wake-capacity-evidence.mjs";

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
    expect(evidence.environments.staging.steadyState).toMatchObject({ total: 51, limit: 94, headroom: 43 });
    expect(evidence.environments.staging.deployOverlap).toMatchObject({
      total: 62,
      limit: 94,
      headroom: 32,
      additionalDirectListenerContextsBeforeUpgradeTrigger: 6,
    });
    expect(evidence.terraformDefaults.doksStagingWorkerDatabasePoolMax).toBe(9);
    expect(evidence.environments.doksStaging).toMatchObject({
      queryConnectionMode: "direct",
      apiPoolDemand: 6,
      workerPoolDemand: 9,
      upgradeTriggerPercent: 80,
      upgradeTrigger: 75,
      apiWaiterListenerDemand: 4,
      workerCapacity: {
        previousDatabasePoolMax: 8,
        databasePoolMax: 9,
        configuredRunnerConcurrency: 9,
        wakeMaxConcurrentRunners: 3,
        wakeStandardLaneRunnerCount: 2,
        steadyStatePoolDelta: 1,
        deployOverlapPoolDelta: 2,
      },
      steadyState: { total: 30, limit: 94, headroom: 64 },
      deployOverlap: {
        total: 56,
        limit: 94,
        headroom: 38,
        additionalDirectListenerContextsBeforeUpgradeTrigger: 9,
      },
    });
    // #4655 converged production query traffic onto managed transaction pools:
    // production now uses the PgBouncer server-side allocation branch (summed
    // production pool sizes = 29) instead of direct App Platform bindings, so
    // apiPoolDemand/workerPoolDemand are client-side only and the rolling-deploy
    // overlap (63) is well clear of the 75 tier-upgrade trigger and no longer
    // moves when worker/API instances scale.
    expect(evidence.environments.production).toMatchObject({
      apiPoolDemand: 12,
      workerPoolDemand: 8,
      pgbouncerServerBackendAllocation: 29,
      upgradeTriggerPercent: 80,
      upgradeTrigger: 75,
      apiWaiterListenerDemand: 8,
      steadyState: { total: 48, limit: 94, headroom: 46 },
      deployOverlap: {
        total: 63,
        limit: 94,
        headroom: 31,
        additionalDirectListenerContextsAtCurrentTier: 15,
        additionalDirectListenerContextsBeforeUpgradeTrigger: 6,
      },
    });
  });

  it("records the wave-2 listener tier decision without claiming live volume proof", () => {
    const input = loadPushWakeCapacityInputs();
    const evidence = buildPushWakeCapacityEvidence({ ...input, checkedAt: "2026-06-24T00:00:00.000Z" });

    expect(evidence.registryToInfrastructureGap.activeRelayContextsWithoutDirectListenerUrls).toEqual([
      "catalog",
      "platform-operations",
      "settlement",
    ]);
    expect(evidence.registryToInfrastructureGap.wave2ContextsWithoutDirectListenerUrls).toEqual([
      "catalog",
      "fulfillment",
    ]);
    expect(evidence.expansionDecision.posture).toBe("wave-2-direct-listeners-fit-current-tier");
    expect(evidence.expansionDecision.wave2DirectListenerExpansion).toMatchObject({
      additionalListenerContextCount: 2,
      additionalOverlapDemand: 4,
      expandedOverlapDemand: 67,
      fitsCurrentTier: true,
      requiredDatabaseSize: null,
    });
    expect(evidence.volumeLoadProofPosture.posture).toBe("not-proven-by-this-ci-evidence");

    const markdown = renderPushWakeCapacityMarkdown(evidence);
    expect(markdown).toContain("Rolling-deploy overlap: 63/94");
    expect(markdown).toContain("Worker pool: 8 -> 9; wake max 3; standard lane 2");
    expect(markdown).toContain("Query connection mode: `direct`");
    expect(markdown).toContain("Tier-upgrade trigger: 75/94 (80%)");
    expect(markdown).toContain("Posture: **wave-2-direct-listeners-fit-current-tier**");
    expect(markdown).toContain("Production-like volume load proof for #1363 still requires live load evidence");
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

  it("writes a redacted JSON evidence record from the CLI", () => {
    const outPath = join(mkdtempSync(join(tmpdir(), "push-wake-capacity-")), "evidence.json");

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
