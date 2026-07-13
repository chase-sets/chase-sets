/**
 * Referral queue policy: the single, auditable rule that turns attributed
 * referrals into beta-invite-line advancement ("move up the founders line").
 *
 * The rule, in one sentence: everyone starts in signup order, and each
 * counted referral improves a signup's queue score by `positionsPerReferral`
 * places of that base order, with the number of counted referrals capped so
 * a late signup can never leapfrog genuine early signups entirely.
 *
 * Determinism: the queue is a pure function of the waitlist read model
 * (signup id, submission time, attributed referral count) -- all of which
 * replay deterministically from `public-presence.waitlist-signup.recorded`
 * events. No wall-clock reads, no randomness, no mutable ranking state.
 *
 * Anti-gaming inputs are enforced upstream of this policy and therefore
 * never re-checked here:
 * - Self-referrals are dropped by the domain decider (a signup's own code
 *   never records as its referrer).
 * - Duplicate emails collapse to one signup (stable email-derived signup id),
 *   so re-submitting an email neither creates a new queue entry nor a new
 *   attributed referral.
 * - Malformed referral codes normalize to "no attribution".
 */
export const WAITLIST_REFERRAL_QUEUE_POLICY = Object.freeze({
  /**
   * How many places of base signup order one counted referral is worth.
   * Deliberately modest: a referral should beat arriving a few minutes
   * earlier, not beat weeks of genuine earliness.
   */
  positionsPerReferral: 10,
  /**
   * Maximum referrals that count toward advancement per signup. Together
   * with `positionsPerReferral` this caps the total score improvement at
   * 100 places, so signup number 4900 with a bot army scores no better
   * than a 4800th arrival and can never leapfrog genuine early signups
   * entirely. Referrals beyond the cap still record for
   * attribution/analytics; they just stop buying places.
   */
  maxCountedReferrals: 10,
});

/** One waitlist signup as the queue policy sees it -- read-model row, no PII beyond the opaque signup id. */
export type WaitlistQueueEntry = Readonly<{
  signupId: string;
  /** ISO timestamp of the initial signup (`submitted_at`); later profile updates never change it. */
  submittedAt: string;
  /** Attributed referrals credited to this signup by the read model. */
  referralCount: number;
}>;

export type WaitlistQueuePlacement = Readonly<{
  signupId: string;
  /**
   * 1-based place this signup would hold on submission order alone. The
   * final position can trail it when other signups referral-advance past
   * this one -- queue places are zero-sum by design.
   */
  basePosition: number;
  /** 1-based place in the beta invite line after referral advancement. */
  position: number;
}>;

function countedReferrals(referralCount: number): number {
  return Math.min(Math.max(0, Math.floor(referralCount)), WAITLIST_REFERRAL_QUEUE_POLICY.maxCountedReferrals);
}

/**
 * Computes the queue placement for every signup. Pure and total: same
 * entries in, same placements out, regardless of input order.
 *
 * Ordering rule:
 * 1. Base order: `submittedAt` ascending, tiebroken by `signupId` ascending
 *    (both fields are immutable after initial signup).
 * 2. Advancement score: base index minus
 *    `min(referralCount, maxCountedReferrals) * positionsPerReferral`.
 * 3. Final order: score ascending, tiebroken by base order -- so a signup
 *    that referral-advances onto an earlier signup's score never passes
 *    that earlier signup, only reaches the place directly behind it.
 */
export function computeWaitlistQueuePlacements(
  entries: readonly WaitlistQueueEntry[],
): ReadonlyMap<string, WaitlistQueuePlacement> {
  const baseOrder = [...entries].sort(
    (left, right) =>
      Date.parse(left.submittedAt) - Date.parse(right.submittedAt) || left.signupId.localeCompare(right.signupId),
  );

  const scored = baseOrder.map((entry, baseIndex) => ({
    signupId: entry.signupId,
    baseIndex,
    score: baseIndex - countedReferrals(entry.referralCount) * WAITLIST_REFERRAL_QUEUE_POLICY.positionsPerReferral,
  }));

  scored.sort((left, right) => left.score - right.score || left.baseIndex - right.baseIndex);

  const placements = new Map<string, WaitlistQueuePlacement>();
  scored.forEach((entry, index) => {
    placements.set(entry.signupId, {
      signupId: entry.signupId,
      basePosition: entry.baseIndex + 1,
      position: index + 1,
    });
  });

  return placements;
}

export type WaitlistQueueStanding = Readonly<{
  /** 1-based place in the beta invite line. */
  position: number;
  totalSignups: number;
  /**
   * Places this signup's OWN referrals bought it: its position with its
   * referral count zeroed (everyone else unchanged) minus its actual
   * position. Always >= 0, unlike `basePosition - position`, which can go
   * negative when other signups referral-advance past a non-referrer.
   */
  positionsAdvanced: number;
}>;

/**
 * Resolves one signup's queue standing, including the truthful "your
 * referrals moved you up N places" counterfactual. Returns null when the
 * signup is not in the entries (e.g. the projection has not caught up yet)
 * so callers surface "position pending" rather than a fake number.
 */
export function resolveWaitlistQueueStanding(
  entries: readonly WaitlistQueueEntry[],
  signupId: string,
): WaitlistQueueStanding | null {
  const placement = computeWaitlistQueuePlacements(entries).get(signupId);
  if (!placement) {
    return null;
  }

  const withoutOwnReferrals = computeWaitlistQueuePlacements(
    entries.map((entry) => (entry.signupId === signupId ? { ...entry, referralCount: 0 } : entry)),
  ).get(signupId);

  return {
    position: placement.position,
    totalSignups: entries.length,
    positionsAdvanced: (withoutOwnReferrals?.position ?? placement.position) - placement.position,
  };
}
