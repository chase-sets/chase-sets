import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  activeDeployments,
  approvedDestructiveChangeAddressesFromText,
  assertNoDestructiveChanges,
  appRollbackTarget,
  appNotFound,
  appPlatformChanges,
  buildDeploymentDiagnosticsRecord,
  captureRollbackTarget,
  collectDeploymentDiagnostics,
  destructiveChangesApprovalFingerprint,
  destructiveResourceChanges,
  deployApp,
  deploymentForDiagnostics,
  deploymentComponentNames,
  durableDatabaseDestructiveResourceChanges,
  latestDeployment,
  listDeploymentSummariesFromApi,
  normalizeDeploymentProgressSteps,
  parseDeploymentSummaryRows,
  pendingDomains,
  planAppChanged,
  postgresClusterIdFromPlan,
  readPostgresClusterIdFromPlan,
  renderTerraformPlanSummaryMarkdown,
  resetStaleDomainAttachment,
  rollbackAppImage,
  rollbackSpecToImage,
  terraformPlanSummary,
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
  it("captures a uniform App Platform rollback target by digest", () => {
    const target = appRollbackTarget(
      {
        id: "app-id",
        spec: {
          name: "production-platform",
          services: [
            {
              name: "public-web",
              image: { registry_type: "DOCR", repository: "chase-sets-platform", digest: "sha256:" + "a".repeat(64) },
            },
          ],
          workers: [
            {
              name: "platform-worker",
              image: { registry_type: "DOCR", repository: "chase-sets-platform", digest: "sha256:" + "a".repeat(64) },
            },
          ],
        },
      },
      {
        registryName: "chase-sets",
        repository: "chase-sets-platform",
        lastKnownGoodCommit: "b".repeat(40),
        releaseTag: "release-20260628010101-bbbbbbbb",
        checkedAt: "2026-06-28T01:02:03.000Z",
      },
    );

    expect(target).toMatchObject({
      appId: "app-id",
      appName: "production-platform",
      registryName: "chase-sets",
      repository: "chase-sets-platform",
      digest: "sha256:" + "a".repeat(64),
      imageRef: `registry.digitalocean.com/chase-sets/chase-sets-platform@sha256:${"a".repeat(64)}`,
      componentNames: ["platform-worker", "public-web"],
      lastKnownGoodCommit: "b".repeat(40),
      releaseTag: "release-20260628010101-bbbbbbbb",
    });
  });

  it("captures a uniform App Platform rollback target from deploy-on-push tags", () => {
    const target = appRollbackTarget(
      {
        id: "app-id",
        spec: {
          name: "production-platform",
          services: [
            {
              name: "public-web",
              image: {
                registry_type: "DOCR",
                repository: "chase-sets-platform",
                deploy_on_push: { enabled: true, tag: "release-rollback" },
              },
            },
          ],
          workers: [
            {
              name: "platform-worker",
              image: {
                registry_type: "DOCR",
                repository: "chase-sets-platform",
                deploy_on_push: { enabled: true, tag: "release-rollback" },
              },
            },
          ],
        },
      },
      {
        registryName: "chase-sets",
        repository: "chase-sets-platform",
        checkedAt: "2026-06-28T01:02:03.000Z",
      },
    );

    expect(target).toMatchObject({
      repository: "chase-sets-platform",
      tag: "release-rollback",
      digest: "",
      imageRef: "registry.digitalocean.com/chase-sets/chase-sets-platform:release-rollback",
      componentNames: ["platform-worker", "public-web"],
    });
  });

  it("refuses a mixed App Platform rollback target", () => {
    expect(() =>
      appRollbackTarget(
        {
          spec: {
            services: [
              {
                name: "public-web",
                image: { registry_type: "DOCR", repository: "chase-sets-platform", digest: "sha256:" + "a".repeat(64) },
              },
            ],
            workers: [
              {
                name: "platform-worker",
                image: { registry_type: "DOCR", repository: "chase-sets-platform", digest: "sha256:" + "b".repeat(64) },
              },
            ],
          },
        },
        { registryName: "chase-sets", repository: "chase-sets-platform" },
      ),
    ).toThrow("do not share a single rollback target");
  });

  it("rewrites matching App Platform component images to the rollback digest", () => {
    const spec = {
      services: [
        {
          name: "public-web",
          image: { registry_type: "DOCR", repository: "chase-sets-platform", digest: "sha256:" + "a".repeat(64) },
        },
      ],
      workers: [
        {
          name: "platform-worker",
          image: { registry_type: "DOCR", repository: "chase-sets-platform", digest: "sha256:" + "a".repeat(64) },
        },
      ],
    };

    const updated = rollbackSpecToImage(spec, {
      repository: "chase-sets-platform",
      digest: "sha256:" + "c".repeat(64),
    });

    expect(updated.services[0].image).toMatchObject({
      repository: "chase-sets-platform",
      digest: "sha256:" + "c".repeat(64),
    });
    expect(updated.services[0].image).not.toHaveProperty("tag");
    expect(updated.workers[0].image.digest).toBe("sha256:" + "c".repeat(64));
    expect(spec.services[0].image.digest).toBe("sha256:" + "a".repeat(64));
  });

  it("captures and applies rollback image updates through doctl", async () => {
    const calls = [];
    const app = {
      id: "app-id",
      spec: {
        name: "production-platform",
        services: [
          {
            name: "public-web",
            image: { registry_type: "DOCR", repository: "chase-sets-platform", digest: "sha256:" + "a".repeat(64) },
          },
        ],
      },
    };

    await expect(
      captureRollbackTarget("app-id", {
        registryName: "chase-sets",
        repository: "chase-sets-platform",
        commandJson: async (command, args) => {
          calls.push([command, args]);
          return [app];
        },
      }),
    ).resolves.toMatchObject({
      imageRef: `registry.digitalocean.com/chase-sets/chase-sets-platform@sha256:${"a".repeat(64)}`,
    });

    const rollback = await rollbackAppImage(
      "app-id",
      {
        registryName: "chase-sets",
        repository: "chase-sets-platform",
        digest: "sha256:" + "d".repeat(64),
      },
      {
        repository: "chase-sets-platform",
        commandJson: async (command, args) => {
          calls.push([command, args]);
          return [app];
        },
        commandOutput: async (command, args, options) => {
          calls.push([command, args, JSON.parse(options.input)]);
          return "";
        },
      },
    );

    expect(rollback).toEqual({
      appId: "app-id",
      imageRef: `registry.digitalocean.com/chase-sets/chase-sets-platform@sha256:${"d".repeat(64)}`,
    });
    expect(calls).toEqual([
      ["doctl", ["apps", "get", "app-id", "--output", "json"]],
      ["doctl", ["apps", "get", "app-id", "--output", "json"]],
      [
        "doctl",
        ["apps", "update", "app-id", "--spec", "-", "--wait"],
        {
          name: "production-platform",
          services: [
            {
              name: "public-web",
              image: {
                registry_type: "DOCR",
                repository: "chase-sets-platform",
                digest: "sha256:" + "d".repeat(64),
              },
            },
          ],
        },
      ],
    ]);
  });

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

  it("classifies durable database destructive Terraform changes separately", () => {
    expect(
      durableDatabaseDestructiveResourceChanges(
        planFor([
          resourceChange("digitalocean_app.platform", ["delete", "create"]),
          resourceChange("digitalocean_database_cluster.postgres", ["delete", "create"]),
          resourceChange('digitalocean_database_db.contexts["checkout"]', ["delete"]),
          resourceChange('digitalocean_database_user.contexts["checkout"]', ["delete"]),
          resourceChange('digitalocean_database_user.wake_listeners["checkout"]', ["delete"]),
          resourceChange('digitalocean_database_connection_pool.contexts["checkout"]', ["delete"]),
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
        address: 'digitalocean_database_db.contexts["checkout"]',
        type: "digitalocean_database_db",
        name: 'contexts["checkout"]',
        actions: ["delete"],
      },
      {
        address: 'digitalocean_database_user.contexts["checkout"]',
        type: "digitalocean_database_user",
        name: 'contexts["checkout"]',
        actions: ["delete"],
      },
      {
        address: 'digitalocean_database_user.wake_listeners["checkout"]',
        type: "digitalocean_database_user",
        name: 'wake_listeners["checkout"]',
        actions: ["delete"],
      },
      {
        address: 'digitalocean_database_connection_pool.contexts["checkout"]',
        type: "digitalocean_database_connection_pool",
        name: 'contexts["checkout"]',
        actions: ["delete"],
      },
    ]);
  });

  it("blocks durable database deletes with profile and restore guidance", () => {
    const plan = planFor([resourceChange('digitalocean_database_db.contexts["checkout"]', ["delete"])]);

    expect(() => assertNoDestructiveChanges(plan)).toThrow(
      /durable database resources without an audited resource-scoped emergency override[\s\S]*profile gating or retained context provisioning[\s\S]*PITR\/restore/,
    );
  });

  it("does not let a broad destructive override bypass durable database deletes", () => {
    const plan = planFor([resourceChange("digitalocean_database_cluster.postgres", ["delete", "create"])]);

    expect(() => assertNoDestructiveChanges(plan, { allowDestructiveChanges: true })).toThrow(
      "durable database resources without an audited resource-scoped emergency override",
    );
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

  it("parses resource-scoped production destructive-change approval markers", () => {
    expect(
      approvedDestructiveChangeAddressesFromText(`
# Production Destructive Change Approval

Approval state: active
Plan fingerprint: sha256:${"a".repeat(64)}

## Approved Destructive Changes

- \`digitalocean_database_db.contexts["experience"]\`
- \`digitalocean_database_user.contexts["experience"]\`

## Evidence

The resources are retired by a reviewed context merge.
`),
    ).toEqual(['digitalocean_database_db.contexts["experience"]', 'digitalocean_database_user.contexts["experience"]']);
  });

  it("blocks destructive Terraform changes not named by a resource-scoped marker", () => {
    const plan = planFor([
      resourceChange('digitalocean_database_db.contexts["experience"]', ["delete"]),
      resourceChange('digitalocean_database_db.contexts["checkout"]', ["delete"]),
    ]);

    expect(() =>
      assertNoDestructiveChanges(plan, {
        allowedDestructiveAddresses: ['digitalocean_database_db.contexts["experience"]'],
      }),
    ).toThrow("destructive changes not covered by the reviewed override marker");
  });

  it("blocks active destructive approvals that do not match the current plan fingerprint", () => {
    const plan = planFor([resourceChange('digitalocean_database_db.contexts["experience"]', ["delete"])]);

    expect(() =>
      assertNoDestructiveChanges(plan, {
        destructiveChangeApproval: {
          state: "active",
          planFingerprint: `sha256:${"b".repeat(64)}`,
          addresses: ['digitalocean_database_db.contexts["experience"]'],
        },
      }),
    ).toThrow("approval plan fingerprint does not match the current Terraform plan");
  });

  it("allows active destructive approvals only when resources and plan fingerprint match", () => {
    const plan = planFor([resourceChange('digitalocean_database_db.contexts["experience"]', ["delete"])]);
    const destructiveChanges = destructiveResourceChanges(plan);

    expect(
      assertNoDestructiveChanges(plan, {
        destructiveChangeApproval: {
          state: "active",
          planFingerprint: destructiveChangesApprovalFingerprint(destructiveChanges),
          addresses: ['digitalocean_database_db.contexts["experience"]'],
        },
      }),
    ).toEqual(destructiveChanges);
  });

  it("allows only destructive Terraform changes named by a resource-scoped marker", () => {
    const plan = planFor([
      resourceChange('digitalocean_database_db.contexts["experience"]', ["delete"]),
      resourceChange('digitalocean_database_user.contexts["experience"]', ["delete"]),
    ]);

    expect(
      assertNoDestructiveChanges(plan, {
        allowedDestructiveAddresses: [
          'digitalocean_database_db.contexts["experience"]',
          'digitalocean_database_user.contexts["experience"]',
        ],
      }),
    ).toEqual([
      {
        address: 'digitalocean_database_db.contexts["experience"]',
        type: "digitalocean_database_db",
        name: 'contexts["experience"]',
        actions: ["delete"],
      },
      {
        address: 'digitalocean_database_user.contexts["experience"]',
        type: "digitalocean_database_user",
        name: 'contexts["experience"]',
        actions: ["delete"],
      },
    ]);
  });

  it("pins the checked-in production destructive approval to Flip attempt 4's attachment release", () => {
    const approvalText = readFileSync(resolve(".github/deployment/production-destructive-change-approved.md"), "utf8");

    expect(approvedDestructiveChangeAddressesFromText(approvalText)).toEqual([
      'digitalocean_app.platform.domain["chasesets.com"]',
      'digitalocean_app.platform.domain["www.chasesets.com"]',
      'digitalocean_app.platform.domain["admin.chasesets.com"]',
    ]);
    expect(approvalText).toContain("Approval state: active");
    expect(approvalText).toContain(
      "Plan fingerprint: sha256:692539e7511fb7339e40c58120900ed89799367ab9e9220520f3c7d2d231eaa1",
    );
    expect(approvalText).toContain("#5574 + Todd 2026-07-18 standing retry grant");
    expect(approvalText).not.toContain('digitalocean_database_db.contexts["experience"]');
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

  it("summarizes Terraform plan change counts and changed resource addresses", () => {
    const summary = terraformPlanSummary(
      planFor([
        resourceChange("digitalocean_app.platform", ["update"]),
        resourceChange('digitalocean_database_db.contexts["checkout"]', ["create"]),
        resourceChange("digitalocean_record.old", ["delete"]),
        resourceChange("digitalocean_database_cluster.postgres", ["delete", "create"]),
        resourceChange("terraform_data.noop", ["no-op"]),
        resourceChange("data.digitalocean_app.platform", ["read"]),
      ]),
      { maxResources: 3 },
    );

    expect(summary).toEqual({
      add: 2,
      change: 1,
      destroy: 2,
      resources: [
        { address: "digitalocean_app.platform", actions: ["update"] },
        { address: "digitalocean_database_cluster.postgres", actions: ["delete", "create"] },
        { address: 'digitalocean_database_db.contexts["checkout"]', actions: ["create"] },
      ],
      omittedResources: 1,
    });
  });

  it("renders a compact Terraform plan Markdown summary", () => {
    expect(
      renderTerraformPlanSummaryMarkdown(planFor([resourceChange("digitalocean_app.platform", ["update"])]), {
        title: "Production Terraform plan",
      }),
    ).toBe(
      [
        "### Production Terraform plan",
        "",
        "- Add: 0",
        "- Change: 1",
        "- Destroy: 0",
        "",
        "Changed resources:",
        "- `digitalocean_app.platform` (update)",
        "",
      ].join("\n") + "\n",
    );
  });

  it("reads the production Postgres cluster id from Terraform JSON plan output", async () => {
    const clusterId = await readPostgresClusterIdFromPlan("tfplan", {
      commandOutput: async (command, args) => {
        expect(command).toBe("terraform");
        expect(args).toEqual(["show", "-json", "tfplan"]);
        return JSON.stringify(
          planFor([
            {
              type: "digitalocean_database_cluster",
              name: "postgres",
              change: {
                after: {
                  id: "d5e498f1-7a22-4108-ac84-008e51c0f6df",
                },
              },
            },
          ]),
        );
      },
    });

    expect(clusterId).toBe("d5e498f1-7a22-4108-ac84-008e51c0f6df");
  });

  it("falls back to planned and prior state resources for the production Postgres cluster id", () => {
    expect(
      postgresClusterIdFromPlan({
        planned_values: {
          root_module: {
            child_modules: [
              {
                resources: [
                  {
                    type: "digitalocean_database_cluster",
                    name: "postgres",
                    values: { id: "planned-cluster-id" },
                  },
                ],
              },
            ],
          },
        },
      }),
    ).toBe("planned-cluster-id");

    expect(
      postgresClusterIdFromPlan({
        resource_changes: [
          {
            type: "digitalocean_database_cluster",
            name: "postgres",
            change: { before: { id: "prior-change-cluster-id" }, after: {} },
          },
        ],
      }),
    ).toBe("prior-change-cluster-id");
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

  it("selects the latest deployment by update timestamp", () => {
    expect(
      latestDeployment([
        { id: "old", phase: "ACTIVE", updated_at: "2026-06-19T21:00:00Z" },
        { id: "failed", phase: "ERROR", updated_at: "2026-06-19T22:00:00Z" },
      ]),
    ).toEqual({
      id: "failed",
      phase: "ERROR",
      createdAt: "",
      updatedAt: "2026-06-19T22:00:00Z",
    });
  });

  it("selects the latest failed deployment for failure diagnostics", () => {
    expect(
      deploymentForDiagnostics([
        { id: "failed", phase: "ERROR", updated_at: "2026-06-19T22:00:00Z" },
        { id: "deploying", phase: "DEPLOYING", updated_at: "2026-06-19T22:01:00Z" },
      ]),
    ).toEqual({
      id: "failed",
      phase: "ERROR",
      createdAt: "",
      updatedAt: "2026-06-19T22:00:00Z",
    });
  });

  it("does not let a stale historical error displace the current deployment", () => {
    expect(
      deploymentForDiagnostics([
        { id: "historical-error", phase: "ERROR", updated_at: "2026-06-12T22:00:00Z" },
        { id: "current-run", phase: "ACTIVE", updated_at: "2026-06-19T22:01:00Z" },
      ]),
    ).toEqual({
      id: "current-run",
      phase: "ACTIVE",
      createdAt: "",
      updatedAt: "2026-06-19T22:01:00Z",
    });
  });

  it("parses compact DigitalOcean deployment summary rows", () => {
    expect(
      parseDeploymentSummaryRows(`
ID Phase Updated
old ACTIVE 2026-06-19T21:00:00Z
failed ERROR 2026-06-19T22:00:00Z
running BUILDING 2026-06-19T22:05:00Z
`),
    ).toEqual([
      { id: "old", phase: "ACTIVE", createdAt: "", updatedAt: "2026-06-19T21:00:00Z" },
      { id: "failed", phase: "ERROR", createdAt: "", updatedAt: "2026-06-19T22:00:00Z" },
      { id: "running", phase: "BUILDING", createdAt: "", updatedAt: "2026-06-19T22:05:00Z" },
    ]);
  });

  it("loads recent deployment summaries from the paginated DigitalOcean API", async () => {
    const summaries = await listDeploymentSummariesFromApi("app-id", {
      accessToken: "token",
      fetch: async (url, init) => {
        expect(String(url)).toBe("https://api.digitalocean.com/v2/apps/app-id/deployments?per_page=20&page=1");
        expect(init.headers.authorization).toBe("Bearer token");

        return new Response(
          JSON.stringify({
            deployments: [
              {
                id: "latest",
                phase: "ACTIVE",
                created_at: "2026-06-21T06:00:00Z",
                updated_at: "2026-06-21T06:02:00Z",
              },
              {
                id: "older",
                phase: "SUPERSEDED",
                created_at: "2026-06-21T05:00:00Z",
                updated_at: "2026-06-21T05:02:00Z",
              },
            ],
          }),
          { status: 200 },
        );
      },
    });

    expect(summaries).toEqual([
      {
        id: "latest",
        phase: "ACTIVE",
        createdAt: "2026-06-21T06:00:00Z",
        updatedAt: "2026-06-21T06:02:00Z",
      },
      {
        id: "older",
        phase: "SUPERSEDED",
        createdAt: "2026-06-21T05:00:00Z",
        updatedAt: "2026-06-21T05:02:00Z",
      },
    ]);
  });

  it("collects component names from an App Platform spec", () => {
    expect(
      deploymentComponentNames({
        spec: {
          jobs: [{ name: "platform-bootstrap" }],
          services: [{ name: "platform-api" }],
          workers: [{ name: "platform-worker" }, { name: "platform-worker" }],
          static_sites: [{ name: "admin-shell" }],
        },
      }),
    ).toEqual(["platform-bootstrap", "platform-api", "platform-worker", "admin-shell"]);
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
    const responses = ["first BUILDING 2026-06-19T22:00:00Z\n", "first ACTIVE 2026-06-19T22:01:00Z\n"];
    let sleeps = 0;

    await waitForDeployments("app-id", {
      commandOutput: async (command, args) => {
        expect(command).toBe("doctl");
        expect(args).toEqual(["apps", "list-deployments", "app-id", "--format", "ID,Phase,Updated", "--no-header"]);
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

  it("uses the DigitalOcean API deployment summary when a token is available", async () => {
    let fetches = 0;
    let sleeps = 0;

    await waitForDeployments("app-id", {
      accessToken: "token",
      fetch: async () => {
        fetches += 1;

        return new Response(
          JSON.stringify({
            deployments: [{ id: "latest", phase: "ACTIVE", updated_at: "2026-06-21T06:02:00Z" }],
          }),
          { status: 200 },
        );
      },
      sleep: async () => {
        sleeps += 1;
      },
    });

    expect(fetches).toBe(1);
    expect(sleeps).toBe(0);
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
      commandOutput: async () => {
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
        commandOutput: async () => "stuck BUILDING 2026-06-19T22:00:00Z\n",
        now: () => timestamps.shift() ?? 2_000,
        timeoutSeconds: 1,
        sleep: async () => {},
      }),
    ).rejects.toThrow("stuck: BUILDING");
  });

  it("collects deployment diagnostics and tails selected component logs", async () => {
    const calls = [];
    const logs = [];
    const warnings = [];

    const result = await collectDeploymentDiagnostics("app-id", {
      componentNames: ["platform-bootstrap"],
      logTypes: ["deploy"],
      tailLines: 50,
      commandJson: async (command, args) => {
        calls.push([command, args]);
        if (args[1] === "get-deployment") {
          return [
            {
              progress: {
                steps: [
                  {
                    name: "platform-bootstrap",
                    status: "ERROR",
                    reason: { code: "DeployContainerExitNonZero" },
                  },
                ],
              },
            },
          ];
        }
        throw new Error(`Unexpected JSON command: ${args.join(" ")}`);
      },
      commandOutput: async (command, args, options = {}) => {
        calls.push([command, args, options]);
        if (args[1] === "list-deployments") {
          return "old ACTIVE 2026-06-19T21:00:00Z\nfailed ERROR 2026-06-19T22:00:00Z\n";
        }
        return "Platform API bootstrap failed.\nCatalog integration seed conflict.\n";
      },
      log: (message) => logs.push(message),
      warn: (message) => warnings.push(message),
    });

    expect(result).toEqual({
      deploymentId: "failed",
      logs: [
        {
          componentName: "platform-bootstrap",
          logType: "deploy",
          ok: true,
          output: "Platform API bootstrap failed.\nCatalog integration seed conflict.\n",
        },
      ],
    });
    expect(warnings).toEqual([]);
    expect(calls).toEqual([
      ["doctl", ["apps", "list-deployments", "app-id", "--format", "ID,Phase,Updated", "--no-header"], {}],
      ["doctl", ["apps", "get-deployment", "app-id", "failed", "--output", "json"]],
      [
        "doctl",
        [
          "apps",
          "logs",
          "app-id",
          "platform-bootstrap",
          "--deployment",
          "failed",
          "--type",
          "deploy",
          "--tail",
          "50",
          "--no-prefix",
        ],
        { timeoutMs: 30_000 },
      ],
    ]);
    expect(logs.join("\n")).toContain("platform-bootstrap: ERROR - DeployContainerExitNonZero");
    expect(logs.join("\n")).toContain("Catalog integration seed conflict.");
  });

  it("bounds stalled deployment log diagnostics and reports the failed log source", async () => {
    const warnings = [];

    const result = await collectDeploymentDiagnostics("app-id", {
      componentNames: ["platform-worker"],
      logTypes: ["run"],
      deploymentId: "failed-deployment",
      commandJson: async () => [],
      commandOutput: async (_command, args, options = {}) => {
        expect(args[1]).toBe("logs");
        expect(options.timeoutMs).toBe(125);
        const error = new Error("Command failed: doctl apps logs timed out");
        error.signal = "SIGTERM";
        throw error;
      },
      commandTimeoutMs: 125,
      log: () => {},
      warn: (message) => warnings.push(message),
    });

    expect(result).toEqual({
      deploymentId: "failed-deployment",
      logs: [
        {
          componentName: "platform-worker",
          logType: "run",
          ok: false,
          error: expect.stringContaining("timed out"),
        },
      ],
    });
    expect(warnings).toEqual([expect.stringContaining("Unable to load platform-worker run logs")]);
  });

  it("classifies failed bootstrap diagnostics and redacts secret-shaped log values", () => {
    const record = buildDeploymentDiagnosticsRecord({
      appId: "app-id",
      deploymentId: "failed-deployment",
      deploymentPhase: "ERROR",
      componentNames: ["platform-bootstrap"],
      logTypes: ["deploy"],
      steps: [
        {
          name: "platform-bootstrap token=step-name-secret",
          componentName: "platform-bootstrap",
          status: "ERROR",
          reason: {
            code: "DeployContainerExitNonZero token=step-reason-secret",
            message: "sk_live_step_message https://user:url-secret@provider.example Pwd=step-password",
          },
        },
      ],
      logs: [
        {
          componentName: "platform-bootstrap",
          logType: "deploy",
          ok: true,
          output: "password=do-not-publish token=gho_secret postgres://user:password@db.example/app",
        },
      ],
    });

    expect(record).toMatchObject({
      schemaVersion: "digitalocean-app-deployment-diagnostics/v2",
      appId: "app-id",
      deploymentId: "failed-deployment",
      bootstrapFailure: true,
      rootCauseCode: "app-platform-bootstrap-runtime",
      affectedComponent: "platform-bootstrap",
      steps: [
        {
          name: "platform-bootstrap token=[REDACTED]",
          componentName: "platform-bootstrap",
          phase: "ERROR",
          reasonCode: "DeployContainerExitNonZero token=[REDACTED]",
          message: "[REDACTED_TOKEN] https://[REDACTED]@provider.example Pwd=[REDACTED]",
        },
      ],
    });
    expect(record.logs[0].output).not.toContain("do-not-publish");
    expect(record.logs[0].output).not.toContain("gho_secret");
    expect(record.logs[0].output).not.toContain("user:password");
    for (const secret of [
      "step-name-secret",
      "step-reason-secret",
      "url-secret",
      "step-password",
      "sk_live_step_message",
    ]) {
      expect(JSON.stringify(record.steps)).not.toContain(secret);
    }
  });

  it("recursively normalizes nested deployment progress and classifies run 29333994354", () => {
    const fixture = JSON.parse(
      readFileSync(resolve("scripts/fixtures/platform-deploy-incidents/app-platform-bootstrap-config.json"), "utf8"),
    );
    const steps = normalizeDeploymentProgressSteps(fixture.input.steps);
    const record = buildDeploymentDiagnosticsRecord({
      appId: "app-id",
      deploymentId: "run-29333994354",
      deploymentPhase: "ERROR",
      componentNames: ["platform-bootstrap"],
      logTypes: ["deploy"],
      steps,
      logs: fixture.input.logs,
    });

    expect(steps).toEqual([
      {
        name: "deploy",
        componentName: "unknown",
        phase: "ERROR",
        reasonCode: "",
        message: "",
      },
      {
        name: "platform-bootstrap",
        componentName: "platform-bootstrap",
        phase: "ERROR",
        reasonCode: "DeployContainerExitNonZero",
        message: "",
      },
    ]);
    expect(record).toMatchObject({
      bootstrapFailure: true,
      rootCauseCode: "app-platform-bootstrap-config",
      affectedComponent: "platform-bootstrap",
      phase: "app-platform-bootstrap",
    });
    expect(record.logs[0].output).not.toContain("fixture-secret");
  });

  it("parses deployment diagnostics details JSON from a failed doctl command stdout", async () => {
    const calls = [];
    const warnings = [];

    const result = await collectDeploymentDiagnostics("app-id", {
      componentNames: ["platform-bootstrap"],
      logTypes: ["deploy"],
      commandOutput: async (command, args) => {
        calls.push([command, args]);

        if (args[1] === "list-deployments") {
          return "failed ERROR 2026-06-19T22:00:00Z\n";
        }

        if (args[1] === "get-deployment") {
          const error = new Error("doctl reported a nonzero exit despite JSON output");
          error.stdout = JSON.stringify([
            {
              progress: {
                steps: [
                  { name: "platform-bootstrap", status: "ERROR", reason: { code: "DeployContainerExitNonZero" } },
                ],
              },
            },
          ]);
          throw error;
        }

        if (args[1] === "logs") {
          return "bootstrap failure details\n";
        }

        throw new Error(`Unexpected command: ${args.join(" ")}`);
      },
      log: () => {},
      warn: (message) => warnings.push(message),
    });

    expect(result).toEqual({
      deploymentId: "failed",
      logs: [
        { componentName: "platform-bootstrap", logType: "deploy", ok: true, output: "bootstrap failure details\n" },
      ],
    });
    expect(warnings).toEqual([]);
    expect(calls.map(([, args]) => args[1])).toEqual(["list-deployments", "get-deployment", "logs"]);
  });

  it("keeps diagnostics warnings bounded when provider output is noisy", async () => {
    const warnings = [];
    const noisyMessage = "x".repeat(8_000);

    const result = await collectDeploymentDiagnostics("app-id", {
      componentNames: ["platform-bootstrap"],
      logTypes: ["deploy"],
      deploymentId: "selected-deployment",
      commandJson: async () => {
        throw new Error(noisyMessage);
      },
      commandOutput: async () => {
        throw new Error(noisyMessage);
      },
      log: () => {},
      warn: (message) => warnings.push(message),
    });

    expect(result).toEqual({
      deploymentId: "selected-deployment",
      logs: [
        {
          componentName: "platform-bootstrap",
          logType: "deploy",
          ok: false,
          error: expect.stringContaining("truncated 6000 characters"),
        },
      ],
    });
    expect(warnings).toHaveLength(2);
    expect(warnings.every((warning) => warning.length < 2_200)).toBe(true);
    expect(warnings.join("\n")).toContain("truncated 6000 characters");
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
