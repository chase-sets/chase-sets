import { describe, expect, it, vi } from "vitest";
import { runScrydexCoordinatePreview } from "./scrydex-coordinate-preview-runner";

const runner = {
  sha: "a".repeat(40),
  runId: "123",
  runAttempt: "1",
  journeyScope: "scrydex-coordinate-preview" as const,
  origin: "admin.staging.chasesets.com" as const,
};
const generation = {
  runId: "900",
  runAttempt: 1,
  jobId: "901",
  jobCompletedAt: "2026-10-20T15:00:00Z",
  deployedHead: "b".repeat(40),
  imageDigest: `sha256:${"c".repeat(64)}`,
};

describe("runScrydexCoordinatePreview", () => {
  it("refuses missing credentials before any producer or provider transport", async () => {
    const produce = vi.fn();
    const receipt = await runScrydexCoordinatePreview({
      runner,
      credentialsPresent: false,
      selectDeployment: async () => ({ generation }),
      signIn: async () => undefined,
      produce,
      now: () => "2026-10-20T16:00:00Z",
    });
    expect(produce).not.toHaveBeenCalled();
    expect(receipt.outcome).toBe("governed-unknown");
    expect(receipt.reasons).toContain("credentials-missing");
    expect(receipt.requests.forbidden).toBe(0);
  });

  it("keeps a denied producer failure diagnostic and never promotes it", async () => {
    const receipt = await runScrydexCoordinatePreview({
      runner,
      credentialsPresent: true,
      selectDeployment: async () => ({ generation }),
      signIn: async () => undefined,
      produce: async () => {
        throw new Error("synthetic provider transport denied");
      },
      now: () => "2026-10-20T16:00:00Z",
    });
    expect(receipt.outcome).toBe("governed-unknown");
    expect(receipt.reasons).toEqual(expect.arrayContaining(["producer-failed", "preview-missing"]));
    expect(receipt.requests.previewPosts).toBe(0);
  });
});
