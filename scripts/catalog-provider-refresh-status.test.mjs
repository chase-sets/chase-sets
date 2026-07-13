import { describe, expect, it } from "vitest";
import {
  evaluateProviderRefreshSchedules,
  parseCatalogProviderRefreshStatusArgs,
} from "./catalog-provider-refresh-status.mjs";

const CHECKED_AT = "2026-07-13T12:00:00.000Z";
const HOUR_MS = 60 * 60 * 1000;

function scheduleRow(overrides = {}) {
  return {
    provider_key: "tcgdex",
    schedule_enabled: true,
    manual_only: false,
    paused: false,
    interval_ms: 6 * HOUR_MS,
    next_run_at: null,
    last_run_completed_at: "2026-07-13T11:00:00.000Z",
    last_run_status: "succeeded",
    last_run_error: null,
    ...overrides,
  };
}

describe("catalog provider refresh status evaluation", () => {
  it("reports success when every scheduled provider completed recently", () => {
    const record = evaluateProviderRefreshSchedules([scheduleRow()], CHECKED_AT);

    expect(record.result).toBe("success");
    expect(record.failedProviders).toHaveLength(0);
    expect(record.staleProviders).toHaveLength(0);
  });

  it("warns when a scheduled provider last run failed", () => {
    const record = evaluateProviderRefreshSchedules(
      [scheduleRow({ last_run_status: "failed", last_run_error: "provider transport 503" })],
      CHECKED_AT,
    );

    expect(record.result).toBe("warning");
    expect(record.failedProviders).toEqual([
      expect.objectContaining({ providerKey: "tcgdex", failed: true, lastRunError: "provider transport 503" }),
    ]);
  });

  it("warns when a scheduled provider has not completed within twice its cadence", () => {
    const record = evaluateProviderRefreshSchedules(
      [scheduleRow({ last_run_completed_at: "2026-07-12T20:00:00.000Z" })],
      CHECKED_AT,
    );

    expect(record.result).toBe("warning");
    expect(record.staleProviders).toEqual([expect.objectContaining({ providerKey: "tcgdex", stale: true })]);
  });

  it("never alerts for paused or manual-only providers", () => {
    const record = evaluateProviderRefreshSchedules(
      [
        scheduleRow({ provider_key: "tcgdex", paused: true, last_run_status: "failed" }),
        scheduleRow({
          provider_key: "scrydex",
          manual_only: true,
          schedule_enabled: false,
          last_run_completed_at: null,
          last_run_status: null,
        }),
      ],
      CHECKED_AT,
    );

    expect(record.result).toBe("success");
    expect(record.summary.pausedCount).toBe(1);
    expect(record.summary.scheduledActiveCount).toBe(0);
  });

  it("parses database url and environment from options and env", () => {
    const options = parseCatalogProviderRefreshStatusArgs(
      ["--environment", "staging", "--catalog-database-url", "postgres://catalog"],
      {},
    );

    expect(options.environment).toBe("staging");
    expect(options.catalogDatabaseUrl).toBe("postgres://catalog");
  });
});
