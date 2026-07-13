import { definePolicy, type PolicyDefinition } from "@chase-sets/platform-policy/define-policy";
import type { JsonValue } from "@chase-sets/primitives/json";
import { PublicPresenceDomainError } from "./common";

export type BetaWave = Readonly<{
  waveNumber: 1 | 2 | 3;
  opensAt: string;
  inviteCount: number;
  rolloutExposurePercent: 10 | 25 | 50;
}>;

export type BetaWavePolicyValue = Readonly<{
  waves: readonly BetaWave[];
  publicLaunchAt: string;
  operationsGates: Readonly<{
    maxCheckoutFailureRatePercent: number;
    requireNearRealTimeProjections: boolean;
    requireSupportWithinSoloOperatorCapacity: boolean;
  }>;
}>;

export const BETA_WAVE_LAUNCH_POLICY_VALUE: BetaWavePolicyValue = {
  waves: [
    { waveNumber: 1, opensAt: "2026-07-31T00:00:00.000Z", inviteCount: 100, rolloutExposurePercent: 10 },
    { waveNumber: 2, opensAt: "2026-08-07T00:00:00.000Z", inviteCount: 250, rolloutExposurePercent: 25 },
    { waveNumber: 3, opensAt: "2026-08-14T00:00:00.000Z", inviteCount: 500, rolloutExposurePercent: 50 },
  ],
  publicLaunchAt: "2026-09-01T00:00:00.000Z",
  operationsGates: {
    maxCheckoutFailureRatePercent: 2,
    requireNearRealTimeProjections: true,
    requireSupportWithinSoloOperatorCapacity: true,
  },
};

function integer(value: unknown, name: string, min: number, max: number) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new PublicPresenceDomainError(`${name} must be a whole number between ${min} and ${max}.`);
  }
  return parsed;
}

function iso(value: unknown, name: string) {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new PublicPresenceDomainError(`${name} must be an ISO timestamp.`);
  }
  return new Date(value).toISOString();
}

function percentage(value: unknown, name: string) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 100) {
    throw new PublicPresenceDomainError(`${name} must be greater than 0 and at most 100.`);
  }
  return parsed;
}

function boolean(value: unknown, name: string) {
  if (typeof value !== "boolean") {
    throw new PublicPresenceDomainError(`${name} must be true or false.`);
  }
  return value;
}

export function decodeBetaWavePolicyValue(raw: JsonValue): BetaWavePolicyValue {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new PublicPresenceDomainError("Beta wave policy must be an object.");
  }
  const record = raw as Record<string, unknown>;
  if (!Array.isArray(record.waves) || record.waves.length !== 3) {
    throw new PublicPresenceDomainError("Beta wave policy must define exactly waves 1, 2, and 3.");
  }
  const waves = record.waves.map((entry, index): BetaWave => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new PublicPresenceDomainError(`Wave ${index + 1} must be an object.`);
    }
    const wave = entry as Record<string, unknown>;
    const waveNumber = integer(wave.waveNumber, "Wave number", 1, 3);
    if (waveNumber !== index + 1) {
      throw new PublicPresenceDomainError("Beta waves must be ordered 1, 2, 3 without gaps.");
    }
    const exposure = integer(wave.rolloutExposurePercent, "Rollout exposure percent", 1, 99);
    if (![10, 25, 50].includes(exposure)) {
      throw new PublicPresenceDomainError("Wave rollout exposure must use an analyzed Argo weight (10, 25, or 50).");
    }
    return {
      waveNumber: waveNumber as BetaWave["waveNumber"],
      opensAt: iso(wave.opensAt, `Wave ${waveNumber} opensAt`),
      inviteCount: integer(wave.inviteCount, `Wave ${waveNumber} inviteCount`, 1, 100_000),
      rolloutExposurePercent: exposure as BetaWave["rolloutExposurePercent"],
    };
  });
  if (waves.some((wave, index) => index > 0 && Date.parse(wave.opensAt) <= Date.parse(waves[index - 1]!.opensAt))) {
    throw new PublicPresenceDomainError("Beta wave dates must increase.");
  }
  const gatesRaw = record.operationsGates;
  if (!gatesRaw || typeof gatesRaw !== "object" || Array.isArray(gatesRaw)) {
    throw new PublicPresenceDomainError("Beta wave policy operationsGates must be an object.");
  }
  const gates = gatesRaw as Record<string, unknown>;
  const publicLaunchAt = iso(record.publicLaunchAt, "Public launch");
  if (Date.parse(publicLaunchAt) <= Date.parse(waves[2]!.opensAt)) {
    throw new PublicPresenceDomainError("Public launch must be after wave 3.");
  }
  return {
    waves,
    publicLaunchAt,
    operationsGates: {
      maxCheckoutFailureRatePercent: percentage(
        gates.maxCheckoutFailureRatePercent,
        "Maximum checkout failure rate percent",
      ),
      requireNearRealTimeProjections: boolean(
        gates.requireNearRealTimeProjections,
        "Require near-real-time projections",
      ),
      requireSupportWithinSoloOperatorCapacity: boolean(
        gates.requireSupportWithinSoloOperatorCapacity,
        "Require support within solo-operator capacity",
      ),
    },
  };
}

export const betaWavePolicy: PolicyDefinition<BetaWavePolicyValue> = definePolicy({
  policyKey: "public-presence.beta-waves",
  contextName: "public-presence",
  schemaSummary:
    "{ waves: [{ waveNumber, opensAt, inviteCount, rolloutExposurePercent }], publicLaunchAt, operationsGates }",
  defaultValue: BETA_WAVE_LAUNCH_POLICY_VALUE,
  decodeValue: decodeBetaWavePolicyValue,
});
