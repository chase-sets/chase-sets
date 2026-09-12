import type { ChannelDriftClassification, ChannelDriftObservationV1 } from "./contracts";

export function classifyChannelDrift(observation: ChannelDriftObservationV1): ChannelDriftClassification {
  if (observation.sourceAuthority.kind !== "complete") return "source-unavailable";
  if (!observation.observed.present) return "structural";

  const expectedMatches =
    observation.observed.revision === String(observation.expectedRevision) &&
    observation.observed.price.amountMinor === observation.expectedPrice.amountMinor &&
    observation.observed.price.currency === observation.expectedPrice.currency &&
    observation.observed.quantity === observation.expectedQuantity &&
    observation.observed.fingerprint === observation.expectedMaterialFingerprint;
  if (expectedMatches) return "in-sync";

  const accepted = observation.acceptedForeignEdit;
  if (
    accepted !== null &&
    accepted.observedFingerprint === observation.observed.fingerprint &&
    accepted.expectedMaterialFingerprint === observation.expectedMaterialFingerprint
  ) {
    return "in-sync";
  }

  return observation.lastAppliedRevision !== null &&
    observation.observed.revision === String(observation.lastAppliedRevision)
    ? "repairable"
    : "foreign-edit";
}
