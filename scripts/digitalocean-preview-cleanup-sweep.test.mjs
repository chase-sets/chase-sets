import { describe, expect, it } from "vitest";
import {
  DIGITALOCEAN_PREVIEW_CLEANUP_SWEEP_VERSION,
  cleanupMatrixForTargets,
  discoverPreviewCleanupTargets,
  previewPrNumberFromStateKey,
  selectPreviewStateTargets,
} from "./digitalocean-preview-cleanup-sweep.mjs";

describe("digitalocean-preview-cleanup-sweep", () => {
  it("extracts preview PR numbers only from platform preview state keys", () => {
    expect(previewPrNumberFromStateKey("platform/previews/pr-123.tfstate")).toBe(123);
    expect(previewPrNumberFromStateKey("platform/previews/pr-123.backup")).toBeNull();
    expect(previewPrNumberFromStateKey("landing/staging.tfstate")).toBeNull();
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

  it("builds a cleanup matrix using trusted checkout and image refs", () => {
    expect(
      cleanupMatrixForTargets([{ prNumber: 7, stateKey: "platform/previews/pr-7.tfstate" }], {
        checkoutRef: "main",
        imageSha: "abc123",
      }),
    ).toEqual({
      include: [{ pr_number: 7, checkout_ref: "main", image_sha: "abc123" }],
    });
  });

  it("discovers only closed pull requests with preview state", async () => {
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
      ],
      errors: [],
    });
    expect(result.matrix).toEqual({
      include: [
        { pr_number: 10, checkout_ref: "main", image_sha: "abc123" },
        { pr_number: 12, checkout_ref: "main", image_sha: "abc123" },
      ],
    });
  });
});
