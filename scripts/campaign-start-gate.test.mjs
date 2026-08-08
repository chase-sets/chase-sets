import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CAMPAIGN_GO_DATE,
  CAMPAIGN_START_GATE_VERSION,
  LANDING_CONVERSION_SURFACE_FILES,
  PRIVACY_CAMPAIGN_DISCLOSURE_SUBJECT_ID,
  PRIVACY_POLICY_SOURCE_PATH,
  PRIVACY_ROUTE_PATH,
  REQUIRED_PRIVACY_CAMPAIGN_DISCLOSURE_TOKENS,
  TERMS_ROUTE_PATH,
  buildCampaignStartGateChecklist,
  parseCampaignStartGateArgs,
  readPolicyArtifactSubjectDraftText,
} from "./campaign-start-gate.mjs";
import { repoRoot } from "./lib/repo.mjs";

const checkedAt = "2026-07-13T12:00:00.000Z";
const complianceArticlePaths = [
  "bounded-contexts/public-presence/features/help/domain/articles/community-guidelines-and-enforcement.en.md",
  "bounded-contexts/public-presence/features/help/domain/articles/intellectual-property-and-dmca.en.md",
  "bounded-contexts/public-presence/features/help/domain/articles/prohibited-and-restricted-items.en.md",
  "bounded-contexts/public-presence/features/help/domain/articles/sales-tax.en.md",
  "bounded-contexts/public-presence/features/help/domain/articles/tax-reporting-1099k.en.md",
];

describe("campaign start gate checklist", () => {
  it("passes every automated row against the real repository and requires operator evidence to fully pass", () => {
    const checklist = buildCampaignStartGateChecklist({
      repoRoot,
      reference: "CAMPAIGN-START-GATE-2026-07-13",
      owner: "Operations",
      checkedAt,
    });

    expect(checklist.schemaVersion).toBe(CAMPAIGN_START_GATE_VERSION);
    expect(checklist.campaignGoDate).toBe(CAMPAIGN_GO_DATE);

    const automatedRows = checklist.checklist.filter((row) => row.automated);
    for (const row of automatedRows) {
      expect(row.status, `${row.key}: ${row.note}`).toBe("pass");
    }

    const productionRow = checklist.checklist.find((row) => row.key === "waitlist-signup-verified-in-production");
    expect(productionRow.automated).toBe(false);
    expect(productionRow.status).toBe("pending");
    expect(checklist.passesCampaignStartGate).toBe(false);
    expect(checklist.operatorSetup.pendingKeys).toContain("waitlist-signup-verified-in-production");
  });

  it("keeps counsel-gated compliance drafts isolated from campaign activation evidence", () => {
    const gateSource = readFileSync(new URL("./campaign-start-gate.mjs", import.meta.url), "utf8");
    const checklist = buildCampaignStartGateChecklist({
      repoRoot,
      reference: "CAMPAIGN-START-GATE-2026-07-13",
      owner: "Operations",
      checkedAt,
    });
    const serializedEvidence = JSON.stringify(checklist.checklist);

    for (const articlePath of complianceArticlePaths) {
      expect(gateSource).not.toContain(articlePath);
      expect(serializedEvidence).not.toContain(path.basename(articlePath, ".en.md"));
    }
    expect(checklist.checklist.filter((row) => row.automated).every((row) => row.status === "pass")).toBe(true);
    expect(checklist.passesCampaignStartGate).toBe(false);
  });

  it("passes the full gate once operator evidence records a verified production signup", () => {
    const checklist = buildCampaignStartGateChecklist({
      repoRoot,
      reference: "CAMPAIGN-START-GATE-2026-07-13",
      owner: "Operations",
      checkedAt,
      operatorEvidence: {
        waitlistProductionVerification: {
          verifiedAt: "2026-07-13T11:00:00.000Z",
          evidenceReference: "CAMPAIGN-START-WAITLIST-PROD-2026-07-13",
          signupCompleted: true,
          adminVisible: true,
          confirmationDelivered: true,
        },
      },
    });

    expect(checklist.passesCampaignStartGate).toBe(true);
    expect(checklist.errors).toBeUndefined();
    for (const row of checklist.checklist) {
      expect(row.status, `${row.key}: ${row.note}`).toBe("pass");
    }
  });

  it("keeps the production row pending when any leg of the operator evidence is missing", () => {
    const checklist = buildCampaignStartGateChecklist({
      repoRoot,
      reference: "CAMPAIGN-START-GATE-2026-07-13",
      owner: "Operations",
      checkedAt,
      operatorEvidence: {
        waitlistProductionVerification: {
          verifiedAt: "2026-07-13T11:00:00.000Z",
          evidenceReference: "CAMPAIGN-START-WAITLIST-PROD-2026-07-13",
          signupCompleted: true,
          adminVisible: false,
          confirmationDelivered: true,
        },
      },
    });

    const productionRow = checklist.checklist.find((row) => row.key === "waitlist-signup-verified-in-production");
    expect(productionRow.status).toBe("pending");
    expect(checklist.passesCampaignStartGate).toBe(false);
    expect(checklist.errors).toEqual(expect.arrayContaining([expect.stringContaining("adminVisible must be true")]));
  });

  it("rejects a placeholder reference and non-ISO checkedAt", () => {
    const checklist = buildCampaignStartGateChecklist({
      repoRoot,
      reference: "todo",
      owner: "Operations",
      checkedAt: "2026-07-13",
    });

    expect(checklist.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("must point to a real external evidence record"),
        "Campaign start gate checkedAt must be an ISO timestamp.",
      ]),
    );
    expect(checklist.passesCampaignStartGate).toBe(false);
  });

  describe("against a synthetic repository fixture", () => {
    let fixtureRoot;

    afterEach(() => {
      if (fixtureRoot) {
        rmSync(fixtureRoot, { recursive: true, force: true });
        fixtureRoot = undefined;
      }
    });

    it("fails the landing-conversion and analytics rows when surface files are missing", () => {
      fixtureRoot = mkdtempSync(path.join(tmpdir(), "campaign-start-gate-"));

      const checklist = buildCampaignStartGateChecklist({
        repoRoot: fixtureRoot,
        reference: "CAMPAIGN-START-GATE-FIXTURE-2026-07-13",
        owner: "Operations",
        checkedAt,
      });

      const landingRow = checklist.checklist.find((row) => row.key === "landing-conversion-slices-landed");
      expect(landingRow.status).toBe("fail");
      expect(landingRow.evidence.missingFiles).toEqual(LANDING_CONVERSION_SURFACE_FILES);

      const analyticsRow = checklist.checklist.find((row) => row.key === "analytics-utm-capture");
      expect(analyticsRow.status).toBe("fail");

      const legalRow = checklist.checklist.find((row) => row.key === "legal-privacy-surfaces-adequate");
      expect(legalRow.status).toBe("fail");

      const timelineRow = checklist.checklist.find((row) => row.key === "launch-timeline-synced");
      expect(timelineRow.status).toBe("fail");

      const goDateRow = checklist.checklist.find((row) => row.key === "campaign-go-date-recorded");
      expect(goDateRow.status).toBe("fail");

      expect(checklist.passesCampaignStartGate).toBe(false);
    });

    it("passes the launch-timeline row once the fixture launch-config carries the ratified values", () => {
      fixtureRoot = mkdtempSync(path.join(tmpdir(), "campaign-start-gate-"));
      const launchConfigDir = path.join(fixtureRoot, "bounded-contexts/public-presence/features/waitlist/ui");
      mkdirSync(launchConfigDir, { recursive: true });
      writeFileSync(
        path.join(launchConfigDir, "launch-config.ts"),
        'export const launchTimeline = { publicLaunchDate: "September 1, 2026", betaWavesWindow: "late July 2026" };\n',
      );

      const checklist = buildCampaignStartGateChecklist({
        repoRoot: fixtureRoot,
        reference: "CAMPAIGN-START-GATE-FIXTURE-2026-07-13",
        owner: "Operations",
        checkedAt,
      });

      const timelineRow = checklist.checklist.find((row) => row.key === "launch-timeline-synced");
      expect(timelineRow.status).toBe("pass");
    });
  });

  describe("legal/privacy row reads the canonical Privacy subject", () => {
    let fixtureRoot;

    afterEach(() => {
      if (fixtureRoot) {
        rmSync(fixtureRoot, { recursive: true, force: true });
        fixtureRoot = undefined;
      }
    });

    function writeFixture(privacySource) {
      fixtureRoot = mkdtempSync(path.join(tmpdir(), "campaign-start-gate-privacy-"));
      for (const relativePath of [PRIVACY_ROUTE_PATH, TERMS_ROUTE_PATH]) {
        const full = path.join(fixtureRoot, relativePath);
        mkdirSync(path.dirname(full), { recursive: true });
        writeFileSync(full, "export default function Route() {\n  return null;\n}\n");
      }
      if (privacySource !== null) {
        const full = path.join(fixtureRoot, PRIVACY_POLICY_SOURCE_PATH);
        mkdirSync(path.dirname(full), { recursive: true });
        writeFileSync(full, privacySource);
      }
      return buildCampaignStartGateChecklist({
        repoRoot: fixtureRoot,
        reference: "CAMPAIGN-START-GATE-FIXTURE-2026-07-13",
        owner: "Operations",
        checkedAt,
      }).checklist.find((row) => row.key === "legal-privacy-surfaces-adequate");
    }

    function privacyArtifactSource(draftText, subjectId = PRIVACY_CAMPAIGN_DISCLOSURE_SUBJECT_ID) {
      return [
        "export const privacyPolicyArtifact = {",
        "  sections: [",
        '    { id: "privacy-notice-scope", draftText: "Scope copy with no campaign tokens." },',
        `    { id: "${subjectId}", draftText: ${JSON.stringify(draftText)} },`,
        "  ],",
        "};",
        "",
      ].join("\n");
    }

    const completeDisclosure =
      "Analytics events carry the campaign parameters utm_source, utm_medium, utm_campaign, utm_content, " +
      "and utm_term, and the referrer of the page you arrived from.";

    it("passes only when the canonical subject carries every required disclosure token", () => {
      const row = writeFixture(privacyArtifactSource(completeDisclosure));
      expect(row.status).toBe("pass");
      expect(row.evidence).toMatchObject({
        missingRoutes: [],
        privacySourceExists: true,
        canonicalSubjectResolved: true,
        missingDisclosureTokens: [],
        disclosesCampaignAttribution: true,
      });
    });

    it("fails naming the exact token when the canonical subject drops one disclosure", () => {
      for (const token of REQUIRED_PRIVACY_CAMPAIGN_DISCLOSURE_TOKENS) {
        const partial = completeDisclosure.replace(token, "a campaign field");
        expect(partial, token).not.toBe(completeDisclosure);
        const row = writeFixture(privacyArtifactSource(partial));
        expect(row.status, token).toBe("fail");
        expect(row.evidence.missingDisclosureTokens, token).toEqual([token]);
        rmSync(fixtureRoot, { recursive: true, force: true });
        fixtureRoot = undefined;
      }
    });

    it("fails when the canonical subject id moves, even though the tokens are still somewhere in the artifact", () => {
      const row = writeFixture(privacyArtifactSource(completeDisclosure, "cookies-and-tracking"));
      expect(row.status).toBe("fail");
      expect(row.evidence.canonicalSubjectResolved).toBe(false);
      expect(row.evidence.missingDisclosureTokens).toEqual(REQUIRED_PRIVACY_CAMPAIGN_DISCLOSURE_TOKENS);
    });

    it("fails closed when the canonical draft text is not a resolvable literal", () => {
      const row = writeFixture(
        [
          "export const privacyPolicyArtifact = {",
          "  sections: [",
          `    { id: "${PRIVACY_CAMPAIGN_DISCLOSURE_SUBJECT_ID}", draftText: buildDisclosure() },`,
          "  ],",
          "};",
          "",
        ].join("\n"),
      );
      expect(row.status).toBe("fail");
      expect(row.evidence.canonicalSubjectResolved).toBe(false);
    });

    it("fails when the canonical Privacy artifact module is missing entirely", () => {
      const row = writeFixture(null);
      expect(row.status).toBe("fail");
      expect(row.evidence.privacySourceExists).toBe(false);
    });

    it("resolves concatenated string-literal draft text", () => {
      const source = [
        "export const privacyPolicyArtifact = {",
        "  sections: [",
        `    { id: "${PRIVACY_CAMPAIGN_DISCLOSURE_SUBJECT_ID}", draftText: "first part " + "second part" },`,
        "  ],",
        "};",
        "",
      ].join("\n");
      expect(readPolicyArtifactSubjectDraftText(source, PRIVACY_CAMPAIGN_DISCLOSURE_SUBJECT_ID)).toBe(
        "first part second part",
      );
    });
  });
});

describe("campaign start gate argument parsing", () => {
  it("parses flags and falls back to environment variables", () => {
    expect(
      parseCampaignStartGateArgs(["--reference", "CAMPAIGN-START-GATE-2026-07-13", "--owner", "Growth"], {}),
    ).toMatchObject({
      reference: "CAMPAIGN-START-GATE-2026-07-13",
      owner: "Growth",
    });

    expect(
      parseCampaignStartGateArgs([], {
        CAMPAIGN_START_GATE_REFERENCE: "CAMPAIGN-START-GATE-FROM-ENV",
        CAMPAIGN_START_GATE_OWNER: "Growth",
      }),
    ).toMatchObject({
      reference: "CAMPAIGN-START-GATE-FROM-ENV",
      owner: "Growth",
    });
  });
});
