import { describe, expect, it } from "vitest";
import {
  DIGITALOCEAN_PREVIEW_CLEANUP_SWEEP_VERSION,
  PREVIEW_DATABASE_DELETE_CONFIRMATION,
  buildPreviewDatabaseClusterInventory,
  cleanupLeakedPreviewDatabaseClusters,
  cleanupMatrixForTargets,
  classifyDatabaseCluster,
  combinePreviewCleanupCandidates,
  discoverPreviewCleanupTargets,
  importPreviewDatabaseClusterIntoTerraformState,
  previewDatabaseClusterNameForPrNumber,
  previewPrNumberFromDatabaseClusterName,
  previewPrNumberFromStateKey,
  selectPreviewDatabaseClusterTargets,
  selectPreviewStateTargets,
} from "./digitalocean-preview-cleanup-sweep.mjs";

describe("digitalocean-preview-cleanup-sweep", () => {
  it("extracts preview PR numbers only from platform preview state keys", () => {
    expect(previewPrNumberFromStateKey("platform/previews/pr-123.tfstate")).toBe(123);
    expect(previewPrNumberFromStateKey("platform/previews/pr-123.backup")).toBeNull();
    expect(previewPrNumberFromStateKey("landing/staging.tfstate")).toBeNull();
  });

  it("extracts preview PR numbers from current and legacy database cluster names", () => {
    expect(previewDatabaseClusterNameForPrNumber(123)).toBe("chase-sets-pr-123-postgres");
    expect(previewPrNumberFromDatabaseClusterName("chase-sets-pr-123-postgres")).toBe(123);
    expect(previewPrNumberFromDatabaseClusterName("preview-pr-456-postgres")).toBe(456);
    expect(previewPrNumberFromDatabaseClusterName("preview-789-postgres")).toBe(789);
    expect(previewPrNumberFromDatabaseClusterName("chase-sets-staging-postgres")).toBeNull();
  });

  it("classifies protected, restore-point, and preview database clusters", () => {
    expect(classifyDatabaseCluster({ name: "chase-sets-postgres", tags: ["production"] })).toEqual({
      classification: "production",
      prNumber: null,
    });
    expect(classifyDatabaseCluster({ name: "chase-sets-staging-postgres", tags: ["staging"] })).toEqual({
      classification: "staging",
      prNumber: null,
    });
    expect(classifyDatabaseCluster({ name: "cs-prod-rp-20260707", tags: ["production"] })).toEqual({
      classification: "cs-prod-rp-*",
      prNumber: null,
    });
    expect(classifyDatabaseCluster({ name: "chase-sets-pr-12-postgres", tags: ["preview"] })).toEqual({
      classification: "preview-*",
      prNumber: 12,
    });
  });

  it("selects deterministic preview state targets from Spaces objects", () => {
    expect(
      selectPreviewStateTargets([
        { Key: "platform/previews/pr-12.tfstate" },
        { Key: "platform/previews/pr-2.tfstate" },
        { Key: "platform/previews/pr-12.tfstate" },
        { Key: "state-archive/2026-07-01/platform/previews/pr-1.tfstate" },
      ]),
    ).toEqual([
      { prNumber: 2, stateKey: "platform/previews/pr-2.tfstate" },
      { prNumber: 12, stateKey: "platform/previews/pr-12.tfstate" },
    ]);
  });

  it("selects preview database cluster targets without selecting protected clusters", () => {
    expect(
      selectPreviewDatabaseClusterTargets([
        { id: "staging", name: "chase-sets-staging-postgres", tags: ["staging"] },
        { id: "prod", name: "chase-sets-postgres", tags: ["production"] },
        { id: "rp", name: "cs-prod-rp-20260707", tags: ["production"] },
        { id: "preview", name: "chase-sets-pr-24-postgres", tags: ["preview"] },
        { id: "legacy", name: "preview-pr-25-postgres", tags: ["preview"] },
      ]),
    ).toEqual([
      { prNumber: 24, clusterId: "preview", clusterName: "chase-sets-pr-24-postgres", classification: "preview-*" },
      { prNumber: 25, clusterId: "legacy", clusterName: "preview-pr-25-postgres", classification: "preview-*" },
    ]);
  });

  it("combines state-backed and live database cleanup candidates by PR", () => {
    expect(
      combinePreviewCleanupCandidates(
        [{ prNumber: 7, stateKey: "platform/previews/pr-7.tfstate" }],
        [
          { prNumber: 7, clusterId: "db-7", clusterName: "chase-sets-pr-7-postgres" },
          { prNumber: 8, clusterId: "db-8", clusterName: "chase-sets-pr-8-postgres" },
        ],
      ),
    ).toEqual([
      {
        prNumber: 7,
        stateKey: "platform/previews/pr-7.tfstate",
        databaseClusters: [{ clusterId: "db-7", clusterName: "chase-sets-pr-7-postgres" }],
      },
      {
        prNumber: 8,
        stateKey: null,
        databaseClusters: [{ clusterId: "db-8", clusterName: "chase-sets-pr-8-postgres" }],
      },
    ]);
  });

  it("builds a cleanup matrix using trusted checkout, image refs, and expected database cluster names", () => {
    expect(
      cleanupMatrixForTargets([{ prNumber: 7, stateKey: "platform/previews/pr-7.tfstate", databaseClusters: [] }], {
        checkoutRef: "main",
        imageSha: "abc123",
      }),
    ).toEqual({
      include: [
        {
          pr_number: 7,
          checkout_ref: "main",
          image_sha: "abc123",
          expected_database_cluster_name: "chase-sets-pr-7-postgres",
        },
      ],
    });
  });

  it("discovers closed pull requests from preview state and live database clusters", async () => {
    const result = await discoverPreviewCleanupTargets(
      {
        bucket: "chase-sets-terraform-state",
        endpointUrl: "https://nyc3.digitaloceanspaces.com",
        prefix: "platform/previews",
        repository: "chase-sets/chase-sets",
        githubToken: "token",
        checkoutRef: "main",
        imageSha: "abc123",
        checkedAt: "2026-07-04T12:00:00.000Z",
      },
      {
        awsJson: async () => ({
          Contents: [
            { Key: "platform/previews/pr-10.tfstate" },
            { Key: "platform/previews/pr-11.tfstate" },
            { Key: "platform/previews/pr-12.tfstate" },
          ],
        }),
        listDatabaseClusters: async () => [
          { id: "db-12", name: "chase-sets-pr-12-postgres", tags: ["preview"] },
          { id: "db-13", name: "chase-sets-pr-13-postgres", tags: ["preview"] },
        ],
        fetchPullRequest: async (prNumber) => ({
          state: prNumber === 11 ? "open" : "closed",
          merged: prNumber === 10,
        }),
      },
    );

    expect(result.record).toMatchObject({
      schemaVersion: DIGITALOCEAN_PREVIEW_CLEANUP_SWEEP_VERSION,
      result: "success",
      targets: [
        { prNumber: 10, pullRequestState: "closed", selected: true },
        { prNumber: 12, pullRequestState: "closed", selected: true },
        { prNumber: 13, pullRequestState: "closed", selected: true },
      ],
      errors: [],
    });
    expect(result.matrix).toEqual({
      include: [
        {
          pr_number: 10,
          checkout_ref: "main",
          image_sha: "abc123",
          expected_database_cluster_name: "chase-sets-pr-10-postgres",
        },
        {
          pr_number: 12,
          checkout_ref: "main",
          image_sha: "abc123",
          expected_database_cluster_name: "chase-sets-pr-12-postgres",
        },
        {
          pr_number: 13,
          checkout_ref: "main",
          image_sha: "abc123",
          expected_database_cluster_name: "chase-sets-pr-13-postgres",
        },
      ],
    });
  });

  it("builds a read-only inventory and marks closed or merged preview clusters leaked", async () => {
    const record = await buildPreviewDatabaseClusterInventory(
      {
        repository: "chase-sets/chase-sets",
        githubToken: "token",
        checkedAt: "2026-07-04T12:00:00.000Z",
      },
      {
        listDatabaseClusters: async () => [
          { id: "open", name: "chase-sets-pr-20-postgres", tags: ["preview"] },
          { id: "merged", name: "chase-sets-pr-21-postgres", tags: ["preview"] },
          { id: "closed", name: "preview-pr-22-postgres", tags: ["preview"] },
          { id: "prod", name: "chase-sets-postgres", tags: ["production"] },
        ],
        fetchPullRequest: async (prNumber) => ({
          state: prNumber === 20 ? "open" : "closed",
          merged: prNumber === 21,
        }),
      },
    );

    expect(record.result).toBe("warning");
    expect(record.clusters).toEqual([
      expect.objectContaining({
        clusterName: "chase-sets-pr-20-postgres",
        pullRequestState: "open",
        leaked: false,
        previewManagedClusterViolation: true,
        conclusion: "preview-managed-cluster-violation",
      }),
      expect.objectContaining({
        clusterName: "chase-sets-pr-21-postgres",
        pullRequestState: "merged",
        leaked: true,
        previewManagedClusterViolation: true,
        conclusion: "leaked-preview-managed-cluster-violation",
      }),
      expect.objectContaining({
        clusterName: "preview-pr-22-postgres",
        pullRequestState: "closed",
        leaked: true,
        previewManagedClusterViolation: true,
        conclusion: "leaked-preview-managed-cluster-violation",
      }),
      expect.objectContaining({ clusterName: "chase-sets-postgres", classification: "production", leaked: false }),
    ]);
  });

  it("defaults database cleanup to dry-run and requires confirmation before delete mode", async () => {
    const dependencies = {
      listDatabaseClusters: async () => [{ id: "leaked", name: "chase-sets-pr-30-postgres", tags: ["preview"] }],
      fetchPullRequest: async () => ({ state: "closed", merged: true }),
    };

    const dryRun = await cleanupLeakedPreviewDatabaseClusters(
      {
        repository: "chase-sets/chase-sets",
        githubToken: "token",
        checkedAt: "2026-07-04T12:00:00.000Z",
        delete: false,
      },
      dependencies,
    );
    expect(dryRun.mode).toBe("dry-run");
    expect(dryRun.selectedDeletionClusters).toHaveLength(1);
    expect(dryRun.deletedClusters).toEqual([]);

    const refused = await cleanupLeakedPreviewDatabaseClusters(
      {
        repository: "chase-sets/chase-sets",
        githubToken: "token",
        checkedAt: "2026-07-04T12:00:00.000Z",
        delete: true,
        confirm: "delete everything",
      },
      dependencies,
    );
    expect(refused.result).toBe("failure");
    expect(refused.errors).toContain(`Delete mode requires --confirm "${PREVIEW_DATABASE_DELETE_CONFIRMATION}".`);
  });

  it("deletes leaked preview clusters only after explicit confirmation", async () => {
    const deleted = [];
    const record = await cleanupLeakedPreviewDatabaseClusters(
      {
        repository: "chase-sets/chase-sets",
        githubToken: "token",
        checkedAt: "2026-07-04T12:00:00.000Z",
        delete: true,
        confirm: PREVIEW_DATABASE_DELETE_CONFIRMATION,
      },
      {
        listDatabaseClusters: async () => [
          { id: "open", name: "chase-sets-pr-31-postgres", tags: ["preview"] },
          { id: "leaked", name: "chase-sets-pr-32-postgres", tags: ["preview"] },
        ],
        fetchPullRequest: async (prNumber) => ({
          state: prNumber === 31 ? "open" : "closed",
          merged: false,
        }),
        deleteDatabaseCluster: async (cluster) => {
          deleted.push(cluster.clusterId);
        },
      },
    );

    // Any surviving preview managed cluster (here the still-open PR 31) is a
    // policy violation because previews must use in-cluster Postgres, so the
    // sweep surfaces a warning even when it successfully deletes the leaked one.
    expect(record.result).toBe("warning");
    expect(deleted).toEqual(["leaked"]);
    expect(record.deletedClusters).toEqual([expect.objectContaining({ clusterId: "leaked" })]);
  });

  it("imports a live preview database cluster into Terraform state before destroy", async () => {
    const commands = [];
    const record = await importPreviewDatabaseClusterIntoTerraformState(
      {
        prNumber: 40,
        terraformDirectory: "infrastructure/digitalocean/platform",
        checkedAt: "2026-07-04T12:00:00.000Z",
      },
      {
        listDatabaseClusters: async () => [{ id: "db-40", name: "chase-sets-pr-40-postgres", tags: ["preview"] }],
        commandOutput: async (command, args) => {
          commands.push([command, args]);
          return args.includes("state") ? "" : "imported";
        },
      },
    );

    expect(record).toMatchObject({
      result: "success",
      action: "imported",
      selectedCluster: { clusterId: "db-40", clusterName: "chase-sets-pr-40-postgres" },
    });
    expect(commands).toEqual([
      ["terraform", ["-chdir=infrastructure/digitalocean/platform", "state", "list"]],
      [
        "terraform",
        ["-chdir=infrastructure/digitalocean/platform", "import", "digitalocean_database_cluster.postgres", "db-40"],
      ],
    ]);
  });

  it("skips Terraform import when the preview database cluster is already in state", async () => {
    const commands = [];
    const record = await importPreviewDatabaseClusterIntoTerraformState(
      {
        prNumber: 41,
        terraformDirectory: "infrastructure/digitalocean/platform",
        checkedAt: "2026-07-04T12:00:00.000Z",
      },
      {
        listDatabaseClusters: async () => [{ id: "db-41", name: "chase-sets-pr-41-postgres", tags: ["preview"] }],
        commandOutput: async (command, args) => {
          commands.push([command, args]);
          return "digitalocean_database_cluster.postgres\n";
        },
      },
    );

    expect(record.result).toBe("success");
    expect(record.action).toBe("already-managed");
    expect(commands).toEqual([["terraform", ["-chdir=infrastructure/digitalocean/platform", "state", "list"]]]);
  });
});
