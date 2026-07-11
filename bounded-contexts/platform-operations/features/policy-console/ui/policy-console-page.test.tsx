// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { PolicyConsoleRegistryItem } from "../api/contracts";
import { PolicyConsolePage } from "./policy-console-page";

const items: readonly PolicyConsoleRegistryItem[] = [
  {
    policyKey: "settlement.clearance-window",
    contextName: "settlement",
    schemaSummary: "{ baseClearanceDays, extendedClearanceDays, highValueThresholdAmount }",
    status: "active",
    value: { baseClearanceDays: 2 },
    effectiveFrom: "2026-05-01T00:00:00.000Z",
    effectiveUntil: null,
    updatedAt: "2026-05-01T00:00:00.000Z",
  },
  {
    policyKey: "platform-operations.rate-limits",
    contextName: "platform-operations",
    schemaSummary: "{ incidentMultiplier, surfaces }",
    status: "fallback",
    value: {},
    effectiveFrom: "",
    effectiveUntil: null,
    updatedAt: "",
  },
];

describe("policy console list page", () => {
  afterEach(() => {
    cleanup();
  });

  it("groups policies by owning context and links to the commercial terms surface", () => {
    render(<PolicyConsolePage items={items} commercialTermsSchedulesHref="/terms/schedules" />);

    expect(screen.getByText("Settlement")).toBeTruthy();
    expect(screen.getByText("Platform Operations")).toBeTruthy();
    expect(screen.getAllByText("settlement.clearance-window").length).toBeGreaterThan(0);
    expect(screen.getAllByText("platform-operations.rate-limits").length).toBeGreaterThan(0);
    expect(screen.getByRole("link", { name: /open commercial terms/i })).toHaveProperty(
      "href",
      expect.stringContaining("/terms/schedules"),
    );
  });
});
