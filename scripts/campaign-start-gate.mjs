#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { isIsoTimestamp, validateEvidenceReference } from "./marketplace-evidence-references.mjs";
import { readEnv, readOption } from "./lib/cli-options.mjs";
import { repoRoot as defaultRepoRoot } from "./lib/repo.mjs";

// Campaign-start gate: the checklist that starts the 30-day pre-launch clock.
// This is a checklist gate, not a build — most of the underlying feature
// surfaces are already implemented, so most rows here are verified directly
// against repository content. The one row that genuinely cannot be verified
// from source (a live signup completing in production, becoming visible to
// admins, and delivering a confirmation) is operator-attested and stays
// "pending" until real evidence is supplied.

export const CAMPAIGN_START_GATE_VERSION = "campaign-start-gate/v1";

// Canonical recorded campaign-start date, mirrored from
// docs/campaigns/30-day-content-calendar.md. Update both together if the
// business date changes.
export const CAMPAIGN_GO_DATE = "2026-07-20";
export const CAMPAIGN_CONTENT_CALENDAR_PATH = "docs/campaigns/30-day-content-calendar.md";

// Canonical launch-timeline values, mirrored from
// bounded-contexts/public-presence/features/waitlist/ui/launch-config.ts.
// Update both together if the ratified public launch date or beta-waves
// window text changes.
export const REQUIRED_PUBLIC_LAUNCH_DATE = "September 1, 2026";
export const REQUIRED_BETA_WAVES_WINDOW = "late July 2026";
export const LAUNCH_CONFIG_PATH = "bounded-contexts/public-presence/features/waitlist/ui/launch-config.ts";

export const PRIVACY_ROUTE_PATH = "bounded-contexts/public-presence/routes/marketplace/privacy.tsx";
export const TERMS_ROUTE_PATH = "bounded-contexts/public-presence/routes/marketplace/terms.tsx";
export const PRIVACY_LOCALE_PATH = "contracts/localization/locales/en/public-presence.ts";

export const LANDING_CONVERSION_SURFACE_FILES = [
  "bounded-contexts/public-presence/features/waitlist/ui/public-pages.tsx",
  "bounded-contexts/public-presence/routes/admin/waitlist.tsx",
  "bounded-contexts/public-presence/features/waitlist/ui/admin-pages.tsx",
  "bounded-contexts/public-presence/features/waitlist/integrations/transactional-email/transactional-email-intents.ts",
  "bounded-contexts/public-presence/features/waitlist/ui/success-page.tsx",
  "bounded-contexts/public-presence/routes/marketplace/welcome.tsx",
];

export const ANALYTICS_CAPTURE_FILES = [
  "bounded-contexts/public-presence/features/waitlist/api/analytics.ts",
  "bounded-contexts/public-presence/features/waitlist/ui/analytics.ts",
  "bounded-contexts/public-presence/routes/admin/campaign-analytics.tsx",
  "bounded-contexts/public-presence/features/waitlist/ui/campaign-analytics-page.tsx",
];

const ANALYTICS_UTM_REFERENCE_FILES = [
  "bounded-contexts/public-presence/features/waitlist/api/analytics.ts",
  "bounded-contexts/public-presence/features/waitlist/ui/campaign-analytics-page.tsx",
];

export function parseCampaignStartGateArgs(argv, env = process.env) {
  return {
    repoRoot: readOption(argv, "--repo-root") ?? readEnv("CAMPAIGN_START_GATE_REPO_ROOT", env) ?? defaultRepoRoot,
    operatorEvidencePath:
      readOption(argv, "--operator-evidence") ?? readEnv("CAMPAIGN_START_GATE_OPERATOR_EVIDENCE", env),
    reference: readOption(argv, "--reference") ?? readEnv("CAMPAIGN_START_GATE_REFERENCE", env),
    owner: readOption(argv, "--owner") ?? readEnv("CAMPAIGN_START_GATE_OWNER", env) ?? "Operations",
    checkedAt: readOption(argv, "--checked-at") ?? new Date().toISOString(),
  };
}

export async function runCampaignStartGate(options) {
  const operatorEvidence = options.operatorEvidencePath ? await readJsonInput(options.operatorEvidencePath) : null;
  return buildCampaignStartGateChecklist({ ...options, operatorEvidence });
}

export function buildCampaignStartGateChecklist(input) {
  const repoRootPath = input.repoRoot ?? defaultRepoRoot;
  const errors = [];

  if (!isNonEmptyString(input.reference)) {
    errors.push("Campaign start gate requires a reference.");
  } else {
    validateEvidenceReference("Campaign start gate reference", input.reference, errors);
  }
  if (!isNonEmptyString(input.owner)) {
    errors.push("Campaign start gate requires an owner.");
  }
  if (!isIsoTimestamp(input.checkedAt)) {
    errors.push("Campaign start gate checkedAt must be an ISO timestamp.");
  }

  const checklist = [
    buildLandingConversionRow(repoRootPath),
    buildAnalyticsUtmRow(repoRootPath),
    buildLegalPrivacyRow(repoRootPath),
    buildLaunchTimelineRow(repoRootPath),
    buildCampaignGoDateRow(repoRootPath),
    buildWaitlistProductionRow(input.operatorEvidence),
  ];

  for (const row of checklist) {
    if (row.status !== "pass") {
      errors.push(`${row.key}: ${row.note}`);
    }
  }

  return {
    schemaVersion: CAMPAIGN_START_GATE_VERSION,
    reference: input.reference ?? null,
    owner: input.owner,
    checkedAt: input.checkedAt,
    campaignGoDate: CAMPAIGN_GO_DATE,
    checklist,
    passesCampaignStartGate: checklist.every((row) => row.status === "pass"),
    operatorSetup: buildOperatorSetup(checklist),
    ...(errors.length > 0 ? { errors } : {}),
  };
}

function buildLandingConversionRow(repoRootPath) {
  const missingFiles = LANDING_CONVERSION_SURFACE_FILES.filter(
    (relativePath) => !existsSync(path.join(repoRootPath, relativePath)),
  );
  const status = missingFiles.length === 0 ? "pass" : "fail";
  return {
    key: "landing-conversion-slices-landed",
    label: "Landing-conversion slices landed (signup form, admin visibility, confirmation path)",
    automated: true,
    status,
    evidence: { checkedFiles: LANDING_CONVERSION_SURFACE_FILES, missingFiles },
    note:
      status === "pass"
        ? "All landing-conversion waitlist surfaces are present in the repository."
        : `Missing landing-conversion surface file(s): ${missingFiles.join(", ")}.`,
  };
}

function buildAnalyticsUtmRow(repoRootPath) {
  const missingFiles = ANALYTICS_CAPTURE_FILES.filter(
    (relativePath) => !existsSync(path.join(repoRootPath, relativePath)),
  );
  const missingUtmReferences = ANALYTICS_UTM_REFERENCE_FILES.filter((relativePath) => {
    const fullPath = path.join(repoRootPath, relativePath);
    if (!existsSync(fullPath)) {
      return true;
    }
    return !/utm/i.test(readFileSync(fullPath, "utf8"));
  });
  const status = missingFiles.length === 0 && missingUtmReferences.length === 0 ? "pass" : "fail";
  return {
    key: "analytics-utm-capture",
    label: "Analytics/UTM capture wired for campaign attribution",
    automated: true,
    status,
    evidence: { checkedFiles: ANALYTICS_CAPTURE_FILES, missingFiles, missingUtmReferences },
    note:
      status === "pass"
        ? "Waitlist analytics and campaign-analytics surfaces are present and reference UTM attribution."
        : `Analytics/UTM capture evidence incomplete: missing files [${missingFiles.join(", ")}]; missing UTM references in [${missingUtmReferences.join(", ")}].`,
  };
}

function buildLegalPrivacyRow(repoRootPath) {
  const missingRoutes = [PRIVACY_ROUTE_PATH, TERMS_ROUTE_PATH].filter(
    (relativePath) => !existsSync(path.join(repoRootPath, relativePath)),
  );
  const localePath = path.join(repoRootPath, PRIVACY_LOCALE_PATH);
  const localeExists = existsSync(localePath);
  const disclosesUtmCollection = localeExists && /utm/i.test(readFileSync(localePath, "utf8"));
  const status = missingRoutes.length === 0 && disclosesUtmCollection ? "pass" : "fail";
  return {
    key: "legal-privacy-surfaces-adequate",
    label: "Legal/privacy surfaces adequate for collecting signups",
    automated: true,
    status,
    evidence: { missingRoutes, localeExists, disclosesUtmCollection },
    note:
      status === "pass"
        ? "Privacy and terms routes exist and the privacy copy discloses UTM/referrer collection."
        : `Legal/privacy evidence incomplete: missing routes [${missingRoutes.join(", ")}]; UTM disclosure present=${disclosesUtmCollection}.`,
  };
}

function buildLaunchTimelineRow(repoRootPath) {
  const fullPath = path.join(repoRootPath, LAUNCH_CONFIG_PATH);
  const exists = existsSync(fullPath);
  const content = exists ? readFileSync(fullPath, "utf8") : "";
  const hasPublicLaunchDate = content.includes(REQUIRED_PUBLIC_LAUNCH_DATE);
  const hasBetaWavesWindow = content.includes(REQUIRED_BETA_WAVES_WINDOW);
  const status = exists && hasPublicLaunchDate && hasBetaWavesWindow ? "pass" : "fail";
  return {
    key: "launch-timeline-synced",
    label: "Launch timeline messaging synced with the canonical source",
    automated: true,
    status,
    evidence: {
      path: LAUNCH_CONFIG_PATH,
      exists,
      hasPublicLaunchDate,
      hasBetaWavesWindow,
      publicLaunchDate: REQUIRED_PUBLIC_LAUNCH_DATE,
      betaWavesWindow: REQUIRED_BETA_WAVES_WINDOW,
    },
    note:
      status === "pass"
        ? "launch-config.ts carries the ratified public launch date and beta-waves window."
        : "launch-config.ts is missing or out of sync with the ratified launch timeline values.",
  };
}

function buildCampaignGoDateRow(repoRootPath) {
  const fullPath = path.join(repoRootPath, CAMPAIGN_CONTENT_CALENDAR_PATH);
  const exists = existsSync(fullPath);
  const content = exists ? readFileSync(fullPath, "utf8") : "";
  const recorded = content.includes(CAMPAIGN_GO_DATE);
  const status = exists && recorded ? "pass" : "fail";
  return {
    key: "campaign-go-date-recorded",
    label: "Campaign go date recorded",
    automated: true,
    status,
    evidence: { path: CAMPAIGN_CONTENT_CALENDAR_PATH, exists, recorded, campaignGoDate: CAMPAIGN_GO_DATE },
    note:
      status === "pass"
        ? `Campaign go date ${CAMPAIGN_GO_DATE} is recorded in ${CAMPAIGN_CONTENT_CALENDAR_PATH}.`
        : `Campaign go date ${CAMPAIGN_GO_DATE} is not recorded in ${CAMPAIGN_CONTENT_CALENDAR_PATH}.`,
  };
}

function buildWaitlistProductionRow(operatorEvidence) {
  const evidence = isRecord(operatorEvidence?.waitlistProductionVerification)
    ? operatorEvidence.waitlistProductionVerification
    : null;
  const rowErrors = [];

  if (!evidence) {
    rowErrors.push(
      "requires operator evidence (waitlistProductionVerification) recording a live production signup, admin visibility, and confirmation delivery.",
    );
  } else {
    if (!isIsoTimestamp(evidence.verifiedAt)) {
      rowErrors.push("verifiedAt must be an ISO timestamp.");
    }
    validateEvidenceReference("evidenceReference", evidence.evidenceReference, rowErrors);
    if (evidence.signupCompleted !== true) {
      rowErrors.push("signupCompleted must be true.");
    }
    if (evidence.adminVisible !== true) {
      rowErrors.push("adminVisible must be true.");
    }
    if (evidence.confirmationDelivered !== true) {
      rowErrors.push("confirmationDelivered must be true.");
    }
  }

  const status = rowErrors.length === 0 ? "pass" : "pending";
  return {
    key: "waitlist-signup-verified-in-production",
    label: "Waitlist signup verified end-to-end in production (signup -> admin visibility -> confirmation)",
    automated: false,
    status,
    evidence: evidence
      ? {
          verifiedAt: evidence.verifiedAt ?? null,
          evidenceReference: evidence.evidenceReference ?? null,
          signupCompleted: evidence.signupCompleted === true,
          adminVisible: evidence.adminVisible === true,
          confirmationDelivered: evidence.confirmationDelivered === true,
        }
      : null,
    note:
      status === "pass"
        ? "Operator recorded a live production waitlist signup verified through admin visibility and confirmation delivery."
        : `Waitlist production verification pending: ${rowErrors.join(" ")}`,
  };
}

function buildOperatorSetup(checklist) {
  const pendingRows = checklist.filter((row) => row.status !== "pass");
  return {
    pendingKeys: pendingRows.map((row) => row.key),
    operatorEvidenceCommand:
      "pnpm run ops campaign:start-gate -- --operator-evidence <evidence.json> --reference <reference> --owner <name>",
    notes: [
      "Automated rows are derived from repository content only; they do not prove production behavior.",
      "Complete a real waitlist signup against the production host, confirm it is visible on the admin waitlist page, confirm the confirmation email arrives, then record verifiedAt/evidenceReference/legs in the operator evidence file.",
      "Re-run this gate after supplying operator evidence; the gate only passes once every row, including production verification, reports pass.",
    ],
  };
}

async function main(argv, env = process.env) {
  const options = parseCampaignStartGateArgs(argv, env);
  const optionErrors = validateOptions(options);
  if (optionErrors.length > 0) {
    for (const error of optionErrors) {
      console.error(error);
    }
    return 2;
  }

  const checklist = await runCampaignStartGate(options);
  console.log(JSON.stringify(checklist, null, 2));
  if (!checklist.passesCampaignStartGate) {
    console.error("Campaign start gate checklist is not complete.");
    return 1;
  }
  return 0;
}

function validateOptions(options) {
  const errors = [];
  if (!isNonEmptyString(options.reference)) {
    errors.push("CAMPAIGN_START_GATE_REFERENCE or --reference is required.");
  }
  return errors;
}

export async function readJsonInput(inputPath, readStdinImpl = readStdin) {
  if (inputPath === "-") {
    return JSON.parse(await readStdinImpl());
  }
  return JSON.parse(await readFile(inputPath, "utf8"));
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
}
