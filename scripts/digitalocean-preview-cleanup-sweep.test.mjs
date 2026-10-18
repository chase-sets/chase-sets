import { describe, expect, it, vi } from "vitest";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DIGITALOCEAN_PREVIEW_CLEANUP_SWEEP_VERSION,
  PREVIEW_DATABASE_DELETE_CONFIRMATION,
  PREVIEW_SHARED_DNS_FQDN,
  applySharedPreviewDnsRecord,
  buildPreviewDatabaseClusterInventory,
  cleanupLeakedPreviewDatabaseClusters,
  cleanupMatrixForTargets,
  classifyDatabaseCluster,
  commandOutput,
  combinePreviewCleanupCandidates,
  destroyPreviewDnsRecords,
  discoverPreviewCleanupTargets,
  importPreviewDatabaseClusterIntoTerraformState,
  previewDatabaseClusterNameForPrNumber,
  previewPrNumberFromDatabaseClusterName,
  previewPrNumberFromDnsRecordFqdn,
  previewPrNumberFromNamespaceName,
  previewPrNumberFromStateKey,
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
    expect(result.matrix.include).toEqual([expect.objectContaining({ pr_number: 50 })]);
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
      { prNumber: 2, namespace: "chase-sets-pr-2" },
      { prNumber: 12, namespace: "chase-sets-pr-12" },
    ]);
    expect(selectPreviewNamespaceTargets(["chase-sets-pr-7", "ingress-nginx"])).toEqual([
      { prNumber: 7, namespace: "chase-sets-pr-7" },
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
      { prNumber: 4736, namespace: "chase-sets-pr-4736" },
      { prNumber: 4783, namespace: "chase-sets-pr-4783" },
    ]);
    // The open PR's namespace must never be selected for teardown, even
    // though it was discovered as a live chase-sets-pr-* namespace.
    expect(result.record.targets).toEqual([
      expect.objectContaining({ prNumber: 4736, pullRequestState: "closed", merged: true, selected: true }),
    ]);
    expect(result.record.targets.some((target) => target.prNumber === 4783)).toBe(false);
    expect(result.matrix.include).toEqual([expect.objectContaining({ pr_number: 4736 })]);
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
    const pidFile = join(tmpdir(), `preview-cleanup-grandchild-${process.pid}.txt`);
    const grandchildScript = [
      "const { spawn } = await import('node:child_process');",
      "const { writeFileSync } = await import('node:fs');",
      `const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], { stdio: 'inherit' }); writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
      "setInterval(() => {}, 1000);",
    ].join(" ");
    await expect(
      commandOutput(process.execPath, ["--input-type=module", "--eval", grandchildScript], {
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
      expect(() => process.kill(grandchildPid, 0)).toThrow();
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

  it("fails closed at the discovery budget", async () => {
    const calls = { namespaces: 0, lookups: 0 };
    const result = await discoverPreviewCleanupTargets(
      discoveryOptions({ discoveryBudgetMs: 35, discoveryCommandTimeoutMs: 1_000 }),
      {
        awsJson: async () => ({ Contents: [{ Key: "platform/previews/pr-3.tfstate" }] }),
        listDatabaseClusters: async () => [],
        listDomains: async () => [],
        listDomainRecords: async () => [],
        listNamespaces: async () => {
          calls.namespaces += 1;
          return new Promise(() => {});
        },
        fetchPullRequest: async () => {
          calls.lookups += 1;
          return { state: "closed", merged: true };
        },
      },
    );
    expect(calls).toEqual({ namespaces: 1, lookups: 0 });
    expect(result.record.result).toBe("failure");
    expect(result.record.errors).toContain("budget-exhausted");
    expect(result.record.targets).toEqual([]);
    expect(result.matrix.include).toEqual([]);
    expect(result.record.phases).toHaveLength(5);
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
        name: "namespace-only (kubectl List shape)",
        namespaces: {
          apiVersion: "v1",
          kind: "List",
          items: [{ metadata: { name: "chase-sets-pr-10" } }, { metadata: { name: "kube-system" } }],
        },
        expected: [],
        listCount: 2,
      },
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
        result.matrix.include.map((target) => target.pr_number),
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

    const invalid = await discoverPreviewCleanupTargets({});
    expect(invalid.record.phases.every((phase) => phase.error === "invalid-options")).toBe(true);

    const perCallWarning = await discoverPreviewCleanupTargets(discoveryOptions({ discoveryCommandTimeoutMs: 20 }), {
      awsJson: async () => ({ Contents: [] }),
      listDatabaseClusters: async () => [],
      listDomains: async () => [],
      listDomainRecords: async () => [],
      listNamespaces: async () => [],
    });
    expect(perCallWarning.record.phases[3].error).toBeNull();

    const budget = await discoverPreviewCleanupTargets(discoveryOptions({ discoveryBudgetMs: 1 }), {
      awsJson: async () => new Promise(() => {}),
    });
    expect(budget.record.result).toBe("failure");
    expect(budget.record.matrix ?? { include: [] }).toEqual({ include: [] });
  });
});
