import { describe, expect, it, vi } from "vitest";
import { runActivationCommand } from "../scripts/activate-agent-grant-revocation.mjs";
import type { AgentGrantRevocations, RevocationActivationProof } from "@chase-sets/identity/server";

function proof(): RevocationActivationProof {
  return {
    environment: "production",
    namespace: "synthetic",
    releaseCommit: "a".repeat(40),
    imageDigest: `sha256:${"b".repeat(64)}`,
    evidenceId: "synthetic-run",
    fenceId: "synthetic-fence",
    capturedAt: new Date().toISOString(),
    expectedReplicas: ["api", "worker"],
    replicas: ["platform-api", "platform-worker"].map((role, index) => ({
      id: index ? "worker" : "api",
      uid: `synthetic-${index}`,
      role: role as "platform-api" | "platform-worker",
      commit: "a".repeat(40),
      digest: `sha256:${"b".repeat(64)}`,
      supportVersion: 1,
    })),
  };
}

describe("revocation-floor activation command", () => {
  it("never emits an activated receipt when Identity refuses or loses the commit response", async () => {
    const captured = proof();
    const write = vi.fn();
    await expect(
      runActivationCommand({
        owner: {
          activationProof: async () => undefined,
          activate: async () => {
            throw new Error("synthetic-lost-reply");
          },
        },
        environment: "production",
        readProof: async () => captured,
        write,
      }),
    ).rejects.toThrow("synthetic-lost-reply");
    expect(write).not.toHaveBeenCalled();
  });
  it("routes an old exact replay through the authoritative owner instead of a time-based reactivation", async () => {
    const captured = { ...proof(), capturedAt: "2020-01-01T00:00:00.000Z" };
    const activate = vi.fn();
    const write = vi.fn();
    await runActivationCommand({
      owner: { activationProof: async () => captured, activate },
      environment: "production",
      readProof: async () => captured,
      write,
    });
    expect(activate).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(expect.objectContaining({ state: "activated" }));
  });
  it("calls the deployed Identity port with trusted context and revalidates before claiming success", async () => {
    const captured = proof();
    const readProof = vi.fn(async () => captured);
    const write = vi.fn();
    const activate = vi.fn<AgentGrantRevocations["activate"]>(async (_proof, context, fence) => {
      expect(context.audit.performedByUserId).toBe("usr_identity_deployment");
      expect(write).not.toHaveBeenCalledWith(expect.objectContaining({ state: "activated" }));
      expect(await fence.revalidate()).toEqual(captured);
    });
    await runActivationCommand({
      owner: { activate, activationProof: async () => undefined },
      environment: "production",
      readProof,
      write,
    });
    expect(activate).toHaveBeenCalledTimes(1);
    expect(readProof).toHaveBeenCalledTimes(2);
    expect(write.mock.calls.map(([item]) => item.state)).toEqual(["revalidate", "activated"]);
  });
  it.each(["foreign", "old-worker", "incomplete", "stale"])(
    "refuses %s proof without an Identity activation call",
    async (poison) => {
      const captured = proof();
      const changed = structuredClone(captured);
      if (poison === "old-worker") Object.assign(changed.replicas[1], { supportVersion: 0 });
      if (poison === "incomplete") Object.assign(changed, { replicas: captured.replicas.slice(0, 1) });
      if (poison === "stale") Object.assign(changed, { capturedAt: "2020-01-01T00:00:00.000Z" });
      const activate = vi.fn();
      await expect(
        runActivationCommand({
          owner: { activate, activationProof: async () => undefined },
          environment: poison === "foreign" ? "staging" : "production",
          readProof: async () => changed,
          write: vi.fn(),
        }),
      ).rejects.toThrow();
      expect(activate).not.toHaveBeenCalled();
    },
  );
});
