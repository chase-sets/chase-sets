import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  DIGITALOCEAN_REGISTRY_CLEANUP_VERSION,
  parseDigitalOceanRegistryCleanupArgs,
  runDigitalOceanRegistryCleanup,
  selectTagsForDeletion,
} from "./digitalocean-registry-cleanup.mjs";

describe("digitalocean-registry-cleanup", () => {
  it("keeps release tags, protected digests, and the latest SHA/tree tags", () => {
    const now = new Date("2026-05-15T12:00:00.000Z");

    expect(
      selectTagsForDeletion(
        [
          { tag: "current-staging", updated_at: "2026-04-01T00:00:00.000Z" },
          { tag: "current-production", updated_at: "2026-04-01T00:00:00.000Z" },
          { tag: "release-20260515-abcdef12", updated_at: "2026-04-01T00:00:00.000Z" },
          { tag: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", updated_at: "2026-05-14T00:00:00.000Z" },
          { tag: "tree-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", updated_at: "2026-05-13T00:00:00.000Z" },
          { tag: "cccccccccccccccccccccccccccccccccccccccc", updated_at: "2026-05-12T00:00:00.000Z" },
          { tag: "old-main", updated_at: "2026-03-01T00:00:00.000Z" },
          { tag: "digest-protected", digest: "sha256:keep", updated_at: "2026-03-01T00:00:00.000Z" },
          { tag: "digest-alias", digest: "sha256:keep", updated_at: "2026-03-01T00:00:00.000Z" },
        ],
        {
          now,
          retentionDays: 30,
          retainRecentShaTreeTags: 2,
          protectedTags: ["current-staging", "current-production"],
          protectedDigests: ["sha256:keep"],
        },
      ),
    ).toEqual(["cccccccccccccccccccccccccccccccccccccccc", "old-main"]);
  });

  it("records dry-run cleanup selections without deleting tags or starting garbage collection", async () => {
    const calls = [];
    const result = await runDigitalOceanRegistryCleanup(
      {
        repository: "chase-sets-platform",
        retentionDays: 7,
        retainRecentShaTreeTags: 1,
        dryRun: true,
        requestedDryRun: true,
        protectedTags: ["current-staging", "manual-keep"],
        checkedAt: "2026-05-15T12:00:00.000Z",
      },
      {
        commandOutput: async (_command, args) => {
          calls.push(args);
          if (args[0] === "registry" && args[1] === "repository" && args[2] === "list-tags") {
            return JSON.stringify([
              { tag: "current-staging", digest: "sha256:current", updated_at: "2026-03-01T00:00:00.000Z" },
              { tag: "current-staging-alias", digest: "sha256:current", updated_at: "2026-03-01T00:00:00.000Z" },
              { tag: "manual-keep", updated_at: "2026-03-01T00:00:00.000Z" },
              { tag: "release-20260515-abcdef12", updated_at: "2026-03-01T00:00:00.000Z" },
              { tag: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", updated_at: "2026-05-14T00:00:00.000Z" },
              { tag: "tree-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", updated_at: "2026-05-13T00:00:00.000Z" },
              { tag: "old-main", digest: "sha256:old", updated_at: "2026-03-01T00:00:00.000Z" },
            ]);
          }
          throw new Error(`Unexpected command: ${args.join(" ")}`);
        },
      },
    );

    expect(result.passesCleanupGate).toBe(true);
    expect(result.record).toMatchObject({
      schemaVersion: DIGITALOCEAN_REGISTRY_CLEANUP_VERSION,
      mode: "dry-run",
      repository: "chase-sets-platform",
      retentionDays: 7,
      retainRecentShaTreeTags: 1,
      protectedTags: ["current-staging", "manual-keep"],
      protectedDigests: ["sha256:current"],
      retainedRecentShaTreeTags: [
        { name: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", digest: null, updatedAt: "2026-05-14T00:00:00.000Z" },
      ],
      selectedDeletionTags: [
        { name: "tree-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", digest: null, updatedAt: "2026-05-13T00:00:00.000Z" },
        { name: "old-main", digest: "sha256:old", updatedAt: "2026-03-01T00:00:00.000Z" },
      ],
      deletedTags: [],
      failedTags: [],
      garbageCollection: { status: "skipped", reason: "dry-run" },
      result: "success",
      errors: [],
    });
    expect(calls.some((args) => args.includes("delete-tag"))).toBe(false);
    expect(calls.some((args) => args.includes("garbage-collection"))).toBe(false);
  });

  it("threads an explicit requested dry-run through argument parsing with zero mutations", async () => {
    const calls = [];
    const options = parseDigitalOceanRegistryCleanupArgs(
      ["--repository=chase-sets-platform", "--retention-days=7", "--retain-recent-sha-tree-tags=1", "--dry-run=true"],
      { DIGITALOCEAN_REGISTRY_CLEANUP_REQUESTED_DRY_RUN: "true" },
    );

    const result = await runDigitalOceanRegistryCleanup(
      { ...options, checkedAt: "2026-05-15T12:00:00.000Z" },
      {
        commandOutput: async (_command, args) => {
          calls.push(args);
          if (args[0] === "registry" && args[1] === "repository" && args[2] === "list-tags") {
            return JSON.stringify([{ tag: "old-main", digest: "sha256:old", updated_at: "2026-03-01T00:00:00.000Z" }]);
          }
          throw new Error(`Dry-run attempted a mutation: ${args.join(" ")}`);
        },
      },
    );

    expect(options).toMatchObject({ dryRun: true, requestedDryRun: true });
    expect(result.passesCleanupGate).toBe(true);
    expect(result.record).toMatchObject({
      mode: "dry-run",
      requestedMode: "dry-run",
      deletedTags: [],
      failedTags: [],
      garbageCollection: { status: "skipped", reason: "dry-run" },
      result: "success",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].slice(0, 3)).toEqual(["registry", "repository", "list-tags"]);
  });

  it("resolves matching explicit apply flags through argument parsing", () => {
    const options = parseDigitalOceanRegistryCleanupArgs(["--repository=chase-sets-platform", "--dry-run=false"], {
      DIGITALOCEAN_REGISTRY_CLEANUP_REQUESTED_DRY_RUN: "false",
    });

    expect(options).toMatchObject({
      repository: "chase-sets-platform",
      dryRun: false,
      requestedDryRun: false,
    });
  });

  it("exits nonzero when the cleanup gate rejects the requested mode", () => {
    const result = spawnSync(
      process.execPath,
      ["./scripts/digitalocean-registry-cleanup.mjs", "cleanup", "--dry-run=false"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          DIGITALOCEAN_REGISTRY_CLEANUP_REQUESTED_DRY_RUN: "true",
        },
      },
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('"result": "failure"');
  });

  it("fails closed before registry access when resolved and requested modes differ", async () => {
    const calls = [];
    const result = await runDigitalOceanRegistryCleanup(
      {
        repository: "chase-sets-platform",
        retentionDays: 7,
        retainRecentShaTreeTags: 1,
        dryRun: false,
        requestedDryRun: true,
        protectedTags: [],
        checkedAt: "2026-05-15T12:00:00.000Z",
      },
      {
        commandOutput: async (_command, args) => {
          calls.push(args);
          throw new Error(`Mode mismatch reached registry access: ${args.join(" ")}`);
        },
      },
    );

    expect(result.passesCleanupGate).toBe(false);
    expect(result.record).toMatchObject({
      mode: "apply",
      requestedMode: "dry-run",
      deletedTags: [],
      result: "failure",
      errors: ["Resolved cleanup mode apply does not match requested mode dry-run."],
    });
    expect(calls).toEqual([]);
  });

  it("rejects the legacy bare dry-run flag before registry access", async () => {
    const calls = [];
    const options = parseDigitalOceanRegistryCleanupArgs(["--dry-run"], {
      DIGITALOCEAN_REGISTRY_CLEANUP_REQUESTED_DRY_RUN: "true",
    });
    const result = await runDigitalOceanRegistryCleanup(
      { ...options, checkedAt: "2026-05-15T12:00:00.000Z" },
      {
        commandOutput: async (_command, args) => {
          calls.push(args);
          throw new Error(`Legacy bare flag reached registry access: ${args.join(" ")}`);
        },
      },
    );

    expect(result.passesCleanupGate).toBe(false);
    expect(result.record).toMatchObject({
      mode: "invalid",
      requestedMode: "dry-run",
      deletedTags: [],
      result: "failure",
      errors: ["--dry-run=true|false is required."],
    });
    expect(calls).toEqual([]);
  });

  it("deletes selected old tags and starts registry garbage collection in apply mode", async () => {
    const calls = [];
    const result = await runDigitalOceanRegistryCleanup(
      {
        repository: "chase-sets-platform",
        retentionDays: 7,
        dryRun: false,
        requestedDryRun: false,
        protectedTags: [],
        checkedAt: "2026-05-15T12:00:00.000Z",
      },
      {
        commandOutput: async (_command, args) => {
          calls.push(args);
          if (args[0] === "registry" && args[1] === "repository" && args[2] === "list-tags") {
            return JSON.stringify([{ tag: "old-main", updated_at: "2026-03-01T00:00:00.000Z" }]);
          }
          if (args[0] === "registry" && args[1] === "repository" && args[2] === "delete-tag") {
            return "";
          }
          if (args[0] === "registry" && args[1] === "garbage-collection" && args[2] === "start") {
            return "";
          }
          throw new Error(`Unexpected command: ${args.join(" ")}`);
        },
      },
    );

    expect(result.passesCleanupGate).toBe(true);
    expect(result.record.deletedTags).toEqual([
      { name: "old-main", digest: null, updatedAt: "2026-03-01T00:00:00.000Z" },
    ]);
    expect(result.record.garbageCollection).toEqual({ status: "started", reason: "cleanup-applied" });
    expect(calls).toContainEqual([
      "registry",
      "repository",
      "delete-tag",
      "chase-sets-platform",
      "old-main",
      "--force",
    ]);
    expect(calls).toContainEqual(["registry", "garbage-collection", "start", "--force"]);
  });

  it("records delete failures and skips garbage collection", async () => {
    const result = await runDigitalOceanRegistryCleanup(
      {
        repository: "chase-sets-platform",
        retentionDays: 7,
        dryRun: false,
        requestedDryRun: false,
        protectedTags: [],
        checkedAt: "2026-05-15T12:00:00.000Z",
      },
      {
        commandOutput: async (_command, args) => {
          if (args[0] === "registry" && args[1] === "repository" && args[2] === "list-tags") {
            return JSON.stringify([{ tag: "old-main", updated_at: "2026-03-01T00:00:00.000Z" }]);
          }
          if (args[0] === "registry" && args[1] === "repository" && args[2] === "delete-tag") {
            const error = new Error("delete failed");
            error.stderr = "permission denied";
            throw error;
          }
          throw new Error(`Unexpected command: ${args.join(" ")}`);
        },
      },
    );

    expect(result.passesCleanupGate).toBe(false);
    expect(result.record.result).toBe("failure");
    expect(result.record.failedTags).toEqual([
      {
        name: "old-main",
        digest: null,
        updatedAt: "2026-03-01T00:00:00.000Z",
        errors: expect.arrayContaining(["stderr: permission denied"]),
      },
    ]);
    expect(result.record.garbageCollection).toEqual({ status: "skipped", reason: "delete-failed" });
  });
});
