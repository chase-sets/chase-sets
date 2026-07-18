import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  appPlatformChanges,
  approvedDestructiveChangeAddressesFromText,
  assertNoDestructiveChanges,
  assertProductionServingModeReplacement,
  destructiveChangesApprovalFingerprint,
  destructiveResourceChanges,
  durableDatabaseDestructiveResourceChanges,
  planAppChanged,
  postgresClusterIdFromPlan,
  renderTerraformPlanSummaryMarkdown,
  terraformPlanSummary,
} from "./terraform-plan-inspection.mjs";

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

describe("Terraform plan inspection", () => {
  it("pins the App Platform domain releases and DOKS record creates in the forward fixture", () => {
    const plan = JSON.parse(
      readFileSync(
        resolve("scripts/fixtures/terraform-plans/production-platform-app-platform-state-to-doks.json"),
        "utf8",
      ),
    );

    expect(assertProductionServingModeReplacement(plan, { from: "app-platform", to: "doks" })).toEqual([
      'digitalocean_app.platform.domain["admin.chasesets.com"]',
      'digitalocean_app.platform.domain["chasesets.com"]',
      'digitalocean_app.platform.domain["www.chasesets.com"]',
    ]);
    const destructiveChanges = destructiveResourceChanges(plan);
    expect(destructiveChanges).toEqual([
      {
        address: 'digitalocean_app.platform.domain["chasesets.com"]',
        type: "digitalocean_app_domain_attachment",
        name: "chasesets.com",
        actions: ["delete"],
      },
      {
        address: 'digitalocean_app.platform.domain["www.chasesets.com"]',
        type: "digitalocean_app_domain_attachment",
        name: "www.chasesets.com",
        actions: ["delete"],
      },
      {
        address: 'digitalocean_app.platform.domain["admin.chasesets.com"]',
        type: "digitalocean_app_domain_attachment",
        name: "admin.chasesets.com",
        actions: ["delete"],
      },
    ]);
    expect(destructiveChangesApprovalFingerprint(destructiveChanges)).toBe(
      "sha256:692539e7511fb7339e40c58120900ed89799367ab9e9220520f3c7d2d231eaa1",
    );
  });

  it("limits the App Platform rollback deletes in the DOKS-state fixture to the intended records", () => {
    const plan = JSON.parse(
      readFileSync(
        resolve("scripts/fixtures/terraform-plans/production-platform-doks-state-to-app-platform.json"),
        "utf8",
      ),
    );

    expect(assertProductionServingModeReplacement(plan, { from: "doks", to: "app-platform" })).toEqual([
      'digitalocean_app.platform.domain["app-platform.chasesets.com"]',
      'digitalocean_record.app_serving["admin"]',
      'digitalocean_record.app_serving["www"]',
      "digitalocean_record.doks_apex[0]",
    ]);

    const ambiguousPlan = structuredClone(plan);
    ambiguousPlan.resource_changes.push(resourceChange("digitalocean_project_resources.platform", ["delete"]));
    expect(() => assertProductionServingModeReplacement(ambiguousPlan, { from: "doks", to: "app-platform" })).toThrow(
      "plan deletes must be limited",
    );
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
          {
            address: "terraform_data.context_database_grants",
            type: "terraform_data",
            name: "context_database_grants",
            change: { actions: ["delete", "create"] },
          },
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

  it("keeps the checked-in production destructive approval in no-active-approval state", () => {
    const approvalText = readFileSync(resolve(".github/deployment/production-destructive-change-approved.md"), "utf8");

    expect(approvedDestructiveChangeAddressesFromText(approvalText)).toEqual([]);
    expect(approvalText).toContain("Approval state: no-active-approval");
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
        resourceChange("digitalocean_database_user.contexts", ["no-op"]),
        resourceChange("data.digitalocean_database_cluster.postgres", ["read"]),
      ]),
    );

    expect(summary).toEqual({
      add: 1,
      change: 1,
      destroy: 1,
      resources: [
        { address: "digitalocean_app.platform", actions: ["update"] },
        { address: 'digitalocean_database_db.contexts["checkout"]', actions: ["create"] },
        { address: "digitalocean_record.old", actions: ["delete"] },
      ],
      omittedResources: 0,
    });
  });

  it("renders Terraform plan summaries for workflow step summaries", () => {
    expect(
      renderTerraformPlanSummaryMarkdown(planFor([resourceChange("digitalocean_app.platform", ["update"])]), {
        title: "Production Terraform plan",
      }),
    ).toContain("### Production Terraform plan");
  });

  it("reads the managed Postgres cluster id from resource changes or plan values", () => {
    expect(
      postgresClusterIdFromPlan({
        resource_changes: [
          {
            type: "digitalocean_database_cluster",
            name: "postgres",
            change: { before: { id: "cluster-before" }, after: { id: "cluster-after" } },
          },
        ],
      }),
    ).toBe("cluster-after");
    expect(
      postgresClusterIdFromPlan({
        planned_values: {
          root_module: {
            child_modules: [
              {
                resources: [{ type: "digitalocean_database_cluster", name: "postgres", values: { id: "cluster" } }],
              },
            ],
          },
        },
      }),
    ).toBe("cluster");
  });
});
