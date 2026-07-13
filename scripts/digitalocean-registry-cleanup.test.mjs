import { describe, expect, it } from "vitest";
import {
  DIGITALOCEAN_REGISTRY_CLEANUP_VERSION,
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

  it("deletes selected old tags and starts registry garbage collection in apply mode", async () => {
    const calls = [];
    const result = await runDigitalOceanRegistryCleanup(
      {
        repository: "chase-sets-platform",
        retentionDays: 7,
        dryRun: false,
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
