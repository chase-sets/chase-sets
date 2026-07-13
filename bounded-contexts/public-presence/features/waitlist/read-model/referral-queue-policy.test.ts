import { describe, expect, it } from "vitest";
import {
  computeWaitlistQueuePlacements,
  resolveWaitlistQueueStanding,
  WAITLIST_REFERRAL_QUEUE_POLICY,
  type WaitlistQueueEntry,
} from "./referral-queue-policy";

/** N signups, one per minute in id order, with no referrals unless overridden. */
function queueOf(count: number, referralsBySignup: Record<string, number> = {}): WaitlistQueueEntry[] {
  return Array.from({ length: count }, (_, index) => {
    const signupId = `wls_${String(index + 1).padStart(4, "0")}`;
    return {
      signupId,
      submittedAt: new Date(Date.UTC(2026, 6, 1, 0, index)).toISOString(),
      referralCount: referralsBySignup[signupId] ?? 0,
    };
  });
}

function positionOf(entries: readonly WaitlistQueueEntry[], signupId: string): number {
  const placement = computeWaitlistQueuePlacements(entries).get(signupId);
  if (!placement) {
    throw new Error(`Expected a placement for ${signupId}.`);
  }
  return placement.position;
}

describe("waitlist referral queue policy", () => {
  it("keeps pure signup order when nobody has referrals", () => {
    const placements = computeWaitlistQueuePlacements(queueOf(5));

    for (let index = 1; index <= 5; index += 1) {
      const signupId = `wls_${String(index).padStart(4, "0")}`;
      expect(placements.get(signupId)).toEqual({ signupId, basePosition: index, position: index });
    }
  });

  it("moves a signup ahead of exactly positionsPerReferral base places per counted referral", () => {
    const entries = queueOf(200, { wls_0100: 1 });

    // Base place 100, one referral: score matches base place 90's arrival,
    // and the base-order tiebreak seats it directly behind that arrival.
    expect(positionOf(entries, "wls_0100")).toBe(91);

    const twoReferrals = queueOf(200, { wls_0100: 2 });
    expect(positionOf(twoReferrals, "wls_0100")).toBe(81);
  });

  it("is deterministic and input-order independent", () => {
    const entries = queueOf(50, { wls_0030: 3, wls_0045: 7, wls_0010: 1 });
    const shuffled = [...entries].reverse();
    const interleaved = [...entries.slice(25), ...entries.slice(0, 25)];

    const expected = computeWaitlistQueuePlacements(entries);
    for (const variant of [shuffled, interleaved]) {
      const placements = computeWaitlistQueuePlacements(variant);
      expect(placements.size).toBe(expected.size);
      for (const [signupId, placement] of expected) {
        expect(placements.get(signupId)).toEqual(placement);
      }
    }
  });

  it("assigns every signup a unique position covering 1..N", () => {
    const entries = queueOf(40, { wls_0035: 10, wls_0036: 10, wls_0040: 4 });
    const positions = [...computeWaitlistQueuePlacements(entries).values()]
      .map((p) => p.position)
      .sort((a, b) => a - b);

    expect(positions).toEqual(Array.from({ length: 40 }, (_, index) => index + 1));
  });

  it("caps the jump so a late signup with unlimited referrals cannot leapfrog genuine early signups entirely", () => {
    const maxJump =
      WAITLIST_REFERRAL_QUEUE_POLICY.maxCountedReferrals * WAITLIST_REFERRAL_QUEUE_POLICY.positionsPerReferral;
    const entries = queueOf(4900, { wls_4900: 100_000 });

    // 100k claimed referrals count as maxCountedReferrals: best case is the
    // place directly behind base arrival (4900 - maxJump), never the front.
    expect(positionOf(entries, "wls_4900")).toBe(4900 - maxJump + 1);
    expect(positionOf(entries, "wls_0001")).toBe(1);
  });

  it("never lets an advancing signup pass an earlier signup whose score it only ties", () => {
    // wls_0011 with one referral scores exactly onto wls_0001's arrival score.
    const entries = queueOf(11, { wls_0011: 1 });

    expect(positionOf(entries, "wls_0001")).toBe(1);
    expect(positionOf(entries, "wls_0011")).toBe(2);
  });

  it("breaks identical submission timestamps by signup id, deterministically", () => {
    const submittedAt = "2026-07-01T00:00:00.000Z";
    const entries: WaitlistQueueEntry[] = [
      { signupId: "wls_b", submittedAt, referralCount: 0 },
      { signupId: "wls_a", submittedAt, referralCount: 0 },
    ];

    expect(positionOf(entries, "wls_a")).toBe(1);
    expect(positionOf(entries, "wls_b")).toBe(2);
  });

  it("ignores negative or fractional referral counts instead of minting advancement", () => {
    const entries = queueOf(20, { wls_0010: -5 });
    expect(positionOf(entries, "wls_0010")).toBe(10);

    const fractional = queueOf(20, { wls_0010: 0.9 });
    expect(positionOf(fractional, "wls_0010")).toBe(10);
  });

  it("reports a standing with the counterfactual places the signup's own referrals bought", () => {
    const entries = queueOf(200, { wls_0100: 3 });

    expect(resolveWaitlistQueueStanding(entries, "wls_0100")).toEqual({
      position: 71,
      totalSignups: 200,
      positionsAdvanced: 29,
    });
  });

  it("never reports negative advancement for a non-referrer who was passed by others", () => {
    const entries = queueOf(100, { wls_0090: 5 });

    // wls_0050 got passed by wls_0090 and sits one behind its base place --
    // but its own (zero) referrals bought it nothing, so advancement is 0.
    expect(resolveWaitlistQueueStanding(entries, "wls_0050")).toEqual({
      position: 51,
      totalSignups: 100,
      positionsAdvanced: 0,
    });
  });

  it("returns null standing while the projection has not caught up with a fresh signup", () => {
    expect(resolveWaitlistQueueStanding(queueOf(10), "wls_absent")).toBeNull();
  });
});
