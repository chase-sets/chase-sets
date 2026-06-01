import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  ACCOUNT_CANARY_EVIDENCE_VERSION,
  buildAccountCanaryEvidence,
  parseAccountCanaryEvidenceArgs,
  runAccountCanaryEvidence,
} from "./account-canary-evidence.mjs";

const releaseCommit = "0123456789abcdef0123456789abcdef01234567";

describe("account canary evidence", () => {
  it("passes deterministic account canaries only for allowlisted accounts at zero percent", () => {
    const result = buildAccountCanaryEvidence({
      releaseCommit,
      featureKey: "marketplace.public-seller-proof",
      environment: "production",
      accountSubjects: ["acct_1", "account:acct_2"],
      checkedAt: "2026-06-01T12:00:00.000Z",
      policy: {
        percentage: 0,
        allowSubjects: ["account:acct_1", "account:acct_2"],
        optOutSubjects: [],
        killSwitchActive: false,
      },
    });

    expect(result.passesAccountCanaryGate).toBe(true);
    expect(result.record).toMatchObject({
      schemaVersion: ACCOUNT_CANARY_EVIDENCE_VERSION,
      promotionDecision: "promote",
      cohort: { subjectType: "account", size: 2, subjects: ["account:acct_1", "account:acct_2"] },
      releaseHealth: {
        canaryCohortSubjectType: "account",
        canaryCohortSize: 2,
        canaryPromotionDecision: "promote",
      },
    });
  });

  it("aborts when percentage rollout starts before account canary evidence passes", () => {
    const result = buildAccountCanaryEvidence({
      releaseCommit,
      featureKey: "marketplace.public-seller-proof",
      environment: "production",
      accountSubjects: ["account:acct_1"],
      policy: {
        percentage: 5,
        allowSubjects: ["account:acct_1"],
        optOutSubjects: [],
        killSwitchActive: false,
      },
    });

    expect(result.passesAccountCanaryGate).toBe(false);
    expect(result.record.promotionDecision).toBe("abort");
    expect(result.record.blockers).toContain(
      "Percentage rollout must remain 0 until deterministic account canary evidence passes.",
    );
  });

  it("aborts when kill switch or opt-out disables the canary account", () => {
    const result = buildAccountCanaryEvidence({
      releaseCommit,
      featureKey: "marketplace.public-seller-proof",
      environment: "production",
      accountSubjects: ["account:acct_1"],
      policy: {
        percentage: 0,
        allowSubjects: ["account:acct_1"],
        optOutSubjects: ["account:acct_1"],
        killSwitchActive: true,
      },
    });

    expect(result.passesAccountCanaryGate).toBe(false);
    expect(result.record.blockers).toContain("Kill switch is active; account canary must abort.");
    expect(result.record.decisions[0]).toMatchObject({ enabled: false, reason: "disabled-by-kill-switch" });
  });

  it("writes account canary evidence from a policy file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chase-sets-account-canary-"));
    const policyFile = join(directory, "policy.json");
    const outFile = join(directory, "account-canary.json");
    await writeFile(
      policyFile,
      `${JSON.stringify({
        featureKey: "marketplace.public-seller-proof",
        policy: { percentage: 0, allowSubjects: ["account:acct_1"], optOutSubjects: [], killSwitchActive: false },
      })}\n`,
    );

    const result = await runAccountCanaryEvidence({
      outPath: outFile,
      policyPath: policyFile,
      releaseCommit,
      accountSubjects: ["acct_1"],
      checkedAt: "2026-06-01T12:00:00.000Z",
    });

    expect(result.passesAccountCanaryGate).toBe(true);
    expect(JSON.parse(await readFile(outFile, "utf8"))).toEqual(result.record);
  });

  it("parses CLI and environment defaults", () => {
    const parsed = parseAccountCanaryEvidenceArgs(["--account", "acct_1"], {
      ACCOUNT_CANARY_EVIDENCE_OUT: "artifacts/release-health/account-canary.json",
      ACCOUNT_CANARY_POLICY_FILE: "policy.json",
      RELEASE_COMMIT: releaseCommit,
      ACCOUNT_CANARY_FEATURE_KEY: "marketplace.public-seller-proof",
      ACCOUNT_CANARY_ACCOUNTS: "account:acct_2",
    });

    expect(parsed).toMatchObject({
      outPath: "artifacts/release-health/account-canary.json",
      policyPath: "policy.json",
      releaseCommit,
      featureKey: "marketplace.public-seller-proof",
      accountSubjects: ["acct_1", "account:acct_2"],
    });
  });
});
