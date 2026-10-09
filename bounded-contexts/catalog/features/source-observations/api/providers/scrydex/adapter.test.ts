import { describe, expect, it, vi } from "vitest";
import {
  createScrydexOnePieceProviderAdapter,
  SCRYDEX_ONE_PIECE_SET_REFERENCE_DATA_UNIT_KEY,
  type ScrydexOnePieceCredentials,
} from "./adapter";

// Every credential, identifier, URL, and usage value below is synthetic.
const syntheticCredentials = {
  apiKey: "synthetic-scrydex-api-key-8427",
  teamId: "synthetic-scrydex-team-8427",
} as const satisfies ScrydexOnePieceCredentials;
const syntheticBaseUrl = "https://synthetic-scrydex.invalid/onepiece/v1";
const observedAt = new Date("2026-10-09T12:00:00.000Z");
const forbiddenValues = [
  syntheticCredentials.apiKey,
  syntheticCredentials.teamId,
  "synthetic-account-8427",
  "synthetic-owner@example.invalid",
  "synthetic-billing.invalid",
  "synthetic-scrydex.invalid",
  "synthetic-plan-tier",
  "0.0042",
];
const forbiddenFieldNames = ["account_id", "team_id", "api_key", "email", "invoice_url", "plan", "overage"];

function syntheticUsageBody(overrides: Record<string, unknown> = {}) {
  return {
    total_credits: 50_000,
    remaining_credits: 41_234,
    used_credits: 8_766,
    overage_credit_rate: "0.0042",
    account_id: "synthetic-account-8427",
    team_id: syntheticCredentials.teamId,
    api_key: syntheticCredentials.apiKey,
    email: "synthetic-owner@example.invalid",
    plan: "synthetic-plan-tier",
    invoice_url: "https://synthetic-billing.invalid/invoices/synthetic",
    ...overrides,
  };
}

function usageAdapter(input: {
  body?: unknown;
  status?: number;
  credentials?: ScrydexOnePieceCredentials;
  now?: () => Date;
}) {
  const fetch = vi.fn(async (request: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    expect(new URL(String(request)).pathname).toBe("/account/v1/usage");
    expect(new Headers(init?.headers).get("X-Api-Key")).toBe((input.credentials ?? syntheticCredentials).apiKey);
    return Response.json(input.body ?? syntheticUsageBody(), { status: input.status ?? 200 });
  });
  const adapter = createScrydexOnePieceProviderAdapter({
    credentials: input.credentials ?? syntheticCredentials,
    baseUrl: syntheticBaseUrl,
    fetch,
    now: input.now ?? (() => observedAt),
  });
  return { adapter, fetch };
}

describe("Scrydex usage snapshot boundary", () => {
  it("retains only redacted balance fields, state, observed-at, and lag diagnostics", async () => {
    const { adapter, fetch } = usageAdapter({});

    const snapshot = await adapter.getUsageSnapshot();

    expect(snapshot).toStrictEqual({
      providerKey: "scrydex",
      creditUnit: "credits",
      creditState: "available",
      totalCredits: 50_000,
      remainingCredits: 41_234,
      usedCredits: 8_766,
      observedAt: observedAt.toISOString(),
      attemptedAt: observedAt.toISOString(),
      attemptState: "checked",
      providerUpdatedAt: null,
      lagCategory: "documented-window",
      diagnosticCode: null,
      diagnostic: "Scrydex account usage check completed with redacted credit evidence.",
      freshWithinSeconds: 900,
      unavailableAfterSeconds: 3600,
    });
    const retained = JSON.stringify(snapshot);
    for (const value of forbiddenValues) expect(retained).not.toContain(value);
    for (const field of forbiddenFieldNames) expect(retained).not.toContain(field);
    expect(retained).not.toMatch(/https?:\/\//);

    const diagnostics = JSON.stringify([
      await adapter.getTransportDiagnostics(),
      await adapter.getCredentialReadiness(),
    ]);
    for (const value of forbiddenValues.filter((value) => value !== "0.0042")) {
      expect(diagnostics).not.toContain(value);
    }
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["within-provider-window", "2026-10-09T11:35:00.000Z", "2026-10-09T11:35:00.000Z"],
    ["beyond-provider-window", "2026-10-09T11:00:00.000Z", "2026-10-09T11:00:00.000Z"],
    ["documented-window", "not-a-timestamp", null],
  ] as const)("records %s provider lag from the provider timestamp", async (lagCategory, updatedAt, expected) => {
    const { adapter } = usageAdapter({ body: syntheticUsageBody({ updated_at: updatedAt }) });

    expect(await adapter.getUsageSnapshot()).toMatchObject({ lagCategory, providerUpdatedAt: expected });
  });

  it("keeps a partial usage response unknown instead of zero or exhausted", async () => {
    const { adapter } = usageAdapter({ body: { total_credits: 50_000 } });

    expect(await adapter.getUsageSnapshot()).toMatchObject({
      attemptState: "checked",
      creditState: "unknown",
      totalCredits: 50_000,
      remainingCredits: null,
      usedCredits: null,
    });
  });

  it("reports a failed read as unavailable with no observed balance", async () => {
    const { adapter } = usageAdapter({ status: 503, body: { error: "synthetic-maintenance", account_id: "x" } });

    const snapshot = await adapter.getUsageSnapshot();

    expect(snapshot).toMatchObject({
      attemptState: "unavailable",
      observedAt: null,
      attemptedAt: observedAt.toISOString(),
      lagCategory: "unobserved",
      creditState: "unknown",
      remainingCredits: null,
      totalCredits: null,
      diagnosticCode: "provider-degraded",
    });
    expect(JSON.stringify(snapshot)).not.toContain("synthetic-maintenance");
  });

  it("never sends a usage request without credentials", async () => {
    const { adapter, fetch } = usageAdapter({ credentials: {} });

    expect(await adapter.getUsageSnapshot()).toMatchObject({
      attemptState: "not-configured",
      observedAt: null,
      attemptedAt: null,
      diagnosticCode: "credential-missing",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("isolates snapshots per adapter credentials and keeps import planning live", async () => {
    const first = usageAdapter({});
    const second = usageAdapter({
      credentials: { apiKey: "synthetic-scrydex-api-key-other", teamId: "synthetic-scrydex-team-other" },
      body: syntheticUsageBody({ remaining_credits: 7 }),
    });

    expect((await first.adapter.getUsageSnapshot()).remainingCredits).toBe(41_234);
    expect((await second.adapter.getUsageSnapshot()).remainingCredits).toBe(7);
    expect(first.fetch).toHaveBeenCalledTimes(1);
    expect(second.fetch).toHaveBeenCalledTimes(1);

    const scope = {
      unitKey: SCRYDEX_ONE_PIECE_SET_REFERENCE_DATA_UNIT_KEY,
      scopeKey: "set-reference",
      values: { expansionId: "synthetic-op-01" },
    };
    await first.adapter.planImport(scope);
    await first.adapter.planImport(scope);
    expect(first.fetch).toHaveBeenCalledTimes(3);
  });
});
