#!/usr/bin/env node
import process from "node:process";
import { fileURLToPath } from "node:url";
import { isIsoTimestamp } from "./marketplace-evidence-references.mjs";
import { readEnv, readOption } from "./lib/cli-options.mjs";

export const MARKETPLACE_PUBLIC_PRESENCE_COPY_AUDIT_VERSION = "marketplace-public-presence-copy-audit/v1";

export const REQUIRED_PUBLIC_PRESENCE_PAGES = [
  { name: "home", path: "/" },
  { name: "terms", path: "/terms" },
  { name: "privacy", path: "/privacy" },
  { name: "refundsAndReturns", path: "/refunds-and-returns" },
  { name: "orderProtection", path: "/order-protection" },
  { name: "salesFees", path: "/sales-fees" },
  { name: "faq", path: "/faq" },
  { name: "contact", path: "/contact" },
];

// The explicit code-level launch-audit set over the public policy corpus.
// Launch mode verifies published policy metadata only for these entries;
// widening the set to further launch-required corpus documents is a reviewed
// code change owned by the corpus launch gate. There are deliberately no
// runtime exemption inputs.
export const LAUNCH_AUDITED_POLICY_PAGES = [{ name: "terms", path: "/terms", policyKey: "terms-of-service" }];

const UNCERTIFIED_AGENT_COMMERCE_CLAIMS = [
  "\\bUCP\\b",
  "\\bAP2\\b",
  "\\bagentic\\b",
  "\\bAI agent\\b",
  "headless checkout",
  "headless-checkout",
  "headless completion",
  "autonomous payment",
  "autonomous-payment",
  "AI-agent checkout",
  "agent checkout",
  "agent-commerce",
  "Payment Handler",
  "Shared Payment Token",
  "\\bSPT\\b",
];

const FUTURE_ONLY_LAUNCH_COPY = [
  "prelaunch",
  "early access",
  "waitlist",
  "Request early access",
  "public checkout remains gated",
  "public marketplace checkout opens only after production promotion",
  "marketplace checkout opens only after production promotion",
  "production promotion approval",
  "production promotion",
  "opens only after",
  "\\bgated\\b",
  "no live marketplace transactions",
];

export function parsePublicPresenceCopyAuditArgs(argv, env = process.env) {
  return {
    baseUrl: readOption(argv, "--base-url") ?? readEnv("PUBLIC_PRESENCE_COPY_AUDIT_BASE_URL", env),
    mode: readOption(argv, "--mode") ?? readEnv("PUBLIC_PRESENCE_COPY_AUDIT_MODE", env) ?? "prelaunch",
    checkedAt: readOption(argv, "--checked-at") ?? new Date().toISOString(),
  };
}

export async function auditPublicPresenceCopy(input, dependencies = {}) {
  const fetchImpl = dependencies.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("Public Presence copy audit requires a fetch implementation.");
  }

  const options = normalizeAuditInput(input);
  const launchAuditedPolicyPages = dependencies.launchAuditedPolicyPages ?? LAUNCH_AUDITED_POLICY_PAGES;
  const auditedPolicyPagesByName = new Map(launchAuditedPolicyPages.map((page) => [page.name, page]));
  const pagesToAudit = [
    ...REQUIRED_PUBLIC_PRESENCE_PAGES,
    ...launchAuditedPolicyPages.filter(
      (policyPage) => !REQUIRED_PUBLIC_PRESENCE_PAGES.some((page) => page.name === policyPage.name),
    ),
  ];
  const pageResults = [];
  for (const page of pagesToAudit) {
    pageResults.push(
      await auditPage({
        baseUrl: options.baseUrl,
        page,
        fetchImpl,
        auditedPolicyPage: auditedPolicyPagesByName.get(page.name),
      }),
    );
  }

  const errors = validateAudit({
    checkedAt: options.checkedAt,
    mode: options.mode,
    pages: pageResults,
    launchAuditedPolicyPages,
  });
  const termsPage = pageResults.find((page) => page.name === "terms");
  const termsPublicationReady = isTermsPublicationReady(termsPage?.termsPublicationMetadata);

  return {
    schemaVersion: MARKETPLACE_PUBLIC_PRESENCE_COPY_AUDIT_VERSION,
    baseUrl: options.baseUrl,
    mode: options.mode,
    checkedAt: options.checkedAt,
    requiredPageCount: REQUIRED_PUBLIC_PRESENCE_PAGES.length,
    pages: pageResults,
    publicPresenceLaunchCopyReviewed: errors.length === 0,
    futureOnlyLaunchCopyRemoved:
      options.mode === "launch" && pageResults.every((page) => page.futureOnlyLaunchCopyMatches.length === 0),
    policyPagesReviewed: pageResults.every((page) => page.status === 200),
    termsPublicationReady,
    uncertifiedClaimsAbsent: pageResults.every((page) => page.uncertifiedAgentCommerceClaimMatches.length === 0),
    passesPublicPresenceCopyAudit: errors.length === 0,
    ...(errors.length > 0 ? { errors } : {}),
  };
}

async function main(argv, env = process.env) {
  const options = parsePublicPresenceCopyAuditArgs(argv, env);
  const optionErrors = validateOptions(options);
  if (optionErrors.length > 0) {
    for (const error of optionErrors) {
      console.error(error);
    }
    return 2;
  }

  const audit = await auditPublicPresenceCopy(options);
  console.log(JSON.stringify(audit, null, 2));
  if (!audit.passesPublicPresenceCopyAudit) {
    console.error("Public Presence copy audit did not satisfy the requested launch posture.");
    return 1;
  }
  return 0;
}

async function auditPage({ baseUrl, page, fetchImpl, auditedPolicyPage }) {
  const url = new URL(page.path, ensureTrailingSlash(baseUrl)).toString();
  const response = await fetchImpl(url, { redirect: "follow" });
  const html = await response.text();
  const text = stripHtml(html);
  return {
    name: page.name,
    path: page.path,
    url: response.url || url,
    status: response.status,
    title: html.match(/<title>(.*?)<\/title>/i)?.[1] ?? null,
    futureOnlyLaunchCopyMatches: matchPatterns(text, FUTURE_ONLY_LAUNCH_COPY),
    uncertifiedAgentCommerceClaimMatches: matchPatterns(text, UNCERTIFIED_AGENT_COMMERCE_CLAIMS),
    termsPublicationMetadata: auditedPolicyPage ? readPolicyPublicationMetadata(html) : null,
  };
}

function normalizeAuditInput(input) {
  return {
    baseUrl: requireString(input.baseUrl, "Public Presence copy audit baseUrl"),
    mode: requireMode(input.mode),
    checkedAt: requireString(input.checkedAt, "Public Presence copy audit checkedAt"),
  };
}

function validateOptions(options) {
  const errors = [];
  if (!options.baseUrl) {
    errors.push("PUBLIC_PRESENCE_COPY_AUDIT_BASE_URL or --base-url is required.");
  }
  if (!["prelaunch", "launch"].includes(options.mode)) {
    errors.push("PUBLIC_PRESENCE_COPY_AUDIT_MODE or --mode must be prelaunch or launch.");
  }
  return errors;
}

function validateAudit({ checkedAt, mode, pages, launchAuditedPolicyPages }) {
  const errors = [];
  if (!isIsoTimestamp(checkedAt)) {
    errors.push("Public Presence copy audit checkedAt must be an ISO timestamp.");
  }
  for (const page of pages) {
    if (page.status !== 200) {
      errors.push(`Public Presence page ${page.path} returned status ${page.status}.`);
    }
    for (const match of page.uncertifiedAgentCommerceClaimMatches) {
      errors.push(`Public Presence page ${page.path} includes uncertified agent-commerce claim: ${match}.`);
    }
    if (mode === "prelaunch" && page.futureOnlyLaunchCopyMatches.length === 0) {
      errors.push(`Public Presence page ${page.path} must keep explicit prelaunch/gated-checkout posture.`);
    }
    if (mode === "launch" && page.futureOnlyLaunchCopyMatches.length > 0) {
      errors.push(
        `Public Presence page ${page.path} still includes future-only launch copy: ${page.futureOnlyLaunchCopyMatches.join(", ")}.`,
      );
    }
  }
  if (mode === "launch") {
    for (const policyPage of launchAuditedPolicyPages) {
      const metadata = pages.find((page) => page.name === policyPage.name)?.termsPublicationMetadata;
      if (metadata?.policyKey !== policyPage.policyKey) {
        errors.push(
          `Public Presence ${policyPage.path} must expose the canonical ${policyPage.policyKey} policy key before launch.`,
        );
      }
      if (!/^v[1-9][0-9]*$/.test(metadata?.version ?? "")) {
        errors.push(`Public Presence ${policyPage.path} must expose a canonical vN policy version before launch.`);
      }
      if (metadata?.publicationStatus !== "published") {
        errors.push(`Public Presence ${policyPage.path} policy artifact must be published before launch.`);
      }
      if (!isIsoTimestamp(metadata?.effectiveAt)) {
        errors.push(
          `Public Presence ${policyPage.path} policy artifact must expose an effective ISO timestamp before launch.`,
        );
      }
    }
  }
  return errors;
}

function readPolicyPublicationMetadata(html) {
  return {
    policyKey: readDataAttribute(html, "policy-key"),
    version: readDataAttribute(html, "policy-version"),
    publicationStatus: readDataAttribute(html, "policy-publication-status"),
    effectiveAt: readDataAttribute(html, "policy-effective-at"),
  };
}

function readDataAttribute(html, name) {
  return html.match(new RegExp(`data-${name}=["']([^"']*)["']`, "i"))?.[1] ?? null;
}

function isTermsPublicationReady(metadata) {
  return (
    metadata?.policyKey === "terms-of-service" &&
    /^v[1-9][0-9]*$/.test(metadata.version ?? "") &&
    metadata.publicationStatus === "published" &&
    isIsoTimestamp(metadata.effectiveAt)
  );
}

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function matchPatterns(text, patterns) {
  return patterns.filter((pattern) => new RegExp(pattern, "i").test(text));
}

function requireString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value.trim();
}

function requireMode(value) {
  if (value !== "prelaunch" && value !== "launch") {
    throw new Error("Public Presence copy audit mode must be prelaunch or launch.");
  }
  return value;
}

function ensureTrailingSlash(value) {
  return value.endsWith("/") ? value : `${value}/`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
}
