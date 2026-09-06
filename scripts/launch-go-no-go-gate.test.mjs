import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  LAUNCH_GO_NO_GO_GATE_VERSION,
  MARKETPLACE_PROMOTION_EVIDENCE_COMMAND,
  REQUIRED_PRODUCTION_APPROVAL_CATEGORIES,
  SUPPORT_DISPUTE_SELF_SERVICE_SURFACE_FILES,
  WAVE_ONE_ADMISSION_BAR,
  buildLaunchGoNoGoGate,
  parseLaunchGoNoGoGateArgs,
  resolveCanonicalLegalCorpusMembership,
} from "./launch-go-no-go-gate.mjs";
import { MARKETPLACE_PRODUCTION_LAUNCH_READINESS_VERSION } from "./marketplace-production-launch-readiness.mjs";
import { MARKETPLACE_PROMOTION_EVIDENCE_VERSION } from "./marketplace-promotion-evidence.mjs";
import {
  MARKETPLACE_PUBLIC_PRESENCE_COPY_AUDIT_VERSION,
  REQUIRED_PUBLIC_PRESENCE_PAGE_PATHS,
} from "./marketplace-public-presence-copy-audit.mjs";
import { COUNSEL_REVIEW_PACKET_VERSION } from "./legal-review-corpus.mjs";
import { GOOGLE_SHOPPING_LAUNCH_READINESS_EVIDENCE_VERSION } from "./google-shopping-launch-readiness-evidence.mjs";
import { RELEASE_HEALTH_REPORT_VERSION } from "./release-health-report.mjs";
import { repoRoot } from "./lib/repo.mjs";

const checkedAt = "2026-07-13T12:00:00.000Z";
const validCommit = "a".repeat(40);
const SYNTHETIC_PACKET_SHA256 = `sha256:${"a".repeat(64)}`;
const SYNTHETIC_CORPUS_SHA256 = `sha256:${"b".repeat(64)}`;

// Resolved from the real registry and the real source-owned compliance
// manifest, so the promotion row's revalidation is compared against canonical
// membership rather than a list re-typed in this test.
let canonicalMembership;

beforeAll(async () => {
  canonicalMembership = await resolveCanonicalLegalCorpusMembership();
  expect(canonicalMembership.ok, JSON.stringify(canonicalMembership.errors ?? [])).toBe(true);
}, 120_000);

// The audited page rows a real promotion record derives from its audit input,
// reduced to the identities this gate can revalidate against canonical
// membership rather than accepting a bare count or boolean.
function auditPageEvidence(overrides = {}) {
  return {
    fetchedPathCount: canonicalMembership.uniqueFetchedPathCount,
    requiredPagePaths: [...REQUIRED_PUBLIC_PRESENCE_PAGE_PATHS],
    launchPolicyPolicyKeys: [...canonicalMembership.launchRequiredPolicyKeys],
    complianceArticleSlugs: [...canonicalMembership.complianceArticleSlugs],
    verifiedOnAuditedOriginCount: canonicalMembership.uniqueFetchedPathCount,
    ...overrides,
  };
}

function promotionEvidenceRecord(overrides = {}) {
  return {
    schemaVersion: MARKETPLACE_PROMOTION_EVIDENCE_VERSION,
    passesPromotionGate: true,
    marketplacePromotion: {
      approved: true,
      publicPresenceCopyAuditVersion: MARKETPLACE_PUBLIC_PRESENCE_COPY_AUDIT_VERSION,
      publicPresenceCopyAuditMode: "launch",
      publicPresenceCopyAuditRequiredPageCount: REQUIRED_PUBLIC_PRESENCE_PAGE_PATHS.length,
      publicPresenceCopyAuditRequiredPagePaths: [...REQUIRED_PUBLIC_PRESENCE_PAGE_PATHS],
      publicPresenceCopyAuditLaunchRequiredPolicyCount: canonicalMembership.launchRequiredPolicyKeys.length,
      publicPresenceCopyAuditLaunchRequiredPolicyKeys: [...canonicalMembership.launchRequiredPolicyKeys],
      publicPresenceCopyAuditComplianceArticleCount: canonicalMembership.complianceArticleSlugs.length,
      publicPresenceCopyAuditComplianceArticleSlugs: [...canonicalMembership.complianceArticleSlugs],
      publicPresenceCopyAuditUniqueFetchedPathCount: canonicalMembership.uniqueFetchedPathCount,
      publicPresenceCopyAuditLegalCorpusDigest: SYNTHETIC_CORPUS_SHA256,
      counselPacketSchemaVersion: COUNSEL_REVIEW_PACKET_VERSION,
      counselPacketSha256: SYNTHETIC_PACKET_SHA256,
      counselPacketUtf8Bytes: 225_583,
      counselPacketCorpusSha256: SYNTHETIC_CORPUS_SHA256,
      counselPacketVerified: true,
      publicPresenceCopyAuditPassed: true,
      publicPresenceCopyAuditFutureOnlyLaunchCopyRemoved: true,
      publicPresenceCopyAuditPolicyPagesReviewed: true,
      publicPresenceCopyAuditComplianceArticlesReviewed: true,
      publicPresenceCopyAuditDmcaRegistrationMarkerAbsent: true,
      publicPresenceCopyAuditUncertifiedClaimsAbsent: true,
      publicPresenceCopyAuditPageEvidence: auditPageEvidence(),
      publicPresenceLaunchCopyReviewed: true,
      futureOnlyLaunchCopyRemoved: true,
      policyPagesReviewed: true,
      ...overrides.marketplacePromotion,
    },
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== "marketplacePromotion")),
  };
}

function fullOperatorEvidence(overrides = {}) {
  return {
    marketplaceProductionLaunchReadiness: {
      schemaVersion: MARKETPLACE_PRODUCTION_LAUNCH_READINESS_VERSION,
      passesProductionLaunchReadinessGate: true,
      environmentName: "production",
    },
    marketplacePromotionEvidence: promotionEvidenceRecord(),
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

describe("launch go/no-go gate: promotion-evidence legal-corpus revalidation", () => {
  function promotionRow(marketplacePromotionOverrides, recordOverrides = {}) {
    const result = buildLaunchGoNoGoGate(
      fullDecisionInput({
        decision: "hold",
        operatorEvidence: fullOperatorEvidence({
          marketplacePromotionEvidence: promotionEvidenceRecord({
            marketplacePromotion: marketplacePromotionOverrides,
            ...recordOverrides,
          }),
        }),
      }),
    );
    return result.rows.find((entry) => entry.key === "marketplace-promotion-evidence");
  }

  it("passes only for the exact v2 legal-corpus projection and displays the audit-record command", () => {
    const row = promotionRow({});
    expect(row.status, row.note).toBe("pass");
    expect(MARKETPLACE_PROMOTION_EVIDENCE_COMMAND).toContain("--public-presence-copy-audit <audit-v2.json>");
    expect(row.evidence.marketplacePromotion.publicPresenceCopyAuditLaunchRequiredPolicyKeys).toEqual(
      canonicalMembership.launchRequiredPolicyKeys,
    );
  });

  it("rejects a stale digest pair, a reordered or shortened membership, and a count-only claim", () => {
    expect(promotionRow({ counselPacketCorpusSha256: `sha256:${"c".repeat(64)}` }).note).toContain(
      "counselPacketCorpusSha256 must equal the audited current publicPresenceCopyAuditLegalCorpusDigest",
    );
    expect(
      promotionRow({
        publicPresenceCopyAuditLaunchRequiredPolicyKeys: [...canonicalMembership.launchRequiredPolicyKeys].reverse(),
      }).note,
    ).toContain("must be the canonical launch-required policy keys in registry order");
    expect(
      promotionRow({
        publicPresenceCopyAuditComplianceArticleSlugs: canonicalMembership.complianceArticleSlugs.slice(1),
        publicPresenceCopyAuditComplianceArticleCount: canonicalMembership.complianceArticleSlugs.length,
      }).note,
    ).toContain("must be the canonical compliance article slugs in manifest order");
    expect(
      promotionRow({
        publicPresenceCopyAuditComplianceArticleSlugs: undefined,
        publicPresenceCopyAuditComplianceArticleCount: 5,
      }).note,
    ).toContain("must be the canonical compliance article slugs in manifest order");
    expect(promotionRow({ publicPresenceCopyAuditUniqueFetchedPathCount: 8 }).note).toContain(
      `publicPresenceCopyAuditUniqueFetchedPathCount must be ${canonicalMembership.uniqueFetchedPathCount}`,
    );
  });

  it("rejects a missing packet verification and every un-proved audit-derived boolean", () => {
    expect(promotionRow({ counselPacketVerified: false }).note).toContain("counselPacketVerified must be true.");
    expect(promotionRow({ counselPacketSchemaVersion: "counsel-review-packet/v0" }).note).toContain(
      `counselPacketSchemaVersion must be ${COUNSEL_REVIEW_PACKET_VERSION}`,
    );
    expect(promotionRow({ counselPacketSha256: "not-a-digest" }).note).toContain("counselPacketSha256 must be");
    for (const field of [
      "publicPresenceCopyAuditPassed",
      "publicPresenceCopyAuditFutureOnlyLaunchCopyRemoved",
      "publicPresenceCopyAuditPolicyPagesReviewed",
      "publicPresenceCopyAuditComplianceArticlesReviewed",
      "publicPresenceCopyAuditDmcaRegistrationMarkerAbsent",
      "publicPresenceCopyAuditUncertifiedClaimsAbsent",
      "publicPresenceLaunchCopyReviewed",
      "futureOnlyLaunchCopyRemoved",
      "policyPagesReviewed",
    ]) {
      expect(promotionRow({ [field]: false }).note, field).toContain(`${field} must be true.`);
    }
  });

  it("refuses a projection that asserts the audit booleans without the audited page evidence", () => {
    // The exact bypass this row exists to stop: every flattened count, array,
    // digest, and boolean is canonical, but no audited row backs any of it.
    expect(promotionRow({ publicPresenceCopyAuditPageEvidence: undefined }).note).toContain(
      "publicPresenceCopyAuditPageEvidence must carry the audited page rows",
    );
    expect(promotionRow({ publicPresenceCopyAuditPageEvidence: null }).status).toBe("pending");

    expect(
      promotionRow({
        publicPresenceCopyAuditPageEvidence: auditPageEvidence({
          requiredPagePaths: REQUIRED_PUBLIC_PRESENCE_PAGE_PATHS.map((_, index) => `/synthetic-${index}`),
        }),
      }).note,
    ).toContain("requiredPagePaths must be the canonical required-page paths in order");

    expect(
      promotionRow({
        publicPresenceCopyAuditPageEvidence: auditPageEvidence({
          launchPolicyPolicyKeys: canonicalMembership.launchRequiredPolicyKeys.slice(1),
        }),
      }).note,
    ).toContain("launchPolicyPolicyKeys must be exactly the canonical launch-required policy keys");

    expect(
      promotionRow({
        publicPresenceCopyAuditPageEvidence: auditPageEvidence({
          complianceArticleSlugs: [...canonicalMembership.complianceArticleSlugs].reverse(),
        }),
      }).note,
    ).toContain("complianceArticleSlugs must be the canonical compliance article slugs in manifest order");

    expect(
      promotionRow({ publicPresenceCopyAuditPageEvidence: auditPageEvidence({ fetchedPathCount: 8 }) }).note,
    ).toContain(`fetchedPathCount must be ${canonicalMembership.uniqueFetchedPathCount}`);

    expect(
      promotionRow({
        publicPresenceCopyAuditPageEvidence: auditPageEvidence({
          verifiedOnAuditedOriginCount: canonicalMembership.uniqueFetchedPathCount - 1,
        }),
      }).note,
    ).toContain(`verifiedOnAuditedOriginCount must be ${canonicalMembership.uniqueFetchedPathCount}`);

    // The canonical projection still passes: the new rule rejects absent or
    // incoherent page evidence, not evidence in general.
    expect(promotionRow({}).status).toBe("pass");
  });

  it("keeps a v1 promotion record rejected even when v2-looking fields and booleans are added to it", () => {
    const v1Row = promotionRow({}, { schemaVersion: "marketplace-promotion-evidence/v1" });
    expect(v1Row.status).toBe("pending");
    expect(v1Row.note).toContain(`schemaVersion must be ${MARKETPLACE_PROMOTION_EVIDENCE_VERSION}`);

    const v1CopyAuditRow = promotionRow({
      publicPresenceCopyAuditVersion: "marketplace-public-presence-copy-audit/v1",
    });
    expect(v1CopyAuditRow.status).toBe("pending");
    expect(v1CopyAuditRow.note).toContain(
      `publicPresenceCopyAuditVersion must be ${MARKETPLACE_PUBLIC_PRESENCE_COPY_AUDIT_VERSION}`,
    );

    const prelaunchRow = promotionRow({ publicPresenceCopyAuditMode: "prelaunch" });
    expect(prelaunchRow.status).toBe("pending");
    expect(prelaunchRow.note).toContain("publicPresenceCopyAuditMode must be launch.");
  });

  it("refuses to revalidate when the canonical legal corpus membership cannot be resolved", () => {
    const result = buildLaunchGoNoGoGate(
      fullDecisionInput({
        decision: "hold",
        legalCorpusMembership: { ok: false, errors: ["synthetic membership resolution failure"] },
      }),
    );
    const row = result.rows.find((entry) => entry.key === "marketplace-promotion-evidence");
    expect(row.status).toBe("pending");
    expect(row.note).toContain("canonical legal corpus membership could not be resolved");
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
