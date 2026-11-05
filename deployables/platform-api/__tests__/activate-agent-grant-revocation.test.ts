import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  activationDiagnostic,
  activationRefusalCode,
  runActivationCommand,
} from "../scripts/activate-agent-grant-revocation.mjs";
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
  it("activates a staging proof only inside a staging pod", async () => {
    const captured = { ...proof(), environment: "staging" as const };
    const activate = vi.fn();
    await runActivationCommand({
      owner: { activate, activationProof: async () => undefined },
      environment: "staging",
      readProof: async () => captured,
      write: vi.fn(),
    });
    expect(activate).toHaveBeenCalledTimes(1);
    await expect(
      runActivationCommand({
        owner: { activate, activationProof: async () => undefined },
        environment: "production",
        readProof: async () => captured,
        write: vi.fn(),
      }),
    ).rejects.toThrow("revocation_activation_environment_mismatch");
    expect(activate).toHaveBeenCalledTimes(1);
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
  it.each([
    [
      "an Identity refusal",
      new Error("revocation_dormant_request_unresolved"),
      "revocation_dormant_request_unresolved",
    ],
    ["a raw database error", new Error("connect postgres://user:synthetic-secret@db"), "revocation_activation_refused"],
    ["an unbounded code", new Error(`revocation_${"a".repeat(65)}`), "revocation_activation_refused"],
    ["a thrown string", "revocation_status_unavailable", "revocation_activation_refused"],
  ])("crosses the pod boundary with only a bounded code for %s", (_name, error, code) => {
    expect(activationRefusalCode(error)).toBe(code);
  });
  it("extracts only a typed SQLSTATE class and finite category", () => {
    const error = Object.assign(new Error(`raw ${"secret-marker"}`), {
      code: "42501",
      failureCategory: "schema_permission",
    });
    expect(activationDiagnostic(error, proof())).toMatchObject({
      code: "revocation_activation_refused",
      sqlstateClass: "42",
      failureCategory: "schema_permission",
      identity: { state: "unknown" },
    });
    expect(JSON.stringify(activationDiagnostic(error, proof()))).not.toContain("secret-marker");
    expect(activationDiagnostic(new Error("raw secret-marker"), proof()).sqlstateClass).toBe("unknown");
    expect(activationDiagnostic(new Error("raw secret-marker"), proof()).failureCategory).toBe("unknown");
  });
  it("retains validated proof identity in the entrypoint refusal diagnostic", async () => {
    const captured = proof();
    const failure = new Error("raw secret-marker");
    await expect(
      runActivationCommand({
        owner: {
          activationProof: async () => undefined,
          activate: async () => {
            throw failure;
          },
        },
        environment: captured.environment,
        readProof: async () => captured,
        write: vi.fn(),
      }),
    ).rejects.toBe(failure);
    const emitted = JSON.parse(JSON.stringify(activationDiagnostic(failure)));
    expect(emitted).toMatchObject({
      environment: captured.environment,
      releaseCommit: captured.releaseCommit,
      imageDigest: captured.imageDigest,
    });
    expect(JSON.stringify(emitted)).not.toContain("secret-marker");
  });
  it("prints the bounded code, never a generic or raw refusal, from the entrypoint", () => {
    const source = readFileSync(new URL("../scripts/activate-agent-grant-revocation.mts", import.meta.url), "utf8");
    const normalized = source.replaceAll("\r\n", "\n");
    expect(normalized).toContain(
      "main().catch((error: unknown) => {\n    process.stderr.write(`${activationRefusalCode(error)}\\n`);",
    );
    expect(normalized.indexOf("process.stderr.write(`${activationRefusalCode(error)}\\n`);")).toBeLessThan(
      normalized.indexOf("process.exitCode = 1;"),
    );
    expect(normalized).toContain("process.stderr.write(`${JSON.stringify(activationDiagnostic(error))}\\n`);");
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
