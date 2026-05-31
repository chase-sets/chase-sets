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
  resetStaleDomainAttachment,
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
          resourceChange("terraform_data.context_database_grants", ["delete", "create"], {
            type: "terraform_data",
            name: "context_database_grants",
          }),
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

  it("resets stale App Platform domain attachments by removing and restoring the domain", async () => {
    const calls = [];
    const app = {
      domains: [
        {
          spec: { domain: "staging.test" },
          phase: "CONFIGURING",
          progress: { steps: [{ reason: { code: "DomainCNAMEMismatch" } }] },
        },
      ],
      spec: {
        name: "test-app",
        domains: [
          { domain: "www.staging.test", type: "ALIAS", zone: "staging.test" },
          { domain: "staging.test", type: "PRIMARY", zone: "staging.test" },
        ],
        ingress: {
          rules: [
            {
              match: { authority: { exact: "staging.test" }, path: { prefix: "/" } },
              component: { name: "marketplace", preserve_path_prefix: true },
            },
            {
              match: { path: { prefix: "/" } },
              component: { name: "worker" },
            },
          ],
        },
      },
    };
    const latestApp = {
      spec: {
        name: "test-app",
        domains: [{ domain: "www.staging.test", type: "ALIAS", zone: "staging.test" }],
        ingress: {
          rules: [
            {
              match: { path: { prefix: "/" } },
              component: { name: "worker" },
            },
          ],
        },
      },
    };
    const responses = [[app], [latestApp]];

    await expect(
      resetStaleDomainAttachment("app-id", "staging.test", {
        commandJson: async (command, args) => {
          calls.push([command, args]);
          return responses.shift();
        },
        commandOutput: async (command, args, options) => {
          calls.push([command, args, JSON.parse(options.input)]);
          return "";
        },
      }),
    ).resolves.toBe(true);

    expect(calls[0]).toEqual(["doctl", ["apps", "get", "app-id", "--output", "json"]]);
    expect(calls[1][0]).toBe("doctl");
    expect(calls[1][1]).toEqual(["apps", "update", "app-id", "--spec", "-", "--wait"]);
    expect(calls[1][2].domains).toEqual([{ domain: "www.staging.test", type: "ALIAS", zone: "staging.test" }]);
    expect(calls[1][2].ingress.rules).toHaveLength(1);
    expect(calls[2]).toEqual(["doctl", ["apps", "get", "app-id", "--output", "json"]]);
    expect(calls[3][2].domains).toContainEqual({
      domain: "staging.test",
      type: "PRIMARY",
      zone: "staging.test",
    });
    expect(calls[3][2].ingress.rules[0].match.authority.exact).toBe("staging.test");
  });

  it("skips App Platform domain reset when the domain is not stale", async () => {
    await expect(
      resetStaleDomainAttachment("app-id", "staging.test", {
        commandJson: async () => [
          {
            domains: [{ spec: { domain: "staging.test" }, phase: "CONFIGURING", progress: { steps: [] } }],
            spec: { domains: [{ domain: "staging.test" }], ingress: { rules: [] } },
          },
        ],
        commandOutput: async () => {
          throw new Error("update should not be called");
        },
      }),
    ).resolves.toBe(false);
  });
});
