import { describe, expect, it } from "vitest";
import {
  activeDeployments,
  assertNoDestructiveChanges,
  appNotFound,
  appPlatformChanges,
  destructiveResourceChanges,
  deployApp,
  pendingDomains,
  planAppChanged,
  waitForDomains,
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

function resourceChange(address, actions) {
  return {
    address,
    type: address.split(".")[0],
    name: address.split(".").at(-1),
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

  it("summarizes destructive Terraform changes", () => {
    expect(
      destructiveResourceChanges(
        planFor([
          resourceChange("digitalocean_app.platform", ["update"]),
          resourceChange("digitalocean_database_cluster.postgres", ["delete", "create"]),
          resourceChange('digitalocean_database_db.contexts["auth"]', ["delete"]),
        ]),
      ),
    ).toEqual([
      {
        address: "digitalocean_database_cluster.postgres",
        type: "digitalocean_database_cluster",
        name: "postgres",
        actions: ["delete", "create"],
      },
      {
        address: 'digitalocean_database_db.contexts["auth"]',
        type: "digitalocean_database_db",
        name: 'contexts["auth"]',
        actions: ["delete"],
      },
    ]);
  });

  it("blocks destructive Terraform changes unless an override marker is present", () => {
    const plan = planFor([resourceChange("digitalocean_app.platform", ["delete", "create"])]);

    expect(() => assertNoDestructiveChanges(plan)).toThrow("Production Terraform plan contains destructive changes");
    expect(assertNoDestructiveChanges(plan, { allowDestructiveChanges: true })).toEqual([
      {
        address: "digitalocean_app.platform",
        type: "digitalocean_app",
        name: "platform",
        actions: ["delete", "create"],
      },
    ]);
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

  it("reports App Platform domains that are not active yet", () => {
    expect(
      pendingDomains(
        {
          domains: [
            { spec: { domain: "landing.test" }, phase: "ACTIVE" },
            { spec: { domain: "admin.test" }, phase: "CONFIGURING" },
          ],
        },
        ["landing.test", "admin.test", "marketplace.test"],
      ),
    ).toEqual([
      { name: "admin.test", phase: "CONFIGURING" },
      { name: "marketplace.test", phase: "MISSING" },
    ]);
  });

  it("waits until active DigitalOcean deployments finish", async () => {
    const responses = [[{ id: "first", phase: "BUILDING" }], [{ id: "first", phase: "ACTIVE" }]];
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

  it("waits until App Platform domains are active", async () => {
    const responses = [
      [
        {
          domains: [
            { spec: { domain: "landing.test" }, phase: "CONFIGURING" },
            { spec: { domain: "admin.test" }, phase: "ACTIVE" },
          ],
        },
      ],
      [
        {
          domains: [
            { spec: { domain: "landing.test" }, phase: "ACTIVE" },
            { spec: { domain: "admin.test" }, phase: "ACTIVE" },
          ],
        },
      ],
    ];
    let sleeps = 0;

    await waitForDomains("app-id", ["landing.test", "admin.test"], {
      commandJson: async (command, args) => {
        expect(command).toBe("doctl");
        expect(args).toEqual(["apps", "get", "app-id", "--output", "json"]);
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

  it("times out with domain names and phases", async () => {
    const timestamps = [0, 2_000];

    await expect(
      waitForDomains("app-id", ["landing.test"], {
        commandJson: async () => [
          {
            domains: [{ spec: { domain: "landing.test" }, phase: "CONFIGURING" }],
          },
        ],
        now: () => timestamps.shift() ?? 2_000,
        timeoutSeconds: 1,
        sleep: async () => {},
      }),
    ).rejects.toThrow("landing.test: CONFIGURING");
  });

  it("treats a deleted App Platform app as no active deployment to wait for", async () => {
    await waitForDeployments("deleted-app-id", {
      commandJson: async () => {
        throw new Error("doctl apps list-deployments deleted-app-id failed: app not found");
      },
      sleep: async () => {
        throw new Error("sleep should not be called");
      },
    });
  });

  it("recognizes App Platform app not found errors", () => {
    expect(appNotFound(new Error("app not found"))).toBe(true);
    expect(appNotFound(new Error("404 could not find apps resource"))).toBe(true);
    expect(appNotFound(new Error("database not found"))).toBe(false);
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
      ["doctl", ["apps", "create-deployment", "app-id", "--wait", "--format", "ID", "--no-header", "--force-rebuild"]],
      ["doctl", ["apps", "get-deployment", "app-id", "deployment-id", "--format", "Phase", "--no-header"]],
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
