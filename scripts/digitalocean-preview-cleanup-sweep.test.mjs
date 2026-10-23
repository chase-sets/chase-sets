import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  DIGITALOCEAN_PREVIEW_CLEANUP_SWEEP_VERSION,
  DIGITALOCEAN_PREVIEW_STATE_RETIREMENT_VERSION,
  IDLE_DRAFT_MAX_SELECTIONS,
  OPEN_PULL_REQUEST_MAX_PAGES,
  PLATFORM_PREVIEW_IDLE_DRAFTS_VERSION,
  PREVIEW_DATABASE_DELETE_CONFIRMATION,
  PREVIEW_SHARED_DNS_FQDN,
  applySharedPreviewDnsRecord,
  buildPreviewDatabaseClusterInventory,
  cleanupLeakedPreviewDatabaseClusters,
  cleanupMatrixForTargets,
  cleanupBatchesForTargets,
  cleanupMatrixForBatches,
  classifyDatabaseCluster,
  commandOutput,
  combinePreviewCleanupCandidates,
  destroyPreviewDnsRecords,
  discoverIdleDraftPreviews,
  discoverPreviewCleanupTargets,
  importPreviewDatabaseClusterIntoTerraformState,
  previewDatabaseClusterNameForPrNumber,
  previewPrNumberFromDatabaseClusterName,
  previewPrNumberFromDnsRecordFqdn,
  previewPrNumberFromNamespaceName,
  previewPrNumberFromStateKey,
  previewStateKeyForPrNumber,
  retirePreviewTerraformState,
  previewSharedDnsRecordPlan,
  resolvePreviewDnsZone,
  selectPreviewDatabaseClusterTargets,
  selectPreviewDnsRecordTargets,
  selectPreviewNamespaceTargets,
  selectPreviewStateTargets,
} from "./digitalocean-preview-cleanup-sweep.mjs";

describe("digitalocean-preview-cleanup-sweep", () => {
  const discoveryOptions = (overrides = {}) => ({
    bucket: "chase-sets-terraform-state",
    endpointUrl: "https://nyc3.digitaloceanspaces.com",
    prefix: "platform/previews",
    repository: "chase-sets/chase-sets",
    githubToken: "token",
    checkoutRef: "main",
    imageSha: "abc123",
    checkedAt: "2026-07-10T12:00:00.000Z",
    ...overrides,
  });

  it("extracts preview PR numbers only from platform preview state keys", () => {
    expect(previewPrNumberFromStateKey("platform/previews/pr-123.tfstate")).toBe(123);
    expect(previewPrNumberFromStateKey("platform/previews/pr-123.backup")).toBeNull();
    expect(previewPrNumberFromStateKey("landing/staging.tfstate")).toBeNull();
  });

  it("retires only an empty exact-key state after cleanup and live version guards", async () => {
    const commands = [];
    let headCount = 0;
    const record = await retirePreviewTerraformState(
      {
        prNumber: 17,
        bucket: "chase-sets-terraform-state",
        endpointUrl: "https://nyc3.digitaloceanspaces.com",
        terraformDirectory: "infrastructure/digitalocean/platform",
        checkedAt: "2026-07-04T12:00:00.000Z",
        cleanupSucceeded: true,
      },
      {
        commandOutput: async (command, args) => {
          commands.push([command, args]);
          if (command === "terraform" && args.includes("state")) return "";
          if (command === "terraform") return "initialized";
          if (args.includes("get-bucket-versioning")) return JSON.stringify({ Status: "Enabled" });
          if (args.includes("head-object")) {
            headCount += 1;
            return JSON.stringify({ VersionId: "version-17" });
          }
          return "deleted";
        },
      },
    );

    expect(record).toMatchObject({
      schemaVersion: DIGITALOCEAN_PREVIEW_STATE_RETIREMENT_VERSION,
      stateKey: "platform/previews/pr-17.tfstate",
      outcome: "retired",
      result: "success",
      stateList: { status: "success", empty: true, resourceCount: 0 },
      versioning: { status: "Enabled" },
      headBeforeStateList: { versionId: "version-17" },
      headBeforeDelete: { versionId: "version-17" },
    });
    expect(headCount).toBe(2);
    expect(commands.map(([command, args]) => `${command} ${args.join(" ")}`)).toEqual([
      expect.stringContaining("aws s3api head-object"),
      expect.stringContaining("terraform -chdir=infrastructure/digitalocean/platform init"),
      expect.stringContaining("terraform -chdir=infrastructure/digitalocean/platform state list"),
      expect.stringContaining("aws s3api get-bucket-versioning"),
      expect.stringContaining("aws s3api head-object"),
      expect.stringContaining("aws s3api delete-object"),
    ]);
    expect(commands[1][1]).toContain("-backend-config=key=platform/previews/pr-17.tfstate");
    expect(commands.at(-1)).toEqual([
      "aws",
      [
        "s3api",
        "delete-object",
        "--bucket",
        "chase-sets-terraform-state",
        "--key",
        "platform/previews/pr-17.tfstate",
        "--endpoint-url",
        "https://nyc3.digitaloceanspaces.com",
      ],
    ]);
    expect(previewStateKeyForPrNumber(17)).toBe("platform/previews/pr-17.tfstate");
  });

  it.each([
    ["non-empty state", "digitalocean_database_cluster.postgres\n", "enabled"],
    ["failed state list", new Error("state list failed"), "enabled"],
    ["suspended versioning", "", "suspended"],
    ["absent versioning", "", "absent"],
    ["malformed versioning", "", "malformed"],
  ])("leaves the state object when the %s guard refuses", async (_label, stateList, versioningMode) => {
    const commands = [];
    const record = await retirePreviewTerraformState(
      { prNumber: 18, cleanupSucceeded: true, checkedAt: "2026-07-04T12:00:00.000Z" },
      {
        commandOutput: async (command, args) => {
          commands.push([command, args]);
          if (command === "terraform" && args.includes("state")) {
            if (stateList instanceof Error) throw stateList;
            return stateList;
          }
          if (command === "terraform") return "initialized";
          if (args.includes("get-bucket-versioning")) {
            if (versioningMode === "malformed") return "not-json";
            if (versioningMode === "absent") return JSON.stringify({});
            return JSON.stringify({ Status: versioningMode === "enabled" ? "Enabled" : "Suspended" });
          }
          if (args.includes("head-object")) return JSON.stringify({ VersionId: "version-18" });
          return "deleted";
        },
      },
    );

    expect(record.result).toBe("failure");
    expect(record.outcome).toBe("refused");
    expect(commands.some(([, args]) => args.includes("delete-object"))).toBe(false);
  });

  it("refuses before state list when backend initialization fails and records the backend key", async () => {
    const commands = [];
    const record = await retirePreviewTerraformState(
      { prNumber: 21, cleanupSucceeded: true, checkedAt: "2026-07-04T12:00:00.000Z" },
      {
        commandOutput: async (command, args) => {
          commands.push([command, args]);
          if (command === "aws" && args.includes("head-object")) return JSON.stringify({ VersionId: "version-21" });
          if (command === "terraform") throw new Error("backend unavailable");
          return JSON.stringify({ Status: "Enabled" });
        },
      },
    );

    expect(record).toMatchObject({
      result: "failure",
      outcome: "refused",
      stateList: { status: "backend-init-failed" },
    });
    expect(record.errors[0]).toContain("backend unavailable");
    expect(commands).toHaveLength(2);
    expect(commands[1][1]).toContain("-backend-config=key=platform/previews/pr-21.tfstate");
    expect(commands.some(([, args]) => args.includes("state"))).toBe(false);
    expect(commands.some(([, args]) => args.includes("delete-object"))).toBe(false);
  });

  it("records a cleanup failure without touching the state object", async () => {
    const commands = [];
    const record = await retirePreviewTerraformState(
      { prNumber: 19, cleanupSucceeded: false },
      { commandOutput: async (...args) => commands.push(args) },
    );
    expect(record).toMatchObject({ result: "failure", outcome: "skipped-cleanup-failure", cleanupSucceeded: false });
    expect(commands).toEqual([]);
  });

  it.each(["changed VersionId", "failed versioning probe"])("refuses delete on %s", async (failureMode) => {
    const commands = [];
    let headCount = 0;
    const record = await retirePreviewTerraformState(
      { prNumber: 20, cleanupSucceeded: true, checkedAt: "2026-07-04T12:00:00.000Z" },
      {
        commandOutput: async (command, args) => {
          commands.push([command, args]);
          if (command === "terraform" && args.includes("state")) return "";
          if (command === "terraform") return "initialized";
          if (args.includes("get-bucket-versioning")) {
            if (failureMode === "failed versioning probe") throw new Error("versioning unavailable");
            return JSON.stringify({ Status: "Enabled" });
          }
          if (args.includes("head-object")) {
            headCount += 1;
            return JSON.stringify({ VersionId: headCount === 1 ? "version-before" : "version-after" });
          }
          return "deleted";
        },
      },
    );
    expect(record.result).toBe("failure");
    expect(commands.some(([, args]) => args.includes("delete-object"))).toBe(false);
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

  it("partitions 1,260 sorted cleanup targets into contiguous 32-target batches", () => {
    const targets = Array.from({ length: 1_260 }, (_, index) => ({ prNumber: 1_260 - index }));
    const batches = cleanupBatchesForTargets(targets);
    expect(batches).toHaveLength(40);
    expect(batches.flatMap((batch) => batch.targets.map((target) => target.prNumber))).toEqual(
      Array.from({ length: 1_260 }, (_, index) => index + 1),
    );
    expect(batches.slice(0, -1).every((batch) => batch.targets.length === 32)).toBe(true);
    expect(batches.at(-1).targets).toHaveLength(12);
    expect(cleanupMatrixForBatches(batches, { checkoutRef: "main", imageSha: "abc123" }).include).toHaveLength(40);
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
        listDomains: async () => [{ name: "chasesets.com" }],
        listDomainRecords: async () => [],
        listNamespaces: async () => [],
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
          batch_index: 0,
          batch_count: 1,
          checkout_ref: "main",
          image_sha: "abc123",
        },
      ],
    });
  });

  it("records an empty successful no-op without a destroy matrix", async () => {
    const result = await discoverPreviewCleanupTargets(discoveryOptions(), {
      awsJson: async () => ({ Contents: [] }),
      listDatabaseClusters: async () => [],
      listDomains: async () => [],
      listDomainRecords: async () => [],
      listNamespaces: async () => [],
    });
    expect(result.record).toMatchObject({
      result: "empty",
      closedTargetCount: 0,
      batchSize: 32,
      batchCount: 0,
      batches: [],
    });
    expect(result.matrix).toEqual({ include: [] });
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

  // #4857: ONE shared *.preview.chasesets.com wildcard record covers every
  // preview forever (single-label hosts: pr-<n>, pr-<n>-marketplace,
  // pr-<n>-admin), replacing the per-preview apex + *.pr-<n>.preview pair.
  it("plans the single shared preview wildcard record against the owning DNS zone", () => {
    expect(PREVIEW_SHARED_DNS_FQDN).toBe("*.preview.chasesets.com");

    // No delegated preview zone: the record lives directly in the chasesets.com
    // zone as `*.preview`.
    expect(previewSharedDnsRecordPlan({ registeredDomains: [{ name: "chasesets.com" }] })).toEqual({
      zone: "chasesets.com",
      target: null,
      record: { role: "wildcard", fqdn: "*.preview.chasesets.com", name: "*.preview" },
    });

    // A delegated preview.chasesets.com child zone shortens the record name.
    const delegated = previewSharedDnsRecordPlan({
      registeredDomains: [{ name: "chasesets.com" }, { name: "preview.chasesets.com" }],
    });
    expect(delegated.zone).toBe("preview.chasesets.com");
    expect(delegated.record.name).toBe("*");
  });

  it("resolves the longest registered zone that owns the preview host", () => {
    expect(resolvePreviewDnsZone([{ name: "chasesets.com" }], "pr-9.preview.chasesets.com")).toBe("chasesets.com");
    expect(resolvePreviewDnsZone([], "pr-9.preview.chasesets.com")).toBe("chasesets.com");
  });

  it("recognizes only per-preview apex and wildcard A record hosts", () => {
    expect(previewPrNumberFromDnsRecordFqdn("pr-4736.preview.chasesets.com")).toBe(4736);
    expect(previewPrNumberFromDnsRecordFqdn("*.pr-4736.preview.chasesets.com")).toBe(4736);
    expect(previewPrNumberFromDnsRecordFqdn("admin.pr-4736.preview.chasesets.com")).toBeNull();
    expect(previewPrNumberFromDnsRecordFqdn("assets.preview.chasesets.com")).toBeNull();
    expect(previewPrNumberFromDnsRecordFqdn("marketplace.staging.chasesets.com")).toBeNull();
  });

  it("groups leftover preview A records by PR from zone-relative record names", () => {
    expect(
      selectPreviewDnsRecordTargets(
        [
          { id: "apex-7", type: "A", name: "pr-7.preview", data: "159.203.145.65" },
          { id: "wild-7", type: "A", name: "*.pr-7.preview", data: "159.203.145.65" },
          { id: "assets", type: "CNAME", name: "assets.preview", data: "cdn" },
          { id: "staging", type: "A", name: "marketplace.staging", data: "1.2.3.4" },
        ],
        "chasesets.com",
      ),
    ).toEqual([
      {
        prNumber: 7,
        zone: "chasesets.com",
        records: [
          { id: "wild-7", name: "*.pr-7.preview", fqdn: "*.pr-7.preview.chasesets.com", data: "159.203.145.65" },
          { id: "apex-7", name: "pr-7.preview", fqdn: "pr-7.preview.chasesets.com", data: "159.203.145.65" },
        ],
      },
    ]);
  });

  it("treats leftover preview DNS records for closed PRs as cleanup targets", async () => {
    const result = await discoverPreviewCleanupTargets(
      {
        bucket: "chase-sets-terraform-state",
        endpointUrl: "https://nyc3.digitaloceanspaces.com",
        prefix: "platform/previews",
        repository: "chase-sets/chase-sets",
        githubToken: "token",
        checkoutRef: "main",
        imageSha: "abc123",
        checkedAt: "2026-07-09T12:00:00.000Z",
      },
      {
        awsJson: async () => ({ Contents: [] }),
        listDatabaseClusters: async () => [],
        listDomains: async () => [{ name: "chasesets.com" }],
        listDomainRecords: async () => [
          { id: "apex-50", type: "A", name: "pr-50.preview", data: "159.203.145.65" },
          { id: "wild-50", type: "A", name: "*.pr-50.preview", data: "159.203.145.65" },
        ],
        listNamespaces: async () => [],
        fetchPullRequest: async () => ({ state: "closed", merged: false }),
      },
    );

    expect(result.record.dnsRecordCandidates).toEqual([
      expect.objectContaining({ prNumber: 50, zone: "chasesets.com" }),
    ]);
    expect(result.record.targets).toEqual([
      expect.objectContaining({ prNumber: 50, pullRequestState: "closed", selected: true }),
    ]);
    expect(result.matrix.include).toEqual([expect.objectContaining({ batch_index: 0, batch_count: 1 })]);
  });

  it("extracts preview PR numbers from live chase-sets-pr-* namespace names only", () => {
    expect(previewPrNumberFromNamespaceName("chase-sets-pr-123")).toBe(123);
    expect(previewPrNumberFromNamespaceName("chase-sets-platform")).toBeNull();
    expect(previewPrNumberFromNamespaceName("chase-sets-pr-123-postgres")).toBeNull();
    expect(previewPrNumberFromNamespaceName("ingress-nginx")).toBeNull();
  });

  it("selects deduplicated, sorted preview namespace targets from a kubectl namespace list", () => {
    expect(
      selectPreviewNamespaceTargets([
        { metadata: { name: "chase-sets-pr-12" } },
        { metadata: { name: "chase-sets-pr-2" } },
        { metadata: { name: "chase-sets-pr-12" } },
        { metadata: { name: "chase-sets-platform" } },
        { metadata: { name: "kube-system" } },
      ]),
    ).toEqual([
      { prNumber: 2, namespace: "chase-sets-pr-2", creationTimestamp: null },
      { prNumber: 12, namespace: "chase-sets-pr-12", creationTimestamp: null },
    ]);
    expect(selectPreviewNamespaceTargets(["chase-sets-pr-7", "ingress-nginx"])).toEqual([
      { prNumber: 7, namespace: "chase-sets-pr-7", creationTimestamp: null },
    ]);
  });

  it("sweeps a leaked namespace for a merged PR that left no Terraform state, database cluster, or DNS record behind", async () => {
    const result = await discoverPreviewCleanupTargets(
      {
        bucket: "chase-sets-terraform-state",
        endpointUrl: "https://nyc3.digitaloceanspaces.com",
        prefix: "platform/previews",
        repository: "chase-sets/chase-sets",
        githubToken: "token",
        checkoutRef: "main",
        imageSha: "abc123",
        checkedAt: "2026-07-10T12:00:00.000Z",
      },
      {
        awsJson: async () => ({ Contents: [] }),
        listDatabaseClusters: async () => [],
        listDomains: async () => [{ name: "chasesets.com" }],
        listDomainRecords: async () => [],
        listNamespaces: async () => [
          { metadata: { name: "chase-sets-pr-4736" } }, // merged PR, straggler namespace
          { metadata: { name: "chase-sets-pr-4783" } }, // still-open PR
          { metadata: { name: "chase-sets-platform" } }, // not a preview namespace
        ],
        fetchPullRequest: async (prNumber) => ({
          state: prNumber === 4783 ? "open" : "closed",
          merged: prNumber === 4736,
        }),
      },
    );

    expect(result.record.namespaceCandidates).toEqual([
      { prNumber: 4736, namespace: "chase-sets-pr-4736", creationTimestamp: null },
      { prNumber: 4783, namespace: "chase-sets-pr-4783", creationTimestamp: null },
    ]);
    // The open PR's namespace must never be selected for teardown, even
    // though it was discovered as a live chase-sets-pr-* namespace.
    expect(result.record.targets).toEqual([
      expect.objectContaining({ prNumber: 4736, pullRequestState: "closed", merged: true, selected: true }),
    ]);
    expect(result.record.targets.some((target) => target.prNumber === 4783)).toBe(false);
    expect(result.matrix.include).toEqual([expect.objectContaining({ batch_index: 0, batch_count: 1 })]);
  });

  it("unwraps Kubernetes List items before closed-preview namespace selection", async () => {
    const result = await discoverPreviewCleanupTargets(discoveryOptions(), {
      awsJson: async () => ({ Contents: [] }),
      listDatabaseClusters: async () => [],
      listDomains: async () => [{ name: "chasesets.com" }],
      listDomainRecords: async () => [],
      listNamespaces: async () => ({
        apiVersion: "v1",
        kind: "List",
        items: [{ metadata: { name: "chase-sets-pr-4736" } }],
      }),
      fetchPullRequest: async () => ({ state: "closed", merged: true }),
    });

    expect(result.record.namespaceCandidates).toEqual([
      { prNumber: 4736, namespace: "chase-sets-pr-4736", creationTimestamp: null },
    ]);
    expect(result.record.targets).toEqual([
      expect.objectContaining({ prNumber: 4736, namespace: "chase-sets-pr-4736", pullRequestState: "closed" }),
    ]);
    expect(result.record.batches).toEqual([
      expect.objectContaining({
        index: 0,
        targets: [expect.objectContaining({ prNumber: 4736, namespace: "chase-sets-pr-4736" })],
      }),
    ]);
    expect(result.matrix.include).toEqual([expect.objectContaining({ batch_index: 0, batch_count: 1 })]);
  });

  it("accepts an empty Kubernetes List without warning", async () => {
    const result = await discoverPreviewCleanupTargets(discoveryOptions(), {
      awsJson: async () => ({ Contents: [] }),
      listDatabaseClusters: async () => [],
      listDomains: async () => [],
      listDomainRecords: async () => [],
      listNamespaces: async () => ({ apiVersion: "v1", kind: "List", items: [] }),
    });

    expect(result.record.namespaceCandidates).toEqual([]);
    expect(result.record.phases[3]).toMatchObject({ name: "namespace-list", count: 0, error: null });
    expect(result.record.warnings).toEqual([]);
  });

  it("fails closed when the namespace listing has no items array", async () => {
    const result = await discoverPreviewCleanupTargets(discoveryOptions(), {
      awsJson: async () => ({ Contents: [] }),
      listDatabaseClusters: async () => [],
      listDomains: async () => [],
      listDomainRecords: async () => [],
      listNamespaces: async () => ({ apiVersion: "v1", kind: "Status" }),
    });

    expect(result.record.namespaceCandidates).toEqual([]);
    expect(result.record.targets).toEqual([]);
    expect(result.matrix.include).toEqual([]);
    expect(result.record.phases[3]).toMatchObject({ name: "namespace-list", count: null });
    expect(result.record.phases[3].error).toBe("kubectl namespace listing returned no items array.");
    expect(result.record.warnings[0]).toBe(
      "Preview namespace listing failed; state, cluster, and DNS cleanup targets were still evaluated.",
    );
    expect(result.record.warnings[1]).toBe("kubectl namespace listing returned no items array.");
  });

  it("degrades to a warning instead of failing the whole sweep when namespace listing is unavailable", async () => {
    const result = await discoverPreviewCleanupTargets(
      {
        bucket: "chase-sets-terraform-state",
        endpointUrl: "https://nyc3.digitaloceanspaces.com",
        prefix: "platform/previews",
        repository: "chase-sets/chase-sets",
        githubToken: "token",
        checkoutRef: "main",
        imageSha: "abc123",
        checkedAt: "2026-07-10T12:00:00.000Z",
      },
      {
        awsJson: async () => ({
          Contents: [{ Key: "platform/previews/pr-90.tfstate" }],
        }),
        listDatabaseClusters: async () => [],
        listDomains: async () => [{ name: "chasesets.com" }],
        listDomainRecords: async () => [],
        listNamespaces: async () => {
          throw new Error("no kubeconfig configured for this run");
        },
        fetchPullRequest: async () => ({ state: "closed", merged: true }),
      },
    );

    expect(result.record.result).toBe("warning");
    expect(result.record.namespaceCandidates).toEqual([]);
    expect(result.record.targets).toEqual([expect.objectContaining({ prNumber: 90, selected: true })]);
  });

  // #4857: the ONE shared *.preview.chasesets.com wildcard record, applied
  // once (idempotently) as part of the DOKS foundation bootstrap, never
  // per-PR.
  it("upserts the single shared preview wildcard record against the DOKS ingress target", async () => {
    const created = [];
    const deleted = [];
    const record = await applySharedPreviewDnsRecord(
      { target: "159.203.145.65" },
      {
        listDomains: async () => [{ name: "chasesets.com" }],
        listDomainRecords: async () => [{ id: "stale-wildcard", type: "A", name: "*.preview", data: "1.1.1.1" }],
        createDomainRecord: async (zone, name, data) => {
          created.push([zone, name, data]);
        },
        deleteDomainRecord: async (zone, id) => {
          deleted.push([zone, id]);
        },
      },
    );

    expect(record.result).toBe("success");
    expect(record.zone).toBe("chasesets.com");
    expect(record.action).toBe("replaced");
    expect(deleted).toEqual([["chasesets.com", "stale-wildcard"]]);
    expect(created).toEqual([["chasesets.com", "*.preview", "159.203.145.65"]]);
  });

  it("leaves the shared preview wildcard record untouched when it already points at the target (idempotent)", async () => {
    const created = [];
    const deleted = [];
    const record = await applySharedPreviewDnsRecord(
      { target: "159.203.145.65" },
      {
        listDomains: async () => [{ name: "chasesets.com" }],
        listDomainRecords: async () => [{ id: "wild-current", type: "A", name: "*.preview", data: "159.203.145.65" }],
        createDomainRecord: async (zone, name, data) => {
          created.push([zone, name, data]);
        },
        deleteDomainRecord: async (zone, id) => {
          deleted.push([zone, id]);
        },
      },
    );

    expect(record.result).toBe("success");
    expect(record.action).toBe("unchanged");
    expect(created).toEqual([]);
    expect(deleted).toEqual([]);
  });

  it("rejects the shared preview DNS apply without a valid IPv4 ingress target", async () => {
    const record = await applySharedPreviewDnsRecord(
      { target: "not-an-ip" },
      { listDomains: async () => [{ name: "chasesets.com" }] },
    );
    expect(record.result).toBe("failure");
    expect(record.errors).toContain("--target must be a valid IPv4 address (the DOKS ingress load balancer).");
  });

  it("deletes only the closing PR's apex and wildcard records on teardown", async () => {
    const deleted = [];
    const record = await destroyPreviewDnsRecords(
      { prNumber: 70 },
      {
        listDomains: async () => [{ name: "chasesets.com" }],
        listDomainRecords: async () => [
          { id: "apex-70", type: "A", name: "pr-70.preview", data: "159.203.145.65" },
          { id: "wild-70", type: "A", name: "*.pr-70.preview", data: "159.203.145.65" },
          { id: "apex-71", type: "A", name: "pr-71.preview", data: "159.203.145.65" },
        ],
        deleteDomainRecord: async (zone, id) => {
          deleted.push([zone, id]);
        },
      },
    );

    expect(record.result).toBe("success");
    expect(deleted).toEqual([
      ["chasesets.com", "wild-70"],
      ["chasesets.com", "apex-70"],
    ]);
    expect(record.deletedRecords).toEqual([
      { fqdn: "*.pr-70.preview.chasesets.com", id: "wild-70" },
      { fqdn: "pr-70.preview.chasesets.com", id: "apex-70" },
    ]);
  });

  it("bounds a hung provider command", async () => {
    const realSetTimeout = globalThis.setTimeout;
    const detachedPidFile = join(tmpdir(), `preview-cleanup-detached-grandchild-${process.pid}.txt`);
    const detachedGrandchildScript = [
      "const { spawn } = await import('node:child_process');",
      "const { writeFileSync } = await import('node:fs');",
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], { stdio: 'inherit', detached: true }); writeFileSync(process.argv[1], String(child.pid));",
      "setInterval(() => {}, 1000);",
    ].join(" ");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let detachedGrandchildPid;
    let detachedCommandState = { status: "pending" };
    try {
      const detachedCommand = commandOutput(
        process.execPath,
        ["--input-type=module", "--eval", detachedGrandchildScript, detachedPidFile],
        { timeout: 200 },
      ).then(
        () => {
          detachedCommandState = { status: "resolved" };
        },
        (error) => {
          detachedCommandState = { status: "rejected", error };
        },
      );
      for (let attempt = 0; attempt < 100 && !detachedGrandchildPid; attempt += 1) {
        try {
          detachedGrandchildPid = Number(await readFile(detachedPidFile, "utf8"));
        } catch {
          await new Promise((resolve) => realSetTimeout(resolve, 50));
        }
      }
      expect(detachedGrandchildPid).toBeGreaterThan(0);
      await vi.advanceTimersByTimeAsync(199);
      expect(detachedCommandState.status).toBe("pending");
      await vi.advanceTimersByTimeAsync(1);
      expect(detachedCommandState.status).toBe("rejected");
      expect(detachedCommandState.error).toHaveProperty("message", expect.stringContaining("timed out after 200ms"));
      if (process.platform !== "win32") {
        expect(() => process.kill(detachedGrandchildPid, 0)).not.toThrow();
      }
      await detachedCommand;
    } finally {
      vi.useRealTimers();
      if (detachedGrandchildPid) {
        try {
          process.kill(detachedGrandchildPid, "SIGKILL");
        } catch (error) {
          if (error?.code !== "ESRCH") {
            throw error;
          }
        }
      }
      await rm(detachedPidFile, { force: true });
    }

    const pidFile = join(tmpdir(), `preview-cleanup-grandchild-${process.pid}.txt`);
    const grandchildScript = [
      "const { spawn } = await import('node:child_process');",
      "const { writeFileSync } = await import('node:fs');",
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], { stdio: 'inherit' }); writeFileSync(process.argv[1], String(child.pid));",
      "setInterval(() => {}, 1000);",
    ].join(" ");
    await expect(
      commandOutput(process.execPath, ["--input-type=module", "--eval", grandchildScript, pidFile], {
        timeout: 200,
      }),
    ).rejects.toThrow("timed out after 200ms");
    if (process.platform !== "win32") {
      let grandchildPid;
      for (let attempt = 0; attempt < 20 && !grandchildPid; attempt += 1) {
        try {
          grandchildPid = Number(await readFile(pidFile, "utf8"));
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      }
      expect(grandchildPid).toBeGreaterThan(0);
      const grandchildIsDead = () => {
        try {
          process.kill(grandchildPid, 0);
        } catch (error) {
          if (error?.code === "ESRCH") {
            return true;
          }
          throw error;
        }
        if (process.platform === "linux") {
          try {
            const stat = readFileSync(`/proc/${grandchildPid}/stat`, "utf8");
            const stateStart = stat.lastIndexOf(")") + 2;
            return stat[stateStart] === "Z";
          } catch (error) {
            if (error?.code === "ENOENT") {
              return true;
            }
            throw error;
          }
        }
        return false;
      };
      let grandchildSettled = false;
      for (let attempt = 0; attempt < 40 && !grandchildSettled; attempt += 1) {
        grandchildSettled = grandchildIsDead();
        if (!grandchildSettled) {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      }
      expect(grandchildSettled).toBe(true);
    }
    await rm(pidFile, { force: true });

    const result = await discoverPreviewCleanupTargets(discoveryOptions({ discoveryCommandTimeoutMs: 25 }), {
      awsJson: () => new Promise(() => {}),
      listDatabaseClusters: async () => [],
      listDomains: async () => [],
      listDomainRecords: async () => [],
      listNamespaces: async () => [],
    });
    expect(result.record.phases[0]).toMatchObject({ name: "state-list", count: null });
    expect(result.record.phases[0].error).toMatch(/timed out/);
    expect(result.record.phases.slice(1).every((phase) => phase.error === "skipped-after-state-list-failure")).toBe(
      true,
    );

    const commandCalls = [];
    await discoverPreviewCleanupTargets(discoveryOptions({ discoveryCommandTimeoutMs: 25 }), {
      commandOutput: async (command, args, commandOptions) => {
        commandCalls.push({ command, args, options: commandOptions });
        return command === "aws" ? JSON.stringify({ Contents: [] }) : "[]";
      },
    });
    expect(commandCalls[0].options).toMatchObject({ timeout: 25 });
  });

  it("aborts a stalled PR lookup", async () => {
    const fetchMock = vi.fn((url, init) => {
      if (fetchMock.mock.calls.length === 1) {
        return new Promise((resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(new DOMException("timed out", "AbortError")), {
            once: true,
          });
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({ state: "closed", merged: false }) });
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const result = await discoverPreviewCleanupTargets(discoveryOptions({ discoveryPullRequestTimeoutMs: 25 }), {
        awsJson: async () => ({
          Contents: [{ Key: "platform/previews/pr-1.tfstate" }, { Key: "platform/previews/pr-2.tfstate" }],
        }),
        listDatabaseClusters: async () => [],
        listDomains: async () => [],
        listDomainRecords: async () => [],
        listNamespaces: async () => [],
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[0][1].signal).toBeDefined();
      expect(result.record.errors).toContain("PR #1 lookup failed: timed out after 25ms.");
      expect(result.record.targets).toEqual([expect.objectContaining({ prNumber: 2, selected: true })]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("looks up each sorted candidate once with no more than eight active workers", async () => {
    let active = 0;
    let maximumActive = 0;
    const lookedUp = [];
    const result = await discoverPreviewCleanupTargets(discoveryOptions(), {
      awsJson: async () => ({
        Contents: Array.from({ length: 1_260 }, (_, index) => ({ Key: `platform/previews/pr-${index + 1}.tfstate` })),
      }),
      listDatabaseClusters: async () => [],
      listDomains: async () => [],
      listDomainRecords: async () => [],
      listNamespaces: async () => [],
      fetchPullRequest: async (prNumber) => {
        lookedUp.push(prNumber);
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setTimeout(resolve, 0));
        active -= 1;
        return { state: "closed", merged: false };
      },
    });
    expect(maximumActive).toBeLessThanOrEqual(8);
    expect(lookedUp).toHaveLength(1_260);
    expect(new Set(lookedUp).size).toBe(1_260);
    expect(result.record.targets).toHaveLength(1_260);
    expect(result.record.batchSize).toBe(32);
    expect(result.record.batchCount).toBe(40);
    expect(result.record.batches.map((batch) => batch.targets.length)).toEqual([...Array(39).fill(32), 12]);
    expect(result.matrix.include).toEqual([
      ...Array.from({ length: 40 }, (_, batch_index) => ({
        batch_index,
        batch_count: 40,
        checkout_ref: "main",
        image_sha: "abc123",
      })),
    ]);
  });

  it("fails closed above the 256-batch matrix limit without truncating targets", async () => {
    const discover = async (count) =>
      discoverPreviewCleanupTargets(discoveryOptions(), {
        awsJson: async () => ({
          Contents: Array.from({ length: count }, (_, index) => ({ Key: `platform/previews/pr-${index + 1}.tfstate` })),
        }),
        listDatabaseClusters: async () => [],
        listDomains: async () => [],
        listDomainRecords: async () => [],
        listNamespaces: async () => [],
        fetchPullRequest: async () => ({ state: "closed", merged: false }),
      });

    const withinLimit = await discover(8_192);
    expect(withinLimit.record.batchCount).toBe(256);
    expect(withinLimit.record.result).not.toBe("failure");
    expect(withinLimit.matrix.include).toHaveLength(256);

    const overLimit = await discover(8_193);
    expect(overLimit.record.result).toBe("failure");
    expect(overLimit.record.errors).toContain("matrix-limit-exceeded");
    expect(overLimit.record.batchCount).toBe(257);
    expect(overLimit.record.targets).toHaveLength(8_193);
    expect(overLimit.record.batches).toHaveLength(257);
    expect(overLimit.matrix).toEqual({ include: [] });
  });

  it("fails closed at the discovery budget", async () => {
    const calls = { namespaces: 0, lookups: 0 };
    let nowMs = 0;
    const result = await discoverPreviewCleanupTargets(discoveryOptions({ discoveryCommandTimeoutMs: 1_000 }), {
      awsJson: async () => ({ Contents: [{ Key: "platform/previews/pr-3.tfstate" }] }),
      listDatabaseClusters: async () => [],
      listDomains: async () => [],
      listDomainRecords: async () => {
        nowMs = 8 * 60 * 1_000 - 30;
        return [];
      },
      listNamespaces: async () => {
        calls.namespaces += 1;
        return new Promise(() => {});
      },
      fetchPullRequest: async () => {
        calls.lookups += 1;
        return { state: "closed", merged: true };
      },
      clock: () => nowMs,
    });
    expect(calls).toEqual({ namespaces: 1, lookups: 0 });
    expect(result.record.result).toBe("failure");
    expect(result.record.errors).toContain("budget-exhausted");
    expect(result.record.targets).toEqual([]);
    expect(result.matrix.include).toEqual([]);
    expect(result.record.phases).toHaveLength(5);
    expect(result.record.phases.map((phase) => phase.name)).toEqual([
      "state-list",
      "database-list",
      "dns-list",
      "namespace-list",
      "pr-lookups",
    ]);
    expect(result.record.phases[3]).toMatchObject({ name: "namespace-list", error: "budget-exhausted", count: null });
    expect(result.record.phases[4]).toMatchObject({
      name: "pr-lookups",
      startedAt: null,
      durationMs: null,
      count: null,
      error: "budget-exhausted",
    });
    expect(result.record.result === "failure" ? 1 : 0).toBe(1);
  });

  it("keeps cleanup selection unchanged", async () => {
    const cases = [
      { name: "state-only", state: [{ Key: "platform/previews/pr-1.tfstate" }], expected: [1] },
      {
        name: "cluster-only",
        clusters: [{ id: "db-2", name: "chase-sets-pr-2-postgres", tags: ["preview"] }],
        expected: [2],
      },
      {
        name: "DNS-only",
        dns: [{ id: "dns-3", type: "A", name: "pr-3.preview", data: "159.203.145.65" }],
        expected: [3],
      },
      { name: "namespace-only", namespaces: [{ metadata: { name: "chase-sets-pr-4" } }], expected: [4] },
      {
        name: "mixed open/closed/merged",
        state: [{ Key: "platform/previews/pr-5.tfstate" }, { Key: "platform/previews/pr-6.tfstate" }],
        expected: [5],
        states: { 5: { state: "closed", merged: true }, 6: { state: "open", merged: false } },
      },
      {
        name: "lookup-error",
        state: [{ Key: "platform/previews/pr-7.tfstate" }],
        expected: [],
        lookupError: true,
      },
    ];
    for (const testCase of cases) {
      const lookedUp = [];
      const result = await discoverPreviewCleanupTargets(discoveryOptions(), {
        awsJson: async () => ({ Contents: testCase.state ?? [] }),
        listDatabaseClusters: async () => testCase.clusters ?? [],
        listDomains: async () => [{ name: "chasesets.com" }],
        listDomainRecords: async () => testCase.dns ?? [],
        listNamespaces: async () => testCase.namespaces ?? [],
        fetchPullRequest: async (prNumber) => {
          lookedUp.push(prNumber);
          if (testCase.lookupError) {
            throw new Error("transport failed");
          }
          return testCase.states?.[prNumber] ?? { state: "closed", merged: false };
        },
      });
      expect(
        result.record.targets.map((target) => target.prNumber),
        testCase.name,
      ).toEqual(testCase.expected);
      expect(
        result.record.targets.map((target) => target.prNumber),
        testCase.name,
      ).toEqual(testCase.expected);
      if (testCase.listCount !== undefined) {
        expect(result.record.namespaceCandidates).toEqual([]);
        expect(result.record.phases[3].count).toBe(testCase.listCount);
        expect(lookedUp).toEqual([]);
      }
    }

    const nonDiscoverCalls = vi.fn(async () => "[]");
    await buildPreviewDatabaseClusterInventory(
      { repository: "chase-sets/chase-sets", checkedAt: "2026-07-10T12:00:00.000Z" },
      { commandOutput: nonDiscoverCalls },
    );
    expect(nonDiscoverCalls).toHaveBeenCalledWith("doctl", ["databases", "list", "--output", "json"], {});
  });

  it("records bounded discover transport without bounding inventory or dry-run cleanup", async () => {
    const transportCalls = [];
    const fetchMock = vi.fn((url, init = {}) => {
      transportCalls.push({ url, init });
      if (init.signal) {
        return new Promise((resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(new DOMException("timed out", "AbortError")), {
            once: true,
          });
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({ state: "closed", merged: true }) });
    });
    const databaseClusters = [{ id: "db-30", name: "chase-sets-pr-30-postgres", tags: ["preview"] }];
    const inventoryOptions = {
      repository: "chase-sets/chase-sets",
      githubToken: "token",
      checkedAt: "2026-07-10T12:00:00.000Z",
    };
    vi.stubGlobal("fetch", fetchMock);
    try {
      const inventory = await buildPreviewDatabaseClusterInventory(inventoryOptions, {
        listDatabaseClusters: async () => databaseClusters,
      });
      const cleanup = await cleanupLeakedPreviewDatabaseClusters(inventoryOptions, {
        listDatabaseClusters: async () => databaseClusters,
      });

      const expectedCluster = {
        clusterId: "db-30",
        clusterName: "chase-sets-pr-30-postgres",
        classification: "preview-*",
        prNumber: 30,
        pullRequestState: "merged",
        leaked: true,
        previewManagedClusterViolation: true,
        conclusion: "leaked-preview-managed-cluster-violation",
      };
      expect(inventory.clusters).toEqual([expectedCluster]);
      expect(cleanup.clusters).toEqual([expectedCluster]);
      expect(cleanup.selectedDeletionClusters).toEqual([expectedCluster]);
      expect(transportCalls.slice(0, 2).every(({ init }) => init.signal === undefined)).toBe(true);

      const discover = await discoverPreviewCleanupTargets(discoveryOptions({ discoveryPullRequestTimeoutMs: 25 }), {
        awsJson: async () => ({ Contents: [{ Key: "platform/previews/pr-30.tfstate" }] }),
        listDatabaseClusters: async () => [],
        listDomains: async () => [],
        listDomainRecords: async () => [],
        listNamespaces: async () => [],
      });
      expect(transportCalls[2].init.signal).toBeDefined();
      expect(discover.record.errors).toContain("PR #30 lookup failed: timed out after 25ms.");
      expect(discover.record.targets).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("records discovery phases and volume", async () => {
    const result = await discoverPreviewCleanupTargets(discoveryOptions(), {
      awsJson: async () => ({
        Contents: [
          { Key: "platform/previews/pr-4.tfstate", Size: 180 },
          { Key: "platform/previews/pr-5.tfstate", Size: 2_048 },
          { Key: "platform/previews/pr-6.tfstate", Size: 70_000 },
          { Key: "platform/previews/pr-7.tfstate", Size: 2_000_000 },
        ],
      }),
      listDatabaseClusters: async () => [{ id: "db-8", name: "chase-sets-pr-8-postgres", tags: ["preview"] }],
      listDomains: async () => [{ name: "chasesets.com" }],
      listDomainRecords: async () => [
        { id: "preview-record", type: "A", name: "pr-9.preview", data: "159.203.145.65" },
        { id: "unrelated", type: "CNAME", name: "assets", data: "cdn" },
      ],
      listNamespaces: async () => [{ metadata: { name: "chase-sets-pr-10" } }],
      fetchPullRequest: async () => ({ state: "closed", merged: false }),
    });
    expect(result.record.result).toBe("success");
    expect(result.record.stateObjectCount).toBe(4);
    expect(result.record.stateObjectBytes).toEqual({
      under1KiB: 1,
      "1KiBTo64KiB": 1,
      "64KiBTo1MiB": 1,
      atLeast1MiB: 1,
    });
    expect(result.record.candidateCount).toBe(7);
    expect(result.record.closedTargetCount).toBe(7);
    expect(result.record.phases.map((phase) => phase.name)).toEqual([
      "state-list",
      "database-list",
      "dns-list",
      "namespace-list",
      "pr-lookups",
    ]);
    expect(result.record.phases.map((phase) => phase.count)).toEqual([4, 1, 1, 1, 7]);

    const dedicatedDns = await discoverPreviewCleanupTargets(discoveryOptions(), {
      awsJson: async () => ({ Contents: [] }),
      listDatabaseClusters: async () => [],
      listDomains: async () => [{ name: "preview.chasesets.com" }],
      listDomainRecords: async () => [
        { id: "ns", type: "NS", name: "@", data: "ns1" },
        { id: "soa", type: "SOA", name: "@", data: "soa" },
        { id: "wild", type: "A", name: "*", data: "159.203.145.65" },
        { id: "pr", type: "A", name: "pr-9", data: "159.203.145.65" },
        { id: "wild-pr", type: "A", name: "*.pr-9", data: "159.203.145.65" },
      ],
      listNamespaces: async () => [],
    });
    expect(dedicatedDns.record.phases[2].count).toBe(5);

    const warning = await discoverPreviewCleanupTargets(discoveryOptions(), {
      awsJson: async () => ({ Contents: [] }),
      listDatabaseClusters: async () => {
        throw new Error("database unavailable");
      },
      listDomains: async () => [],
      listDomainRecords: async () => [],
      listNamespaces: async () => [],
    });
    expect(warning.record.warnings[0]).toMatch(/database cluster listing failed/);
    expect(warning.record.phases[1].count).toBeNull();
    expect(warning.record.phases.map((phase) => phase.name)).toEqual([
      "state-list",
      "database-list",
      "dns-list",
      "namespace-list",
      "pr-lookups",
    ]);
    expect(warning.record.phases.map((phase) => phase.count)).toEqual([0, null, 0, 0, 0]);

    const stateListFailure = await discoverPreviewCleanupTargets(discoveryOptions(), {
      awsJson: async () => {
        throw new Error("state unavailable");
      },
      listDatabaseClusters: async () => [],
      listDomains: async () => [],
      listDomainRecords: async () => [],
      listNamespaces: async () => [],
    });
    expect(stateListFailure.record.result).toBe("failure");
    expect(stateListFailure.record.phases.map((phase) => phase.name)).toEqual([
      "state-list",
      "database-list",
      "dns-list",
      "namespace-list",
      "pr-lookups",
    ]);
    expect(stateListFailure.record.phases.map((phase) => phase.count)).toEqual([null, null, null, null, null]);
    expect(stateListFailure.record.phases[0].error).toBe("state unavailable");
    expect(
      stateListFailure.record.phases.slice(1).every((phase) => phase.error === "skipped-after-state-list-failure"),
    ).toBe(true);

    const invalid = await discoverPreviewCleanupTargets({});
    expect(invalid.record.phases.every((phase) => phase.error === "invalid-options")).toBe(true);
    expect(invalid.record.phases.map((phase) => phase.name)).toEqual([
      "state-list",
      "database-list",
      "dns-list",
      "namespace-list",
      "pr-lookups",
    ]);
    expect(invalid.record.phases.map((phase) => phase.count)).toEqual([null, null, null, null, null]);

    let lookupCount = 0;
    const perCallWarning = await discoverPreviewCleanupTargets(
      discoveryOptions({ discoveryCommandTimeoutMs: 30, discoveryBudgetMs: 1_000 }),
      {
        awsJson: async () => ({ Contents: [{ Key: "platform/previews/pr-31.tfstate" }] }),
        listDatabaseClusters: async () => [],
        listDomains: async () => [],
        listDomainRecords: async () => [],
        listNamespaces: async () => new Promise(() => {}),
        fetchPullRequest: async () => {
          lookupCount += 1;
          return { state: "closed", merged: false };
        },
      },
    );
    expect(perCallWarning.record.result).toBe("warning");
    expect(perCallWarning.record.phases.map((phase) => phase.name)).toEqual([
      "state-list",
      "database-list",
      "dns-list",
      "namespace-list",
      "pr-lookups",
    ]);
    expect(perCallWarning.record.phases.map((phase) => phase.count)).toEqual([1, 0, 0, null, 1]);
    expect(perCallWarning.record.phases[3].error).toMatch(/timed out/);
    expect(lookupCount).toBe(1);

    const budget = await discoverPreviewCleanupTargets(discoveryOptions({ discoveryBudgetMs: 1 }), {
      awsJson: async () => new Promise(() => {}),
    });
    expect(budget.record.result).toBe("failure");
    expect(budget.matrix.include).toEqual([]);
    expect(budget.record.targets).toEqual([]);
    expect(budget.record.phases.map((phase) => phase.name)).toEqual([
      "state-list",
      "database-list",
      "dns-list",
      "namespace-list",
      "pr-lookups",
    ]);
    expect(budget.record.phases.map((phase) => phase.count)).toEqual([null, null, null, null, null]);
  });
});

// #9964: idle draft preview retirement. Clock and fixtures are fixed so every
// 24h boundary and the oldest-first cap are deterministic.
const IDLE_DRAFT_CHECKED_AT = "2026-10-18T12:00:00.000Z";
const hoursBefore = (hours) => new Date(Date.parse(IDLE_DRAFT_CHECKED_AT) - hours * 3_600_000).toISOString();
const previewNamespace = (prNumber, ageHours) => ({
  metadata: { name: `chase-sets-pr-${prNumber}`, creationTimestamp: hoursBefore(ageHours) },
});
const namespaceList = (...items) => ({ apiVersion: "v1", kind: "List", items });
const openPullRequest = (number, draft) => ({ number, state: "open", draft });
const pagesOf = (pullRequests, fetchedPages = []) => {
  return async (page) => {
    fetchedPages.push(page);
    return pullRequests.slice((page - 1) * 100, page * 100);
  };
};
const idleDraftOptions = (overrides = {}) => ({
  repository: "chase-sets/chase-sets",
  githubToken: "token",
  checkedAt: IDLE_DRAFT_CHECKED_AT,
  ...overrides,
});
const recheckOptions = (prNumber) => idleDraftOptions({ prNumber, checkoutRef: "refs/heads/main", imageSha: "abc123" });

describe("discover-idle-drafts (#9964)", () => {
  it("selects an open draft at 24h or older and skips a recent draft, an open non-draft, and a not-open PR with their reasons", async () => {
    const { record, matrix } = await discoverIdleDraftPreviews(idleDraftOptions(), {
      listNamespaces: async () =>
        namespaceList(
          previewNamespace(101, 24),
          previewNamespace(102, 23.9),
          previewNamespace(103, 200),
          previewNamespace(104, 200),
          { metadata: { name: "kube-system", creationTimestamp: hoursBefore(900) } },
        ),
      fetchOpenPullRequestPage: pagesOf([
        openPullRequest(101, true),
        openPullRequest(102, true),
        openPullRequest(103, false),
      ]),
    });

    expect(record).toMatchObject({
      schemaVersion: PLATFORM_PREVIEW_IDLE_DRAFTS_VERSION,
      mode: "sweep",
      result: "success",
      errors: [],
      openPullRequestPages: 1,
      openPullRequestCount: 3,
    });
    expect(record.namespaces.map(({ prNumber, decision, ageHours }) => [prNumber, decision, ageHours])).toEqual([
      [101, "idle-draft", 24],
      [102, "recent-draft", 23.9],
      [103, "open-ready", 200],
      [104, "not-open", 200],
    ]);
    expect(record.namespaces.map(({ reason }) => reason)).toEqual([
      "Open draft; last deploy at least 24h ago.",
      "Open draft; last deploy under 24h ago.",
      "PR is open and ready for review; its preview is never retired.",
      "PR is not open; the closed-PR sweep owns this namespace.",
    ]);
    expect(record.selected).toEqual([
      { prNumber: 101, namespace: "chase-sets-pr-101", creationTimestamp: hoursBefore(24), ageHours: 24 },
    ]);
    expect(record.deferred).toEqual([]);
    expect(record.counts).toEqual({
      namespaces: 4,
      idleDraft: 1,
      recentDraft: 1,
      openReady: 1,
      notOpen: 1,
      selected: 1,
      deferred: 0,
    });
    // The sweep only selects; it never emits a destroy matrix.
    expect(matrix).toEqual({ include: [] });
  });

  it("caps selection at 10 per run, oldest first, and records the rest as deferred", async () => {
    // PR numbers deliberately disagree with age order: 212 is the oldest.
    const ages = {
      201: 30,
      202: 40,
      203: 50,
      204: 60,
      205: 70,
      206: 80,
      207: 90,
      208: 100,
      209: 110,
      210: 25,
      211: 26,
      212: 500,
    };
    const prNumbers = Object.keys(ages).map(Number);
    const { record } = await discoverIdleDraftPreviews(idleDraftOptions(), {
      listNamespaces: async () =>
        namespaceList(...prNumbers.map((prNumber) => previewNamespace(prNumber, ages[prNumber]))),
      fetchOpenPullRequestPage: pagesOf(prNumbers.map((prNumber) => openPullRequest(prNumber, true))),
    });

    expect(IDLE_DRAFT_MAX_SELECTIONS).toBe(10);
    expect(record.selected.map(({ prNumber }) => prNumber)).toEqual([212, 209, 208, 207, 206, 205, 204, 203, 202, 201]);
    expect(record.deferred.map(({ prNumber }) => prNumber)).toEqual([211, 210]);
    expect(record.counts).toMatchObject({ idleDraft: 12, selected: 10, deferred: 2 });
  });

  it("reads every open pull request page until a page returns fewer than 100 items", async () => {
    const pullRequests = Array.from({ length: 150 }, (_, index) => openPullRequest(1000 + index, false));
    pullRequests[120] = openPullRequest(1120, true);
    const fetchedPages = [];
    const { record } = await discoverIdleDraftPreviews(idleDraftOptions(), {
      listNamespaces: async () => namespaceList(previewNamespace(1120, 48)),
      fetchOpenPullRequestPage: pagesOf(pullRequests, fetchedPages),
    });

    expect(fetchedPages).toEqual([1, 2]);
    expect(record).toMatchObject({ result: "success", openPullRequestPages: 2, openPullRequestCount: 150 });
    expect(record.selected.map(({ prNumber }) => prNumber)).toEqual([1120]);

    // Exactly 100 open PRs: page 2 is read and is empty.
    const exactPages = [];
    await discoverIdleDraftPreviews(idleDraftOptions(), {
      listNamespaces: async () => namespaceList(),
      fetchOpenPullRequestPage: pagesOf(pullRequests.slice(0, 100), exactPages),
    });
    expect(exactPages).toEqual([1, 2]);
  });

  const fullPage = Array.from({ length: 100 }, (_, index) => openPullRequest(2000 + index, true));
  it.each([
    [
      "a page request fails after a full page",
      async (page) => {
        if (page === 2) throw new Error("GitHub open pull request listing page 2 returned 502.");
        return fullPage;
      },
      "GitHub open pull request listing page 2 returned 502.",
    ],
    ["a page is not a JSON array", async () => ({ message: "API rate limit exceeded" }), "was not a JSON array"],
    [
      "a page entry has no draft flag",
      async () => [openPullRequest(2000, true), { number: 2001, state: "open" }],
      "without number, open state, and draft",
    ],
    [
      "a page entry is not open",
      async () => [{ number: 2000, state: "closed", draft: true }],
      "without number, open state, and draft",
    ],
    [
      "pages never end",
      async (page) => (page <= OPEN_PULL_REQUEST_MAX_PAGES + 5 ? fullPage : []),
      `exceeded ${OPEN_PULL_REQUEST_MAX_PAGES} pages`,
    ],
  ])("fails closed and selects nothing when %s", async (_label, fetchOpenPullRequestPage, expectedError) => {
    const { record, matrix } = await discoverIdleDraftPreviews(idleDraftOptions(), {
      listNamespaces: async () => namespaceList(previewNamespace(2000, 72)),
      fetchOpenPullRequestPage,
    });

    expect(record.result).toBe("failure");
    expect(record.errors[0]).toBe("Open pull request listing failed; nothing was selected.");
    expect(record.errors[1]).toContain(expectedError);
    expect(record.namespaces).toEqual([]);
    expect(record.selected).toEqual([]);
    expect(matrix).toEqual({ include: [] });
  });

  it.each([
    [
      "kubectl fails",
      async () => {
        throw new Error("no kubeconfig configured for this run");
      },
      "no kubeconfig configured for this run",
    ],
    ["the listing has no items array", async () => ({ kind: "Status" }), "no items array"],
    [
      "a preview namespace has no parseable creationTimestamp",
      async () => namespaceList(previewNamespace(2000, 72), { metadata: { name: "chase-sets-pr-2001" } }),
      "chase-sets-pr-2001 has no parseable creationTimestamp",
    ],
  ])("fails closed and selects nothing when %s", async (_label, listNamespaces, expectedError) => {
    const fetchedPages = [];
    const { record } = await discoverIdleDraftPreviews(idleDraftOptions(), {
      listNamespaces,
      fetchOpenPullRequestPage: pagesOf([openPullRequest(2000, true), openPullRequest(2001, true)], fetchedPages),
    });

    expect(record.result).toBe("failure");
    expect(record.errors[0]).toBe("Preview namespace listing failed; nothing was selected.");
    expect(record.errors[1]).toContain(expectedError);
    expect(record.selected).toEqual([]);
    expect(fetchedPages).toEqual([]);
  });

  it("--pr-number re-check emits the single-PR destroy matrix only while D1 still holds", async () => {
    // Twelve idle drafts plus the re-checked one: the re-check ignores the
    // sweep's cap and never selects any other PR.
    const others = Array.from({ length: 12 }, (_, index) => 300 + index);
    const listNamespaces = async () =>
      namespaceList(previewNamespace(399, 25), ...others.map((prNumber) => previewNamespace(prNumber, 400)));
    const draftOthers = others.map((prNumber) => openPullRequest(prNumber, true));

    const holds = await discoverIdleDraftPreviews(recheckOptions(399), {
      listNamespaces,
      fetchOpenPullRequestPage: pagesOf([...draftOthers, openPullRequest(399, true)]),
    });
    expect(holds.record).toMatchObject({
      mode: "recheck",
      recheckPrNumber: 399,
      result: "success",
      recheck: { prNumber: 399, decision: "idle-draft", selected: true },
      deferred: [],
    });
    expect(holds.matrix).toEqual({
      include: [
        {
          pr_number: 399,
          checkout_ref: "refs/heads/main",
          image_sha: "abc123",
          expected_database_cluster_name: "chase-sets-pr-399-postgres",
        },
      ],
    });

    const markedReady = await discoverIdleDraftPreviews(recheckOptions(399), {
      listNamespaces,
      fetchOpenPullRequestPage: pagesOf([...draftOthers, openPullRequest(399, false)]),
    });
    expect(markedReady.record.recheck).toEqual({
      prNumber: 399,
      decision: "open-ready",
      selected: false,
      reason: "PR is open and ready for review; its preview is never retired.",
    });
    expect(markedReady.matrix).toEqual({ include: [] });

    const redeployed = await discoverIdleDraftPreviews(recheckOptions(399), {
      listNamespaces: async () => namespaceList(previewNamespace(399, 0.2)),
      fetchOpenPullRequestPage: pagesOf([openPullRequest(399, true)]),
    });
    expect(redeployed.record.recheck).toMatchObject({ decision: "recent-draft", selected: false });
    expect(redeployed.matrix).toEqual({ include: [] });

    const closed = await discoverIdleDraftPreviews(recheckOptions(399), {
      listNamespaces,
      fetchOpenPullRequestPage: pagesOf(draftOthers),
    });
    expect(closed.record.recheck).toMatchObject({ decision: "not-open", selected: false });
    expect(closed.matrix).toEqual({ include: [] });

    const gone = await discoverIdleDraftPreviews(recheckOptions(399), {
      listNamespaces: async () => namespaceList(),
      fetchOpenPullRequestPage: pagesOf([openPullRequest(399, true)]),
    });
    expect(gone.record.recheck).toEqual({
      prNumber: 399,
      decision: null,
      selected: false,
      reason: "No live chase-sets-pr-399 namespace exists.",
    });
    expect(gone.matrix).toEqual({ include: [] });
  });

  it("rejects an invalid re-check before listing anything", async () => {
    const listed = [];
    const dependencies = {
      listNamespaces: async () => {
        listed.push("namespaces");
        return namespaceList();
      },
      fetchOpenPullRequestPage: async () => {
        listed.push("pulls");
        return [];
      },
    };

    const invalid = await discoverIdleDraftPreviews(recheckOptions(Number.NaN), dependencies);
    expect(invalid.record.result).toBe("failure");
    expect(invalid.record.errors).toEqual(["--pr-number must be a positive integer."]);

    const unbound = await discoverIdleDraftPreviews(idleDraftOptions({ prNumber: 5 }), dependencies);
    expect(unbound.record.errors).toEqual([
      "--checkout-ref is required with --pr-number.",
      "--image-sha is required with --pr-number.",
    ]);
    expect(listed).toEqual([]);
  });

  it("CLI: an empty --pr-number is an invalid re-check, never a fallback to the full sweep", () => {
    const directory = mkdtempSync(join(tmpdir(), "idle-drafts-"));
    const githubOutput = join(directory, "github-output");
    try {
      let status = 0;
      try {
        execFileSync(
          process.execPath,
          [
            resolve("scripts/digitalocean-preview-cleanup-sweep.mjs"),
            "discover-idle-drafts",
            "--pr-number",
            "",
            "--checkout-ref",
            "refs/heads/main",
            "--image-sha",
            "abc123",
            "--repo",
            "chase-sets/chase-sets",
            "--github-token",
            "token",
            "--github-output",
            githubOutput,
          ],
          // A missing kubeconfig keeps a mutant that reaches listing off any real cluster.
          { stdio: "pipe", env: { ...process.env, KUBECONFIG: join(directory, "missing-kubeconfig") } },
        );
      } catch (error) {
        status = error.status;
      }

      expect(status).toBe(1);
      expect(readFileSync(githubOutput, "utf8")).toBe(
        'result=failure\ntarget_count=0\npr_numbers=\nmatrix={"include":[]}\nreason=re-check failed\n',
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("leaves closed-PR selection in discoverPreviewCleanupTargets unchanged when namespaces carry creationTimestamp", async () => {
    const result = await discoverPreviewCleanupTargets(
      {
        bucket: "chase-sets-terraform-state",
        endpointUrl: "https://nyc3.digitaloceanspaces.com",
        prefix: "platform/previews",
        repository: "chase-sets/chase-sets",
        githubToken: "token",
        checkoutRef: "main",
        imageSha: "abc123",
        checkedAt: IDLE_DRAFT_CHECKED_AT,
      },
      {
        awsJson: async () => ({ Contents: [] }),
        listDatabaseClusters: async () => [],
        listDomains: async () => [{ name: "chasesets.com" }],
        listDomainRecords: async () => [],
        listNamespaces: async () => [previewNamespace(501, 300), previewNamespace(502, 300)],
        fetchPullRequest: async (prNumber) =>
          prNumber === 501 ? { state: "open", draft: true, merged: false } : { state: "closed", merged: true },
      },
    );

    expect(result.record.namespaceCandidates).toEqual([
      { prNumber: 501, namespace: "chase-sets-pr-501", creationTimestamp: hoursBefore(300) },
      { prNumber: 502, namespace: "chase-sets-pr-502", creationTimestamp: hoursBefore(300) },
    ]);
    // An idle open draft is never a closed-PR target; the closed one is.
    expect(result.record.targets).toEqual([
      {
        prNumber: 502,
        stateKey: null,
        databaseClusters: [],
        namespace: "chase-sets-pr-502",
        pullRequestState: "closed",
        merged: true,
        selected: true,
      },
    ]);
    expect(result.matrix).toEqual({
      include: [
        {
          batch_index: 0,
          batch_count: 1,
          checkout_ref: "main",
          image_sha: "abc123",
        },
      ],
    });
  });

  it("documents D1-D5 and the hand re-check in the runbook's Preview Node Pool section", () => {
    const runbook = readFileSync(resolve("docs/runbooks/doks-platform-operations.md"), "utf8");
    const start = runbook.indexOf("## Preview Node Pool\n");
    expect(start).toBeGreaterThanOrEqual(0);
    const end = runbook.indexOf("\n## ", start + 1);
    const section = runbook.slice(start, end === -1 ? runbook.length : end);

    for (const claim of [
      // D1
      "open and draft",
      "`creationTimestamp` is at least 24h old",
      // D2
      "node ./scripts/digitalocean-preview-cleanup-sweep.mjs discover-idle-drafts",
      "`idle-draft`, `recent-draft`, `open-ready`, or `not-open`",
      "fails closed",
      "at most 10",
      "oldest first",
      "`deferred`",
      "`platform-preview-idle-drafts/v1`",
      // D3
      "`retire-idle-draft-previews`",
      "`17 10 * * *` and `47 */3 * * *`",
      "`actions: write`",
      "about 27h",
      // D4
      "`idle_draft_recheck`",
      "`destroy-preview`",
      // D5
      "`platform-pr-<n>`",
      "`platform-preview-pr-<n>`",
      "fail once",
      // Hand re-check
      "gh workflow run platform-preview-cleanup.yml --ref main -f pr_number=<n> -f idle_draft_recheck=true",
    ]) {
      expect(section, claim).toContain(claim);
    }
  });
});
