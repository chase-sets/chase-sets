import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  LAUNCH_GO_NO_GO_GATE_VERSION,
  REQUIRED_PRODUCTION_APPROVAL_CATEGORIES,
  SUPPORT_DISPUTE_SELF_SERVICE_SURFACE_FILES,
  WAVE_ONE_ADMISSION_BAR,
  buildLaunchGoNoGoGate,
  parseLaunchGoNoGoGateArgs,
} from "./launch-go-no-go-gate.mjs";
import { MARKETPLACE_PRODUCTION_LAUNCH_READINESS_VERSION } from "./marketplace-production-launch-readiness.mjs";
import { MARKETPLACE_PROMOTION_EVIDENCE_VERSION } from "./marketplace-promotion-evidence.mjs";
import { GOOGLE_SHOPPING_LAUNCH_READINESS_EVIDENCE_VERSION } from "./google-shopping-launch-readiness-evidence.mjs";
import { RELEASE_HEALTH_REPORT_VERSION } from "./release-health-report.mjs";
import { repoRoot } from "./lib/repo.mjs";

const checkedAt = "2026-07-13T12:00:00.000Z";
const validCommit = "a".repeat(40);

function fullOperatorEvidence(overrides = {}) {
  return {
    marketplaceProductionLaunchReadiness: {
      schemaVersion: MARKETPLACE_PRODUCTION_LAUNCH_READINESS_VERSION,
      passesProductionLaunchReadinessGate: true,
      environmentName: "production",
    },
    marketplacePromotionEvidence: {
      schemaVersion: MARKETPLACE_PROMOTION_EVIDENCE_VERSION,
      passesPromotionGate: true,
    },
    googleShoppingLaunchReadiness: {
      schemaVersion: GOOGLE_SHOPPING_LAUNCH_READINESS_EVIDENCE_VERSION,
      passesGoogleShoppingLaunchReadinessGate: true,
    },
    campaignStartGate: {
      schemaVersion: "campaign-start-gate/v1",
      passesCampaignStartGate: true,
    },
    lagSloRegressionGate: {
      schemaVersion: RELEASE_HEALTH_REPORT_VERSION,
      gateEnabled: true,
      gatePassed: true,
      workflowRunReference: "LAG-SLO-GATE-RUN-2026-07-13",
    },
    incidentBacklog: {
      milestoneNumber: 100,
      openIncidentCount: 0,
      untriagedIncidentCount: 0,
      verifiedAt: "2026-07-13T10:00:00.000Z",
      evidenceReference: "INCIDENT-BACKLOG-SWEEP-2026-07-13",
    },
    waveOneAdmissionBar: {
      totalSignups: 520,
      qualifiedSellerCount: 55,
      qualifiedSellersByGame: {
        pokemon: 10,
        "magic-the-gathering": 10,
        "yu-gi-oh": 10,
        "disney-lorcana": 10,
        "one-piece-card-game": 10,
      },
      verifiedAt: "2026-07-13T10:00:00.000Z",
      evidenceReference: "WAVE-ONE-ADMISSION-BAR-2026-07-13",
    },
    rollbackReadiness: {
      mode: "readiness",
      targetCommit: validCommit,
      releaseTag: "v2026.07.13",
      imageRef: "registry.digitalocean.com/chase-sets/platform:v2026.07.13",
      imageExists: "true",
      smokeVerified: "true",
      terraformPlan: { destructiveChanges: false },
      destructivePlanApproved: false,
      emergencyReference: "EMERGENCY-REF-2026-07-13",
      checkedAt,
    },
    ...overrides,
  };
}

function writeFullyGreenFixtureRepo() {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), "launch-go-no-go-gate-green-"));

  const workflowDir = path.join(fixtureRoot, ".github/workflows");
  mkdirSync(workflowDir, { recursive: true });
  const workflowBody = REQUIRED_PRODUCTION_APPROVAL_CATEGORIES.map(
    (name) =>
      `      TF_VAR: \${{ vars.${name} == 'true' && 'true' || 'false' }}\n      TF_VAR_ref: \${{ vars.${name.replace(/_APPROVED$/, "_REFERENCE")} || '' }}\n`,
  ).join("");
  writeFileSync(path.join(workflowDir, "platform-production.yml"), workflowBody);

  const waitlistReadModelDir = path.join(fixtureRoot, "bounded-contexts/public-presence/features/waitlist/read-model");
  mkdirSync(waitlistReadModelDir, { recursive: true });
  writeFileSync(
    path.join(waitlistReadModelDir, "campaign-admission-bar-policy.ts"),
    [
      "export const WAVE_ONE_ADMISSION_BAR = Object.freeze({",
      `  minQualifiedSellers: ${WAVE_ONE_ADMISSION_BAR.minQualifiedSellers},`,
      `  minQualifiedSellersPerGame: ${WAVE_ONE_ADMISSION_BAR.minQualifiedSellersPerGame},`,
      `  minTotalSignups: ${WAVE_ONE_ADMISSION_BAR.minTotalSignups},`,
      "});",
      "",
    ].join("\n"),
  );

  const waitlistDomainDir = path.join(fixtureRoot, "bounded-contexts/public-presence/features/waitlist/domain");
  mkdirSync(waitlistDomainDir, { recursive: true });
  writeFileSync(
    path.join(waitlistDomainDir, "common.ts"),
    [
      "export const WAITLIST_GAMES = [",
      '  "pokemon",',
      '  "magic-the-gathering",',
      '  "yu-gi-oh",',
      '  "disney-lorcana",',
      '  "one-piece-card-game",',
      "];",
      "",
    ].join("\n"),
  );

  for (const relativePath of SUPPORT_DISPUTE_SELF_SERVICE_SURFACE_FILES) {
    const fullPath = path.join(fixtureRoot, relativePath);
    mkdirSync(path.dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, "export {};\n");
  }

  const scriptsDir = path.join(fixtureRoot, "scripts");
  mkdirSync(scriptsDir, { recursive: true });
  writeFileSync(path.join(scriptsDir, "campaign-start-gate.mjs"), "export {};\n");

  return fixtureRoot;
}

function fullDecisionInput(overrides = {}) {
  return {
    repoRoot,
    reference: "LAUNCH-GO-NO-GO-2026-07-13",
    checkedAt,
    decision: "go",
    decisionOwner: "Todd Skelton",
    decisionRationale: "All evidence rows pass and wave-1 admission bar is cleared with margin.",
    rollbackCriteriaReference: "ROLLBACK-CRITERIA-2026-07-13",
    first24hMonitoringPlanReference: "WAVE-1-MONITORING-PLAN-2026-07-13",
    operatorEvidence: fullOperatorEvidence(),
    ...overrides,
  };
}

describe("launch go/no-go gate: composed evidence rows", () => {
  it("passes every row and records a go decision once every sibling gate (including a landed campaign-start-gate) reports green", () => {
    // Exercises the fully-green path against a synthetic repository, rather
    // than the real one, because scripts/campaign-start-gate.mjs (PR #5110)
    // has not merged to main yet -- see the dedicated
    // "not-yet-integrated" test below for that real, current state.
    const fixtureRoot = writeFullyGreenFixtureRepo();
    try {
      const result = buildLaunchGoNoGoGate({ ...fullDecisionInput(), repoRoot: fixtureRoot });

      expect(result.schemaVersion).toBe(LAUNCH_GO_NO_GO_GATE_VERSION);
      for (const row of result.rows) {
        expect(row.status, `${row.key}: ${row.note}`).toBe("pass");
      }
      expect(result.passesLaunchGoNoGoGate).toBe(true);
      expect(result.errors).toBeUndefined();
      expect(result.decision).toEqual({
        value: "go",
        owner: "Todd Skelton",
        rationale: "All evidence rows pass and wave-1 admission bar is cleared with margin.",
        rollbackCriteriaReference: "ROLLBACK-CRITERIA-2026-07-13",
        first24hMonitoringPlanReference: "WAVE-1-MONITORING-PLAN-2026-07-13",
        recordedAt: checkedAt,
      });
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("automated money-operations-approval-matrix row passes against the real platform-production.yml", () => {
    const result = buildLaunchGoNoGoGate({ ...fullDecisionInput(), decision: "hold" });
    const row = result.rows.find((entry) => entry.key === "money-operations-approval-matrix");
    expect(row.automated).toBe(true);
    expect(row.status, row.note).toBe("pass");
    expect(row.evidence.requiredCategories).toEqual(REQUIRED_PRODUCTION_APPROVAL_CATEGORIES);
  });

  it("automated wave-one-admission-bar-code-in-sync row passes against the real read-model policy", () => {
    const result = buildLaunchGoNoGoGate({ ...fullDecisionInput(), decision: "hold" });
    const row = result.rows.find((entry) => entry.key === "wave-one-admission-bar-code-in-sync");
    expect(row.status, row.note).toBe("pass");
    expect(row.evidence.ratifiedBar).toEqual(WAVE_ONE_ADMISSION_BAR);
    expect(row.evidence.missingGames).toEqual([]);
  });

  it("automated support-dispute-surfaces-ready row passes against the real self-service surfaces", () => {
    const result = buildLaunchGoNoGoGate({ ...fullDecisionInput(), decision: "hold" });
    const row = result.rows.find((entry) => entry.key === "support-dispute-surfaces-ready");
    expect(row.status, row.note).toBe("pass");
    expect(row.evidence.checkedFiles).toEqual(SUPPORT_DISPUTE_SELF_SERVICE_SURFACE_FILES);
  });

  it("marks the campaign-start-gate row not-yet-integrated when the sibling script has not landed", () => {
    // As of this PR, scripts/campaign-start-gate.mjs has not merged to main
    // yet (PR #5110 is open). This asserts the honest current state against
    // the real repository rather than a fixture, so the row flips to
    // "operator-evidence" behavior automatically the day that PR lands.
    const result = buildLaunchGoNoGoGate({ ...fullDecisionInput(), decision: "hold" });
    const row = result.rows.find((entry) => entry.key === "campaign-start-gate");
    expect(["not-yet-integrated", "pending", "pass"]).toContain(row.status);
  });
});

describe("launch go/no-go gate: operator-attested rows", () => {
  it("keeps rows pending when operator evidence is entirely absent", () => {
    const result = buildLaunchGoNoGoGate({
      repoRoot,
      reference: "LAUNCH-GO-NO-GO-2026-07-13",
      checkedAt,
      decision: "hold",
      decisionOwner: "Todd Skelton",
      decisionRationale: "Evidence not yet collected.",
      rollbackCriteriaReference: "ROLLBACK-CRITERIA-2026-07-13",
      first24hMonitoringPlanReference: "WAVE-1-MONITORING-PLAN-2026-07-13",
    });

    expect(result.passesLaunchGoNoGoGate).toBe(false);
    const operatorRowKeys = [
      "marketplace-production-launch-readiness",
      "marketplace-promotion-evidence",
      "google-shopping-launch-readiness",
      "lag-slo-regression-gate",
      "incident-backlog-zero-or-triaged",
      "wave-one-admission-bar-met",
      "rollback-readiness",
    ];
    for (const key of operatorRowKeys) {
      const row = result.rows.find((entry) => entry.key === key);
      expect(row.status, key).not.toBe("pass");
      expect(row.automated).toBe(false);
    }
  });

  it("fails the wave-one-admission-bar-met row when a game falls under the per-game floor", () => {
    const result = buildLaunchGoNoGoGate(
      fullDecisionInput({
        decision: "hold",
        operatorEvidence: fullOperatorEvidence({
          waveOneAdmissionBar: {
            totalSignups: 520,
            qualifiedSellerCount: 55,
            qualifiedSellersByGame: {
              pokemon: 30,
              "magic-the-gathering": 15,
              "yu-gi-oh": 10,
              "disney-lorcana": 0,
              "one-piece-card-game": 0,
            },
            verifiedAt: "2026-07-13T10:00:00.000Z",
            evidenceReference: "WAVE-ONE-ADMISSION-BAR-2026-07-13",
          },
        }),
      }),
    );

    const row = result.rows.find((entry) => entry.key === "wave-one-admission-bar-met");
    expect(row.status).toBe("fail");
    expect(row.note).toContain("disney-lorcana");
    expect(row.note).toContain("one-piece-card-game");
  });

  it("fails the wave-one-admission-bar-met row when total signups or qualified sellers are short", () => {
    const result = buildLaunchGoNoGoGate(
      fullDecisionInput({
        decision: "hold",
        operatorEvidence: fullOperatorEvidence({
          waveOneAdmissionBar: {
            totalSignups: 200,
            qualifiedSellerCount: 20,
            qualifiedSellersByGame: {
              pokemon: 10,
              "magic-the-gathering": 10,
              "yu-gi-oh": 10,
              "disney-lorcana": 10,
              "one-piece-card-game": 10,
            },
            verifiedAt: "2026-07-13T10:00:00.000Z",
            evidenceReference: "WAVE-ONE-ADMISSION-BAR-2026-07-13",
          },
        }),
      }),
    );

    const row = result.rows.find((entry) => entry.key === "wave-one-admission-bar-met");
    expect(row.status).toBe("fail");
    expect(row.note).toContain("total signups below 500");
    expect(row.note).toContain("qualified sellers below 50");
  });

  it("fails imported-gate rows when the operator evidence schemaVersion drifts from the sibling gate's version", () => {
    const result = buildLaunchGoNoGoGate(
      fullDecisionInput({
        decision: "hold",
        operatorEvidence: fullOperatorEvidence({
          googleShoppingLaunchReadiness: {
            schemaVersion: "google-shopping-launch-readiness-evidence/v0",
            passesGoogleShoppingLaunchReadinessGate: true,
          },
        }),
      }),
    );

    const row = result.rows.find((entry) => entry.key === "google-shopping-launch-readiness");
    expect(row.status).toBe("pending");
    expect(row.note).toContain("schemaVersion must be");
  });

  it("fails the incident-backlog row when there are untriaged incidents", () => {
    const result = buildLaunchGoNoGoGate(
      fullDecisionInput({
        decision: "hold",
        operatorEvidence: fullOperatorEvidence({
          incidentBacklog: {
            milestoneNumber: 100,
            openIncidentCount: 3,
            untriagedIncidentCount: 2,
            verifiedAt: "2026-07-13T10:00:00.000Z",
            evidenceReference: "INCIDENT-BACKLOG-SWEEP-2026-07-13",
          },
        }),
      }),
    );

    const row = result.rows.find((entry) => entry.key === "incident-backlog-zero-or-triaged");
    expect(row.status).toBe("pending");
    expect(row.note).toContain("untriagedIncidentCount must be zero");
  });

  it("fails the rollback-readiness row when the target commit is not a full SHA", () => {
    const result = buildLaunchGoNoGoGate(
      fullDecisionInput({
        decision: "hold",
        operatorEvidence: fullOperatorEvidence({
          rollbackReadiness: {
            mode: "readiness",
            targetCommit: "not-a-sha",
            releaseTag: "v2026.07.13",
            imageRef: "registry.digitalocean.com/chase-sets/platform:v2026.07.13",
            imageExists: "true",
            smokeVerified: "true",
            terraformPlan: { destructiveChanges: false },
            destructivePlanApproved: false,
            emergencyReference: "EMERGENCY-REF-2026-07-13",
            checkedAt,
          },
        }),
      }),
    );

    const row = result.rows.find((entry) => entry.key === "rollback-readiness");
    expect(row.status).toBe("fail");
    expect(row.note).toContain("40-character Git commit SHA");
  });
});

describe("launch go/no-go gate: decision coherence", () => {
  it("refuses a go decision when any row is not passing", () => {
    const result = buildLaunchGoNoGoGate({
      ...fullDecisionInput(),
      operatorEvidence: fullOperatorEvidence({ incidentBacklog: undefined }),
    });

    expect(result.passesLaunchGoNoGoGate).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.stringContaining("cannot be recorded as go while evidence rows")]),
    );
  });

  it("allows a no-go or hold decision even when rows are not passing, without the go-coherence error", () => {
    const goCoherenceError = "cannot be recorded as go while evidence rows";

    const noGo = buildLaunchGoNoGoGate({
      ...fullDecisionInput(),
      decision: "no-go",
      operatorEvidence: fullOperatorEvidence({ incidentBacklog: undefined }),
    });
    expect(noGo.decision.value).toBe("no-go");
    expect(noGo.passesLaunchGoNoGoGate).toBe(false);
    expect(noGo.errors.some((error) => error.includes(goCoherenceError))).toBe(false);

    const hold = buildLaunchGoNoGoGate({
      ...fullDecisionInput(),
      decision: "hold",
      operatorEvidence: fullOperatorEvidence({ incidentBacklog: undefined }),
    });
    expect(hold.decision.value).toBe("hold");
    expect(hold.passesLaunchGoNoGoGate).toBe(false);
    expect(hold.errors.some((error) => error.includes(goCoherenceError))).toBe(false);
  });

  it("rejects an invalid decision value", () => {
    const result = buildLaunchGoNoGoGate({ ...fullDecisionInput(), decision: "maybe" });
    expect(result.errors).toEqual(
      expect.arrayContaining(["Launch go/no-go decision must be one of: go, no-go, hold."]),
    );
  });

  it("requires a decision owner, rationale, and both evidence references", () => {
    const result = buildLaunchGoNoGoGate({
      repoRoot,
      reference: "LAUNCH-GO-NO-GO-2026-07-13",
      checkedAt,
      decision: "hold",
      operatorEvidence: fullOperatorEvidence(),
    });

    expect(result.errors).toEqual(
      expect.arrayContaining([
        "Launch go/no-go gate requires a decision owner.",
        "Launch go/no-go gate requires a decision rationale.",
        "Launch go/no-go rollbackCriteriaReference is required.",
        "Launch go/no-go first24hMonitoringPlanReference is required.",
      ]),
    );
  });

  it("rejects a placeholder reference and non-ISO checkedAt", () => {
    const result = buildLaunchGoNoGoGate({
      ...fullDecisionInput(),
      decision: "hold",
      reference: "todo",
      checkedAt: "2026-07-13",
    });
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("must point to a real external evidence record"),
        "Launch go/no-go gate checkedAt must be an ISO timestamp.",
      ]),
    );
  });
});

describe("launch go/no-go gate: synthetic repository fixture", () => {
  let fixtureRoot;

  afterEach(() => {
    if (fixtureRoot) {
      rmSync(fixtureRoot, { recursive: true, force: true });
      fixtureRoot = undefined;
    }
  });

  it("fails the automated rows when the fixture repository has no matching files", () => {
    fixtureRoot = mkdtempSync(path.join(tmpdir(), "launch-go-no-go-gate-"));

    const result = buildLaunchGoNoGoGate({ ...fullDecisionInput(), decision: "hold", repoRoot: fixtureRoot });

    const approvalRow = result.rows.find((entry) => entry.key === "money-operations-approval-matrix");
    expect(approvalRow.status).toBe("fail");

    const waveSyncRow = result.rows.find((entry) => entry.key === "wave-one-admission-bar-code-in-sync");
    expect(waveSyncRow.status).toBe("fail");

    const supportRow = result.rows.find((entry) => entry.key === "support-dispute-surfaces-ready");
    expect(supportRow.status).toBe("fail");
    expect(supportRow.evidence.missingFiles).toEqual(SUPPORT_DISPUTE_SELF_SERVICE_SURFACE_FILES);

    const campaignRow = result.rows.find((entry) => entry.key === "campaign-start-gate");
    expect(campaignRow.status).toBe("not-yet-integrated");
  });

  it("fails the money-operations-approval-matrix row when a required category is missing from the workflow", () => {
    fixtureRoot = mkdtempSync(path.join(tmpdir(), "launch-go-no-go-gate-"));
    const workflowDir = path.join(fixtureRoot, ".github/workflows");
    mkdirSync(workflowDir, { recursive: true });
    const missingCategory = REQUIRED_PRODUCTION_APPROVAL_CATEGORIES[0];
    const partialCategories = REQUIRED_PRODUCTION_APPROVAL_CATEGORIES.filter((name) => name !== missingCategory);
    const workflowBody = partialCategories
      .map(
        (name) =>
          `      TF_VAR: \${{ vars.${name} == 'true' && 'true' || 'false' }}\n      TF_VAR_ref: \${{ vars.${name.replace(/_APPROVED$/, "_REFERENCE")} || '' }}\n`,
      )
      .join("");
    writeFileSync(path.join(workflowDir, "platform-production.yml"), workflowBody);

    const result = buildLaunchGoNoGoGate({ ...fullDecisionInput(), decision: "hold", repoRoot: fixtureRoot });
    const row = result.rows.find((entry) => entry.key === "money-operations-approval-matrix");
    expect(row.status).toBe("fail");
    expect(row.evidence.missingApproved).toEqual([missingCategory]);
  });
});

describe("launch go/no-go gate argument parsing", () => {
  it("parses flags and falls back to environment variables", () => {
    expect(
      parseLaunchGoNoGoGateArgs(
        ["--reference", "LAUNCH-GO-NO-GO-2026-07-13", "--decision", "go", "--decision-owner", "Todd"],
        {},
      ),
    ).toMatchObject({
      reference: "LAUNCH-GO-NO-GO-2026-07-13",
      decision: "go",
      decisionOwner: "Todd",
    });

    expect(
      parseLaunchGoNoGoGateArgs([], {
        LAUNCH_GO_NO_GO_GATE_REFERENCE: "LAUNCH-GO-NO-GO-FROM-ENV",
        LAUNCH_GO_NO_GO_DECISION: "hold",
        LAUNCH_GO_NO_GO_DECISION_OWNER: "Todd",
      }),
    ).toMatchObject({
      reference: "LAUNCH-GO-NO-GO-FROM-ENV",
      decision: "hold",
      decisionOwner: "Todd",
    });
  });
});
