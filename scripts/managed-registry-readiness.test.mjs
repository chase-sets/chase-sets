import { describe, expect, it, vi } from "vitest";

import {
  MANAGED_REGISTRY_AUTHORITY,
  managedRegistryReadinessChecks,
  managedRegistryServiceAccountReferenceCheck,
  waitForManagedRegistryAuthority,
} from "./managed-registry-readiness.mjs";

describe("managed registry readiness", () => {
  it("waits boundedly for the managed Secret and default ServiceAccount before its managed reference", async () => {
    const calls = [];
    const times = [0, 1_000];
    const result = await waitForManagedRegistryAuthority({
      namespace: "arbitrary-preview-42",
      timeoutSeconds: 120,
      now: () => times.shift() ?? 1_000,
      run: async (call) => calls.push(call),
    });

    expect(result).toMatchObject({
      authority: MANAGED_REGISTRY_AUTHORITY,
      namespace: "arbitrary-preview-42",
    });
    expect(calls).toEqual([
      {
        command: "kubectl",
        args: ["wait", "--for=create", "secret/chase-sets", "--namespace", "arbitrary-preview-42", "--timeout=120s"],
      },
      {
        command: "kubectl",
        args: [
          "wait",
          "--for=create",
          "serviceaccount/default",
          "--namespace",
          "arbitrary-preview-42",
          "--timeout=120s",
        ],
      },
      {
        command: "kubectl",
        args: [
          "wait",
          '--for=jsonpath={.imagePullSecrets[?(@.name=="chase-sets")].name}=chase-sets',
          "serviceaccount/default",
          "--namespace",
          "arbitrary-preview-42",
          "--timeout=119s",
        ],
      },
    ]);
  });

  it("fails closed with named diagnostics when either provider-created resource is absent", async () => {
    const run = vi.fn().mockRejectedValueOnce(new Error("synthetic Secret absence")).mockResolvedValueOnce(undefined);

    await expect(
      waitForManagedRegistryAuthority({
        namespace: "arbitrary-preview-43",
        timeoutSeconds: 30,
        run,
        now: () => 0,
      }),
    ).rejects.toThrow("managed Secret 'chase-sets' exists in namespace 'arbitrary-preview-43'");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("fails closed when the default ServiceAccount never references the authority", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("synthetic reference absence"));

    await expect(
      waitForManagedRegistryAuthority({
        namespace: "arbitrary-preview-44",
        timeoutSeconds: 30,
        run,
        now: () => 0,
      }),
    ).rejects.toThrow(
      "default ServiceAccount references managed Secret 'chase-sets' in namespace 'arbitrary-preview-44'",
    );
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("rejects unbounded or excessive readiness deadlines", () => {
    for (const timeoutSeconds of [0, 301, 1.5, "forever"]) {
      expect(() => managedRegistryReadinessChecks({ namespace: "arbitrary-preview-45", timeoutSeconds })).toThrow(
        "--timeout-seconds must be a whole number from 1 through 300",
      );
    }
    expect(() =>
      managedRegistryServiceAccountReferenceCheck({
        namespace: "arbitrary-preview-45",
        timeoutSeconds: 0,
      }),
    ).toThrow("--timeout-seconds");
  });
});
