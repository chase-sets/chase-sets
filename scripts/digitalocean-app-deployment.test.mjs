import { describe, expect, it } from "vitest";
import {
  activeDeployments,
  appPlatformChanges,
  deployApp,
  planAppChanged,
  waitForDeployments,
} from "./digitalocean-app-deployment.mjs";

function planFor(resourceChanges) {
  return {
    resource_changes: resourceChanges,
  };
}

function appChange(actions) {
  return {
    type: "digitalocean_app",
    name: "platform",
    change: { actions },
  };
}

describe("digitalocean-app-deployment", () => {
  it("detects create, update, and delete actions for the platform app", () => {
    expect(appPlatformChanges(planFor([appChange(["create"])]))).toBe(true);
    expect(appPlatformChanges(planFor([appChange(["update"])]))).toBe(true);
    expect(appPlatformChanges(planFor([appChange(["delete"])]))).toBe(true);
  });

  it("ignores no-op platform app actions and unrelated resources", () => {
    expect(appPlatformChanges(planFor([appChange(["no-op"])]))).toBe(false);
    expect(
      appPlatformChanges(
        planFor([
          {
            type: "digitalocean_database_cluster",
            name: "postgres",
            change: { actions: ["update"] },
          },
        ]),
      ),
    ).toBe(false);
  });

  it("reads Terraform JSON plan output for app-change detection", async () => {
    const changed = await planAppChanged("tfplan", {
      commandOutput: async (command, args) => {
        expect(command).toBe("terraform");
        expect(args).toEqual(["show", "-json", "tfplan"]);
        return JSON.stringify(planFor([appChange(["update"])]));
      },
    });

    expect(changed).toBe(true);
  });

  it("filters terminal DigitalOcean deployment phases", () => {
    expect(
      activeDeployments([
        { id: "active", phase: "ACTIVE" },
        { id: "error", phase: "ERROR" },
        { id: "canceled", phase: "CANCELED" },
        { id: "cancelled", phase: "CANCELLED" },
        { id: "superseded", phase: "SUPERSEDED" },
        { id: "pending", phase: "PENDING_BUILD" },
        { ID: "running", Phase: "BUILDING" },
      ]),
    ).toEqual([
      { id: "pending", phase: "PENDING_BUILD" },
      { id: "running", phase: "BUILDING" },
    ]);
  });

  it("waits until active DigitalOcean deployments finish", async () => {
    const responses = [
      [{ id: "first", phase: "BUILDING" }],
      [{ id: "first", phase: "ACTIVE" }],
    ];
    let sleeps = 0;

    await waitForDeployments("app-id", {
      commandJson: async (command, args) => {
        expect(command).toBe("doctl");
        expect(args).toEqual(["apps", "list-deployments", "app-id", "--output", "json"]);
        return responses.shift();
      },
      now: () => 0,
      sleep: async (duration) => {
        sleeps += 1;
        expect(duration).toBe(30_000);
      },
    });

    expect(sleeps).toBe(1);
  });

  it("times out with deployment IDs and phases", async () => {
    const timestamps = [0, 2_000];

    await expect(
      waitForDeployments("app-id", {
        commandJson: async () => [{ id: "stuck", phase: "BUILDING" }],
        now: () => timestamps.shift() ?? 2_000,
        timeoutSeconds: 1,
        sleep: async () => {},
      }),
    ).rejects.toThrow("stuck: BUILDING");
  });

  it("deploys the app and verifies the deployment phase", async () => {
    const calls = [];

    const deploymentId = await deployApp("app-id", {
      forceRebuild: true,
      commandOutput: async (command, args) => {
        calls.push([command, args]);
        if (args[1] === "create-deployment") {
          return "deployment-id\n";
        }
        return "ACTIVE\n";
      },
    });

    expect(deploymentId).toBe("deployment-id");
    expect(calls).toEqual([
      [
        "doctl",
        [
          "apps",
          "create-deployment",
          "app-id",
          "--wait",
          "--format",
          "ID",
          "--no-header",
          "--force-rebuild",
        ],
      ],
      [
        "doctl",
        [
          "apps",
          "get-deployment",
          "app-id",
          "deployment-id",
          "--format",
          "Phase",
          "--no-header",
        ],
      ],
    ]);
  });

  it("fails when DigitalOcean does not return a deployment ID", async () => {
    await expect(
      deployApp("app-id", {
        commandOutput: async () => "\n",
      }),
    ).rejects.toThrow("DigitalOcean deployment did not return an ID.");
  });

  it("fails when the deployment does not become active", async () => {
    await expect(
      deployApp("app-id", {
        commandOutput: async (_command, args) => {
          if (args[1] === "create-deployment") {
            return "deployment-id\n";
          }
          return "ERROR\n";
        },
      }),
    ).rejects.toThrow("deployment-id finished with phase 'ERROR' instead of ACTIVE");
  });
});
