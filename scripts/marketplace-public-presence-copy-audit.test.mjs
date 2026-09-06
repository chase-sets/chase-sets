import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildCounselReviewPacketReceipt,
  buildLegalReviewCorpus,
  loadLegalReviewAuthorities,
  renderCounselReviewPacket,
  renderCounselReviewPacketReceipt,
  resolveLegalReviewMembership,
} from "./legal-review-corpus.mjs";
import {
  MARKETPLACE_PUBLIC_PRESENCE_COPY_AUDIT_VERSION,
  REQUIRED_PUBLIC_PRESENCE_PAGES,
  REQUIRED_PUBLIC_PRESENCE_PAGE_PATHS,
  auditPublicPresenceCopy,
  main,
  parsePublicPresenceCopyAuditArgs,
  validatePublicPresenceCopyAuditOptions,
  validatePublicPresenceCopyAuditRecord,
} from "./marketplace-public-presence-copy-audit.mjs";

// The launch fixtures below are an unmistakably synthetic counsel disposition:
// a placeholder approval reference and a placeholder Copyright Office record
// token, applied in memory only. They exercise the launch branch; they assert
// nothing about real counsel review or real DMCA registration, and no
// checked-in file is modified.
const SYNTHETIC_COUNSEL_APPROVAL_REFERENCE = "SYNTHETIC-COUNSEL-DISPOSITION-CONTROL-0001";
const SYNTHETIC_DMCA_DIRECTORY_RECORD = "synthetic-directory-record-control";
const LAUNCH_BODY = "Live marketplace policies are available. Support is available.";
const PRELAUNCH_BODY =
  "Public marketplace checkout opens only after production promotion approval. Request early access.";
const CHECKED_AT = "2026-09-05T02:00:00.000Z";

let baseAuthorities;
let launchAuthorities;
let launchMembership;
let launchCorpus;
let preCounselMembership;
let preCounselCorpus;
let temporaryDirectory;
let packetPath;
let receiptPath;

beforeAll(async () => {
  baseAuthorities = await loadLegalReviewAuthorities();
  preCounselMembership = resolveLegalReviewMembership(baseAuthorities);
  preCounselCorpus = expectCorpus(baseAuthorities);

  launchAuthorities = {
    ...baseAuthorities,
    policyRegistry: baseAuthorities.policyRegistry.map(toPublishedEntry),
    helpArticleSources: baseAuthorities.helpArticleSources.map((source) =>
      source.fileName === "intellectual-property-and-dmca.en.md"
        ? {
            ...source,
            source: source.source.replaceAll(
              baseAuthorities.dmcaUnverifiedRegistrationMarker,
              SYNTHETIC_DMCA_DIRECTORY_RECORD,
            ),
          }
        : source,
    ),
  };
  launchMembership = resolveLegalReviewMembership(launchAuthorities);
  launchCorpus = expectCorpus(launchAuthorities);

  temporaryDirectory = mkdtempSync(path.join(tmpdir(), "public-presence-copy-audit-"));
  packetPath = path.join(temporaryDirectory, "counsel-review-packet.md");
  receiptPath = path.join(temporaryDirectory, "counsel-review-packet.receipt.json");
  const packet = renderCounselReviewPacket(launchCorpus);
  writeFileSync(packetPath, packet, "utf8");
  writeFileSync(
    receiptPath,
    renderCounselReviewPacketReceipt(buildCounselReviewPacketReceipt(launchCorpus, Buffer.from(packet, "utf8"))),
    "utf8",
  );
}, 120_000);

afterAll(() => {
  if (temporaryDirectory) {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

function expectCorpus(authorities) {
  const result = buildLegalReviewCorpus(authorities);
  if (!result.ok) {
    throw new Error(`expected a valid corpus, got: ${result.errors.join(" | ")}`);
  }
  return result.corpus;
}

function toPublishedEntry(entry) {
  return {
    ...entry,
    artifact: {
      ...entry.artifact,
      metadata: {
        ...entry.artifact.metadata,
        publicationStatus: "published",
        effectiveAt: "2026-09-01T00:00:00.000Z",
        counselApprovalReference: SYNTHETIC_COUNSEL_APPROVAL_REFERENCE,
        rolloutJurisdictionsOrProductLimits: ["synthetic-reviewed-rollout-scope"],
      },
      sections: entry.artifact.sections.map((section) => ({ ...section, reviewStatus: "counsel-approved" })),
    },
  };
}

function page(title, body) {
  return `<html><head><title>${title}</title></head><body>${body}</body></html>`;
}

function policyPage(policyKey, version, body = LAUNCH_BODY, overrides = {}) {
  const metadata = {
    "policy-key": policyKey,
    "policy-version": version,
    "policy-publication-status": "published",
    "policy-effective-at": "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
  const attributes = Object.entries(metadata)
    .map(([name, value]) => `data-${name}="${value}"`)
    .join(" ");
  return `<html><head><title>${policyKey}</title></head><body><main ${attributes}>${body}</main></body></html>`;
}

function launchPageBodies(corpus, body = LAUNCH_BODY) {
  const bodies = {};
  for (const required of REQUIRED_PUBLIC_PRESENCE_PAGES) {
    bodies[required.path] = page(required.name, body);
  }
  for (const policy of corpus.policies.filter((candidate) => candidate.launchRequired)) {
    bodies[policy.href] = policyPage(policy.policyKey, policy.version, body);
  }
  for (const article of corpus.complianceArticles) {
    bodies[article.href] = page(article.slug, body);
  }
  return bodies;
}

function prelaunchPageBodies(body = PRELAUNCH_BODY) {
  return Object.fromEntries(
    REQUIRED_PUBLIC_PRESENCE_PAGES.map((required) => [required.path, page(required.name, body)]),
  );
}

function fetchWithPages(bodies, options = {}) {
  return async (url) => {
    const requested = new URL(url).pathname;
    if (options.unreachablePaths?.includes(requested)) {
      throw new Error("SYNTHETIC-TRANSPORT-FAILURE-DETAIL-SHOULD-NEVER-SURFACE");
    }
    const body = bodies[requested];
    if (body === undefined) {
      return { status: 404, url, text: async () => "" };
    }
    return { status: 200, url: options.resolvedUrls?.[requested] ?? url, text: async () => body };
  };
}

function launchInput(overrides = {}) {
  return {
    baseUrl: "https://chasesets.com",
    mode: "launch",
    checkedAt: CHECKED_AT,
    counselPacketPath: packetPath,
    counselPacketReceiptPath: receiptPath,
    ...overrides,
  };
}

function prelaunchInput(overrides = {}) {
  return { baseUrl: "https://chasesets.com", mode: "prelaunch", checkedAt: CHECKED_AT, ...overrides };
}

function launchDependencies(overrides = {}) {
  return {
    fetch: fetchWithPages(launchPageBodies(launchCorpus)),
    membership: launchMembership,
    corpus: { ok: true, corpus: launchCorpus },
    ...overrides,
  };
}

function withoutPages(record) {
  const { pages: _pages, ...rest } = record;
  return rest;
}

function writeTemporaryFile(name, content) {
  const filePath = path.join(temporaryDirectory, name);
  writeFileSync(filePath, content, "utf8");
  return filePath;
}

async function runCli(argv, dependencies) {
  const stdout = [];
  const stderr = [];
  const exitCode = await main(argv, {
    write: (value) => stdout.push(value),
    writeError: (value) => stderr.push(value),
    env: {},
    ...dependencies,
  });
  return { exitCode, stdout: stdout.join(""), stderr };
}

describe("marketplace public presence copy audit: launch mode", () => {
  it("emits the exact successful launch shape with 17 unique fetches after verifying the retained packet", async () => {
    const audit = await auditPublicPresenceCopy(launchInput(), launchDependencies());

    expect(withoutPages(audit)).toEqual({
      schemaVersion: MARKETPLACE_PUBLIC_PRESENCE_COPY_AUDIT_VERSION,
      baseUrl: "https://chasesets.com",
      mode: "launch",
      checkedAt: CHECKED_AT,
      requiredPageCount: 8,
      requiredPagePaths: [...REQUIRED_PUBLIC_PRESENCE_PAGE_PATHS],
      launchRequiredPolicyCount: 6,
      launchRequiredPolicyKeys: [
        "terms-of-service",
        "privacy-policy",
        "seller-agreement",
        "payments-terms",
        "agent-connector-terms",
        "founders-offer-terms",
      ],
      complianceArticleCount: 5,
      complianceArticleSlugs: [
        "community-guidelines-and-enforcement",
        "intellectual-property-and-dmca",
        "prohibited-and-restricted-items",
        "sales-tax",
        "tax-reporting-1099k",
      ],
      uniqueFetchedPathCount: 17,
      legalCorpusDigest: launchCorpus.identity.sha256,
      counselPacket: {
        schemaVersion: "counsel-review-packet/v1",
        sha256: buildCounselReviewPacketReceipt(
          launchCorpus,
          Buffer.from(renderCounselReviewPacket(launchCorpus), "utf8"),
        ).packet.sha256,
        utf8Bytes: Buffer.byteLength(renderCounselReviewPacket(launchCorpus), "utf8"),
        corpusSha256: launchCorpus.identity.sha256,
        verified: true,
      },
      publicPresenceLaunchCopyReviewed: true,
      futureOnlyLaunchCopyRemoved: true,
      policyPagesReviewed: true,
      complianceArticlesReviewed: true,
      dmcaRegistrationMarkerAbsent: true,
      uncertifiedClaimsAbsent: true,
      passesPublicPresenceCopyAudit: true,
    });

    // `/terms` and `/privacy` declare two categories but are fetched once.
    expect(audit.pages.map((row) => row.path)).toEqual([
      "/",
      "/terms",
      "/privacy",
      "/refunds-and-returns",
      "/order-protection",
      "/sales-fees",
      "/faq",
      "/contact",
      "/seller-agreement",
      "/payments-terms",
      "/agent-terms",
      "/founders",
      "/help/buying/community-guidelines-and-enforcement",
      "/help/selling/intellectual-property-and-dmca",
      "/help/selling/prohibited-and-restricted-items",
      "/help/selling/sales-tax",
      "/help/selling/tax-reporting-1099k",
    ]);
    expect(new Set(audit.pages.map((row) => row.path)).size).toBe(17);
    expect(audit.pages.find((row) => row.path === "/terms")).toEqual({
      name: "terms",
      path: "/terms",
      url: "https://chasesets.com/terms",
      status: 200,
      title: "terms-of-service",
      categories: ["required-page", "launch-policy"],
      futureOnlyLaunchCopyMatches: [],
      uncertifiedAgentCommerceClaimMatches: [],
      policyPublicationMetadata: {
        policyKey: "terms-of-service",
        version: "v1",
        publicationStatus: "published",
        effectiveAt: "2026-09-01T00:00:00.000Z",
      },
    });
    expect(audit.pages.find((row) => row.path === "/help/selling/sales-tax")).toEqual({
      name: "sales-tax",
      path: "/help/selling/sales-tax",
      url: "https://chasesets.com/help/selling/sales-tax",
      status: 200,
      title: "sales-tax",
      categories: ["compliance-article"],
      futureOnlyLaunchCopyMatches: [],
      uncertifiedAgentCommerceClaimMatches: [],
      policyPublicationMetadata: null,
    });
    // Authenticity Service Terms is packet-only and is never audited as a
    // launch-required route.
    expect(audit.pages.some((row) => row.path === "/authenticity-terms")).toBe(false);
    expect(audit.launchRequiredPolicyKeys).not.toContain("authenticity-service-terms");
    expect(validatePublicPresenceCopyAuditRecord(audit)).toEqual({ ok: true, record: audit, errors: [] });
    expect(audit).not.toHaveProperty("termsPublicationReady");
  });

  it("still verifies the pre-counsel packet after a publication-only lifecycle transition", async () => {
    // The retained packet was rendered from the pre-counsel snapshot in this
    // fixture's own lifecycle; the audit compares the receipt's stable
    // reviewed-content identity, never regenerated post-publication bytes.
    const preCounselPacket = renderCounselReviewPacket(preCounselCorpus);
    const preCounselPacketPath = writeTemporaryFile("pre-counsel-packet.md", preCounselPacket);
    const preCounselReceiptPath = writeTemporaryFile(
      "pre-counsel-packet.receipt.json",
      renderCounselReviewPacketReceipt(
        buildCounselReviewPacketReceipt(preCounselCorpus, Buffer.from(preCounselPacket, "utf8")),
      ),
    );

    const published = expectCorpus({
      ...baseAuthorities,
      policyRegistry: baseAuthorities.policyRegistry.map(toPublishedEntry),
    });
    expect(published.identity.sha256).toBe(preCounselCorpus.identity.sha256);

    const audit = await auditPublicPresenceCopy(
      launchInput({ counselPacketPath: preCounselPacketPath, counselPacketReceiptPath: preCounselReceiptPath }),
      {
        fetch: fetchWithPages(launchPageBodies(published)),
        membership: preCounselMembership,
        corpus: { ok: true, corpus: published },
      },
    );

    expect(audit.counselPacket.verified).toBe(true);
    expect(audit.legalCorpusDigest).toBe(preCounselCorpus.identity.sha256);
    // The checked-in DMCA marker is still present in this corpus, so launch is
    // correctly refused even though the packet verified.
    expect(audit.dmcaRegistrationMarkerAbsent).toBe(false);
    expect(audit.passesPublicPresenceCopyAudit).toBe(false);
    expect(audit.errors.join(" ")).toContain("unverified DMCA registration marker");
  });

  it("refuses launch while the DMCA registration marker is on the live page", async () => {
    const bodies = launchPageBodies(launchCorpus);
    bodies["/help/selling/intellectual-property-and-dmca"] = page(
      "dmca",
      `${LAUNCH_BODY} registration-status-unverified`,
    );

    const audit = await auditPublicPresenceCopy(launchInput(), launchDependencies({ fetch: fetchWithPages(bodies) }));
    expect(audit.dmcaRegistrationMarkerAbsent).toBe(false);
    expect(audit.passesPublicPresenceCopyAudit).toBe(false);
    expect(audit.errors).toContain(
      "The live DMCA compliance page still carries the unverified DMCA registration marker.",
    );
  });

  it("fails each launch policy route control: pending posture, wrong version, invalid instant, and wrong key", async () => {
    const cases = [
      {
        overrides: { "policy-publication-status": "counsel-review-required" },
        expected: "must be published before launch",
      },
      { version: "v9", expected: "must expose the exact current v1 policy version" },
      { overrides: { "policy-effective-at": "2026-09-01" }, expected: "must expose an effective ISO timestamp" },
      { policyKey: "privacy-policy", expected: "must expose the canonical seller-agreement policy key" },
    ];

    for (const testCase of cases) {
      const bodies = launchPageBodies(launchCorpus);
      bodies["/seller-agreement"] = policyPage(
        testCase.policyKey ?? "seller-agreement",
        testCase.version ?? "v1",
        LAUNCH_BODY,
        testCase.overrides ?? {},
      );
      const audit = await auditPublicPresenceCopy(launchInput(), launchDependencies({ fetch: fetchWithPages(bodies) }));
      expect(audit.policyPagesReviewed, testCase.expected).toBe(false);
      expect(audit.passesPublicPresenceCopyAudit).toBe(false);
      expect(audit.errors.join(" ")).toContain(testCase.expected);
      // Post-verification failure keeps every exact pair and the verified packet.
      expect(audit.uniqueFetchedPathCount).toBe(17);
      expect(audit.counselPacket.verified).toBe(true);
      expect(audit.launchRequiredPolicyCount).toBe(6);
      expect(audit.complianceArticleCount).toBe(5);
    }
  });

  it("fails when a compliance route is missing or redirects away from its canonical path", async () => {
    const missingBodies = launchPageBodies(launchCorpus);
    delete missingBodies["/help/selling/tax-reporting-1099k"];
    const missing = await auditPublicPresenceCopy(
      launchInput(),
      launchDependencies({ fetch: fetchWithPages(missingBodies) }),
    );
    expect(missing.complianceArticlesReviewed).toBe(false);
    expect(missing.passesPublicPresenceCopyAudit).toBe(false);
    expect(missing.errors).toContain("Public Presence page /help/selling/tax-reporting-1099k returned status 404.");

    const redirected = await auditPublicPresenceCopy(
      launchInput(),
      launchDependencies({
        fetch: fetchWithPages(launchPageBodies(launchCorpus), {
          resolvedUrls: { "/help/selling/sales-tax": "https://chasesets.com/help/selling/sales-tax-legacy" },
        }),
      }),
    );
    expect(redirected.complianceArticlesReviewed).toBe(false);
    expect(redirected.errors).toContain(
      "Public Presence compliance article /help/selling/sales-tax did not resolve to its canonical route.",
    );
  });

  it("refuses same-path off-origin resolutions for required, policy, and compliance targets", async () => {
    // A redirect that keeps the requested pathname but lands on another origin
    // is not Chase Sets copy: the bytes it returns can prove nothing about the
    // audited site. `synthetic.invalid` is a reserved, unroutable control host.
    const categoryTargets = {
      "/faq": "https://synthetic.invalid/faq",
      "/seller-agreement": "https://synthetic.invalid/seller-agreement",
      "/help/selling/sales-tax": "https://synthetic.invalid/help/selling/sales-tax",
    };
    const oneRowPerCategory = await auditPublicPresenceCopy(
      launchInput(),
      launchDependencies({
        fetch: fetchWithPages(launchPageBodies(launchCorpus), { resolvedUrls: categoryTargets }),
      }),
    );

    // Every planned path is still attempted after retained-byte verification.
    expect(oneRowPerCategory.pages).toHaveLength(17);
    expect(oneRowPerCategory.uniqueFetchedPathCount).toBe(17);
    expect(oneRowPerCategory.counselPacket.verified).toBe(true);
    expect(oneRowPerCategory.publicPresenceLaunchCopyReviewed).toBe(false);
    expect(oneRowPerCategory.futureOnlyLaunchCopyRemoved).toBe(false);
    expect(oneRowPerCategory.uncertifiedClaimsAbsent).toBe(false);
    expect(oneRowPerCategory.policyPagesReviewed).toBe(false);
    expect(oneRowPerCategory.complianceArticlesReviewed).toBe(false);
    expect(oneRowPerCategory.passesPublicPresenceCopyAudit).toBe(false);
    expect(oneRowPerCategory.errors.join(" ")).toContain(
      "Public Presence page /faq did not resolve to the audited origin and canonical route.",
    );
    expect(oneRowPerCategory.errors.join(" ")).toContain(
      "Public Presence /seller-agreement must resolve to the audited origin and canonical route before launch.",
    );
    expect(oneRowPerCategory.errors).toContain(
      "Public Presence compliance article /help/selling/sales-tax did not resolve to its canonical route.",
    );
    // Diagnostics stay bounded: the off-origin location is never echoed.
    expect(oneRowPerCategory.errors.join(" ")).not.toContain("synthetic.invalid");

    const everyRowOffOrigin = await auditPublicPresenceCopy(
      launchInput(),
      launchDependencies({
        fetch: fetchWithPages(launchPageBodies(launchCorpus), {
          resolvedUrls: Object.fromEntries(
            Object.keys(launchPageBodies(launchCorpus)).map((route) => [route, `https://synthetic.invalid${route}`]),
          ),
        }),
      }),
    );
    expect(everyRowOffOrigin.pages).toHaveLength(17);
    expect(everyRowOffOrigin.pages.every((row) => row.status === 200)).toBe(true);
    expect(everyRowOffOrigin.dmcaRegistrationMarkerAbsent).toBe(false);
    expect(everyRowOffOrigin.passesPublicPresenceCopyAudit).toBe(false);
    expect(everyRowOffOrigin.errors.join(" ")).toContain(
      "The live DMCA compliance page did not resolve to the audited origin and canonical route",
    );
  });

  it("attempts every planned path on a post-verification transport failure without leaking the exception", async () => {
    const audit = await auditPublicPresenceCopy(
      launchInput(),
      launchDependencies({
        fetch: fetchWithPages(launchPageBodies(launchCorpus), { unreachablePaths: ["/founders"] }),
      }),
    );

    expect(audit.uniqueFetchedPathCount).toBe(17);
    expect(audit.pages).toHaveLength(17);
    expect(audit.pages.find((row) => row.path === "/founders")).toEqual({
      name: "founders-offer-terms",
      path: "/founders",
      url: "https://chasesets.com/founders",
      status: null,
      title: null,
      categories: ["launch-policy"],
      futureOnlyLaunchCopyMatches: [],
      uncertifiedAgentCommerceClaimMatches: [],
      policyPublicationMetadata: null,
    });
    expect(audit.counselPacket.verified).toBe(true);
    expect(audit.futureOnlyLaunchCopyRemoved).toBe(false);
    expect(audit.uncertifiedClaimsAbsent).toBe(false);
    expect(audit.policyPagesReviewed).toBe(false);
    expect(audit.passesPublicPresenceCopyAudit).toBe(false);
    expect(audit.errors.join(" ")).not.toContain("SYNTHETIC-TRANSPORT-FAILURE-DETAIL-SHOULD-NEVER-SURFACE");
    expect(audit.errors).toContain("Public Presence page /founders could not be fetched.");
  });

  it("fails launch while future-only copy or an uncertified agent-commerce claim remains live", async () => {
    const futureOnly = await auditPublicPresenceCopy(
      launchInput(),
      launchDependencies({
        fetch: fetchWithPages(launchPageBodies(launchCorpus, "Request early access before public checkout opens.")),
      }),
    );
    expect(futureOnly.futureOnlyLaunchCopyRemoved).toBe(false);
    expect(futureOnly.errors).toContain(
      "Public Presence page / still includes future-only launch copy: early access, Request early access.",
    );

    const bodies = launchPageBodies(launchCorpus);
    bodies["/faq"] = page("faq", `${LAUNCH_BODY} AP2 headless checkout is launch-ready.`);
    const uncertified = await auditPublicPresenceCopy(
      launchInput(),
      launchDependencies({ fetch: fetchWithPages(bodies) }),
    );
    expect(uncertified.uncertifiedClaimsAbsent).toBe(false);
    expect(uncertified.errors).toContain(
      "Public Presence page /faq includes uncertified agent-commerce claim: \\bAP2\\b.",
    );
  });
});

describe("marketplace public presence copy audit: pre-verification failure branch", () => {
  const preVerificationDependencies = () => ({
    fetch: async () => {
      throw new Error("pre-verification failure must perform zero fetches");
    },
    membership: launchMembership,
    corpus: { ok: true, corpus: launchCorpus },
  });

  it("retains both exact membership pairs when only the current source or receipt is invalid", async () => {
    const invalidContent = await auditPublicPresenceCopy(launchInput(), {
      ...preVerificationDependencies(),
      corpus: {
        ok: false,
        errors: ["Public policy 'seller-agreement' subject 'taxes' has no operative draft text to review."],
      },
    });

    expect(invalidContent.uniqueFetchedPathCount).toBe(0);
    expect(invalidContent.pages).toEqual([]);
    expect(invalidContent.launchRequiredPolicyCount).toBe(6);
    expect(invalidContent.launchRequiredPolicyKeys).toHaveLength(6);
    expect(invalidContent.complianceArticleCount).toBe(5);
    expect(invalidContent.complianceArticleSlugs).toHaveLength(5);
    expect(invalidContent.legalCorpusDigest).toBeNull();
    expect(invalidContent.counselPacket.verified).toBe(false);
    expect(invalidContent.counselPacket.sha256).not.toBeNull();
    expect(invalidContent.policyPagesReviewed).toBe(false);
    expect(invalidContent.complianceArticlesReviewed).toBe(false);
    expect(invalidContent.dmcaRegistrationMarkerAbsent).toBe(false);
    expect(invalidContent.passesPublicPresenceCopyAudit).toBe(false);
    expect(validatePublicPresenceCopyAuditRecord(invalidContent).ok).toBe(true);
  });

  it("nulls exactly one membership pair when only that authority is invalid", async () => {
    const invalidPolicyMembership = await auditPublicPresenceCopy(launchInput(), {
      ...preVerificationDependencies(),
      membership: resolveLegalReviewMembership({
        ...launchAuthorities,
        policyRegistry: [...launchAuthorities.policyRegistry, launchAuthorities.policyRegistry[0]],
      }),
    });
    expect(invalidPolicyMembership.launchRequiredPolicyCount).toBeNull();
    expect(invalidPolicyMembership.launchRequiredPolicyKeys).toBeNull();
    expect(invalidPolicyMembership.complianceArticleCount).toBe(5);
    expect(invalidPolicyMembership.complianceArticleSlugs).toHaveLength(5);
    expect(invalidPolicyMembership.uniqueFetchedPathCount).toBe(0);
    expect(invalidPolicyMembership.errors.join(" ")).toContain(
      "registers policy key 'terms-of-service' more than once",
    );
    expect(validatePublicPresenceCopyAuditRecord(invalidPolicyMembership).ok).toBe(true);

    const invalidComplianceMembership = await auditPublicPresenceCopy(launchInput(), {
      ...preVerificationDependencies(),
      membership: resolveLegalReviewMembership({
        ...launchAuthorities,
        complianceArticleSlugs: [...launchAuthorities.complianceArticleSlugs, "sales-tax"],
      }),
    });
    expect(invalidComplianceMembership.complianceArticleCount).toBeNull();
    expect(invalidComplianceMembership.complianceArticleSlugs).toBeNull();
    expect(invalidComplianceMembership.launchRequiredPolicyCount).toBe(6);
    expect(invalidComplianceMembership.launchRequiredPolicyKeys).toHaveLength(6);
    expect(invalidComplianceMembership.errors.join(" ")).toContain("lists article slug 'sales-tax' more than once");
  });

  it("refuses a malformed, predecessor, byte-mismatched, or stale-digest receipt", async () => {
    const malformedPath = writeTemporaryFile("malformed.receipt.json", "{ not json");
    const malformed = await auditPublicPresenceCopy(
      launchInput({ counselPacketReceiptPath: malformedPath }),
      preVerificationDependencies(),
    );
    expect(malformed.counselPacket).toEqual({
      schemaVersion: null,
      sha256: null,
      utf8Bytes: null,
      corpusSha256: null,
      verified: false,
    });
    expect(malformed.errors).toContain("Retained counsel review packet receipt is not parseable JSON.");
    expect(malformed.uniqueFetchedPathCount).toBe(0);

    const predecessorPath = writeTemporaryFile(
      "predecessor.receipt.json",
      `${JSON.stringify({ schemaVersion: "counsel-review-packet-receipt/v0", packet: { sha256: "abc" } }, null, 2)}\n`,
    );
    const predecessor = await auditPublicPresenceCopy(
      launchInput({ counselPacketReceiptPath: predecessorPath }),
      preVerificationDependencies(),
    );
    expect(predecessor.counselPacket.verified).toBe(false);
    expect(predecessor.counselPacket.sha256).toBeNull();
    expect(predecessor.errors.join(" ")).toContain("schemaVersion must be counsel-review-packet-receipt/v1");

    const truncatedPacketPath = writeTemporaryFile("truncated-packet.md", "# not the retained packet\n");
    const byteMismatch = await auditPublicPresenceCopy(
      launchInput({ counselPacketPath: truncatedPacketPath }),
      preVerificationDependencies(),
    );
    expect(byteMismatch.counselPacket.verified).toBe(false);
    expect(byteMismatch.errors).toContain(
      "Retained counsel review packet bytes do not hash to the digest its receipt records.",
    );
    expect(byteMismatch.errors).toContain(
      "Retained counsel review packet byte length does not match the length its receipt records.",
    );

    const missingPacket = await auditPublicPresenceCopy(
      launchInput({ counselPacketPath: path.join(temporaryDirectory, "absent-packet.md") }),
      preVerificationDependencies(),
    );
    expect(missingPacket.counselPacket.verified).toBe(false);
    expect(missingPacket.errors.join(" ")).toContain("Retained counsel review packet bytes could not be read (Error)");
  });

  it("rejects a stable-content change between the retained receipt and current source", async () => {
    const drifted = expectCorpus({
      ...launchAuthorities,
      policyRegistry: launchAuthorities.policyRegistry.map((entry) =>
        entry.artifact.metadata.policyKey === "payments-terms"
          ? {
              ...entry,
              artifact: {
                ...entry.artifact,
                sections: entry.artifact.sections.map((section) =>
                  section.id === "no-interest"
                    ? { ...section, draftText: `${section.draftText} Synthetic stable-content drift control.` }
                    : section,
                ),
              },
            }
          : entry,
      ),
    });

    const audit = await auditPublicPresenceCopy(launchInput(), {
      ...preVerificationDependencies(),
      corpus: { ok: true, corpus: drifted },
    });

    expect(audit.counselPacket.verified).toBe(false);
    expect(audit.legalCorpusDigest).toBe(drifted.identity.sha256);
    expect(audit.legalCorpusDigest).not.toBe(audit.counselPacket.corpusSha256);
    expect(audit.errors).toContain(
      "Retained counsel review receipt corpus digest does not match the current reviewed corpus identity.",
    );
    expect(audit.errors).toContain(
      "Retained counsel review receipt policy member 'payments-terms' field 'reviewedContentSha256' does not match current source.",
    );
    expect(audit.uniqueFetchedPathCount).toBe(0);
  });
});

describe("marketplace public presence copy audit: prelaunch mode", () => {
  it("preserves the existing eight-page prelaunch success contract with explicit null launch authorities", async () => {
    const audit = await auditPublicPresenceCopy(prelaunchInput(), {
      fetch: fetchWithPages(prelaunchPageBodies()),
      membership: preCounselMembership,
      corpus: {
        ok: false,
        errors: ["prelaunch must not consult the corpus"],
      },
    });

    expect(withoutPages(audit)).toEqual({
      schemaVersion: MARKETPLACE_PUBLIC_PRESENCE_COPY_AUDIT_VERSION,
      baseUrl: "https://chasesets.com",
      mode: "prelaunch",
      checkedAt: CHECKED_AT,
      requiredPageCount: 8,
      requiredPagePaths: [...REQUIRED_PUBLIC_PRESENCE_PAGE_PATHS],
      launchRequiredPolicyCount: 6,
      launchRequiredPolicyKeys: [
        "terms-of-service",
        "privacy-policy",
        "seller-agreement",
        "payments-terms",
        "agent-connector-terms",
        "founders-offer-terms",
      ],
      complianceArticleCount: 5,
      complianceArticleSlugs: [
        "community-guidelines-and-enforcement",
        "intellectual-property-and-dmca",
        "prohibited-and-restricted-items",
        "sales-tax",
        "tax-reporting-1099k",
      ],
      uniqueFetchedPathCount: 8,
      legalCorpusDigest: null,
      counselPacket: null,
      publicPresenceLaunchCopyReviewed: true,
      futureOnlyLaunchCopyRemoved: false,
      policyPagesReviewed: null,
      complianceArticlesReviewed: null,
      dmcaRegistrationMarkerAbsent: null,
      uncertifiedClaimsAbsent: true,
      passesPublicPresenceCopyAudit: true,
    });
    expect(audit.pages).toHaveLength(8);
    expect(audit.pages.every((row) => row.categories.length === 1 && row.categories[0] === "required-page")).toBe(true);
    expect(audit.pages.every((row) => row.policyPublicationMetadata === null)).toBe(true);
    expect(validatePublicPresenceCopyAuditRecord(audit).ok).toBe(true);
  });

  it("still fails the prelaunch posture predicate on an ungated required page", async () => {
    const bodies = prelaunchPageBodies();
    bodies["/privacy"] = page("privacy", "Privacy notice.");
    const audit = await auditPublicPresenceCopy(prelaunchInput(), {
      fetch: fetchWithPages(bodies),
      membership: preCounselMembership,
    });
    expect(audit.passesPublicPresenceCopyAudit).toBe(false);
    expect(audit.errors).toContain(
      "Public Presence page /privacy must keep explicit prelaunch/gated-checkout posture.",
    );
  });

  it("takes the zero-fetch union branch when a membership authority is invalid", async () => {
    const audit = await auditPublicPresenceCopy(prelaunchInput(), {
      fetch: async () => {
        throw new Error("invalid prelaunch membership must perform zero fetches");
      },
      membership: resolveLegalReviewMembership({ ...baseAuthorities, complianceArticleSlugs: [] }),
    });

    expect(withoutPages(audit)).toEqual({
      schemaVersion: MARKETPLACE_PUBLIC_PRESENCE_COPY_AUDIT_VERSION,
      baseUrl: "https://chasesets.com",
      mode: "prelaunch",
      checkedAt: CHECKED_AT,
      requiredPageCount: 8,
      requiredPagePaths: [...REQUIRED_PUBLIC_PRESENCE_PAGE_PATHS],
      launchRequiredPolicyCount: 6,
      launchRequiredPolicyKeys: [
        "terms-of-service",
        "privacy-policy",
        "seller-agreement",
        "payments-terms",
        "agent-connector-terms",
        "founders-offer-terms",
      ],
      complianceArticleCount: null,
      complianceArticleSlugs: null,
      uniqueFetchedPathCount: 0,
      legalCorpusDigest: null,
      counselPacket: null,
      publicPresenceLaunchCopyReviewed: false,
      futureOnlyLaunchCopyRemoved: false,
      policyPagesReviewed: null,
      complianceArticlesReviewed: null,
      dmcaRegistrationMarkerAbsent: null,
      uncertifiedClaimsAbsent: false,
      passesPublicPresenceCopyAudit: false,
      errors: ["Compliance legal-review manifest must be a non-empty array of article slugs."],
    });
    expect(audit.pages).toEqual([]);
  });

  it("never reads a packet file or a launch-only route in prelaunch mode", async () => {
    const fetched = [];
    const audit = await auditPublicPresenceCopy(prelaunchInput(), {
      fetch: async (url) => {
        fetched.push(new URL(url).pathname);
        return { status: 200, url, text: async () => page("x", PRELAUNCH_BODY) };
      },
      membership: preCounselMembership,
      readTextFile: async () => {
        throw new Error("prelaunch must not read a packet receipt");
      },
      readBinaryFile: async () => {
        throw new Error("prelaunch must not read packet bytes");
      },
    });

    expect(fetched).toEqual([...REQUIRED_PUBLIC_PRESENCE_PAGE_PATHS]);
    expect(audit.counselPacket).toBeNull();
    expect(audit.legalCorpusDigest).toBeNull();
  });
});

describe("marketplace public presence copy audit: CLI and record contract", () => {
  it("writes exactly one parseable record and exits 0 on pass, 1 on failure, 2 on option-shape errors", async () => {
    const passing = await runCli(
      [
        "--base-url",
        "https://chasesets.com",
        "--mode",
        "launch",
        "--checked-at",
        CHECKED_AT,
        "--counsel-packet",
        packetPath,
        "--counsel-packet-receipt",
        receiptPath,
      ],
      launchDependencies(),
    );
    expect(passing.exitCode).toBe(0);
    expect(passing.stdout.endsWith("\n")).toBe(true);
    expect(JSON.parse(passing.stdout).passesPublicPresenceCopyAudit).toBe(true);

    const bodies = launchPageBodies(launchCorpus);
    delete bodies["/contact"];
    const failing = await runCli(
      [
        "--base-url",
        "https://chasesets.com",
        "--mode",
        "launch",
        "--checked-at",
        CHECKED_AT,
        "--counsel-packet",
        packetPath,
        "--counsel-packet-receipt",
        receiptPath,
      ],
      launchDependencies({ fetch: fetchWithPages(bodies) }),
    );
    expect(failing.exitCode).toBe(1);
    expect(JSON.parse(failing.stdout).passesPublicPresenceCopyAudit).toBe(false);

    const missingPacketOptions = await runCli(["--base-url", "https://chasesets.com", "--mode", "launch"]);
    expect(missingPacketOptions.exitCode).toBe(2);
    expect(missingPacketOptions.stdout).toBe("");
    expect(missingPacketOptions.stderr.join(" ")).toContain("--counsel-packet");

    const prelaunchWithPacket = await runCli([
      "--base-url",
      "https://chasesets.com",
      "--mode",
      "prelaunch",
      "--counsel-packet",
      packetPath,
    ]);
    expect(prelaunchWithPacket.exitCode).toBe(2);
    expect(prelaunchWithPacket.stdout).toBe("");
  });

  it("refuses a malformed base URL at option validation with one diagnostic, no JSON, and no fetch", async () => {
    let fetchCalls = 0;
    const malformed = await runCli(["--base-url", "not-a-url", "--mode", "prelaunch", "--checked-at", CHECKED_AT], {
      fetch: async () => {
        fetchCalls += 1;
        throw new Error("a malformed base URL must never reach a fetch");
      },
    });

    expect(malformed.exitCode).toBe(2);
    expect(malformed.stdout).toBe("");
    expect(malformed.stderr).toEqual([
      "PUBLIC_PRESENCE_COPY_AUDIT_BASE_URL or --base-url must be an absolute http(s) URL.",
    ]);
    expect(fetchCalls).toBe(0);

    const unsupportedScheme = await runCli(["--base-url", "file:///etc/hosts", "--mode", "prelaunch"], {
      fetch: async () => {
        fetchCalls += 1;
        throw new Error("an unsupported scheme must never reach a fetch");
      },
    });
    expect(unsupportedScheme.exitCode).toBe(2);
    expect(unsupportedScheme.stdout).toBe("");
    expect(fetchCalls).toBe(0);

    // The accepted absolute HTTP(S) forms are unchanged in both modes.
    for (const baseUrl of ["https://chasesets.com", "https://chasesets.com/", "http://localhost:3000"]) {
      expect(validatePublicPresenceCopyAuditOptions({ baseUrl, mode: "prelaunch" })).toEqual([]);
    }
  });

  it("parses operator arguments from flags and environment", () => {
    expect(
      parsePublicPresenceCopyAuditArgs(
        [
          "--base-url",
          "https://chasesets.com",
          "--mode",
          "launch",
          "--checked-at",
          CHECKED_AT,
          "--counsel-packet",
          "secure/packet.md",
          "--counsel-packet-receipt",
          "secure/packet.receipt.json",
        ],
        {},
      ),
    ).toEqual({
      baseUrl: "https://chasesets.com",
      mode: "launch",
      checkedAt: CHECKED_AT,
      counselPacketPath: "secure/packet.md",
      counselPacketReceiptPath: "secure/packet.receipt.json",
    });

    expect(
      parsePublicPresenceCopyAuditArgs([], { PUBLIC_PRESENCE_COPY_AUDIT_BASE_URL: "https://chasesets.com" }),
    ).toMatchObject({ baseUrl: "https://chasesets.com", mode: "prelaunch", counselPacketPath: null });
    expect(validatePublicPresenceCopyAuditOptions({ baseUrl: null, mode: "sideways" })).toEqual([
      "PUBLIC_PRESENCE_COPY_AUDIT_BASE_URL or --base-url is required.",
      "PUBLIC_PRESENCE_COPY_AUDIT_MODE or --mode must be prelaunch or launch.",
    ]);
  });

  it("fails a non-ISO checkedAt and rejects unknown, missing, and half-null record fields", async () => {
    const audit = await auditPublicPresenceCopy(launchInput({ checkedAt: "2026-09-05" }), launchDependencies());
    expect(audit.passesPublicPresenceCopyAudit).toBe(false);
    expect(audit.errors).toContain("Public Presence copy audit checkedAt must be an ISO timestamp.");

    const valid = await auditPublicPresenceCopy(launchInput(), launchDependencies());
    const unknownKey = validatePublicPresenceCopyAuditRecord({ ...valid, termsPublicationReady: true });
    expect(unknownKey.ok).toBe(false);
    expect(unknownKey.errors).toContain(
      "Public Presence copy audit record has an unexpected field 'termsPublicationReady'.",
    );

    const { legalCorpusDigest: _digest, ...missingKey } = valid;
    expect(validatePublicPresenceCopyAuditRecord(missingKey).ok).toBe(false);

    const halfNull = validatePublicPresenceCopyAuditRecord({ ...valid, launchRequiredPolicyCount: null });
    expect(halfNull.ok).toBe(false);
    expect(halfNull.errors).toContain(
      "Public Presence copy audit record launchRequiredPolicyCount/launchRequiredPolicyKeys must both be null or both be exact.",
    );

    const v1Record = validatePublicPresenceCopyAuditRecord({
      schemaVersion: "marketplace-public-presence-copy-audit/v1",
      baseUrl: "https://chasesets.com",
      mode: "launch",
      checkedAt: CHECKED_AT,
      requiredPageCount: 8,
      pages: [],
      publicPresenceLaunchCopyReviewed: true,
      futureOnlyLaunchCopyRemoved: true,
      policyPagesReviewed: true,
      termsPublicationReady: true,
      uncertifiedClaimsAbsent: true,
      passesPublicPresenceCopyAudit: true,
    });
    expect(v1Record.ok).toBe(false);
    expect(v1Record.errors.join(" ")).toContain("schemaVersion must be marketplace-public-presence-copy-audit/v2");
  });
});

describe("marketplace public presence copy audit: stored record relational authority", () => {
  // Every case starts from ONE wholly synthetic record the producer actually
  // emitted and mutates a single decisive fact, so a rejection can only come
  // from the relational rule under test rather than from a shape error.
  let valid;

  beforeAll(async () => {
    valid = await auditPublicPresenceCopy(launchInput(), launchDependencies());
    expect(validatePublicPresenceCopyAuditRecord(valid)).toEqual({ ok: true, record: valid, errors: [] });
  }, 120_000);

  function reject(record) {
    const validation = validatePublicPresenceCopyAuditRecord(record);
    expect(validation.ok, JSON.stringify(validation.errors)).toBe(false);
    return validation.errors.join(" ");
  }

  it("rejects 17 coherent-looking rows that are not the fetch plan its own membership implies", () => {
    // Counts, membership pairs, digests, packet verification, and every
    // success boolean are retained; only the row identities are replaced.
    const crafted = {
      ...valid,
      pages: valid.pages.map((row, index) => ({
        ...row,
        name: `synthetic-${index}`,
        path: `/synthetic-${index}`,
        url: `https://chasesets.com/synthetic-${index}`,
      })),
    };
    expect(crafted.pages).toHaveLength(17);
    expect(crafted.uniqueFetchedPathCount).toBe(17);
    expect(crafted.launchRequiredPolicyCount).toBe(6);
    expect(crafted.complianceArticleCount).toBe(5);
    expect(crafted.counselPacket.verified).toBe(true);
    expect(crafted.passesPublicPresenceCopyAudit).toBe(true);
    expect(crafted).not.toHaveProperty("errors");

    expect(reject(crafted)).toContain("must open with the canonical required public pages in order");
  });

  it("rejects a reordered required block, a renamed compliance row, and a non-member policy route", () => {
    const reorderedRequired = {
      ...valid,
      pages: [valid.pages[1], valid.pages[0], ...valid.pages.slice(2)],
    };
    expect(reject(reorderedRequired)).toContain("must open with the canonical required public pages in order");

    const renamedCompliance = {
      ...valid,
      pages: valid.pages.map((row) =>
        row.path === "/help/selling/sales-tax" ? { ...row, name: "synthetic-compliance-member" } : row,
      ),
    };
    expect(reject(renamedCompliance)).toContain("one row per compliance article slug in manifest order");

    const nonMemberPolicy = {
      ...valid,
      pages: valid.pages.map((row) =>
        row.path === "/seller-agreement"
          ? { ...row, name: "authenticity-service-terms", policyPublicationMetadata: null }
          : row,
      ),
    };
    expect(reject(nonMemberPolicy)).toContain("launch-required policy routes in registry order");
  });

  it("rejects success booleans that its own rows do not prove", () => {
    const claimsUncertifiedAbsent = {
      ...valid,
      pages: valid.pages.map((row) =>
        row.path === "/faq" ? { ...row, uncertifiedAgentCommerceClaimMatches: ["\\bAP2\\b"] } : row,
      ),
    };
    expect(reject(claimsUncertifiedAbsent)).toContain("uncertifiedClaimsAbsent must agree with its own page rows");

    const claimsPolicyPagesReviewed = {
      ...valid,
      pages: valid.pages.map((row) => (row.path === "/payments-terms" ? { ...row, status: 404 } : row)),
    };
    expect(reject(claimsPolicyPagesReviewed)).toContain("policyPagesReviewed=true requires every launch-required");

    const claimsOffOriginSuccess = {
      ...valid,
      pages: valid.pages.map((row) =>
        row.path === "/help/selling/sales-tax"
          ? { ...row, url: "https://synthetic.invalid/help/selling/sales-tax" }
          : row,
      ),
    };
    expect(reject(claimsOffOriginSuccess)).toContain("complianceArticlesReviewed=true requires every compliance");

    const passesWithDiagnostics = { ...valid, errors: ["synthetic retained diagnostic"] };
    expect(reject(passesWithDiagnostics)).toContain("cannot report a pass while it carries diagnostics");

    const passesWithoutPacketVerification = {
      ...valid,
      counselPacket: { ...valid.counselPacket, verified: false },
    };
    expect(reject(passesWithoutPacketVerification)).toContain("cannot report a pass without every mode predicate");
  });

  it("rejects a prelaunch record carrying launch-only rows and keeps both zero-fetch branches valid", async () => {
    const prelaunchProjection = {
      ...valid,
      mode: "prelaunch",
      legalCorpusDigest: null,
      counselPacket: null,
      policyPagesReviewed: null,
      complianceArticlesReviewed: null,
      dmcaRegistrationMarkerAbsent: null,
    };
    expect(reject(prelaunchProjection)).toContain("prelaunch pages must be exactly the eight required public pages");

    const zeroFetch = await auditPublicPresenceCopy(launchInput(), {
      fetch: async () => {
        throw new Error("pre-verification failure must perform zero fetches");
      },
      membership: launchMembership,
      corpus: { ok: false, errors: ["synthetic current-source failure"] },
    });
    expect(zeroFetch.pages).toEqual([]);
    expect(validatePublicPresenceCopyAuditRecord(zeroFetch).ok).toBe(true);
  });
});
