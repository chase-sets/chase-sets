import { describe, expect, it } from "vitest";
import { WAVE_ONE_ADMISSION_BAR, evaluateWaveOneAdmissionBar } from "./campaign-admission-bar-policy";

describe("evaluateWaveOneAdmissionBar", () => {
  const fullCoverage = {
    pokemon: WAVE_ONE_ADMISSION_BAR.minQualifiedSellersPerGame,
    "magic-the-gathering": WAVE_ONE_ADMISSION_BAR.minQualifiedSellersPerGame,
    "yu-gi-oh": WAVE_ONE_ADMISSION_BAR.minQualifiedSellersPerGame,
    "disney-lorcana": WAVE_ONE_ADMISSION_BAR.minQualifiedSellersPerGame,
    "one-piece-card-game": WAVE_ONE_ADMISSION_BAR.minQualifiedSellersPerGame,
  } as const;

  it("admits when every sub-condition clears the bar", () => {
    const status = evaluateWaveOneAdmissionBar({
      totalSignups: WAVE_ONE_ADMISSION_BAR.minTotalSignups,
      qualifiedSellerCount: WAVE_ONE_ADMISSION_BAR.minQualifiedSellers,
      qualifiedSellersByGame: fullCoverage,
    });

    expect(status.admitted).toBe(true);
    expect(status.totalSignupsMet).toBe(true);
    expect(status.qualifiedSellersMet).toBe(true);
    expect(status.allGamesCovered).toBe(true);
    expect(status.gameCoverage).toHaveLength(5);
  });

  it("rejects when the overall signup floor is not met even if sellers clear the bar", () => {
    const status = evaluateWaveOneAdmissionBar({
      totalSignups: WAVE_ONE_ADMISSION_BAR.minTotalSignups - 1,
      qualifiedSellerCount: WAVE_ONE_ADMISSION_BAR.minQualifiedSellers,
      qualifiedSellersByGame: fullCoverage,
    });

    expect(status.totalSignupsMet).toBe(false);
    expect(status.admitted).toBe(false);
  });

  it("rejects when total qualified sellers is below the bar even with full game coverage", () => {
    const status = evaluateWaveOneAdmissionBar({
      totalSignups: WAVE_ONE_ADMISSION_BAR.minTotalSignups,
      qualifiedSellerCount: WAVE_ONE_ADMISSION_BAR.minQualifiedSellers - 1,
      qualifiedSellersByGame: fullCoverage,
    });

    expect(status.qualifiedSellersMet).toBe(false);
    expect(status.admitted).toBe(false);
  });

  it("rejects when one game has zero qualified sellers, even with 50+ sellers overall", () => {
    const status = evaluateWaveOneAdmissionBar({
      totalSignups: WAVE_ONE_ADMISSION_BAR.minTotalSignups,
      qualifiedSellerCount: WAVE_ONE_ADMISSION_BAR.minQualifiedSellers,
      qualifiedSellersByGame: { ...fullCoverage, "one-piece-card-game": 0 },
    });

    expect(status.qualifiedSellersMet).toBe(true);
    expect(status.allGamesCovered).toBe(false);
    expect(status.admitted).toBe(false);
    const onePieceCoverage = status.gameCoverage.find((entry) => entry.game === "one-piece-card-game");
    expect(onePieceCoverage?.covered).toBe(false);
    expect(onePieceCoverage?.qualifiedSellerCount).toBe(0);
  });

  it("defaults missing games to zero qualified sellers", () => {
    const status = evaluateWaveOneAdmissionBar({
      totalSignups: 0,
      qualifiedSellerCount: 0,
      qualifiedSellersByGame: {},
    });

    expect(status.gameCoverage.every((entry) => entry.qualifiedSellerCount === 0)).toBe(true);
    expect(status.allGamesCovered).toBe(false);
  });
});
