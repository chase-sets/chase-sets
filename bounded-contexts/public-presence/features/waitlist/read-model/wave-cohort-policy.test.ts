import { describe, expect, it } from "vitest";
import { WAITLIST_GAMES, type WaitlistGame } from "../domain/common";
import { selectWaveCohort, type WaveCandidate } from "./wave-cohort-policy";

function candidate(id: number, overrides: Partial<WaveCandidate> = {}): WaveCandidate {
  return {
    signupId: `wls_${id}`,
    role: "buy",
    games: [],
    inventorySize: null,
    hasStoreLink: false,
    queuePosition: id,
    submittedAt: `2026-07-${String(id).padStart(2, "0")}T00:00:00.000Z`,
    ...overrides,
  };
}

describe("wave cohort policy", () => {
  it("game-balances wave 1 before filling by referral queue", () => {
    const buyers = Array.from({ length: 30 }, (_, index) => candidate(index + 1));
    const sellers = WAITLIST_GAMES.flatMap((game, gameIndex) =>
      Array.from({ length: 5 }, (_, index) =>
        candidate(100 + gameIndex * 5 + index, {
          role: "sell",
          games: [game as WaitlistGame],
          inventorySize: "100_to_500",
        }),
      ),
    );
    const selected = selectWaveCohort([...buyers, ...sellers], 1, 30);
    for (const game of WAITLIST_GAMES) {
      expect(selected.filter((entry) => entry.games.includes(game)).length).toBeGreaterThanOrEqual(5);
    }
  });

  it("prioritizes store-linked qualified sellers in wave 2", () => {
    const selected = selectWaveCohort(
      [
        candidate(1),
        candidate(2, { role: "sell", games: ["pokemon"], inventorySize: "under_100", hasStoreLink: true }),
      ],
      2,
      1,
    );
    expect(selected[0]?.signupId).toBe("wls_2");
  });
});
