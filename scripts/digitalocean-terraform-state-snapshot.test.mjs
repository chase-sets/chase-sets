import { describe, expect, it } from "vitest";
import {
  DEFAULT_TERRAFORM_STATE_KEYS,
  DIGITALOCEAN_TERRAFORM_STATE_SNAPSHOT_VERSION,
  archiveKeyForStateKey,
  runTerraformStateSnapshot,
  selectExpiredArchiveKeys,
} from "./digitalocean-terraform-state-snapshot.mjs";

describe("digitalocean-terraform-state-snapshot", () => {
  it("builds dated archive keys under the configured prefix", () => {
    expect(
      archiveKeyForStateKey("/landing/staging.tfstate", {
        archivePrefix: "/state-archive/",
        checkedAt: "2026-07-02T18:30:00.000Z",
      }),
    ).toBe("state-archive/2026-07-02/landing/staging.tfstate");
  });

  it("selects archive objects older than the retention window", () => {
    expect(
      selectExpiredArchiveKeys(
        [
          { Key: "state-archive/2026-06-01/landing/staging.tfstate" },
          { Key: "state-archive/2026-06-15/landing/staging.tfstate" },
          { Key: "state-archive/not-a-date/landing/staging.tfstate" },
          { Key: "platform/previews/pr-123.tfstate" },
        ],
        {
          checkedAt: "2026-07-02T18:30:00.000Z",
          retentionDays: 30,
        },
      ),
    ).toEqual(["state-archive/2026-06-01/landing/staging.tfstate"]);
  });

  it("copies durable state keys and prunes expired archive objects without reading state bodies", async () => {
    const calls = [];
    const result = await runTerraformStateSnapshot(
      {
        bucket: "chase-sets-terraform-state",
        endpointUrl: "https://nyc3.digitaloceanspaces.com",
        archivePrefix: "state-archive",
        retentionDays: 30,
        checkedAt: "2026-07-02T18:30:00.000Z",
        stateKeys: ["landing/staging.tfstate", "catalog-assets/production.tfstate"],
      },
      {
        commandOutput: async (_command, args) => {
          calls.push(args);
          if (args[1] === "copy-object") {
            return JSON.stringify({ CopyObjectResult: { ETag: '"copy-etag"' } });
          }
          if (args[1] === "delete-object") {
            return "{}";
          }
          throw new Error(`Unexpected commandOutput call: ${args.join(" ")}`);
        },
        commandJson: async (_command, args) => {
          calls.push(args);
          if (args[1] === "head-object") {
            return {
              ContentLength: 1234,
              LastModified: "2026-07-02T18:00:00.000Z",
              ETag: '"source-etag"',
            };
          }
          if (args[1] === "list-objects-v2") {
            return {
              Contents: [
                { Key: "state-archive/2026-06-01/landing/staging.tfstate" },
                { Key: "state-archive/2026-07-01/landing/staging.tfstate" },
              ],
            };
          }
          throw new Error(`Unexpected commandJson call: ${args.join(" ")}`);
        },
      },
    );

    expect(result.passesSnapshotGate).toBe(true);
    expect(result.record).toMatchObject({
      schemaVersion: DIGITALOCEAN_TERRAFORM_STATE_SNAPSHOT_VERSION,
      result: "success",
      archiveDate: "2026-07-02",
      snapshots: [
        {
          stateKey: "landing/staging.tfstate",
          archiveKey: "state-archive/2026-07-02/landing/staging.tfstate",
          sizeBytes: 1234,
          status: "copied",
        },
        {
          stateKey: "catalog-assets/production.tfstate",
          archiveKey: "state-archive/2026-07-02/catalog-assets/production.tfstate",
          sizeBytes: 1234,
          status: "copied",
        },
      ],
      prunedArchiveKeys: ["state-archive/2026-06-01/landing/staging.tfstate"],
      errors: [],
    });
    expect(calls.some((args) => args.includes("get-object"))).toBe(false);
    expect(calls).toContainEqual([
      "s3api",
      "copy-object",
      "--bucket",
      "chase-sets-terraform-state",
      "--key",
      "state-archive/2026-07-02/landing/staging.tfstate",
      "--copy-source",
      "/chase-sets-terraform-state/landing/staging.tfstate",
      "--metadata-directive",
      "COPY",
      "--endpoint-url",
      "https://nyc3.digitaloceanspaces.com",
    ]);
  });

  it("uses the durable state key set and excludes disposable PR preview state", () => {
    expect(DEFAULT_TERRAFORM_STATE_KEYS).toEqual([
      "landing/staging.tfstate",
      "landing/production.tfstate",
      "environment-dns/staging.tfstate",
      "catalog-assets/preview.tfstate",
      "catalog-assets/staging.tfstate",
      "catalog-assets/production.tfstate",
      "observability/shared.tfstate",
      "seed-packs/shared.tfstate",
    ]);
    expect(DEFAULT_TERRAFORM_STATE_KEYS.some((key) => key.startsWith("platform/previews/"))).toBe(false);
  });

  it("fails the gate when a state object cannot be snapshotted", async () => {
    const result = await runTerraformStateSnapshot(
      {
        bucket: "chase-sets-terraform-state",
        endpointUrl: "https://nyc3.digitaloceanspaces.com",
        archivePrefix: "state-archive",
        retentionDays: 30,
        checkedAt: "2026-07-02T18:30:00.000Z",
        stateKeys: ["landing/staging.tfstate"],
      },
      {
        commandJson: async (_command, args) => {
          if (args[1] === "head-object") {
            throw new Error("object not found");
          }
          if (args[1] === "list-objects-v2") {
            return { Contents: [] };
          }
          throw new Error(`Unexpected commandJson call: ${args.join(" ")}`);
        },
      },
    );

    expect(result.passesSnapshotGate).toBe(false);
    expect(result.record.result).toBe("failure");
    expect(result.record.errors[0]).toBe("1 Terraform state object(s) could not be snapshotted.");
    expect(result.record.snapshots[0]).toMatchObject({
      stateKey: "landing/staging.tfstate",
      status: "failed",
      errors: expect.arrayContaining([expect.stringContaining("object not found")]),
    });
  });
});
