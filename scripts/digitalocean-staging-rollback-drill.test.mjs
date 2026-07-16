import { describe, expect, it } from "vitest";
import {
  DIGITALOCEAN_STAGING_ROLLBACK_DRILL_VERSION,
  parseDigitalOceanStagingRollbackDrillArgs,
  performDigitalOceanStagingRollbackDrill,
} from "./digitalocean-staging-rollback-drill.mjs";

const digestA = `sha256:${"a".repeat(64)}`;
const digestB = `sha256:${"b".repeat(64)}`;

function validOptions(overrides = {}) {
  return {
    environment: "staging",
    appId: "staging-app-id",
    expectedAppName: "chase-sets-staging-platform",
    registryName: "chase-sets",
    repository: "chase-sets-platform",
    targetDigest: digestB,
    targetTag: "previous-good",
    targetReference: "https://github.com/chase-sets/chase-sets/actions/runs/1",
    landingUrl: "https://www.staging.chasesets.com",
    adminUrl: "https://admin.staging.chasesets.com",
    marketplaceUrl: "https://marketplace.staging.chasesets.com",
    marketplaceRootUrl: "https://staging.chasesets.com",
    checkedAt: "2026-07-02T20:00:00.000Z",
    timeoutSeconds: 30,
    pollSeconds: 1,
    validateTargetImage: true,
    ...overrides,
  };
}

function stagingApp(digest = digestA) {
  return {
    id: "staging-app-id",
    spec: {
      name: "chase-sets-staging-platform",
      services: [
        {
          name: "public-web",
          image: {
            registry_type: "DOCR",
            repository: "chase-sets-platform",
            digest,
          },
        },
      ],
    },
  };
}

function dependencies({ smokeFailureLabel = "" } = {}) {
  const calls = [];
  return {
    calls,
    commandJson: async (command, args) => {
      calls.push([command, args]);
      return [stagingApp()];
    },
    commandOutput: async (command, args, options = {}) => {
      calls.push([command, args, options.input ? JSON.parse(options.input) : null]);
      if (command === "docker") {
        return "";
      }
      if (args[1] === "list-deployments") {
        return "deployment-1 ACTIVE 2026-07-02T20:00:01Z\n";
      }
      return "";
    },
    runSmoke: async (_options, label) => {
      calls.push(["smoke", [label]]);
      if (label === smokeFailureLabel) {
        throw new Error(`${label} smoke failed`);
      }
    },
  };
}

describe("digitalocean staging rollback drill", () => {
  it("parses staging-only inputs from env", () => {
    const parsed = parseDigitalOceanStagingRollbackDrillArgs([], {
      DEPLOYMENT_ENVIRONMENT: "staging",
      STAGING_APP_ID: "app-id",
      DIGITALOCEAN_REGISTRY_NAME: "chase-sets",
      ROLLBACK_TARGET_DIGEST: digestB,
      ROLLBACK_TARGET_TAG: "previous-good",
      ROLLBACK_TARGET_REFERENCE: "issue-3334",
      LANDING_URL: "https://www.staging.chasesets.com",
      ADMIN_URL: "https://admin.staging.chasesets.com",
      MARKETPLACE_URL: "https://marketplace.staging.chasesets.com",
      MARKETPLACE_ROOT_WEB_URL: "https://staging.chasesets.com",
    });

    expect(parsed.environment).toBe("staging");
    expect(parsed.appId).toBe("app-id");
    expect(parsed.repository).toBe("chase-sets-platform");
    expect(parsed.validateTargetImage).toBe(true);
  });

  it("rolls staging back, smokes the old digest, rolls forward, and records support-safe evidence", async () => {
    const deps = dependencies();
    const result = await performDigitalOceanStagingRollbackDrill(validOptions(), deps);

    expect(result.passesRollbackDrillGate).toBe(true);
    expect(result.record).toMatchObject({
      schemaVersion: DIGITALOCEAN_STAGING_ROLLBACK_DRILL_VERSION,
      environment: "staging",
      app: { id: "staging-app-id", name: "chase-sets-staging-platform" },
      rollbackTarget: {
        imageRef: `registry.digitalocean.com/chase-sets/chase-sets-platform@${digestB}`,
        digest: digestB,
        imageExists: true,
      },
      current: {
        imageRef: `registry.digitalocean.com/chase-sets/chase-sets-platform@${digestA}`,
        digest: digestA,
      },
      supportSafe: true,
      result: "success",
      errors: [],
    });
    expect(result.record.phases.rollback.status).toBe("success");
    expect(result.record.phases.rollbackSmoke.status).toBe("success");
    expect(result.record.phases.rollForward.status).toBe("success");
    expect(result.record.phases.rollForwardSmoke.status).toBe("success");
    expect(deps.calls.filter((call) => call[0] === "smoke").map((call) => call[1][0])).toEqual([
      "rollback",
      "roll-forward",
    ]);
    const appUpdates = deps.calls.filter((call) => call[0] === "doctl" && call[1][1] === "update");
    expect(appUpdates).toHaveLength(2);
    expect(appUpdates[0][2].services[0].image.digest).toBe(digestB);
    expect(appUpdates[1][2].services[0].image.digest).toBe(digestA);
  });

  it("refuses non-staging environments before touching DigitalOcean", async () => {
    const deps = dependencies();
    const result = await performDigitalOceanStagingRollbackDrill(validOptions({ environment: "production" }), deps);

    expect(result.passesRollbackDrillGate).toBe(false);
    expect(result.record.errors).toContain(
      "DigitalOcean staging rollback drill is staging-only; DEPLOYMENT_ENVIRONMENT must be staging.",
    );
    expect(deps.calls).toEqual([]);
  });

  it("refuses to run when the target digest is already current", async () => {
    const deps = dependencies();
    const result = await performDigitalOceanStagingRollbackDrill(validOptions({ targetDigest: digestA }), deps);

    expect(result.passesRollbackDrillGate).toBe(false);
    expect(result.record.errors).toContain(
      "Rollback target digest matches the current staging image; drill would not exercise rollback.",
    );
    expect(deps.calls.some((call) => call[0] === "smoke")).toBe(false);
  });

  it("rolls forward even when rollback smoke fails", async () => {
    const deps = dependencies({ smokeFailureLabel: "rollback" });
    const result = await performDigitalOceanStagingRollbackDrill(validOptions(), deps);

    expect(result.passesRollbackDrillGate).toBe(false);
    expect(result.record.phases.rollback.status).toBe("success");
    expect(result.record.phases.rollbackSmoke.status).toBe("failure");
    expect(result.record.phases.rollForward.status).toBe("success");
    expect(result.record.phases.rollForwardSmoke.status).toBe("success");
    const appUpdates = deps.calls.filter((call) => call[0] === "doctl" && call[1][1] === "update");
    expect(appUpdates).toHaveLength(2);
  });
});
