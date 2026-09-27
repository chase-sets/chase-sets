import { BETA_WAVE_LAUNCH_POLICY_VALUE } from "../domain/wave-policy";

function inviteCount(waveNumber: 1 | 2 | 3) {
  const wave = BETA_WAVE_LAUNCH_POLICY_VALUE.waves.find((candidate) => candidate.waveNumber === waveNumber);
  if (!wave) {
    throw new Error(`Beta invite wave ${waveNumber} is not configured.`);
  }
  return wave.inviteCount;
}

/**
 * Public launch copy is undated: waitlist, numbered beta invite waves,
 * then open signup. Waves are gated on operational readiness, never dates.
 * Only policy-owned invite counts are interpolated into localized copy.
 */
export const launchTimeline = {
  waveOneInviteCount: inviteCount(1),
  waveTwoInviteCount: inviteCount(2),
  waveThreeInviteCount: inviteCount(3),
} as const;
