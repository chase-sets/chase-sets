import { afterEach, describe, expect, it, vi } from "vitest";
import { createProviderConnectionsRuntime } from "./runtime";
import type { ProviderConnectionRow } from "./contracts";

const row: ProviderConnectionRow = {
  id: "catalog-connection",
  provider: "catalog-provider",
  owner: "catalog",
  capability: "catalog-integration",
  accountId: null,
  credentialReadiness: "unknown",
  health: "unknown",
  observedAt: null,
  destination: null,
  freshness: { freshWithinSeconds: 15, staleAfterSeconds: 60, unavailableAfterSeconds: 300 },
};

afterEach(() => vi.useRealTimers());

describe("provider connections runtime", () => {
  it("returns canonical freshness state and age for every row", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-29T12:00:00.000Z"));
    let sourceStarted = false;
    const runtime = createProviderConnectionsRuntime({
      catalog: async () => {
        sourceStarted = true;
        await Promise.resolve();
        vi.setSystemTime(new Date("2026-09-29T12:00:01.000Z"));
        return { complete: true, rows: [{ ...row, observedAt: new Date().toISOString() }] };
      },
    });

    const snapshot = await runtime.read();

    expect(sourceStarted).toBe(true);
    expect(snapshot.evaluatedAt).toBe("2026-09-29T12:00:01.000Z");
    expect(snapshot.catalog.rows[0]).toMatchObject({
      observedAt: snapshot.evaluatedAt,
      freshnessState: "fresh",
      ageSeconds: 0,
    });
    expect(snapshot.channels).toEqual({ state: "unavailable", rows: [] });
  });
});
