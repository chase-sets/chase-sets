import { describe, expect, it } from "vitest";
import { providerConnectionAge } from "./freshness";
import type { ProviderConnectionRow } from "../api/contracts";

const now = "2026-09-29T12:00:00.000Z";
const row: ProviderConnectionRow = {
  id: "test",
  provider: "test",
  owner: "catalog",
  capability: "catalog-integration",
  accountId: null,
  credentialReadiness: "unknown",
  health: "unknown",
  observedAt: now,
  destination: null,
  freshness: { freshWithinSeconds: 15, staleAfterSeconds: 60, unavailableAfterSeconds: 300 },
};

describe("provider observation age", () => {
  it.each([
    [0, "fresh"],
    [15, "fresh"],
    [16, "aging"],
    [60, "aging"],
    [61, "stale"],
    [300, "stale"],
    [301, "unavailable"],
  ])("classifies age %i as %s without resetting it", (age, state) => {
    const observedAt = new Date(Date.parse(now) - Number(age) * 1000).toISOString();
    expect(providerConnectionAge({ ...row, observedAt }, now).state).toBe(state);
  });
  it.each([null, "invalid", "1", "2026-09-29", "2026-02-30T00:00:00Z", "2026-09-30T00:00:00Z"])(
    "does not make %s fresh",
    (observedAt) => {
      expect(providerConnectionAge({ ...row, observedAt }, now)).toEqual({ state: "unknown", ageSeconds: null });
    },
  );
  it("never calls Channels observations fresh", () => {
    expect(providerConnectionAge({ ...row, owner: "channels", freshness: null }, now).state).toBe("ageOnly");
  });
  it("preserves timezone-bearing owner timestamps", () => {
    expect(providerConnectionAge({ ...row, observedAt: "2026-09-29T07:00:00-05:00" }, now).state).toBe("fresh");
  });
});
