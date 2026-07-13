import {
  WAITLIST_GAMES,
  type WaitlistGame,
  type WaitlistInventorySize,
  type WaitlistCommerceIntent,
} from "../domain/common";

export type WaveCandidate = Readonly<{
  signupId: string;
  role: WaitlistCommerceIntent;
  games: readonly WaitlistGame[];
  inventorySize: WaitlistInventorySize | null;
  hasStoreLink: boolean;
  queuePosition: number;
  submittedAt: string;
}>;

function qualifiedSeller(candidate: WaveCandidate) {
  return candidate.role !== "buy" && candidate.games.length > 0 && candidate.inventorySize !== null;
}

function compareQueue(left: WaveCandidate, right: WaveCandidate) {
  return (
    left.queuePosition - right.queuePosition ||
    left.submittedAt.localeCompare(right.submittedAt) ||
    left.signupId.localeCompare(right.signupId)
  );
}

function unique(items: readonly WaveCandidate[]) {
  const seen = new Set<string>();
  return items.filter((item) => !seen.has(item.signupId) && Boolean(seen.add(item.signupId)));
}

function balancedGameCoverage(candidates: readonly WaveCandidate[], minimumPerGame: number) {
  const selected: WaveCandidate[] = [];
  const selectedIds = new Set<string>();
  for (const game of WAITLIST_GAMES) {
    let covered = selected.filter((candidate) => candidate.games.includes(game)).length;
    for (const candidate of candidates) {
      if (covered >= minimumPerGame) break;
      if (!selectedIds.has(candidate.signupId) && qualifiedSeller(candidate) && candidate.games.includes(game)) {
        selected.push(candidate);
        selectedIds.add(candidate.signupId);
        covered += 1;
      }
    }
  }
  return selected;
}

export function selectWaveCohort(
  candidates: readonly WaveCandidate[],
  waveNumber: 1 | 2 | 3,
  inviteCount: number,
  minimumSellersPerGame = 5,
) {
  const byQueue = [...candidates].sort(compareQueue);
  const priorities =
    waveNumber === 1
      ? [
          ...balancedGameCoverage(byQueue, minimumSellersPerGame),
          ...byQueue.filter(qualifiedSeller),
          ...byQueue.filter((candidate) => candidate.role === "both"),
          ...byQueue,
        ]
      : waveNumber === 2
        ? [
            ...byQueue.filter((candidate) => qualifiedSeller(candidate) && candidate.hasStoreLink),
            ...byQueue.filter(qualifiedSeller),
            ...byQueue,
          ]
        : byQueue;
  return unique(priorities).slice(0, inviteCount);
}
