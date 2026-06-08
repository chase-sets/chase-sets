import type { ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { GoogleShoppingOperationsPage } from "./google-shopping-operations-page";
import type { GoogleShoppingFeedRowList } from "./contracts";

vi.mock("react-router", () => ({
  Form: (props: { children?: ReactNode; method?: string }) => <form method={props.method}>{props.children}</form>,
  Link: (props: { children?: ReactNode; to: string; className?: string }) => (
    <a href={props.to} className={props.className}>
      {props.children}
    </a>
  ),
}));

describe("GoogleShoppingOperationsPage", () => {
  it("renders filtered feed row remediation context without exposing raw provider state", () => {
    const markup = renderToString(
      <GoogleShoppingOperationsPage
        data={feedRows()}
        filters={{
          filter: "failed",
          search: "lst_1",
          limit: 25,
          refreshWindowDays: 30,
          selected: "google-shopping:listing:lst_1",
        }}
        notice={{ tone: "success", message: "Full sync dry-run queued as job_sync." }}
      />,
    );

    expect(markup).toContain("Google Shopping");
    expect(markup).toContain("Search: lst_1");
    expect(markup).toContain("Filter: Failed syncs");
    expect(markup).toContain("missing-title, not-crawlable, missing-image");
    expect(markup).toContain("Catalog, Public Presence, Platform Runtime, Ops / Google Merchant Center");
    expect(markup).toContain("/access/accounts/acc_1");
    expect(markup).toContain("/catalog/catalog-items/cit_1");
    expect(markup).toContain("Targeted retry deferred");
    expect(markup).not.toContain("lastProviderResponse");
    expect(markup).not.toContain("secret-token");
  });
});

function feedRows(): GoogleShoppingFeedRowList {
  return {
    generatedAt: "2026-06-03T12:00:00.000Z",
    filter: "failed",
    search: "lst_1",
    limit: 25,
    refreshWindowDays: 30,
    refreshCutoff: "2026-05-04T12:00:00.000Z",
    summary: {
      totalRows: 3,
      eligibleRows: 1,
      excludedRows: 2,
      failedRows: 1,
      disapprovedRows: 1,
      pendingDeleteRows: 1,
      staleRows: 1,
      nearingRefreshRows: 1,
      pendingDiagnosticsRows: 1,
    },
    rows: [
      {
        rowId: "google-shopping:listing:lst_1",
        listingId: "lst_1",
        accountId: "acc_1",
        catalogItemId: "cit_1",
        productId: "prd_1",
        merchantOfferId: "cs-listing-lst_1",
        externalSellerId: "cs-account-acc_1",
        canonicalUrl: "https://marketplace.chasesets.com/listings/charizard-lst_1",
        targetCountry: "US",
        contentLanguage: "en",
        feedLabel: "US",
        eligibilityStatus: "excluded",
        exclusionReasons: ["missing-title", "not-crawlable"],
        imageEligibilityStatus: "excluded",
        imageExclusionReasons: ["missing-image"],
        syncStatus: "failed",
        diagnosticStatus: "disapproved",
        activeIssueCount: 1,
        unknownIssueCodeCount: 1,
        blockingIssueCount: 4,
        remediationOwners: ["Catalog", "Public Presence", "Platform Runtime", "Ops / Google Merchant Center"],
        pendingDelete: true,
        stale: false,
        nearingRefresh: false,
        payloadHash: "hash_2",
        lastSubmittedPayloadHash: "hash_1",
        lastSubmittedAt: "2026-05-01T12:00:00.000Z",
        lastAcceptedAt: "2026-05-01T12:00:00.000Z",
        lastSyncAttemptedAt: "2026-06-03T12:00:00.000Z",
        lastSyncErrorCode: "google_merchant_rate_limited",
        lastSyncErrorMessage: "Merchant API rate limit exhausted.",
        lastProviderOperation: "insert-product-input",
        deleteSubmittedAt: null,
        lastDiagnosticAt: "2026-06-03T12:00:00.000Z",
        shippingPolicyUrl: "https://chasesets.com/policies/shipping",
        returnPolicyUrl: "https://chasesets.com/policies/returns",
        returnPolicyLabel: "chase-sets-standard-returns",
        updatedAt: "2026-06-03T12:00:00.000Z",
      },
    ],
  };
}
