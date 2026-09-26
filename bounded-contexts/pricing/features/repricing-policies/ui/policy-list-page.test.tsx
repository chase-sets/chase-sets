// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RepricingDryRun } from "../../repricing-engine/api/dry-run";
import type { RepricingHaltState } from "../domain/halt";
import { PricingRepricingPolicyListPage, type RepricingPolicyListRow } from "./policy-list-page";

afterEach(cleanup);

const released: RepricingHaltState = { engaged: false, engagedAt: null, releasedAt: null };
const engaged: RepricingHaltState = { engaged: true, engagedAt: "2026-09-26T09:00:00.000Z", releasedAt: null };

function policy(overrides: Partial<RepricingPolicyListRow> = {}): RepricingPolicyListRow {
  return {
    policyId: "rpp_1",
    accountId: "acc_1",
    name: "Undercut raw singles",
    scope: { kind: "all-listings" },
    excludedListingIds: [],
    rules: [],
    maxChangesPerDay: 500,
    status: "active",
    createdAt: "2026-09-20T00:00:00.000Z",
    updatedAt: "2026-09-25T00:00:00.000Z",
    changesUsedToday: 1234,
    ...overrides,
  } as RepricingPolicyListRow;
}

function renderList(props: Partial<Parameters<typeof PricingRepricingPolicyListPage>[0]> = {}) {
  const handlers = { onHaltChange: vi.fn(), onPause: vi.fn(), onResume: vi.fn() };
  render(<PricingRepricingPolicyListPage policies={[policy()]} halt={released} dryRuns={[]} {...handlers} {...props} />);
  return handlers;
}

describe("PricingRepricingPolicyListPage", () => {
  it("lists each policy with its status, scope kind, cap and account-wide changes used today", () => {
    renderList({
      policies: [
        policy(),
        policy({
          policyId: "rpp_2",
          name: "Graded slabs",
          status: "paused",
          scope: { kind: "catalog-filter", categoryIds: ["cat_1", "cat_2"] },
          maxChangesPerDay: null,
        }),
      ],
    });

    const text = screen.getByTestId("repricing-policy-list").textContent ?? "";
    expect(text).toContain("Undercut raw singles");
    expect(text).toContain("Active");
    expect(text).toContain("All listings");
    expect(text).toContain("1,234 of 500 account-wide changes today");
    expect(text).toContain("Paused");
    expect(text).toContain("Categories (2)");
    expect(text).toContain("1,234 account-wide changes today · no daily cap");
    expect(screen.getAllByRole("link", { name: "Graded slabs" })[0]?.getAttribute("href")).toBe(
      "/account/desk/repricing/rpp_2",
    );
  });

  it("pauses and resumes a policy as a row transition", () => {
    const handlers = renderList({
      policies: [policy(), policy({ policyId: "rpp_2", name: "Paused one", status: "paused" })],
    });
    fireEvent.click(screen.getAllByRole("button", { name: "Pause" })[0]!);
    expect(handlers.onPause).toHaveBeenCalledWith("rpp_1");
    fireEvent.click(screen.getAllByRole("button", { name: "Resume" })[0]!);
    expect(handlers.onResume).toHaveBeenCalledWith("rpp_2");

    cleanup();
    renderList({ busyPolicyId: "rpp_1" });
    for (const button of screen.getAllByRole("button", { name: "Pause" })) {
      expect((button as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it("confirms before engaging the halt and shows every active policy as paused by halt", () => {
    const handlers = renderList();
    fireEvent.click(screen.getByRole("switch", { name: "Halt all repricing" }));
    expect(handlers.onHaltChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Halt repricing" }));
    expect(handlers.onHaltChange).toHaveBeenCalledWith(true);

    cleanup();
    renderList({ halt: engaged });
    expect(screen.getByTestId("repricing-halt").textContent).toContain("Repricing is halted");
    expect(screen.getByTestId("repricing-policy-list").textContent).toContain("Paused by halt");
  });

  it("confirms before releasing the halt", () => {
    const handlers = renderList({ halt: engaged });
    fireEvent.click(screen.getByRole("switch", { name: "Halt all repricing" }));
    fireEvent.click(screen.getByRole("button", { name: "Release halt" }));
    expect(handlers.onHaltChange).toHaveBeenCalledWith(false);
  });

  it("lists recent dry runs", () => {
    const dryRun = {
      dryRunId: "dry_1",
      status: "completed",
      requestedAt: "2026-09-26T08:00:00.000Z",
      summary: { listingsEvaluated: 4210 },
    } as unknown as RepricingDryRun;
    renderList({ dryRuns: [dryRun] });
    const text = screen.getByTestId("repricing-dry-runs").textContent ?? "";
    expect(text).toContain("Completed");
    expect(text).toContain("4,210");
  });

  it("renders loading, empty and error states", () => {
    const loading = renderToStaticMarkup(
      <PricingRepricingPolicyListPage
        policies={[]}
        halt={released}
        dryRuns={[]}
        loading
        onHaltChange={() => undefined}
        onPause={() => undefined}
        onResume={() => undefined}
      />,
    );
    expect(loading).toContain('aria-busy="true"');

    renderList({ policies: [] });
    expect(screen.getByTestId("repricing-policy-list-empty").textContent).toContain("No repricing policies yet");

    cleanup();
    renderList({ loadFailed: true });
    expect(screen.getByText("Repricing policies couldn't load")).toBeTruthy();
    expect(screen.queryByTestId("repricing-policy-list")).toBeNull();
  });
});
