#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import process from "node:process";

export const UCP_AP2_CERTIFICATION_SCHEMA = "ucp-ap2-certification/v1";
export const REQUIRED_UCP_AP2_CHECKS = [
  "profileDiscovery",
  "merchantAuthorizationSignature",
  "merchantKeyRotation",
  "validMandateHeadlessSpt",
  "invalidMandateTrustedHandoff",
  "expiredMandateTrustedHandoff",
  "replayedMandateTrustedHandoff",
  "untrustedMandateTrustedHandoff",
  "sharedPaymentTokenWebhooks",
  "paymentReplaySafety",
  "oauthPkceAndRefreshRotation",
  "oauthIntrospectionRevocationConsentRemoval",
  "unsignedRequestNoEffects",
  "incidentResponseDrill",
];

const sensitivePattern =
  /(?:spt_|sk_(?:live|test)_|pk_(?:live|test)_|whsec_|bearer\s+|authorization\s*[:=]|private[_ -]?key|BEGIN [A-Z ]*PRIVATE KEY|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,})/i;

export function validateUcpAp2CertificationEvidence(record) {
  const blockers = [];
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return ["Certification evidence must be a JSON object."];
  }
  if (sensitivePattern.test(JSON.stringify(record))) {
    blockers.push("Certification evidence contains payment, credential, key, or personal data.");
  }
  if (record.schemaVersion !== UCP_AP2_CERTIFICATION_SCHEMA) blockers.push("schemaVersion is not supported.");
  if (record.environment !== "staging") blockers.push("environment must be staging.");
  if (!/^[0-9a-f]{40}$/i.test(String(record.releaseCommit ?? "")))
    blockers.push("releaseCommit must be a full commit SHA.");
  if (record.ucpVersion !== "2026-04-08") blockers.push("ucpVersion must be 2026-04-08.");
  if (record.ap2Version !== "0.2") blockers.push("ap2Version must be 0.2.");
  if (JSON.stringify(record.enabledModes) !== JSON.stringify(["human-present"])) {
    blockers.push("enabledModes must contain only human-present.");
  }
  for (const check of REQUIRED_UCP_AP2_CHECKS) {
    validateApproval(record.checks?.[check], `checks.${check}`, blockers);
  }
  validateApproval(record.supportReview, "supportReview", blockers);
  validateApproval(record.financeReview, "financeReview", blockers);
  if (record.certificationDecision !== "approved") blockers.push("certificationDecision must be approved.");
  if (record.publicMarketingClaimsEnabled !== false) {
    blockers.push("publicMarketingClaimsEnabled must remain false until the separate marketing gate is approved.");
  }
  return blockers;
}

function validateApproval(value, label, blockers) {
  if (value?.passed !== true && value?.approved !== true) blockers.push(`${label} is not approved.`);
  const reference = typeof value?.evidenceReference === "string" ? value.evidenceReference.trim() : "";
  if (!reference || reference.includes("<") || /^https?:/i.test(reference)) {
    blockers.push(`${label}.evidenceReference must be a redacted internal evidence reference.`);
  }
}

export async function runUcpAp2CertificationEvidence({ evidenceFile, outFile }) {
  const record = JSON.parse(await readFile(evidenceFile, "utf8"));
  const blockers = validateUcpAp2CertificationEvidence(record);
  const result = {
    schemaVersion: UCP_AP2_CERTIFICATION_SCHEMA,
    environment: record?.environment ?? null,
    releaseCommit: record?.releaseCommit ?? null,
    enabledModes: record?.enabledModes ?? [],
    certificationApproved: blockers.length === 0,
    publicMarketingClaimsEnabled: false,
    blockers,
  };
  if (outFile) await writeFile(outFile, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  return result;
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--evidence-file") args.evidenceFile = argv[++index];
    else if (argv[index] === "--out") args.outFile = argv[++index];
  }
  if (!args.evidenceFile) throw new Error("--evidence-file is required.");
  return args;
}

if (process.argv[1]?.endsWith("ucp-ap2-certification-evidence.mjs")) {
  runUcpAp2CertificationEvidence(parseArgs(process.argv.slice(2)))
    .then((result) => {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      if (!result.certificationApproved) process.exitCode = 1;
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
