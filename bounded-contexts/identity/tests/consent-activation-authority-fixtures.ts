import {
  consentActivationAuthorityStreamId,
  decodeConsentActivationAuthoritySnapshot,
  type ValidatedConsentActivationAuthoritySnapshot,
} from "@chase-sets/platform-policy/consent-activation-authority";
import type { ConsentActivationAuthorityReader } from "../features/consents/domain/consent-bundle";

/**
 * Validated Consent Activation Authority snapshots for Identity's consent
 * tests.
 *
 * Every fixture here is minted by the owning context's canonical snapshot
 * decoder, never hand-assembled. That is the point: Identity consumes the
 * validated authority contract rather than duplicating its validation, so a
 * fixture that describes an impossible lifecycle fails at construction time in
 * the test file instead of quietly exercising a state production can never
 * reach.
 */

const LAST_TRANSITION_AT = "2026-07-01T00:00:00.000Z";

export function neverActivatedUnregisteredSnapshot(policyKey: string): ValidatedConsentActivationAuthoritySnapshot {
  const streamId = consentActivationAuthorityStreamId(policyKey);
  return decodeConsentActivationAuthoritySnapshot(policyKey, {
    policyKey,
    streamId,
    registered: false,
    status: "never-activated",
    isActive: false,
    activeVersion: null,
    activeDocumentId: null,
    activationCount: 0,
    lastTransitionAt: null,
    authorityVersion: 0,
    guard: { policyKey, streamId, expectedVersion: "no_stream" },
  });
}

export function registeredNeverActivatedSnapshot(policyKey: string): ValidatedConsentActivationAuthoritySnapshot {
  const streamId = consentActivationAuthorityStreamId(policyKey);
  return decodeConsentActivationAuthoritySnapshot(policyKey, {
    policyKey,
    streamId,
    registered: true,
    status: "never-activated",
    isActive: false,
    activeVersion: null,
    activeDocumentId: null,
    activationCount: 0,
    lastTransitionAt: LAST_TRANSITION_AT,
    authorityVersion: 1,
    guard: { policyKey, streamId, expectedVersion: 1 },
  });
}

export function activeSnapshot(policyKey: string, version: string): ValidatedConsentActivationAuthoritySnapshot {
  const streamId = consentActivationAuthorityStreamId(policyKey);
  return decodeConsentActivationAuthoritySnapshot(policyKey, {
    policyKey,
    streamId,
    registered: true,
    status: "active",
    isActive: true,
    activeVersion: version,
    activeDocumentId: "pol_active",
    activationCount: 1,
    lastTransitionAt: LAST_TRANSITION_AT,
    authorityVersion: 2,
    guard: { policyKey, streamId, expectedVersion: 2 },
  });
}

export function deactivatedSnapshot(policyKey: string): ValidatedConsentActivationAuthoritySnapshot {
  const streamId = consentActivationAuthorityStreamId(policyKey);
  return decodeConsentActivationAuthoritySnapshot(policyKey, {
    policyKey,
    streamId,
    registered: true,
    status: "inactive",
    isActive: false,
    activeVersion: null,
    activeDocumentId: null,
    activationCount: 1,
    lastTransitionAt: LAST_TRANSITION_AT,
    authorityVersion: 3,
    guard: { policyKey, streamId, expectedVersion: 3 },
  });
}

export type RecordingAuthorityReader = ConsentActivationAuthorityReader &
  Readonly<{
    /** Every policy key this reader was asked for, in call order. */
    reads: readonly string[];
  }>;

/**
 * An authority reader backed by an explicit per-policy-key script, recording
 * exactly which authorities were read. The read trace is how "no authority read
 * was performed" is asserted positively rather than inferred from an outcome.
 *
 * A key with no scripted entry throws, so a test can never accidentally pass
 * because an unexpected read silently returned a benign default.
 */
export function recordingAuthorityReader(
  script: Readonly<Record<string, () => ValidatedConsentActivationAuthoritySnapshot>>,
): RecordingAuthorityReader {
  const reads: string[] = [];
  return {
    reads,
    read: async (policyKey: string) => {
      reads.push(policyKey);
      const entry = script[policyKey];
      if (!entry) {
        throw new Error(`No authority scripted for '${policyKey}'.`);
      }
      return entry();
    },
  };
}
