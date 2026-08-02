import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CAMPAIGN_GO_DATE,
  CAMPAIGN_START_GATE_VERSION,
  LANDING_CONVERSION_SURFACE_FILES,
  PRIVACY_POLICY_SOURCE_PATH,
  PRIVACY_ROUTE_PATH,
  TERMS_ROUTE_PATH,
  buildCampaignStartGateChecklist,
  parseCampaignStartGateArgs,
} from "./campaign-start-gate.mjs";
import { repoRoot } from "./lib/repo.mjs";

const checkedAt = "2026-07-13T12:00:00.000Z";

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

    it("reads UTM/referrer disclosure only from the canonical Privacy subject", () => {
      fixtureRoot = mkdtempSync(path.join(tmpdir(), "campaign-start-gate-"));
      for (const routePath of [PRIVACY_ROUTE_PATH, TERMS_ROUTE_PATH]) {
        const routeDirectory = path.dirname(path.join(fixtureRoot, routePath));
        mkdirSync(routeDirectory, { recursive: true });
        writeFileSync(path.join(fixtureRoot, routePath), "export default function Route() { return null; }\n");
      }

      const unrelatedLocalePath = path.join(fixtureRoot, "contracts/localization/locales/en/public-presence.ts");
      mkdirSync(path.dirname(unrelatedLocalePath), { recursive: true });
      writeFileSync(unrelatedLocalePath, 'export const unrelated = "utm referrer";\n');

      let checklist = buildCampaignStartGateChecklist({
        repoRoot: fixtureRoot,
        reference: "CAMPAIGN-START-GATE-FIXTURE-2026-07-13",
        owner: "Operations",
        checkedAt,
      });
      let legalRow = checklist.checklist.find((row) => row.key === "legal-privacy-surfaces-adequate");
      expect(legalRow.status).toBe("fail");
      expect(legalRow.evidence.privacySourceExists).toBe(false);

      const privacySourcePath = path.join(fixtureRoot, PRIVACY_POLICY_SOURCE_PATH);
      mkdirSync(path.dirname(privacySourcePath), { recursive: true });
      writeFileSync(
        privacySourcePath,
        `export const privacy = { sections: [{
          id: "cookies-and-analytics",
          draftText: "utm_source utm_medium utm_campaign utm_content utm_term",
          reviewStatus: "counsel-required",
          reviewManifest: { scopeNote: "Packet-only referrer wording must not satisfy public disclosure." }
        }] };\n`,
      );

      checklist = buildCampaignStartGateChecklist({
        repoRoot: fixtureRoot,
        reference: "CAMPAIGN-START-GATE-FIXTURE-2026-07-13",
        owner: "Operations",
        checkedAt,
      });
      legalRow = checklist.checklist.find((row) => row.key === "legal-privacy-surfaces-adequate");
      expect(legalRow.status).toBe("fail");
      expect(legalRow.evidence.missingDisclosureTokens).toEqual(["referrer"]);

      writeFileSync(
        privacySourcePath,
        `export const privacy = { sections: [{
          id: "cookies-and-analytics",
          draftText: "utm_source utm_medium utm_campaign utm_content utm_term referrer",
          reviewStatus: "counsel-required"
        }] };\n`,
      );

      checklist = buildCampaignStartGateChecklist({
        repoRoot: fixtureRoot,
        reference: "CAMPAIGN-START-GATE-FIXTURE-2026-07-13",
        owner: "Operations",
        checkedAt,
      });
      legalRow = checklist.checklist.find((row) => row.key === "legal-privacy-surfaces-adequate");
      expect(legalRow.status).toBe("pass");
      expect(legalRow.evidence.canonicalPrivacySourcePath).toBe(PRIVACY_POLICY_SOURCE_PATH);
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
