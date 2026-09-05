#!/usr/bin/env node
// The deployed Public Presence copy audit.
//
// v2 replaces v1's Terms-only, hand-written launch set with the full legal
// corpus and binds launch to the exact counsel-reviewed bytes. Three separate
// jobs, deliberately not collapsed into one:
//
//   1. MEMBERSHIP. Which documents are in the corpus at all comes from the
//      registry and the source-owned compliance manifest through
//      scripts/legal-review-corpus.mjs — never from a filename, a category
//      listing, or a list typed here. The two membership authorities are
//      independent atomic pairs: each is an exact count plus ordered array, or
//      exactly `null/null`. A half-null pair is never emitted, and one
//      authority failing never degrades the other.
//
//   2. RETAINED-BYTE VERIFICATION. Launch mode verifies the retained
//      pre-counsel packet against its receipt and verifies that receipt's
//      lifecycle-stable reviewed-content corpus identity against the current
//      source projection. It never regenerates a packet, and it never accepts a
//      post-publication regeneration as a substitute for what counsel read.
//
//   3. CURRENT PUBLICATION POSTURE. Only after verification does it audit live
//      pages: the eight required public pages, the six launch-required policy
//      routes, and the five compliance article routes, plus the current source
//      readiness that a counsel disposition (not this tool) fills in.
//
// The output is one recursively closed discriminated union. Every failure
// branch still emits exactly one parseable record; diagnostics name bounded
// member/path/error classes and never echo a response body, a raw exception
// message, or legal content.
import { readFile } from "node:fs/promises";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { isIsoTimestamp } from "./marketplace-evidence-references.mjs";
import { readEnv, readOption } from "./lib/cli-options.mjs";
import {
  compareRetainedCorpusIdentity,
  evaluateLaunchPublicationReadiness,
  loadLegalReviewCorpus,
  loadLegalReviewMembership,
  sha256Digest,
  validateCounselReviewPacketReceipt,
} from "./legal-review-corpus.mjs";

export const MARKETPLACE_PUBLIC_PRESENCE_COPY_AUDIT_VERSION = "marketplace-public-presence-copy-audit/v2";

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

export const REQUIRED_PUBLIC_PRESENCE_PAGE_PATHS = REQUIRED_PUBLIC_PRESENCE_PAGES.map((page) => page.path);

/** Canonical category order for a page row's `categories` subset. */
export const PUBLIC_PRESENCE_AUDIT_PAGE_CATEGORIES = ["required-page", "launch-policy", "compliance-article"];

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

const POLICY_VERSION_PATTERN = /^v[1-9][0-9]*$/;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;

export function parsePublicPresenceCopyAuditArgs(argv, env = process.env) {
  return {
    baseUrl: readOption(argv, "--base-url") ?? readEnv("PUBLIC_PRESENCE_COPY_AUDIT_BASE_URL", env),
    mode: readOption(argv, "--mode") ?? readEnv("PUBLIC_PRESENCE_COPY_AUDIT_MODE", env) ?? "prelaunch",
    checkedAt: readOption(argv, "--checked-at") ?? new Date().toISOString(),
    counselPacketPath:
      readOption(argv, "--counsel-packet") ?? readEnv("PUBLIC_PRESENCE_COPY_AUDIT_COUNSEL_PACKET", env),
    counselPacketReceiptPath:
      readOption(argv, "--counsel-packet-receipt") ?? readEnv("PUBLIC_PRESENCE_COPY_AUDIT_COUNSEL_PACKET_RECEIPT", env),
  };
}

export function validatePublicPresenceCopyAuditOptions(options) {
  const errors = [];
  if (!options.baseUrl) {
    errors.push("PUBLIC_PRESENCE_COPY_AUDIT_BASE_URL or --base-url is required.");
  } else if (toAuditedOrigin(options.baseUrl) === null) {
    // A malformed or unsupported base URL is an option-shape error, not an
    // audit outcome: it must be refused before any fetch, with no JSON record.
    errors.push("PUBLIC_PRESENCE_COPY_AUDIT_BASE_URL or --base-url must be an absolute http(s) URL.");
  }
  if (!["prelaunch", "launch"].includes(options.mode)) {
    errors.push("PUBLIC_PRESENCE_COPY_AUDIT_MODE or --mode must be prelaunch or launch.");
    return errors;
  }
  if (options.mode === "launch") {
    if (!options.counselPacketPath) {
      errors.push("Launch mode requires --counsel-packet pointing at the exact retained counsel review packet.");
    }
    if (!options.counselPacketReceiptPath) {
      errors.push("Launch mode requires --counsel-packet-receipt pointing at that packet's retained receipt.");
    }
  } else if (options.counselPacketPath || options.counselPacketReceiptPath) {
    // Prelaunch never reads a packet file. Accepting one silently would make
    // the two modes look interchangeable to an operator who mistyped --mode.
    errors.push("Prelaunch mode does not accept --counsel-packet or --counsel-packet-receipt.");
  }
  return errors;
}

export async function auditPublicPresenceCopy(input, dependencies = {}) {
  const fetchImpl = dependencies.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("Public Presence copy audit requires a fetch implementation.");
  }
  const options = normalizeAuditInput(input);
  const readTextFileImpl = dependencies.readTextFile ?? readTextFile;
  const readBinaryFileImpl = dependencies.readBinaryFile ?? readBinaryFile;

  const errors = [];
  if (!isIsoTimestamp(options.checkedAt)) {
    errors.push("Public Presence copy audit checkedAt must be an ISO timestamp.");
  }

  const membership = dependencies.membership ?? (await loadMembershipOrNullPairs());
  const policyPair = membership.policy.ok
    ? {
        launchRequiredPolicyCount: membership.policy.launchRequiredPolicyCount,
        launchRequiredPolicyKeys: [...membership.policy.launchRequiredPolicyKeys],
      }
    : { launchRequiredPolicyCount: null, launchRequiredPolicyKeys: null };
  const compliancePair = membership.compliance.ok
    ? {
        complianceArticleCount: membership.compliance.complianceArticleCount,
        complianceArticleSlugs: [...membership.compliance.complianceArticleSlugs],
      }
    : { complianceArticleCount: null, complianceArticleSlugs: null };
  errors.push(...membership.policy.errors, ...membership.compliance.errors);

  const verification =
    options.mode === "launch"
      ? await verifyRetainedCounselPacket(options, dependencies, { readTextFileImpl, readBinaryFileImpl })
      : null;
  if (verification) {
    errors.push(...verification.errors);
  }

  // The pre-verification branch: nothing about the deployed site can be
  // audited yet, so it performs zero fetches. Each independently valid
  // membership pair still reports its exact values.
  const zeroFetchFailure = () =>
    finalizeAudit({
      options,
      policyPair,
      compliancePair,
      legalCorpusDigest: verification ? verification.legalCorpusDigest : null,
      counselPacket: verification ? verification.counselPacket : null,
      pages: [],
      copyReviewed: false,
      futureOnlyLaunchCopyRemoved: false,
      policyPagesReviewed: options.mode === "launch" ? false : null,
      complianceArticlesReviewed: options.mode === "launch" ? false : null,
      dmcaRegistrationMarkerAbsent: options.mode === "launch" ? false : null,
      uncertifiedClaimsAbsent: false,
      passed: false,
      errors,
    });

  const membershipValid = membership.policy.ok && membership.compliance.ok;
  if (!membershipValid || (options.mode === "launch" && !verification.counselPacket.verified)) {
    return zeroFetchFailure();
  }

  const plan = buildFetchPlan(options.mode, membership);
  if (plan.errors.length > 0) {
    errors.push(...plan.errors);
    return zeroFetchFailure();
  }

  const fetched = [];
  for (const target of plan.targets) {
    fetched.push(await auditPage({ baseUrl: options.baseUrl, target, fetchImpl }));
  }
  const pages = fetched.map((entry) => entry.row);

  const copyErrors = evaluateCopyPredicates(options.mode, pages, options.baseUrl);
  errors.push(...copyErrors);
  const copyReviewed = copyErrors.length === 0;
  // A row proves nothing about the audited site unless the response it
  // actually ended on is still that site's origin and the exact planned path.
  const allRowsProvable = pages.every((page) => isAuditedTargetResponse(options.baseUrl, page));
  const uncertifiedClaimsAbsent =
    allRowsProvable && pages.every((page) => page.uncertifiedAgentCommerceClaimMatches.length === 0);

  if (options.mode === "prelaunch") {
    return finalizeAudit({
      options,
      policyPair,
      compliancePair,
      legalCorpusDigest: null,
      counselPacket: null,
      pages,
      copyReviewed,
      futureOnlyLaunchCopyRemoved: false,
      policyPagesReviewed: null,
      complianceArticlesReviewed: null,
      dmcaRegistrationMarkerAbsent: null,
      uncertifiedClaimsAbsent,
      passed: copyReviewed && uncertifiedClaimsAbsent && errors.length === 0,
      errors,
    });
  }

  const corpus = verification.corpus;
  const futureOnlyLaunchCopyRemoved =
    allRowsProvable && pages.every((page) => page.futureOnlyLaunchCopyMatches.length === 0);
  const policyReview = evaluateLaunchPolicyRoutes(pages, corpus, options.baseUrl);
  const complianceReview = evaluateComplianceRoutes(pages, compliancePair.complianceArticleCount, options.baseUrl);
  const dmcaReview = evaluateDmcaRegistrationMarker(fetched, corpus, options.baseUrl);
  errors.push(...policyReview.errors, ...complianceReview.errors, ...dmcaReview.errors);
  errors.push(...evaluateLaunchPublicationReadiness(corpus));

  const passed =
    verification.counselPacket.verified &&
    copyReviewed &&
    futureOnlyLaunchCopyRemoved &&
    policyReview.reviewed &&
    complianceReview.reviewed &&
    dmcaReview.absent &&
    uncertifiedClaimsAbsent &&
    errors.length === 0;

  return finalizeAudit({
    options,
    policyPair,
    compliancePair,
    legalCorpusDigest: verification.legalCorpusDigest,
    counselPacket: verification.counselPacket,
    pages,
    copyReviewed,
    futureOnlyLaunchCopyRemoved,
    policyPagesReviewed: policyReview.reviewed,
    complianceArticlesReviewed: complianceReview.reviewed,
    dmcaRegistrationMarkerAbsent: dmcaReview.absent,
    uncertifiedClaimsAbsent,
    passed,
    errors,
  });
}

function finalizeAudit({
  options,
  policyPair,
  compliancePair,
  legalCorpusDigest,
  counselPacket,
  pages,
  copyReviewed,
  futureOnlyLaunchCopyRemoved,
  policyPagesReviewed,
  complianceArticlesReviewed,
  dmcaRegistrationMarkerAbsent,
  uncertifiedClaimsAbsent,
  passed,
  errors,
}) {
  const bounded = [...new Set(errors)];
  return {
    schemaVersion: MARKETPLACE_PUBLIC_PRESENCE_COPY_AUDIT_VERSION,
    baseUrl: options.baseUrl,
    mode: options.mode,
    checkedAt: options.checkedAt,
    requiredPageCount: REQUIRED_PUBLIC_PRESENCE_PAGES.length,
    requiredPagePaths: [...REQUIRED_PUBLIC_PRESENCE_PAGE_PATHS],
    launchRequiredPolicyCount: policyPair.launchRequiredPolicyCount,
    launchRequiredPolicyKeys: policyPair.launchRequiredPolicyKeys,
    complianceArticleCount: compliancePair.complianceArticleCount,
    complianceArticleSlugs: compliancePair.complianceArticleSlugs,
    uniqueFetchedPathCount: pages.length,
    legalCorpusDigest,
    counselPacket,
    pages,
    publicPresenceLaunchCopyReviewed: copyReviewed,
    futureOnlyLaunchCopyRemoved,
    policyPagesReviewed,
    complianceArticlesReviewed,
    dmcaRegistrationMarkerAbsent,
    uncertifiedClaimsAbsent,
    passesPublicPresenceCopyAudit: passed,
    ...(bounded.length > 0 ? { errors: bounded } : {}),
  };
}

/**
 * An unreadable membership authority is a `null/null` pair with a bounded
 * diagnostic, never a thrown stack trace: a valid CLI invocation must still
 * emit exactly one parseable record.
 */
async function loadMembershipOrNullPairs() {
  try {
    return await loadLegalReviewMembership();
  } catch (error) {
    const failure = `Legal review corpus membership could not be resolved (${
      error instanceof Error ? error.constructor.name : "UnknownError"
    }).`;
    const invalid = { ok: false, errors: [failure] };
    return { policy: invalid, compliance: { ...invalid, errors: [] } };
  }
}

// ---------------------------------------------------------------------------
// Retained packet verification
// ---------------------------------------------------------------------------

async function verifyRetainedCounselPacket(options, dependencies, io) {
  const errors = [];
  const corpusResult = dependencies.corpus ?? (await loadLegalReviewCorpus());
  const corpus = corpusResult.ok ? corpusResult.corpus : null;
  const legalCorpusDigest = corpus ? corpus.identity.sha256 : null;
  if (!corpus) {
    errors.push("Current legal review corpus did not validate, so no launch corpus identity exists to compare.");
    errors.push(...corpusResult.errors);
  }

  const receiptRead = await io.readTextFileImpl(options.counselPacketReceiptPath);
  let parsedReceipt = null;
  if (!receiptRead.ok) {
    errors.push(`Retained counsel review packet receipt could not be read (${receiptRead.failure}).`);
  } else {
    try {
      parsedReceipt = JSON.parse(receiptRead.content);
    } catch {
      errors.push("Retained counsel review packet receipt is not parseable JSON.");
    }
  }

  const counselPacket = projectRetainedReceipt(parsedReceipt);
  const receiptValidation = parsedReceipt === null ? null : validateCounselReviewPacketReceipt(parsedReceipt);
  if (receiptValidation && !receiptValidation.ok) {
    errors.push(...receiptValidation.errors);
  }

  const packetRead = await io.readBinaryFileImpl(options.counselPacketPath);
  if (!packetRead.ok) {
    errors.push(`Retained counsel review packet bytes could not be read (${packetRead.failure}).`);
  }

  const receiptValid = Boolean(receiptValidation && receiptValidation.ok);
  let verified = false;
  if (receiptValid && packetRead.ok) {
    const actualSha256 = sha256Digest(packetRead.content);
    const byteMatch = packetRead.content.byteLength === parsedReceipt.packet.utf8Bytes;
    const digestMatch = actualSha256 === parsedReceipt.packet.sha256;
    if (!digestMatch) {
      errors.push("Retained counsel review packet bytes do not hash to the digest its receipt records.");
    }
    if (!byteMatch) {
      errors.push("Retained counsel review packet byte length does not match the length its receipt records.");
    }
    if (corpus) {
      const identityErrors = compareRetainedCorpusIdentity(parsedReceipt, corpus.identity);
      errors.push(...identityErrors);
      verified = digestMatch && byteMatch && identityErrors.length === 0;
    }
  }

  return { errors, corpus, legalCorpusDigest, counselPacket: { ...counselPacket, verified } };
}

/**
 * Safely projects the four retained receipt values. Each field is carried only
 * when it passes its own type/format check, so a malformed or predecessor
 * receipt yields explicit nulls rather than a smuggled value.
 */
function projectRetainedReceipt(receipt) {
  const packet = isRecord(receipt) && isRecord(receipt.packet) ? receipt.packet : null;
  const corpus = isRecord(receipt) && isRecord(receipt.corpus) ? receipt.corpus : null;
  return {
    schemaVersion: packet && isNonEmptyString(packet.schemaVersion) ? packet.schemaVersion.trim() : null,
    sha256: packet && typeof packet.sha256 === "string" && SHA256_PATTERN.test(packet.sha256) ? packet.sha256 : null,
    utf8Bytes: packet && Number.isInteger(packet.utf8Bytes) && packet.utf8Bytes > 0 ? packet.utf8Bytes : null,
    corpusSha256:
      corpus && typeof corpus.sha256 === "string" && SHA256_PATTERN.test(corpus.sha256) ? corpus.sha256 : null,
    verified: false,
  };
}

async function readTextFile(filePath) {
  try {
    return { ok: true, content: await readFile(filePath, "utf8") };
  } catch (error) {
    return { ok: false, failure: error instanceof Error ? error.constructor.name : "UnknownError" };
  }
}

async function readBinaryFile(filePath) {
  try {
    return { ok: true, content: await readFile(filePath) };
  } catch (error) {
    return { ok: false, failure: error instanceof Error ? error.constructor.name : "UnknownError" };
  }
}

// ---------------------------------------------------------------------------
// Fetch plan
// ---------------------------------------------------------------------------

function buildFetchPlan(mode, membership) {
  const errors = [];
  const targets = REQUIRED_PUBLIC_PRESENCE_PAGES.map((page) => ({
    name: page.name,
    path: page.path,
    categories: ["required-page"],
    policyKey: null,
    complianceSlug: null,
  }));
  if (mode !== "launch") {
    return { targets, errors };
  }

  const byPath = new Map(targets.map((target) => [target.path, target]));
  const claimedByMember = new Map();

  for (const [index, policyKey] of membership.policy.launchRequiredPolicyKeys.entries()) {
    const path = membership.policy.launchRequiredPolicyPaths[index];
    const claimant = claimedByMember.get(path);
    if (claimant) {
      errors.push(`Launch audit route '${path}' is claimed by both '${claimant}' and '${policyKey}'.`);
      continue;
    }
    claimedByMember.set(path, policyKey);
    const existing = byPath.get(path);
    if (existing) {
      existing.categories = [...existing.categories, "launch-policy"];
      existing.policyKey = policyKey;
      continue;
    }
    const target = {
      name: policyKey,
      path,
      categories: ["launch-policy"],
      policyKey,
      complianceSlug: null,
    };
    targets.push(target);
    byPath.set(path, target);
  }

  for (const [index, slug] of membership.compliance.complianceArticleSlugs.entries()) {
    const path = membership.compliance.complianceArticlePaths[index];
    const claimant = claimedByMember.get(path);
    if (claimant) {
      errors.push(`Launch audit route '${path}' is claimed by both '${claimant}' and '${slug}'.`);
      continue;
    }
    claimedByMember.set(path, slug);
    const existing = byPath.get(path);
    if (existing) {
      errors.push(`Compliance article '${slug}' conflicts with the existing required public page at '${path}'.`);
      continue;
    }
    const target = {
      name: slug,
      path,
      categories: ["compliance-article"],
      policyKey: null,
      complianceSlug: slug,
    };
    targets.push(target);
    byPath.set(path, target);
  }

  for (const target of targets) {
    target.categories = PUBLIC_PRESENCE_AUDIT_PAGE_CATEGORIES.filter((category) =>
      target.categories.includes(category),
    );
  }
  return { targets, errors };
}

async function auditPage({ baseUrl, target, fetchImpl }) {
  // Defense in depth for programmatic callers: `main` already refuses an
  // unusable base URL at option validation, so a resolution failure here is a
  // caught row rather than an exception that escapes the audit boundary.
  const url = resolveTargetUrl(baseUrl, target.path);
  const isLaunchPolicyRow = target.categories.includes("launch-policy");
  try {
    if (url === null) {
      throw new Error("The audited base URL could not resolve this target path.");
    }
    const response = await fetchImpl(url, { redirect: "follow" });
    const html = await response.text();
    const text = stripHtml(html);
    return {
      target,
      html,
      row: {
        name: target.name,
        path: target.path,
        url: response.url || url,
        status: typeof response.status === "number" ? response.status : null,
        title: html.match(/<title>(.*?)<\/title>/i)?.[1] ?? null,
        categories: [...target.categories],
        futureOnlyLaunchCopyMatches: matchPatterns(text, FUTURE_ONLY_LAUNCH_COPY),
        uncertifiedAgentCommerceClaimMatches: matchPatterns(text, UNCERTIFIED_AGENT_COMMERCE_CLAIMS),
        policyPublicationMetadata: isLaunchPolicyRow ? readPolicyPublicationMetadata(html) : null,
      },
    };
  } catch {
    // A caught fetch/read failure is still a row: the audit attempts every
    // planned path so one unreachable route cannot shorten the record.
    return {
      target,
      html: null,
      row: {
        name: target.name,
        path: target.path,
        url: url ?? target.path,
        status: null,
        title: null,
        categories: [...target.categories],
        futureOnlyLaunchCopyMatches: [],
        uncertifiedAgentCommerceClaimMatches: [],
        policyPublicationMetadata: null,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Predicates
// ---------------------------------------------------------------------------

function evaluateCopyPredicates(mode, pages, baseUrl) {
  const errors = [];
  for (const page of pages) {
    if (page.status === null) {
      errors.push(`Public Presence page ${page.path} could not be fetched.`);
      continue;
    }
    if (page.status !== 200) {
      errors.push(`Public Presence page ${page.path} returned status ${page.status}.`);
    }
    if (!resolvesToAuditedTarget(baseUrl, page)) {
      // Bounded by design: the off-origin location is a response value and is
      // never echoed into a diagnostic.
      errors.push(`Public Presence page ${page.path} did not resolve to the audited origin and canonical route.`);
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
  return errors;
}

function evaluateLaunchPolicyRoutes(pages, corpus, baseUrl) {
  const errors = [];
  const versionsByKey = new Map(corpus.policies.map((policy) => [policy.policyKey, policy.version]));
  const policyRows = pages.filter((page) => page.categories.includes("launch-policy"));
  let reviewed = policyRows.length > 0;

  for (const page of policyRows) {
    const metadata = page.policyPublicationMetadata;
    // Resolved by canonical route, never by the row's display name: a required
    // public page and a launch policy can share a path, and the policy key is
    // the registry's identity for it.
    const expectedKey = findPolicyKeyForPath(corpus, page.path);
    const expectedVersion = versionsByKey.get(expectedKey);
    if (page.status !== 200) {
      errors.push(`Public Presence ${page.path} must return 200 before launch.`);
      reviewed = false;
      continue;
    }
    if (!resolvesToAuditedTarget(baseUrl, page)) {
      errors.push(`Public Presence ${page.path} must resolve to the audited origin and canonical route before launch.`);
      reviewed = false;
      continue;
    }
    if (metadata?.policyKey !== expectedKey) {
      errors.push(`Public Presence ${page.path} must expose the canonical ${expectedKey} policy key before launch.`);
      reviewed = false;
    }
    if (!POLICY_VERSION_PATTERN.test(metadata?.version ?? "") || metadata.version !== expectedVersion) {
      errors.push(`Public Presence ${page.path} must expose the exact current ${expectedVersion} policy version.`);
      reviewed = false;
    }
    if (metadata?.publicationStatus !== "published") {
      errors.push(`Public Presence ${page.path} policy artifact must be published before launch.`);
      reviewed = false;
    }
    if (!isIsoTimestamp(metadata?.effectiveAt)) {
      errors.push(`Public Presence ${page.path} policy artifact must expose an effective ISO timestamp before launch.`);
      reviewed = false;
    }
  }
  return { reviewed, errors };
}

function findPolicyKeyForPath(corpus, path) {
  return corpus.policies.find((policy) => policy.href === path)?.policyKey ?? null;
}

function evaluateComplianceRoutes(pages, expectedComplianceCount, baseUrl) {
  const errors = [];
  const complianceRows = pages.filter((page) => page.categories.includes("compliance-article"));
  let reviewed = complianceRows.length === expectedComplianceCount && expectedComplianceCount > 0;
  if (!reviewed) {
    errors.push("The launch audit did not attempt every compliance article route.");
  }

  for (const page of complianceRows) {
    if (page.status !== 200) {
      errors.push(`Public Presence compliance article ${page.path} must return 200 before launch.`);
      reviewed = false;
      continue;
    }
    if (!resolvesToAuditedTarget(baseUrl, page)) {
      errors.push(`Public Presence compliance article ${page.path} did not resolve to its canonical route.`);
      reviewed = false;
    }
  }
  return { reviewed, errors };
}

/**
 * The audited base origin, or `null` when the value is not a supported
 * absolute HTTP(S) URL. Origin comparison is the whole point: a same-path
 * redirect onto another host returns bytes that prove nothing about this site.
 */
function toAuditedOrigin(baseUrl) {
  if (typeof baseUrl !== "string" || baseUrl.trim().length === 0) {
    return null;
  }
  try {
    const url = new URL(baseUrl.trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}

function resolveTargetUrl(baseUrl, targetPath) {
  if (toAuditedOrigin(baseUrl) === null) {
    return null;
  }
  try {
    return new URL(targetPath, ensureTrailingSlash(baseUrl.trim())).toString();
  } catch {
    return null;
  }
}

/** True when a row's FINAL response URL is the audited origin plus its exact planned path. */
function resolvesToAuditedTarget(baseUrl, page) {
  const origin = toAuditedOrigin(baseUrl);
  if (origin === null || typeof page.url !== "string") {
    return false;
  }
  try {
    const resolved = new URL(page.url);
    return resolved.origin === origin && resolved.pathname === page.path;
  } catch {
    return false;
  }
}

/** A row that both answered 200 and stayed on the audited target. */
function isAuditedTargetResponse(baseUrl, page) {
  return page.status === 200 && resolvesToAuditedTarget(baseUrl, page);
}

function evaluateDmcaRegistrationMarker(fetched, corpus, baseUrl) {
  const errors = [];
  const marker = corpus.dmcaUnverifiedRegistrationMarker;
  const slug = corpus.dmcaComplianceArticleSlug;
  const member = corpus.complianceArticles.find((article) => article.slug === slug);

  if (!marker || !member) {
    errors.push("The DMCA compliance member or its registration marker could not be resolved from source.");
    return { absent: false, errors };
  }

  let absent = true;
  if (member.markdown.includes(marker)) {
    errors.push(
      `Compliance member '${slug}' still carries the unverified DMCA registration marker; launch requires its own Copyright Office directory probe.`,
    );
    absent = false;
  }

  const entry = fetched.find((candidate) => candidate.target.complianceSlug === slug);
  if (!entry || entry.row.status !== 200 || entry.html === null) {
    errors.push(`The live DMCA compliance page could not be read, so the registration marker cannot be proven absent.`);
    absent = false;
  } else if (!resolvesToAuditedTarget(baseUrl, entry.row)) {
    errors.push(
      "The live DMCA compliance page did not resolve to the audited origin and canonical route, so the registration marker cannot be proven absent.",
    );
    absent = false;
  } else if (entry.html.includes(marker)) {
    errors.push("The live DMCA compliance page still carries the unverified DMCA registration marker.");
    absent = false;
  }

  return { absent, errors };
}

// ---------------------------------------------------------------------------
// Closed-schema record validation (consumed by promotion evidence)
// ---------------------------------------------------------------------------

const AUDIT_RECORD_FIELDS = [
  "schemaVersion",
  "baseUrl",
  "mode",
  "checkedAt",
  "requiredPageCount",
  "requiredPagePaths",
  "launchRequiredPolicyCount",
  "launchRequiredPolicyKeys",
  "complianceArticleCount",
  "complianceArticleSlugs",
  "uniqueFetchedPathCount",
  "legalCorpusDigest",
  "counselPacket",
  "pages",
  "publicPresenceLaunchCopyReviewed",
  "futureOnlyLaunchCopyRemoved",
  "policyPagesReviewed",
  "complianceArticlesReviewed",
  "dmcaRegistrationMarkerAbsent",
  "uncertifiedClaimsAbsent",
  "passesPublicPresenceCopyAudit",
];
const AUDIT_COUNSEL_PACKET_FIELDS = ["schemaVersion", "sha256", "utf8Bytes", "corpusSha256", "verified"];
const AUDIT_PAGE_FIELDS = [
  "name",
  "path",
  "url",
  "status",
  "title",
  "categories",
  "futureOnlyLaunchCopyMatches",
  "uncertifiedAgentCommerceClaimMatches",
  "policyPublicationMetadata",
];
const AUDIT_PAGE_METADATA_FIELDS = ["policyKey", "version", "publicationStatus", "effectiveAt"];

/**
 * Recursively closed validation of one emitted audit record. Unknown or
 * missing keys at every level fail, `termsPublicationReady` is retired and so
 * reads as an unknown key, and a half-null membership pair is rejected.
 */
export function validatePublicPresenceCopyAuditRecord(value) {
  const errors = [];
  if (!isRecord(value)) {
    return { ok: false, errors: ["Public Presence copy audit record must be a JSON object."] };
  }
  pushClosedFieldErrors(errors, value, AUDIT_RECORD_FIELDS, "", ["errors"]);
  if (value.schemaVersion !== MARKETPLACE_PUBLIC_PRESENCE_COPY_AUDIT_VERSION) {
    errors.push(
      `Public Presence copy audit record schemaVersion must be ${MARKETPLACE_PUBLIC_PRESENCE_COPY_AUDIT_VERSION}.`,
    );
  }
  if (!isNonEmptyString(value.baseUrl)) {
    errors.push("Public Presence copy audit record baseUrl must be a non-empty string.");
  }
  if (value.mode !== "prelaunch" && value.mode !== "launch") {
    errors.push("Public Presence copy audit record mode must be prelaunch or launch.");
  }
  if (!isIsoTimestamp(value.checkedAt)) {
    errors.push("Public Presence copy audit record checkedAt must be an ISO timestamp.");
  }
  if (value.requiredPageCount !== REQUIRED_PUBLIC_PRESENCE_PAGES.length) {
    errors.push(
      `Public Presence copy audit record requiredPageCount must be ${REQUIRED_PUBLIC_PRESENCE_PAGES.length}.`,
    );
  }
  if (!isExactStringArray(value.requiredPagePaths, REQUIRED_PUBLIC_PRESENCE_PAGE_PATHS)) {
    errors.push(
      "Public Presence copy audit record requiredPagePaths must be the canonical required-page paths in order.",
    );
  }
  validateMembershipPair(
    errors,
    value.launchRequiredPolicyCount,
    value.launchRequiredPolicyKeys,
    "launchRequiredPolicy",
  );
  validateMembershipPair(errors, value.complianceArticleCount, value.complianceArticleSlugs, "complianceArticle");
  if (!Number.isInteger(value.uniqueFetchedPathCount) || value.uniqueFetchedPathCount < 0) {
    errors.push("Public Presence copy audit record uniqueFetchedPathCount must be a non-negative integer.");
  }
  if (
    value.legalCorpusDigest !== null &&
    !(typeof value.legalCorpusDigest === "string" && SHA256_PATTERN.test(value.legalCorpusDigest))
  ) {
    errors.push("Public Presence copy audit record legalCorpusDigest must be null or a lowercase sha256 digest.");
  }

  validateAuditCounselPacket(errors, value);
  validateAuditPages(errors, value);
  validateAuditFetchPlanComposition(errors, value);
  validateAuditEvidenceCoherence(errors, value);

  for (const field of [
    "publicPresenceLaunchCopyReviewed",
    "futureOnlyLaunchCopyRemoved",
    "uncertifiedClaimsAbsent",
    "passesPublicPresenceCopyAudit",
  ]) {
    if (typeof value[field] !== "boolean") {
      errors.push(`Public Presence copy audit record ${field} must be a boolean.`);
    }
  }
  for (const field of ["policyPagesReviewed", "complianceArticlesReviewed", "dmcaRegistrationMarkerAbsent"]) {
    if (value.mode === "launch" ? typeof value[field] !== "boolean" : value[field] !== null) {
      errors.push(
        `Public Presence copy audit record ${field} must be ${value.mode === "launch" ? "a boolean in launch mode" : "null outside launch mode"}.`,
      );
    }
  }
  if (Object.hasOwn(value, "errors")) {
    if (!Array.isArray(value.errors) || value.errors.length === 0 || !value.errors.every(isNonEmptyString)) {
      errors.push("Public Presence copy audit record errors, when present, must be a non-empty array of diagnostics.");
    }
  }

  return errors.length === 0 ? { ok: true, record: value, errors: [] } : { ok: false, errors };
}

function validateAuditCounselPacket(errors, value) {
  if (value.mode !== "launch") {
    if (value.counselPacket !== null) {
      errors.push("Public Presence copy audit record counselPacket must be null outside launch mode.");
    }
    return;
  }
  if (!isRecord(value.counselPacket)) {
    errors.push("Public Presence copy audit record counselPacket must be an object in launch mode.");
    return;
  }
  const packet = value.counselPacket;
  pushClosedFieldErrors(errors, packet, AUDIT_COUNSEL_PACKET_FIELDS, "counselPacket.", []);
  if (packet.schemaVersion !== null && !isNonEmptyString(packet.schemaVersion)) {
    errors.push("Public Presence copy audit record counselPacket.schemaVersion must be null or a non-empty string.");
  }
  if (packet.sha256 !== null && !(typeof packet.sha256 === "string" && SHA256_PATTERN.test(packet.sha256))) {
    errors.push("Public Presence copy audit record counselPacket.sha256 must be null or a lowercase sha256 digest.");
  }
  if (packet.utf8Bytes !== null && !(Number.isInteger(packet.utf8Bytes) && packet.utf8Bytes > 0)) {
    errors.push("Public Presence copy audit record counselPacket.utf8Bytes must be null or a positive integer.");
  }
  if (
    packet.corpusSha256 !== null &&
    !(typeof packet.corpusSha256 === "string" && SHA256_PATTERN.test(packet.corpusSha256))
  ) {
    errors.push(
      "Public Presence copy audit record counselPacket.corpusSha256 must be null or a lowercase sha256 digest.",
    );
  }
  if (typeof packet.verified !== "boolean") {
    errors.push("Public Presence copy audit record counselPacket.verified must be a boolean.");
  }
}

function validateAuditPages(errors, value) {
  if (!Array.isArray(value.pages)) {
    errors.push("Public Presence copy audit record pages must be an array.");
    return;
  }
  if (value.pages.length !== value.uniqueFetchedPathCount) {
    errors.push("Public Presence copy audit record pages must have exactly uniqueFetchedPathCount rows.");
  }
  const seenPaths = new Set();
  for (const [index, page] of value.pages.entries()) {
    const rowPath = `pages[${index}]`;
    if (!isRecord(page)) {
      errors.push(`Public Presence copy audit record ${rowPath} must be an object.`);
      continue;
    }
    pushClosedFieldErrors(errors, page, AUDIT_PAGE_FIELDS, `${rowPath}.`, []);
    if (!isNonEmptyString(page.name)) {
      errors.push(`Public Presence copy audit record ${rowPath}.name must be a non-empty string.`);
    }
    if (typeof page.path !== "string" || !page.path.startsWith("/")) {
      errors.push(`Public Presence copy audit record ${rowPath}.path must be an absolute route.`);
    } else if (seenPaths.has(page.path)) {
      errors.push(`Public Presence copy audit record ${rowPath}.path duplicates an earlier fetched path.`);
    } else {
      seenPaths.add(page.path);
    }
    if (!isNonEmptyString(page.url)) {
      errors.push(`Public Presence copy audit record ${rowPath}.url must be a non-empty string.`);
    }
    if (page.status !== null && !Number.isInteger(page.status)) {
      errors.push(`Public Presence copy audit record ${rowPath}.status must be null or an integer.`);
    }
    if (page.title !== null && typeof page.title !== "string") {
      errors.push(`Public Presence copy audit record ${rowPath}.title must be null or a string.`);
    }
    if (
      !Array.isArray(page.categories) ||
      page.categories.length === 0 ||
      !page.categories.every((category) => PUBLIC_PRESENCE_AUDIT_PAGE_CATEGORIES.includes(category)) ||
      !isCanonicallyOrdered(page.categories, PUBLIC_PRESENCE_AUDIT_PAGE_CATEGORIES)
    ) {
      errors.push(
        `Public Presence copy audit record ${rowPath}.categories must be an ordered nonempty category subset.`,
      );
    }
    for (const field of ["futureOnlyLaunchCopyMatches", "uncertifiedAgentCommerceClaimMatches"]) {
      if (!Array.isArray(page[field]) || !page[field].every(isNonEmptyString)) {
        errors.push(`Public Presence copy audit record ${rowPath}.${field} must be an array of strings.`);
      }
    }
    validateAuditPageMetadata(errors, page, rowPath);
  }
}

function validateAuditPageMetadata(errors, page, rowPath) {
  const metadata = page.policyPublicationMetadata;
  const expectsMetadata = Array.isArray(page.categories) && page.categories.includes("launch-policy");
  if (!expectsMetadata) {
    if (metadata !== null) {
      errors.push(
        `Public Presence copy audit record ${rowPath}.policyPublicationMetadata must be null off launch-policy rows.`,
      );
    }
    return;
  }
  if (metadata === null) {
    return;
  }
  if (!isRecord(metadata)) {
    errors.push(`Public Presence copy audit record ${rowPath}.policyPublicationMetadata must be null or an object.`);
    return;
  }
  pushClosedFieldErrors(errors, metadata, AUDIT_PAGE_METADATA_FIELDS, `${rowPath}.policyPublicationMetadata.`, []);
  for (const field of AUDIT_PAGE_METADATA_FIELDS) {
    if (metadata[field] !== null && typeof metadata[field] !== "string") {
      errors.push(
        `Public Presence copy audit record ${rowPath}.policyPublicationMetadata.${field} must be null or a string.`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Relational record validation
//
// Field shapes alone are not authority. A stored record whose rows are not the
// fetch plan its own mode and membership pairs imply describes fetches that
// never happened, so promotion and the terminal gate would be authorizing
// launch on 17 rows of nothing. These two passes bind the rows to the plan and
// the success booleans to the rows.
// ---------------------------------------------------------------------------

/** The only category sets `buildFetchPlan` can produce, in canonical order. */
const ALLOWED_AUDIT_PAGE_CATEGORY_SETS = [
  ["required-page"],
  ["required-page", "launch-policy"],
  ["launch-policy"],
  ["compliance-article"],
];

const AUDIT_RECORD_LABEL = "Public Presence copy audit record";

function validateAuditFetchPlanComposition(errors, value) {
  const pages = Array.isArray(value.pages) ? value.pages : [];
  // The zero-fetch union branch has no rows to bind, and a row that failed its
  // own shape check is already named by `validateAuditPages`.
  if (pages.length === 0 || !pages.every((page) => isRecord(page) && Array.isArray(page.categories))) {
    return;
  }

  for (const [index, page] of pages.entries()) {
    if (!ALLOWED_AUDIT_PAGE_CATEGORY_SETS.some((allowed) => isExactStringArray(page.categories, allowed))) {
      errors.push(`${AUDIT_RECORD_LABEL} pages[${index}].categories must be one of the planned audit category sets.`);
    }
  }

  const requiredRows = pages.filter((page) => page.categories.includes("required-page"));
  const policyRows = pages.filter((page) => page.categories.includes("launch-policy"));
  const complianceRows = pages.filter((page) => page.categories.includes("compliance-article"));
  const requiredBlock = pages.slice(0, REQUIRED_PUBLIC_PRESENCE_PAGES.length);
  const openingIsCanonical =
    requiredRows.length === REQUIRED_PUBLIC_PRESENCE_PAGES.length &&
    requiredBlock.length === REQUIRED_PUBLIC_PRESENCE_PAGES.length &&
    REQUIRED_PUBLIC_PRESENCE_PAGES.every(
      (required, index) =>
        requiredBlock[index].name === required.name &&
        requiredBlock[index].path === required.path &&
        requiredBlock[index].categories[0] === "required-page",
    );
  if (!openingIsCanonical) {
    errors.push(`${AUDIT_RECORD_LABEL} pages must open with the canonical required public pages in order.`);
  }

  if (value.mode !== "launch") {
    if (pages.length !== REQUIRED_PUBLIC_PRESENCE_PAGES.length) {
      errors.push(`${AUDIT_RECORD_LABEL} prelaunch pages must be exactly the eight required public pages.`);
    }
    if (policyRows.length > 0 || complianceRows.length > 0) {
      errors.push(`${AUDIT_RECORD_LABEL} prelaunch pages must not carry launch-only categories.`);
    }
    return;
  }

  const policyKeys = value.launchRequiredPolicyKeys;
  const complianceSlugs = value.complianceArticleSlugs;
  if (!Array.isArray(policyKeys) || !Array.isArray(complianceSlugs)) {
    errors.push(
      `${AUDIT_RECORD_LABEL} launch pages require both membership pairs to carry their exact ordered identities.`,
    );
    return;
  }
  if (policyRows.length !== policyKeys.length) {
    errors.push(
      `${AUDIT_RECORD_LABEL} launch pages must carry exactly one launch-policy row per launch-required policy key.`,
    );
  }
  if (complianceRows.length !== complianceSlugs.length) {
    errors.push(
      `${AUDIT_RECORD_LABEL} launch pages must carry exactly one compliance-article row per compliance member.`,
    );
  }

  // `/terms` and `/privacy` declare two categories but are fetched once, so the
  // row count is the deduplicated 8 + policies + articles.
  const sharedRows = pages.filter(
    (page) => page.categories.includes("required-page") && page.categories.includes("launch-policy"),
  );
  const expectedRowCount =
    REQUIRED_PUBLIC_PRESENCE_PAGES.length + policyKeys.length + complianceSlugs.length - sharedRows.length;
  if (pages.length !== expectedRowCount) {
    errors.push(`${AUDIT_RECORD_LABEL} launch pages must be the ${expectedRowCount} deduplicated planned routes.`);
  }
  if (!sharedRows.every((page) => requiredBlock.includes(page))) {
    errors.push(`${AUDIT_RECORD_LABEL} only a required public page row may also declare the launch-policy category.`);
  }

  const policyOnlyRows = pages.slice(
    REQUIRED_PUBLIC_PRESENCE_PAGES.length,
    REQUIRED_PUBLIC_PRESENCE_PAGES.length + policyKeys.length - sharedRows.length,
  );
  if (
    policyOnlyRows.length !== policyKeys.length - sharedRows.length ||
    !policyOnlyRows.every((page) => isExactStringArray(page.categories, ["launch-policy"])) ||
    !isOrderedSubsequence(
      policyOnlyRows.map((page) => page.name),
      policyKeys,
    )
  ) {
    errors.push(
      `${AUDIT_RECORD_LABEL} launch pages must continue with the launch-required policy routes in registry order.`,
    );
  }

  const complianceBlock = pages.slice(pages.length - complianceSlugs.length);
  if (
    complianceRows.length !== complianceSlugs.length ||
    !complianceBlock.every((page) => isExactStringArray(page.categories, ["compliance-article"])) ||
    !isExactStringArray(
      complianceBlock.map((page) => page.name),
      complianceSlugs,
    )
  ) {
    errors.push(
      `${AUDIT_RECORD_LABEL} launch pages must end with one row per compliance article slug in manifest order.`,
    );
  }

  const declaredKeys = resolvePolicyRowKeys(policyRows);
  if (declaredKeys.some((key) => key !== null && !policyKeys.includes(key)) || hasRepeatedIdentity(declaredKeys)) {
    errors.push(`${AUDIT_RECORD_LABEL} every launch-policy row must name a distinct launch-required policy member.`);
  }
}

function validateAuditEvidenceCoherence(errors, value) {
  const pages = Array.isArray(value.pages) ? value.pages : [];
  if (!pages.every(isCoherenceReadyRow) || (value.mode !== "launch" && value.mode !== "prelaunch")) {
    return;
  }
  const baseUrl = value.baseUrl;

  // Recomputed through the producer's own predicate, so the stored booleans
  // cannot drift from the rows they claim to summarize.
  const expectedCopyReviewed = pages.length > 0 && evaluateCopyPredicates(value.mode, pages, baseUrl).length === 0;
  if (value.publicPresenceLaunchCopyReviewed !== expectedCopyReviewed) {
    errors.push(`${AUDIT_RECORD_LABEL} publicPresenceLaunchCopyReviewed must agree with its own page rows.`);
  }
  const allRowsProvable = pages.length > 0 && pages.every((page) => isAuditedTargetResponse(baseUrl, page));
  const expectedUncertifiedAbsent =
    allRowsProvable && pages.every((page) => page.uncertifiedAgentCommerceClaimMatches.length === 0);
  if (value.uncertifiedClaimsAbsent !== expectedUncertifiedAbsent) {
    errors.push(`${AUDIT_RECORD_LABEL} uncertifiedClaimsAbsent must agree with its own page rows.`);
  }
  const expectedFutureOnlyRemoved =
    value.mode === "launch" && allRowsProvable && pages.every((page) => page.futureOnlyLaunchCopyMatches.length === 0);
  if (value.futureOnlyLaunchCopyRemoved !== expectedFutureOnlyRemoved) {
    errors.push(`${AUDIT_RECORD_LABEL} futureOnlyLaunchCopyRemoved must agree with its own page rows.`);
  }

  if (value.mode === "launch") {
    validateLaunchReviewCoherence(errors, value, pages, baseUrl);
  }
  if (value.passesPublicPresenceCopyAudit !== true) {
    return;
  }
  if (Object.hasOwn(value, "errors")) {
    errors.push(`${AUDIT_RECORD_LABEL} cannot report a pass while it carries diagnostics.`);
  }
  const proved =
    value.mode === "launch"
      ? [
          value.publicPresenceLaunchCopyReviewed,
          value.futureOnlyLaunchCopyRemoved,
          value.policyPagesReviewed,
          value.complianceArticlesReviewed,
          value.dmcaRegistrationMarkerAbsent,
          value.uncertifiedClaimsAbsent,
          isRecord(value.counselPacket) ? value.counselPacket.verified : false,
        ]
      : [value.publicPresenceLaunchCopyReviewed, value.uncertifiedClaimsAbsent];
  if (!proved.every((predicate) => predicate === true)) {
    errors.push(`${AUDIT_RECORD_LABEL} cannot report a pass without every mode predicate proved.`);
  }
}

function validateLaunchReviewCoherence(errors, value, pages, baseUrl) {
  const policyKeys = Array.isArray(value.launchRequiredPolicyKeys) ? value.launchRequiredPolicyKeys : [];
  const complianceSlugs = Array.isArray(value.complianceArticleSlugs) ? value.complianceArticleSlugs : [];
  const policyRows = pages.filter((page) => page.categories.includes("launch-policy"));
  const complianceRows = pages.filter((page) => page.categories.includes("compliance-article"));

  if (value.policyPagesReviewed === true) {
    const declaredKeys = resolvePolicyRowKeys(policyRows).filter((key) => key !== null);
    const everyRowProved = policyRows.every((page) => {
      const metadata = page.policyPublicationMetadata;
      return (
        isAuditedTargetResponse(baseUrl, page) &&
        isRecord(metadata) &&
        isNonEmptyString(metadata.policyKey) &&
        policyKeys.includes(metadata.policyKey) &&
        POLICY_VERSION_PATTERN.test(metadata.version ?? "") &&
        metadata.publicationStatus === "published" &&
        isIsoTimestamp(metadata.effectiveAt)
      );
    });
    if (
      policyKeys.length === 0 ||
      policyRows.length !== policyKeys.length ||
      declaredKeys.length !== policyKeys.length ||
      !everyRowProved
    ) {
      errors.push(
        `${AUDIT_RECORD_LABEL} policyPagesReviewed=true requires every launch-required policy row to answer 200 on its canonical route with its exact published policy metadata.`,
      );
    }
  }

  if (value.complianceArticlesReviewed === true) {
    if (
      complianceSlugs.length === 0 ||
      complianceRows.length !== complianceSlugs.length ||
      !complianceRows.every((page) => isAuditedTargetResponse(baseUrl, page))
    ) {
      errors.push(
        `${AUDIT_RECORD_LABEL} complianceArticlesReviewed=true requires every compliance article row to answer 200 on its canonical route.`,
      );
    }
  }

  if (
    value.dmcaRegistrationMarkerAbsent === true &&
    !complianceRows.some((page) => isAuditedTargetResponse(baseUrl, page))
  ) {
    errors.push(
      `${AUDIT_RECORD_LABEL} dmcaRegistrationMarkerAbsent=true requires an audited compliance article response to read the marker from.`,
    );
  }
}

/**
 * The policy identity each launch-policy row carries: its own name when the
 * route belongs to no required public page, otherwise the key its published
 * metadata declares. `null` means the row proves no identity, which only a
 * failure branch may contain.
 */
function resolvePolicyRowKeys(policyRows) {
  return policyRows.map((page) => {
    if (!page.categories.includes("required-page")) {
      return typeof page.name === "string" ? page.name : null;
    }
    const metadata = page.policyPublicationMetadata;
    return isRecord(metadata) && isNonEmptyString(metadata.policyKey) ? metadata.policyKey : null;
  });
}

function isCoherenceReadyRow(page) {
  return (
    isRecord(page) &&
    typeof page.name === "string" &&
    typeof page.path === "string" &&
    typeof page.url === "string" &&
    (page.status === null || Number.isInteger(page.status)) &&
    Array.isArray(page.categories) &&
    Array.isArray(page.futureOnlyLaunchCopyMatches) &&
    Array.isArray(page.uncertifiedAgentCommerceClaimMatches)
  );
}

function hasRepeatedIdentity(values) {
  const declared = values.filter((value) => value !== null);
  return new Set(declared).size !== declared.length;
}

function isOrderedSubsequence(values, canonical) {
  const indexes = values.map((value) => canonical.indexOf(value));
  return indexes.every((index, position) => index >= 0 && (position === 0 || indexes[position - 1] < index));
}

/**
 * The page evidence a downstream consumer can revalidate against canonical
 * membership without holding the audit record itself. Derived only from rows
 * the audit actually emitted; it carries no new custody claim.
 */
export function projectPublicPresenceCopyAuditPageEvidence(audit) {
  if (!isRecord(audit) || !Array.isArray(audit.pages) || !audit.pages.every(isCoherenceReadyRow)) {
    return null;
  }
  const rows = audit.pages;
  return {
    fetchedPathCount: rows.length,
    requiredPagePaths: rows.filter((row) => row.categories.includes("required-page")).map((row) => row.path),
    launchPolicyPolicyKeys: resolvePolicyRowKeys(rows.filter((row) => row.categories.includes("launch-policy"))),
    complianceArticleSlugs: rows.filter((row) => row.categories.includes("compliance-article")).map((row) => row.name),
    verifiedOnAuditedOriginCount: rows.filter((row) => isAuditedTargetResponse(audit.baseUrl, row)).length,
  };
}

function validateMembershipPair(errors, count, values, label) {
  if (count === null && values === null) {
    return;
  }
  if (count === null || values === null) {
    errors.push(`Public Presence copy audit record ${label}Count/${label}Keys must both be null or both be exact.`);
    return;
  }
  if (!Array.isArray(values) || values.length === 0 || !values.every(isNonEmptyString)) {
    errors.push(
      `Public Presence copy audit record ${label} membership must be a non-empty ordered array of identities.`,
    );
    return;
  }
  if (new Set(values).size !== values.length) {
    errors.push(`Public Presence copy audit record ${label} membership must not repeat an identity.`);
  }
  if (count !== values.length) {
    errors.push(`Public Presence copy audit record ${label} count must equal its ordered membership length.`);
  }
}

function pushClosedFieldErrors(errors, value, knownFields, pathPrefix, optionalFields) {
  for (const field of Object.keys(value)) {
    if (!knownFields.includes(field) && !optionalFields.includes(field)) {
      errors.push(`Public Presence copy audit record has an unexpected field '${pathPrefix}${field}'.`);
    }
  }
  for (const field of knownFields) {
    if (!Object.hasOwn(value, field)) {
      errors.push(`Public Presence copy audit record is missing required field '${pathPrefix}${field}'.`);
    }
  }
}

function isCanonicallyOrdered(values, canonical) {
  const indexes = values.map((value) => canonical.indexOf(value));
  return indexes.every((index, position) => position === 0 || indexes[position - 1] < index);
}

function isExactStringArray(value, expected) {
  return (
    Array.isArray(value) && value.length === expected.length && value.every((entry, index) => entry === expected[index])
  );
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/**
 * The one CLI entrypoint. Option-shape errors are refused before invocation
 * and write no JSON at all (exit 2); every accepted invocation writes exactly
 * one parseable v2 record plus a terminal newline and exits 0 on pass or 1 on
 * either audit failure branch.
 */
export async function main(argv, io = {}) {
  const write = io.write ?? ((value) => process.stdout.write(value));
  const writeError = io.writeError ?? ((value) => process.stderr.write(`${value}\n`));
  const options = parsePublicPresenceCopyAuditArgs(argv, io.env ?? process.env);
  const optionErrors = validatePublicPresenceCopyAuditOptions(options);
  if (optionErrors.length > 0) {
    for (const error of optionErrors) {
      writeError(error);
    }
    return 2;
  }

  const audit = await auditPublicPresenceCopy(options, io);
  write(`${JSON.stringify(audit, null, 2)}\n`);
  if (!audit.passesPublicPresenceCopyAudit) {
    writeError("Public Presence copy audit did not satisfy the requested launch posture.");
    return 1;
  }
  return 0;
}

function normalizeAuditInput(input) {
  const mode = requireMode(input.mode);
  return {
    baseUrl: requireString(input.baseUrl, "Public Presence copy audit baseUrl"),
    mode,
    checkedAt: requireString(input.checkedAt, "Public Presence copy audit checkedAt"),
    counselPacketPath: mode === "launch" ? requireString(input.counselPacketPath, "Counsel review packet path") : null,
    counselPacketReceiptPath:
      mode === "launch" ? requireString(input.counselPacketReceiptPath, "Counsel review packet receipt path") : null,
  };
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

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
}
