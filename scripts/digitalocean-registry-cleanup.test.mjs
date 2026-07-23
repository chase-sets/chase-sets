import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DIGITALOCEAN_REGISTRY_CLEANUP_VERSION,
  classifyCommandFailure,
  parseDigitalOceanRegistryCleanupArgs,
  runDigitalOceanRegistryCleanup,
  selectTagsForDeletion,
  validateDigitalOceanRegistryCleanupRecord,
} from "./digitalocean-registry-cleanup.mjs";

const observedProviderManagedGarbageCollectionRefusal = () => {
  const error = new Error("raw-exception-secret-marker must not escape");
  error.code = 1;
  error.stderr =
    'Error: POST https://api.digitalocean.com/v2/registry/chase-sets/garbage-collection: 412 (request "00000000-0000-4000-8000-000000000000") manual garbage collection is not available while automated garbage collection is enabled for this registry';
  return error;
};

const observedRequestId = "00000000-0000-4000-8000-000000000000";
const providerManagedMessage =
  "manual garbage collection is not available while automated garbage collection is enabled for this registry";
const providerFailure = (status, message, { code = 1 } = {}) => {
  const error = new Error("raw-exception-secret-marker must not escape");
  error.code = code;
  error.stderr = `Error: POST https://api.digitalocean.com/v2/registry/chase-sets/garbage-collection: ${status} ${message}`;
  return error;
};

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
    expect(result.stdout).toContain("result=failure");
  });

  it("real CLI invocation accepts the workflow's split --out form and writes one validated record", () => {
    const directory = mkdtempSync(join(tmpdir(), "registry-cleanup-cli-"));
    const outPath = join(directory, "digitalocean-registry-cleanup.json");
    try {
      const result = spawnSync(
        process.execPath,
        ["./scripts/digitalocean-registry-cleanup.mjs", "cleanup", "--dry-run=false", "--out", outPath],
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
      const record = JSON.parse(readFileSync(outPath, "utf8"));
      expect(validateDigitalOceanRegistryCleanupRecord(record)).toEqual([]);
      expect(record).toMatchObject({ result: "failure", mode: "apply", requestedMode: "dry-run" });
      expect(readFileSync(outPath, "utf8").match(/"schemaVersion"/g)).toHaveLength(1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("canonical record validation rejects a nonempty JSON payload that is not the exact cleanup contract", () => {
    const directory = mkdtempSync(join(tmpdir(), "registry-cleanup-record-"));
    const recordPath = join(directory, "digitalocean-registry-cleanup.json");
    try {
      writeFileSync(
        recordPath,
        JSON.stringify({
          schemaVersion: DIGITALOCEAN_REGISTRY_CLEANUP_VERSION,
          checkedAt: "2026-07-22T12:00:00.000Z",
          mode: "apply",
          requestedMode: "apply",
          result: "success",
          diagnostics: ["nonempty directory masking fixture"],
        }),
      );

      const result = spawnSync(
        process.execPath,
        ["./scripts/digitalocean-registry-cleanup-record.mjs", "--record", recordPath],
        { cwd: process.cwd(), encoding: "utf8" },
      );

      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toMatch(
        /^Registry cleanup canonical record failed validation \(\d+ field error\(s\)\)\.\r?\n$/,
      );
      expect(result.stderr).not.toContain("nonempty directory masking fixture");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
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

  it("rejects the legacy bare dry-run CLI form at the safe boundary without leaking the raw error", () => {
    const result = spawnSync(
      process.execPath,
      ["./scripts/digitalocean-registry-cleanup.mjs", "cleanup", "--dry-run"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          DIGITALOCEAN_REGISTRY_CLEANUP_REQUESTED_DRY_RUN: "true",
          DIGITALOCEAN_ACCESS_TOKEN: "must-not-be-used",
        },
      },
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe("Registry cleanup command failed before reaching a terminal status.");
    expect(result.stderr).not.toContain("--dry-run requires a value");
    expect(result.stderr).not.toContain("must-not-be-used");
    expect(result.stderr).not.toContain(" at ");
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

  it("accepts the sanitized real-run godo 412 shape at the cleanup client seam and writes the canonical record", async () => {
    const calls = [];
    const directory = mkdtempSync(join(tmpdir(), "registry-cleanup-provider-managed-"));
    const outPath = join(directory, "digitalocean-registry-cleanup.json");
    try {
      const result = await runDigitalOceanRegistryCleanup(
        {
          repository: "chase-sets-platform",
          retentionDays: 7,
          dryRun: false,
          requestedDryRun: false,
          protectedTags: [],
          checkedAt: "2026-07-22T12:00:00.000Z",
          outPath,
        },
        {
          commandOutput: async (_command, args) => {
            calls.push(args);
            if (args.slice(0, 3).join(" ") === "registry repository list-tags") {
              return JSON.stringify([{ tag: "old-main", updated_at: "2026-03-01T00:00:00.000Z" }]);
            }
            if (args[2] === "delete-tag") return "";
            if (args.slice(0, 3).join(" ") === "registry garbage-collection start") {
              throw observedProviderManagedGarbageCollectionRefusal();
            }
            throw new Error("unexpected fixture command");
          },
        },
      );

      expect(result.passesCleanupGate).toBe(true);
      expect(result.record).toMatchObject({
        result: "success",
        selectedDeletionTags: [{ name: "old-main" }],
        deletedTags: [{ name: "old-main" }],
        failedTags: [],
        garbageCollection: { status: "skipped", reason: "provider-managed" },
        errors: [],
      });
      expect(calls.map((args) => args.slice(0, 3))).toEqual([
        ["registry", "repository", "list-tags"],
        ["registry", "repository", "delete-tag"],
        ["registry", "garbage-collection", "start"],
      ]);
      const serializedRecord = readFileSync(outPath, "utf8");
      expect(validateDigitalOceanRegistryCleanupRecord(JSON.parse(serializedRecord))).toEqual([]);
      expect(serializedRecord.match(/"schemaVersion"/g)).toHaveLength(1);
      expect(serializedRecord).not.toContain(observedRequestId);
      expect(serializedRecord).not.toContain("raw-exception-secret-marker");
      expect(serializedRecord).not.toContain("api.digitalocean.com");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each([
    ["request-id-free internal fixture", providerFailure(412, providerManagedMessage)],
    [
      "wrong message with a request id",
      providerFailure(412, `(request "${observedRequestId}") another precondition failed secret-body-marker`),
    ],
    ["empty request id", providerFailure(412, `(request "") ${providerManagedMessage}`)],
    ["malformed request id", providerFailure(412, `(request "not-a-uuid") ${providerManagedMessage}`)],
    [
      "extra text before the request segment",
      providerFailure(412, `unexpected-prefix (request "${observedRequestId}") ${providerManagedMessage}`),
    ],
    [
      "extra text after the authoritative message",
      providerFailure(412, `(request "${observedRequestId}") ${providerManagedMessage} unexpected-suffix`),
    ],
    [
      "duplicate request segments",
      providerFailure(
        412,
        `(request "${observedRequestId}") (request "${observedRequestId}") ${providerManagedMessage}`,
      ),
    ],
    ["another 412", providerFailure(412, `(request "${observedRequestId}") another precondition failed`)],
    ["401", providerFailure(401, `(request "${observedRequestId}") ${providerManagedMessage}`)],
    ["403", providerFailure(403, `(request "${observedRequestId}") ${providerManagedMessage}`)],
    ["429", providerFailure(429, `(request "${observedRequestId}") ${providerManagedMessage}`)],
    ["500", providerFailure(500, `(request "${observedRequestId}") provider internal failure`)],
    ["malformed provider output", providerFailure("not-http", "secret-body-marker")],
    [
      "timeout transport failure",
      Object.assign(new Error("raw-exception-secret-marker must not escape"), {
        code: "ETIMEDOUT",
        stderr: "secret-body-marker",
      }),
    ],
  ])("keeps every non-authoritative garbage-collection refusal red: %s", async (_name, failure) => {
    const result = await runDigitalOceanRegistryCleanup(
      {
        repository: "chase-sets-platform",
        retentionDays: 7,
        dryRun: false,
        requestedDryRun: false,
        protectedTags: [],
        checkedAt: "2026-07-22T12:00:00.000Z",
      },
      {
        commandOutput: async (_command, args) => {
          if (args.slice(0, 3).join(" ") === "registry repository list-tags") return "[]";
          throw failure;
        },
      },
    );

    expect(result.passesCleanupGate).toBe(false);
    expect(result.record).toMatchObject({
      result: "failure",
      garbageCollection: { status: "failed", reason: "doctl-failed" },
      errors: ["DigitalOcean registry garbage collection could not be started."],
    });
    const serialized = JSON.stringify(result.record);
    expect(serialized).not.toContain("raw-exception-secret-marker");
    expect(serialized).not.toContain("secret-body-marker");
    expect(serialized).not.toContain("provider internal failure");
    expect(result.record.garbageCollection.errors).toEqual([
      expect.stringMatching(/^failure classification: (provider-http|transport|command-exit)$/),
      ...(typeof failure.stderr === "string" && /(?:^|\s)\d{3}\s+/.test(failure.stderr)
        ? [expect.stringMatching(/^provider status: \d{3}$/)]
        : []),
    ]);
  });

  it("keeps malformed registry JSON support-safe and fails before any mutation", async () => {
    const calls = [];
    const result = await runDigitalOceanRegistryCleanup(
      {
        repository: "chase-sets-platform",
        retentionDays: 7,
        dryRun: false,
        requestedDryRun: false,
        protectedTags: [],
        checkedAt: "2026-07-22T12:00:00.000Z",
      },
      {
        commandOutput: async (_command, args) => {
          calls.push(args);
          return '{"secret-body-marker":';
        },
      },
    );

    expect(result.passesCleanupGate).toBe(false);
    expect(result.record).toMatchObject({
      result: "failure",
      deletedTags: [],
      garbageCollection: { status: "skipped", reason: "registry-read-failed" },
      errors: ["DigitalOcean registry tags could not be listed.", "failure classification: invalid-response"],
    });
    expect(calls).toHaveLength(1);
    expect(JSON.stringify(result.record)).not.toContain("secret-body-marker");
  });

  it("classifies transport failures without copying raw exception messages", () => {
    const error = new Error("token=secret-value https://credential.invalid");
    error.code = "ENOTFOUND";

    expect(classifyCommandFailure(error)).toEqual({
      classification: "transport",
      providerStatus: null,
      providerManagedGarbageCollection: false,
    });
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
            const error = new Error("delete failed with token=secret-value");
            error.code = 1;
            error.stderr = "permission denied for provider object secret-image";
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
        errors: ["failure classification: command-exit"],
      },
    ]);
    expect(JSON.stringify(result.record)).not.toContain("secret-value");
    expect(JSON.stringify(result.record)).not.toContain("secret-image");
    expect(result.record.garbageCollection).toEqual({ status: "skipped", reason: "delete-failed" });
  });
});
