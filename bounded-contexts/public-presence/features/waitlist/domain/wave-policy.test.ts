import { describe, expect, it } from "vitest";
import { BETA_WAVE_LAUNCH_POLICY_VALUE, decodeBetaWavePolicyValue } from "./wave-policy";

describe("beta wave policy", () => {
  it("ratifies the three invite waves and proportional rollout holds", () => {
    expect(
      BETA_WAVE_LAUNCH_POLICY_VALUE.waves.map(({ inviteCount, rolloutExposurePercent }) => [
        inviteCount,
        rolloutExposurePercent,
      ]),
    ).toEqual([
      [100, 10],
      [250, 25],
      [500, 50],
    ]);
    expect(BETA_WAVE_LAUNCH_POLICY_VALUE.operationsGates).toMatchObject({
      maxCheckoutFailureRatePercent: 2,
    });
  });

  it("rejects a rollout hold that Argo does not analyze", () => {
    const raw = structuredClone(BETA_WAVE_LAUNCH_POLICY_VALUE) as never;
    (raw as { waves: Array<{ rolloutExposurePercent: number }> }).waves[0]!.rolloutExposurePercent = 15;
    expect(() => decodeBetaWavePolicyValue(raw)).toThrow("analyzed Argo weight");
  });
});
