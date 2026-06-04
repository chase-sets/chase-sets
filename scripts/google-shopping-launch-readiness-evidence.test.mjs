import { describe, expect, it } from "vitest";
import {
  GOOGLE_SHOPPING_LAUNCH_READINESS_EVIDENCE_VERSION,
  GOOGLE_SHOPPING_OPERATIONS_RUNBOOK_PATH,
  buildGoogleShoppingLaunchReadinessEvidence,
  parseGoogleShoppingLaunchReadinessArgs,
} from "./google-shopping-launch-readiness-evidence.mjs";

const checkedAt = "2026-06-04T12:00:00.000Z";

describe("google shopping launch readiness evidence", () => {
  it("passes live readiness when feed, crawl, policy, diagnostics, sync, and environment evidence are green", () => {
    const evidence = buildGoogleShoppingLaunchReadinessEvidence({
      readinessReport: readinessReport(),
      expectedMode: "live",
      reference: "GOOGLE-SHOPPING-LAUNCH-2026-06-04",
      owner: "Operations",
      checkedAt,
      productionSyncApprovalReference: "GOOGLE-SHOPPING-SYNC-APPROVAL-2026-06-04",
    });

    expect(evidence).toMatchObject({
      schemaVersion: GOOGLE_SHOPPING_LAUNCH_READINESS_EVIDENCE_VERSION,
      readinessStatus: "live",
      merchantFeedSubmissionAllowed: true,
      passesGoogleShoppingLaunchReadinessGate: true,
      runbook: {
        path: GOOGLE_SHOPPING_OPERATIONS_RUNBOOK_PATH,
        operatorSurfaceLinkText: "Google Shopping Operations",
      },
      productionEnvironment: {
        googleMerchantSyncEnabled: true,
        googleMerchantDryRun: false,
        marketplaceIndexing: true,
        merchantConfig: {
          allRequiredPresent: true,
          targetCountry: "US",
          contentLanguage: "en",
          feedLabel: "US",
        },
      },
      gates: {
        feedQuality: {
          totalRows: 12,
          eligibleRows: 10,
          samplePayloadCount: 3,
          sampleImageCheckCount: 3,
        },
        crawlability: {
          approved: true,
          sampledFeedLinkCount: 3,
        },
        diagnostics: {
          approved: true,
          totals: {
            disapproved: 0,
          },
        },
        syncState: {
          approved: true,
          mode: "dry-run",
          failed: 0,
        },
      },
    });
    expect(evidence.errors).toBeUndefined();
  });

  it("passes disabled posture without requiring readiness evidence or allowing Merchant submission", () => {
    const evidence = buildGoogleShoppingLaunchReadinessEvidence({
      readinessReport: {
        productionEnvironment: {
          GOOGLE_MERCHANT_SYNC_ENABLED: "false",
          GOOGLE_MERCHANT_DRY_RUN: "true",
          CHASE_SETS_MARKETPLACE_INDEXING: "true",
        },
      },
      expectedMode: "disabled",
      reference: "GOOGLE-SHOPPING-DISABLED-2026-06-04",
      owner: "Operations",
      checkedAt,
    });

    expect(evidence).toMatchObject({
      readinessStatus: "disabled",
      merchantFeedSubmissionAllowed: false,
      passesGoogleShoppingLaunchReadinessGate: true,
      gates: {
        environment: { approved: true },
        feedQuality: { approved: true, totalRows: 0 },
      },
    });
  });

  it("passes dry-run readiness while keeping Merchant submission blocked", () => {
    const report = readinessReport({
      productionEnvironment: {
        ...productionEnvironment(),
        GOOGLE_MERCHANT_DRY_RUN: "true",
      },
    });

    const evidence = buildGoogleShoppingLaunchReadinessEvidence({
      readinessReport: report,
      expectedMode: "dry-run",
      reference: "GOOGLE-SHOPPING-DRY-RUN-2026-06-04",
      owner: "Operations",
      checkedAt,
    });

    expect(evidence).toMatchObject({
      readinessStatus: "dry-run",
      merchantFeedSubmissionAllowed: false,
      passesGoogleShoppingLaunchReadinessGate: true,
      gates: {
        environment: { approved: true },
      },
    });
  });

  it("fails live readiness when P0 evidence is missing or unsafe", () => {
    const report = readinessReport({
      productionEnvironment: {
        ...productionEnvironment(),
        GOOGLE_MERCHANT_API_DATA_SOURCE_ID: "",
        GOOGLE_MERCHANT_DRY_RUN: "true",
        CHASE_SETS_MARKETPLACE_INDEXING: "false",
      },
      feed: {
        ...feedEvidence(),
        eligibleRows: 0,
        excludedRows: 12,
        samplePayloads: [],
        blockingIssueCounts: {
          "missing-image": 2,
          "not-crawlable": 1,
        },
      },
      crawlPosture: {
        ...crawlPostureEvidence(),
        merchantFeedSubmissionAllowed: false,
      },
      diagnostics: {
        ...diagnosticsEvidence(),
        totals: {
          ...diagnosticsEvidence().totals,
          disapproved: 1,
        },
        launchImpact: {
          p0: true,
          p1: false,
          reasons: ["1 submitted Google Shopping row(s) are disapproved."],
        },
      },
      sync: {
        ...syncEvidence(),
        failed: 1,
      },
    });

    const evidence = buildGoogleShoppingLaunchReadinessEvidence({
      readinessReport: report,
      expectedMode: "live",
      reference: "todo",
      owner: "Operations",
      checkedAt,
    });

    expect(evidence).toMatchObject({
      readinessStatus: "blocked",
      merchantFeedSubmissionAllowed: false,
      passesGoogleShoppingLaunchReadinessGate: false,
    });
    expect(evidence.errors).toEqual(
      expect.arrayContaining([
        "Google Shopping launch readiness reference must point to a real external evidence record, not a placeholder.",
        "Google Shopping live readiness requires GOOGLE_MERCHANT_DRY_RUN=false.",
        "Google Shopping live readiness requires CHASE_SETS_MARKETPLACE_INDEXING=true.",
        "Google Shopping live readiness requires productionSyncApprovalReference.",
        "GOOGLE_MERCHANT_API_DATA_SOURCE_ID must be present when Google Merchant sync is expected.",
        "Google Shopping feed evidence must include at least one eligible row.",
        "Google Shopping feed has 2 blocking missing-image issue(s).",
        "Google Shopping crawl posture must allow Merchant feed submission.",
        "Google Shopping diagnostics must have zero disapproved submitted rows.",
        "Google Shopping dry-run sync must have zero failed rows.",
      ]),
    );
  });

  it("parses readiness report and expected mode from flags or environment", () => {
    expect(
      parseGoogleShoppingLaunchReadinessArgs(
        [
          "--readiness-report",
          "secure/google-shopping-readiness.json",
          "--expected-mode",
          "live",
          "--reference",
          "GOOGLE-SHOPPING-LAUNCH-2026-06-04",
        ],
        {},
      ),
    ).toMatchObject({
      readinessReportPath: "secure/google-shopping-readiness.json",
      expectedMode: "live",
      reference: "GOOGLE-SHOPPING-LAUNCH-2026-06-04",
    });

    expect(
      parseGoogleShoppingLaunchReadinessArgs([], {
        GOOGLE_SHOPPING_READINESS_REPORT: "secure/from-env.json",
        GOOGLE_SHOPPING_LAUNCH_EXPECTED_MODE: "disabled",
      }),
    ).toMatchObject({
      readinessReportPath: "secure/from-env.json",
      expectedMode: "disabled",
    });
  });
});

function readinessReport(overrides = {}) {
  return {
    productionEnvironment: productionEnvironment(),
    feed: feedEvidence(),
    crawlPosture: crawlPostureEvidence(),
    policy: policyEvidence(),
    diagnostics: diagnosticsEvidence(),
    sync: syncEvidence(),
    ...overrides,
  };
}

function productionEnvironment() {
  return {
    GOOGLE_MERCHANT_SYNC_ENABLED: "true",
    GOOGLE_MERCHANT_DRY_RUN: "false",
    GOOGLE_MERCHANT_ACCOUNT_ID: "123456",
    GOOGLE_MERCHANT_API_DATA_SOURCE_ID: "7890",
    GOOGLE_MERCHANT_TARGET_COUNTRY: "US",
    GOOGLE_MERCHANT_CONTENT_LANGUAGE: "en",
    GOOGLE_MERCHANT_FEED_LABEL: "US",
    GOOGLE_MERCHANT_CREDENTIAL_SECRET_NAME: "GOOGLE_MERCHANT_SERVICE_ACCOUNT_JSON",
    CHASE_SETS_MARKETPLACE_INDEXING: "true",
  };
}

function feedEvidence() {
  return {
    totalRows: 12,
    eligibleRows: 10,
    excludedRows: 2,
    exclusionReasonCounts: {
      "seller-unavailable": 2,
    },
    imageEligibilityCounts: {
      eligible: 10,
      excluded: 2,
    },
    blockingIssueCounts: {},
    samplePayloads: [samplePayload("lst_1"), samplePayload("lst_2"), samplePayload("lst_3")],
    sampleImageChecks: [
      { url: "https://assets.chasesets.com/catalog/charizard.webp", status: 200 },
      { url: "https://assets.chasesets.com/catalog/blastoise.webp", status: 200 },
      { url: "https://assets.chasesets.com/catalog/venusaur.webp", status: 200 },
    ],
  };
}

function samplePayload(listingId) {
  return {
    offerId: `cs-listing-${listingId}`,
    title: "Charizard 4/102 Base Set",
    description: "Pokemon trading card with verified condition.",
    link: `https://marketplace.chasesets.com/listings/charizard-${listingId}`,
    imageLink: "https://assets.chasesets.com/catalog/charizard.webp",
    priceAmount: "42.00",
    currencyCode: "USD",
    availability: "in stock",
    condition: "used",
    externalSellerId: "cs-account-acc_1",
    targetCountry: "US",
    contentLanguage: "en",
    feedLabel: "US",
  };
}

function crawlPostureEvidence() {
  return {
    schemaVersion: "google-shopping-crawl-posture-evidence/v1",
    baseUrl: "https://marketplace.chasesets.com",
    passesGoogleShoppingCrawlPostureGate: true,
    merchantFeedSubmissionAllowed: true,
    sitemap: {
      sampledFeedLinks: [
        "https://marketplace.chasesets.com/listings/charizard-lst_1",
        "https://marketplace.chasesets.com/listings/blastoise-lst_2",
        "https://marketplace.chasesets.com/listings/venusaur-lst_3",
      ],
    },
  };
}

function policyEvidence() {
  return {
    accountApprovalReference: "GOOGLE-MERCHANT-ACCOUNT-2026-06-04",
    apiDataSourceReference: "GOOGLE-MERCHANT-DATASOURCE-2026-06-04",
    policyReviewReference: "GOOGLE-MERCHANT-POLICY-2026-06-04",
    merchantShippingSettingsReference: "GOOGLE-MERCHANT-SHIPPING-2026-06-04",
    merchantReturnsSettingsReference: "GOOGLE-MERCHANT-RETURNS-2026-06-04",
    taxReadinessReference: "TAX-READINESS-2026-06-04",
    publicShippingPolicyUrl: "https://chasesets.com/policies/shipping",
    publicReturnsPolicyUrl: "https://chasesets.com/policies/returns",
    returnPolicyLabel: "chase-sets-standard-returns",
  };
}

function diagnosticsEvidence() {
  return {
    totals: {
      rows: 10,
      approved: 10,
      disapproved: 0,
      pending: 0,
      approvedWithIssues: 0,
      unknown: 0,
    },
    unknownIssueCodeCount: 0,
    launchImpact: {
      p0: false,
      p1: false,
      reasons: [],
    },
  };
}

function syncEvidence() {
  return {
    mode: "dry-run",
    status: "completed",
    total: 12,
    submitted: 10,
    skipped: 0,
    deleted: 0,
    failed: 0,
    excluded: 2,
    jobReference: "GOOGLE-SHOPPING-DRY-RUN-JOB-2026-06-04",
    completedAt: "2026-06-04T11:30:00.000Z",
  };
}
