import { describe, expect, it } from "vitest";
import { decodeRepricingEnginePolicyValue, REPRICING_ENGINE_LAUNCH_POLICY_VALUE } from "./policy";

const storedRevision = {
  productRoundCooldownMinutes: 45,
  pauseResumeStableHours: 24,
  repauseCooldownHours: 2,
  lastSoldFreshForDays: 60,
  hardAskOutlierPriceRatio: 20,
};

describe("repricing engine policy", () => {
  it("decodes a stored revision with only the two absent breaker keys defaulted", () => {
    expect(decodeRepricingEnginePolicyValue(storedRevision)).toEqual({
      ...storedRevision,
      spiralBreakerRounds: 3,
      spiralBreakerFreezeMinutes: 120,
    });
    expect(decodeRepricingEnginePolicyValue(REPRICING_ENGINE_LAUNCH_POLICY_VALUE)).toEqual(
      REPRICING_ENGINE_LAUNCH_POLICY_VALUE,
    );
  });
  it.each(Object.keys(storedRevision))("still rejects an absent existing key: %s", (key) => {
    expect(() =>
      decodeRepricingEnginePolicyValue(
        Object.fromEntries(Object.entries(storedRevision).filter(([name]) => name !== key)),
      ),
    ).toThrow(key);
  });
  it.each([
    ["spiralBreakerRounds", 1],
    ["spiralBreakerRounds", 11],
    ["spiralBreakerRounds", 2.5],
    ["spiralBreakerRounds", null],
    ["spiralBreakerFreezeMinutes", 59],
    ["spiralBreakerFreezeMinutes", 1441],
    ["spiralBreakerFreezeMinutes", null],
  ] as const)("rejects %s=%s", (key, value) => {
    expect(() => decodeRepricingEnginePolicyValue({ ...storedRevision, [key]: value })).toThrow(key);
  });
  it.each([
    [2, 60],
    [10, 1440],
  ])("accepts the ruled boundaries %s/%s", (rounds, minutes) => {
    expect(
      decodeRepricingEnginePolicyValue({
        ...storedRevision,
        spiralBreakerRounds: rounds,
        spiralBreakerFreezeMinutes: minutes,
      }),
    ).toMatchObject({ spiralBreakerRounds: rounds, spiralBreakerFreezeMinutes: minutes });
  });
});
