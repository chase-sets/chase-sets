import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  EMERGENCY_RECOVERY_GUIDE_VERSION,
  buildEmergencyRecoveryGuide,
  parseEmergencyRecoveryGuideArgs,
  runEmergencyRecoveryGuide,
} from "./emergency-recovery-guide.mjs";
import { parseReleaseDispatchContractArgs, validateReleaseDispatchContract } from "./release-dispatch-contract.mjs";

const targetCommit = "0123456789abcdef0123456789abcdef01234567";

describe("emergency recovery guide", () => {
  it("guides rollback readiness without allowing release-lock bypass", () => {
    const result = buildEmergencyRecoveryGuide({
      mode: "rollback-readiness",
      emergencyReference: "INC-2026-06-01-001",
      targetCommit,
      releaseTag: "release-20260601120000-01234567",
      imageRef: "registry.digitalocean.com/chase-sets/chase-sets-platform:release-20260601120000-01234567",
      checkedAt: "2026-06-01T12:00:00.000Z",
    });

    expect(result.passesEmergencyRecoveryGuide).toBe(true);
    expect(result.record).toMatchObject({
      schemaVersion: EMERGENCY_RECOVERY_GUIDE_VERSION,
      mode: "rollback-readiness",
      lockBypassAllowed: false,
      kubernetesRollback: {
        platform: "doks",
        release: "chase-sets-platform",
        namespace: "chase-sets-platform",
        timeout: "15m",
      },
      result: "ready",
    });
  });

  it.each(["fix-forward", "revert"])("emits a contract-valid %s production dispatch", (mode) => {
    const result = buildEmergencyRecoveryGuide({
      mode,
      emergencyReference: "INC-2026-06-01-001",
      targetCommit,
      recoveryPullRequest: "https://github.com/chase-sets/chase-sets/pull/999",
      checkedAt: "2026-06-01T12:00:00.000Z",
    });

    expect(result.passesEmergencyRecoveryGuide).toBe(true);
    expect(result.record).toMatchObject({
      lockBypassAllowed: true,
      productionDispatchInputs: {
        release_ref: targetCommit,
        dispatch_source: "emergency",
        reason: `Emergency ${mode} recovery for https://github.com/chase-sets/chase-sets/pull/999.`,
        emergency_release: true,
        emergency_reference: "INC-2026-06-01-001",
      },
    });

    const dispatch = result.record.productionDispatchInputs;
    const contract = parseReleaseDispatchContractArgs([], {
      RELEASE_COMMIT: dispatch.release_ref,
      DISPATCH_SOURCE: dispatch.dispatch_source,
      DISPATCH_REASON: dispatch.reason,
      EMERGENCY_RELEASE: String(dispatch.emergency_release),
      EMERGENCY_REFERENCE: dispatch.emergency_reference,
    });
    expect(validateReleaseDispatchContract(contract).errors).toEqual([]);
  });

  it("blocks recovery without an emergency reference", () => {
    const result = buildEmergencyRecoveryGuide({
      mode: "revert",
      recoveryPullRequest: "PR-999",
    });

    expect(result.passesEmergencyRecoveryGuide).toBe(false);
    expect(result.record.lockBypassAllowed).toBe(false);
    expect(result.record.blockers).toContain("Emergency reference is required for every guided recovery path.");
  });

  it("writes a summary artifact", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chase-sets-emergency-recovery-"));
    const outFile = join(directory, "guide.json");
    const result = await runEmergencyRecoveryGuide({
      outPath: outFile,
      mode: "fix-forward",
      emergencyReference: "INC-2026-06-01-001",
      targetCommit,
      recoveryPullRequest: "PR-999",
      checkedAt: "2026-06-01T12:00:00.000Z",
    });

    expect(JSON.parse(await readFile(outFile, "utf8"))).toEqual(result.record);
  });

  it("parses CLI and environment defaults", () => {
    expect(
      parseEmergencyRecoveryGuideArgs(["--mode", "rollback"], {
        EMERGENCY_RECOVERY_GUIDE_OUT: "artifacts/release-health/emergency-recovery-guide.json",
        EMERGENCY_RELEASE_REFERENCE: "INC-1",
        RECOVERY_TARGET_COMMIT: targetCommit,
        CHASE_SETS_HELM_RELEASE: "release-from-env",
        CHASE_SETS_KUBERNETES_NAMESPACE: "namespace-from-env",
        CHASE_SETS_KUBERNETES_ROLLOUT_TIMEOUT: "20m",
      }),
    ).toMatchObject({
      outPath: "artifacts/release-health/emergency-recovery-guide.json",
      mode: "rollback",
      emergencyReference: "INC-1",
      targetCommit,
      kubernetesRelease: "release-from-env",
      kubernetesNamespace: "namespace-from-env",
      kubernetesTimeout: "20m",
    });
  });

  it("records the exact DOKS rollback command for validated rollback mode", () => {
    const result = buildEmergencyRecoveryGuide({
      mode: "rollback",
      emergencyReference: "INC-2026-06-01-001",
      targetCommit,
      releaseTag: "release-20260601120000-01234567",
      imageRef: "registry.digitalocean.com/chase-sets/chase-sets-platform:release-20260601120000-01234567",
      checkedAt: "2026-06-01T12:00:00.000Z",
    });

    expect(result.record.kubernetesRollback.commandText).toBe(
      "pnpm run platform:kubernetes-deployment -- rollback --release chase-sets-platform --namespace chase-sets-platform --timeout 15m",
    );
    expect(result.record.nextActions).toEqual(
      expect.arrayContaining([expect.stringContaining("Execute the source-owned DOKS rollback")]),
    );
  });
});
