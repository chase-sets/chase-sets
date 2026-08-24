// @vitest-environment jsdom

import type { ReactNode } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
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

class FakeEventSource {
  static instances: FakeEventSource[] = [];

  readonly listeners = new Map<string, Set<(event: Event) => void>>();
  readonly close = vi.fn();

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: Event) => void) {
    const listeners = this.listeners.get(type) ?? new Set<(event: Event) => void>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  emit(type: string, data: unknown, lastEventId = "") {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data: JSON.stringify(data), lastEventId } as MessageEvent);
    }
  }
}

describe("GoogleShoppingOperationsPage", () => {
  const originalEventSource = globalThis.EventSource;

  afterEach(() => {
    cleanup();
    FakeEventSource.instances = [];
    Object.defineProperty(globalThis, "EventSource", {
      value: originalEventSource,
      configurable: true,
    });
  });

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
        actorPermissions={["accounts.view", "catalog.view", "security.manage"]}
      />,
    );

    expect(markup).toContain("Google Shopping");
    expect(markup).toContain("Search: lst_1");
    expect(markup).toContain("Filter: Failed syncs");
    expect(markup).toContain("missing-title, not-crawlable, missing-image");
    expect(markup).toContain("Catalog, Public Presence, Platform Runtime, Ops / Google Merchant Center");
    expect(markup).toContain("/access/accounts/acc_1");
    expect(markup).toContain("/catalog/catalog-items/cit_1");
    expect(markup).toContain("Live writes gated");
    expect(markup).toContain("Live full sync gated");
    expect(markup).toContain("Live maintenance gated");
    expect(markup).toContain("Targeted retry gated");
    expect(markup).toContain("https://github.com/chase-sets/chase-sets/issues/3032");
    expect(markup).not.toContain("lastProviderResponse");
    expect(markup).not.toContain("secret-token");
  });

  it("subscribes to latest Google Shopping sync job events and renders terminal progress", async () => {
    Object.defineProperty(globalThis, "EventSource", {
      value: FakeEventSource,
      configurable: true,
    });
    const onJobTerminal = vi.fn();

    render(
      <GoogleShoppingOperationsPage
        data={feedRows()}
        filters={{
          filter: "failed",
          search: "lst_1",
          limit: 25,
          refreshWindowDays: 30,
          selected: "",
        }}
        latestJobIds={["job_sync"]}
        onJobTerminal={onJobTerminal}
      />,
    );

    expect(FakeEventSource.instances[0]?.url).toBe("/api/marketplace/google-shopping/sync-jobs/job_sync/events");
    expect(screen.getByText("Waiting for live job status.")).toBeTruthy();

    FakeEventSource.instances[0]?.emit(
      "status",
      {
        jobId: "job_sync",
        jobKind: "full-sync",
        status: "completed",
        progress: {
          phase: "completed",
          completed: 3,
          total: 3,
          currentRowId: "google-shopping:listing:lst_1",
          submitted: 1,
          skipped: 1,
          deleted: 0,
          failed: 1,
          excluded: 0,
          message: "Google Shopping full sync completed.",
        },
        result: {
          mode: "dry-run",
          submitted: 1,
          skipped: 1,
          deleted: 0,
          failed: 1,
          excluded: 0,
          total: 3,
        },
        errorMessage: null,
        createdAt: "2026-06-03T12:00:00.000Z",
        startedAt: "2026-06-03T12:01:00.000Z",
        completedAt: "2026-06-03T12:02:00.000Z",
        updatedAt: "2026-06-03T12:02:00.000Z",
      },
      "2",
    );

    expect(await screen.findByText("Google Shopping full sync completed.")).toBeTruthy();
    expect(screen.getByText("completed")).toBeTruthy();
    expect(screen.getByText("3 of 3")).toBeTruthy();
    expect(screen.getAllByText("google-shopping:listing:lst_1").length).toBeGreaterThan(0);
    expect(onJobTerminal).toHaveBeenCalledOnce();
    expect(FakeEventSource.instances[0]?.close).toHaveBeenCalled();
  });

  it("hides cross-section remediation links from growth-only actors", () => {
    const markup = renderToString(
      <GoogleShoppingOperationsPage
        data={feedRows()}
        filters={{
          filter: "failed",
          search: "lst_1",
          limit: 25,
          refreshWindowDays: 30,
          selected: "",
        }}
        actorPermissions={["google-shopping.view"]}
      />,
    );

    expect(markup).toContain("https://marketplace.chasesets.com/listings/charizard-lst_1");
    expect(markup).not.toContain("/platform/projections?contextName=discovery");
    expect(markup).not.toContain("/access/accounts/acc_1");
    expect(markup).not.toContain("/catalog/catalog-items/cit_1");
  });

  const tintedSurfaceClassName = "min-w-0 max-w-full rounded-tokenLg bg-surface-2 p-4";
  const elevatedSurfaceClassName =
    "surface-border min-w-0 max-w-full rounded-tokenLg ds-glass bg-elevated p-4 shadow-tokenLg";

  it("renders the live-gate and readiness-summary roots with the tinted furniture elevation", () => {
    const { getByTestId } = render(
      <GoogleShoppingOperationsPage
        data={feedRows()}
        filters={{
          filter: "failed",
          search: "lst_1",
          limit: 25,
          refreshWindowDays: 30,
          selected: "",
        }}
      />,
    );

    expect(getByTestId("google-shopping-live-gate-surface").className).toBe(tintedSurfaceClassName);
    expect(getByTestId("google-shopping-readiness-summary-surface").className).toBe(tintedSurfaceClassName);
  });

  it("renders the latest-job root with the elevated entity elevation when a job id is populated", () => {
    const { getByTestId } = render(
      <GoogleShoppingOperationsPage
        data={feedRows()}
        filters={{
          filter: "failed",
          search: "lst_1",
          limit: 25,
          refreshWindowDays: 30,
          selected: "",
        }}
        latestJobIds={["job_sync"]}
      />,
    );

    expect(getByTestId("google-shopping-latest-job-surface").className).toBe(elevatedSurfaceClassName);
  });

  const noticeStates: ReadonlyArray<{
    name: string;
    props: { unavailableMessage?: string; notice?: { tone: "success"; message: string }; actionError?: string };
  }> = [
    { name: "unavailable", props: { unavailableMessage: "Google Shopping feed is temporarily unavailable." } },
    { name: "notice", props: { notice: { tone: "success", message: "Full sync dry-run queued as job_sync." } } },
    { name: "action-error", props: { actionError: "Diagnostics refresh failed." } },
  ];

  it.each(noticeStates)("renders the shared Notice root tinted for the $name input", ({ props }) => {
    const { getAllByTestId } = render(
      <GoogleShoppingOperationsPage
        data={feedRows()}
        filters={{
          filter: "failed",
          search: "lst_1",
          limit: 25,
          refreshWindowDays: 30,
          selected: "",
        }}
        {...props}
      />,
    );

    const noticeSurfaces = getAllByTestId("google-shopping-notice-surface");
    expect(noticeSurfaces).toHaveLength(1);
    expect(noticeSurfaces[0]?.className).toBe(tintedSurfaceClassName);
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
