// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { formatDateTime } from "@chase-sets/localization";
import { afterEach, describe, expect, it } from "vitest";
import type { CatalogIntegrationProviderUsageBudget } from "../../contracts";
import { buildCatalogPrimaryWorkbenchReadModelForSurface } from "../../primary-workbench-read-model";
import { controlPlaneOverview, sourceObservationScope } from "../../primary-workbench-test-fixtures";
import { CatalogIntegrationHealthTriageWorkspace } from "./integration-health-dashboard";

afterEach(cleanup);

// Synthetic usage values only.
const observedAt = "2026-10-09T12:00:00.000Z";

function budget(overrides: Partial<CatalogIntegrationProviderUsageBudget>): CatalogIntegrationProviderUsageBudget {
  return {
    creditBalance: 41_234,
    creditAllowance: 50_000,
    creditUnit: "credits",
    readiness: "ready",
    freshness: "fresh",
    observedAt,
    lagCategory: "documented-window",
    diagnosticCode: null,
    diagnostic: "Synthetic usage check completed.",
    estimatedCalls: null,
    estimatedScope: null,
    ...overrides,
  };
}

function renderHealth(providers: ReadonlyArray<readonly [string, CatalogIntegrationProviderUsageBudget | null]>) {
  const base = controlPlaneOverview();
  const baseProvider = base.providerReadiness.providers[0]!;
  const readModel = buildCatalogPrimaryWorkbenchReadModelForSurface("health", {
    requestUrl: "https://admin.example/catalog/integrations?section=triage",
    scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
    profileReviews: { items: [], total: 0, count: 0 },
    controlPlaneOverview: controlPlaneOverview({
      providerReadiness: {
        ...base.providerReadiness,
        providers: providers.map(([providerKey, usageBudget]) => ({
          ...baseProvider,
          providerKey,
          adapterKey: providerKey,
          usageBudget,
        })),
      },
    }),
    canManageCatalog: true,
  });
  render(<CatalogIntegrationHealthTriageWorkspace readModel={readModel} />);
}

function providerRow(providerKey: string): HTMLElement {
  const row = screen
    .getAllByText(providerKey)
    .map((element) => element.closest("tr"))
    .find((element) => element !== null);
  if (!row) throw new Error(`Missing health row for ${providerKey}.`);
  return row;
}

describe("Integration health usage budget", () => {
  it("renders the validated fresh projection with balance, allowance, freshness, and lag", () => {
    renderHealth([["scrydex", budget({})]]);
    const row = within(providerRow("scrydex"));

    expect(row.getByText("41234 of 50000 credits")).toBeTruthy();
    expect(row.getByText("Budget readiness")).toBeTruthy();
    expect(row.getByText(`Fresh, observed ${formatDateTime(observedAt)}`)).toBeTruthy();
    expect(row.getByText("Provider updates usage every 20-30 minutes")).toBeTruthy();
    expect(row.queryByText("Usage diagnostic")).toBeNull();
  });

  it("renders stale, unavailable, never-observed, and unsupported states explicitly", () => {
    renderHealth([
      [
        "synthetic-stale",
        budget({
          freshness: "stale",
          readiness: "degraded",
          lagCategory: "beyond-provider-window",
          diagnostic: "Synthetic provider degraded.",
        }),
      ],
      [
        "synthetic-unavailable",
        budget({
          freshness: "unavailable",
          readiness: "unknown",
          creditBalance: null,
          creditAllowance: null,
          diagnostic: "Synthetic usage read failed.",
        }),
      ],
      [
        "synthetic-never",
        budget({
          freshness: "never-observed",
          readiness: "unknown",
          creditBalance: null,
          creditAllowance: null,
          observedAt: null,
          lagCategory: "unobserved",
          diagnostic: "Synthetic credentials missing.",
        }),
      ],
      ["synthetic-unsupported", null],
    ]);

    const stale = within(providerRow("synthetic-stale"));
    expect(stale.getByText(`Stale, last observed ${formatDateTime(observedAt)}`)).toBeTruthy();
    expect(stale.getByText("Beyond the provider's 30-minute update window")).toBeTruthy();
    expect(stale.getByText("Synthetic provider degraded.")).toBeTruthy();

    const unavailable = within(providerRow("synthetic-unavailable"));
    expect(unavailable.getByText("Not reported")).toBeTruthy();
    expect(unavailable.getByText(`Unavailable, last observed ${formatDateTime(observedAt)}`)).toBeTruthy();
    expect(unavailable.getByText("Synthetic usage read failed.")).toBeTruthy();
    expect(unavailable.queryByText(/^0 /)).toBeNull();

    const never = within(providerRow("synthetic-never"));
    expect(never.getByText("Never observed")).toBeTruthy();
    expect(never.getByText("Not observed")).toBeTruthy();

    const unsupported = within(providerRow("synthetic-unsupported"));
    expect(unsupported.getByText("Not reported by this provider")).toBeTruthy();
    expect(unsupported.queryByText("Budget readiness")).toBeNull();
  });

  it("shows the usage reason for fresh incomplete budgets without inventing an allowance", () => {
    renderHealth([
      [
        "synthetic-missing-consumed",
        budget({
          readiness: "unknown",
          creditAllowance: null,
          diagnostic: "Synthetic allowance unreported: consumed evidence missing.",
        }),
      ],
      [
        "synthetic-overage",
        budget({
          readiness: "unknown",
          creditAllowance: null,
          diagnostic: "Synthetic allowance unreported: overage consumed.",
        }),
      ],
      [
        "synthetic-missing-balance",
        budget({
          readiness: "unknown",
          creditBalance: null,
          creditAllowance: null,
          diagnostic: "Synthetic remaining balance unreported for the current period.",
        }),
      ],
    ]);

    const missingConsumed = within(providerRow("synthetic-missing-consumed"));
    expect(missingConsumed.getByText("41234 credits")).toBeTruthy();
    expect(missingConsumed.getByText("unknown")).toBeTruthy();
    expect(missingConsumed.getByText("Usage diagnostic")).toBeTruthy();
    expect(missingConsumed.getByText("Synthetic allowance unreported: consumed evidence missing.")).toBeTruthy();

    const overage = within(providerRow("synthetic-overage"));
    expect(overage.getByText("Synthetic allowance unreported: overage consumed.")).toBeTruthy();

    const missingBalance = within(providerRow("synthetic-missing-balance"));
    expect(missingBalance.getByText("Not reported")).toBeTruthy();
    expect(missingBalance.getByText("Synthetic remaining balance unreported for the current period.")).toBeTruthy();
    expect(missingBalance.queryByText(/^0 /)).toBeNull();
  });
});
