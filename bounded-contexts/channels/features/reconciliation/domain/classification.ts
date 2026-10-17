import type { ChannelDriftClassification, ChannelDriftObservation } from "./contracts";

export function classifyChannelDrift(observation: ChannelDriftObservation): ChannelDriftClassification {
  const authority = observation.sourceAuthority;
  if (authority.kind !== "complete" && authority.kind !== "present-rows") return "source-unavailable";
  if (!observation.observed.present) return authority.kind === "complete" ? "structural" : "source-unavailable";

  const revisionUnavailable = observation.observed.revision === null;
  if (authority.kind === "present-rows" && !revisionUnavailable) return "source-unavailable";
  const materialRowTotal = authority.kind === "complete" ? authority.authorityTotal : authority.snapshotRowTotal;
  if (
    revisionUnavailable &&
    (!observation.expectedMaterialIdentity ||
      observation.observed.materialIdentity !== observation.expectedMaterialIdentity ||
      observation.expectedPrice.currency !== "USD" ||
      observation.observed.price.currency !== "USD" ||
      !Number.isSafeInteger(materialRowTotal) ||
      materialRowTotal < 1 ||
      authority.collectedCount !== materialRowTotal ||
      !Number.isSafeInteger(observation.observed.price.amountMinor) ||
      observation.observed.price.amountMinor < 0 ||
      !Number.isSafeInteger(observation.observed.quantity) ||
      observation.observed.quantity < 0 ||
      !/^[a-f0-9]{64}$/.test(observation.observed.fingerprint))
  )
    return "source-unavailable";

  const expectedMatches =
    (revisionUnavailable || observation.observed.revision === String(observation.expectedRevision)) &&
    observation.observed.price.amountMinor === observation.expectedPrice.amountMinor &&
    observation.observed.price.currency === observation.expectedPrice.currency &&
    observation.observed.quantity === observation.expectedQuantity &&
    (revisionUnavailable || observation.observed.fingerprint === observation.expectedMaterialFingerprint);
  if (expectedMatches) return "in-sync";

  const accepted = observation.acceptedForeignEdit;
  if (
    accepted !== null &&
    accepted.observedFingerprint === observation.observed.fingerprint &&
    accepted.expectedMaterialFingerprint === observation.expectedMaterialFingerprint
  ) {
    return "in-sync";
  }

  return !revisionUnavailable &&
    observation.lastAppliedRevision !== null &&
    observation.observed.revision === String(observation.lastAppliedRevision)
    ? "repairable"
    : "foreign-edit";
}
