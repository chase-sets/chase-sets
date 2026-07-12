import { describe, expect, it } from "vitest";
import type { AgentGrant } from "./contracts";
import {
  agentGrantActivityOutcomeTone,
  agentGrantMandateCapLabel,
  agentGrantPaymentRailLabel,
  agentGrantSpendSummary,
  agentGrantStatusTone,
} from "./agent-grant-presentation";

function grant(overrides: Partial<AgentGrant> = {}): AgentGrant {
  return {
    id: "lpa_1",
    platform_profile_url: "https://agent.example/.well-known/ucp",
    client_id: "ocl_1",
    client_name: "Agent Platform",
    client_uri: "https://agent.example",
    scopes: ["catalog:read"],
    status: "active",
    access_token_expires_at: "2026-07-16T20:00:00.000Z",
    refresh_token_expires_at: null,
    granted_at: "2026-07-10T19:00:00.000Z",
    last_refreshed_at: null,
    revoked_at: null,
    revocation_reason: null,
    updated_at: "2026-07-10T19:00:00.000Z",
    ...overrides,
  };
}

describe("agentGrantStatusTone", () => {
  it("maps active to success and revoked to danger", () => {
    expect(agentGrantStatusTone("active")).toBe("success");
    expect(agentGrantStatusTone("revoked")).toBe("danger");
    expect(agentGrantStatusTone("pending")).toBe("neutral");
  });
});

describe("agentGrantActivityOutcomeTone", () => {
  it("maps allowed/denied/failed to distinct tones", () => {
    expect(agentGrantActivityOutcomeTone("allowed")).toBe("success");
    expect(agentGrantActivityOutcomeTone("denied")).toBe("warning");
    expect(agentGrantActivityOutcomeTone("failed")).toBe("danger");
  });
});

describe("agentGrantMandateCapLabel", () => {
  it("renders a null cap as unlimited copy", () => {
    expect(agentGrantMandateCapLabel(null)).toBe("No cap");
  });

  it("formats a cent amount as money", () => {
    expect(agentGrantMandateCapLabel(5_000)).toBe("$50.00");
  });
});

describe("agentGrantPaymentRailLabel", () => {
  it("has a plain-language label for every supported rail", () => {
    expect(agentGrantPaymentRailLabel("handoff-only")).toBe("Trusted checkout handoff");
    expect(agentGrantPaymentRailLabel("stored-pm")).toBe("Saved payment method");
    expect(agentGrantPaymentRailLabel("ap2")).toBe("AP2 mandate");
  });
});

describe("agentGrantSpendSummary", () => {
  it("reports no spend data when no mandate/spend is present", () => {
    expect(agentGrantSpendSummary(grant())).toBe("No spending mandate configured yet.");
  });

  it("summarizes daily spend against the daily cap", () => {
    const withSpend = grant({
      spending_mandate: {
        max_per_order_cents: 4_000,
        daily_cap_cents: 5_000,
        monthly_cap_cents: 20_000,
        human_present_required: false,
        allowed_rails: ["ap2"],
      },
      spend: { daily_cents: 1_250, monthly_cents: 1_250 },
    });
    expect(agentGrantSpendSummary(withSpend)).toBe("$12.50 / $50.00 daily");
  });

  it("shows an unlimited cap when the mandate has no daily cap", () => {
    const uncapped = grant({
      spending_mandate: {
        max_per_order_cents: null,
        daily_cap_cents: null,
        monthly_cap_cents: null,
        human_present_required: true,
        allowed_rails: ["handoff-only"],
      },
      spend: { daily_cents: 0, monthly_cents: 0 },
    });
    expect(agentGrantSpendSummary(uncapped)).toBe("$0.00 / No cap daily");
  });
});
