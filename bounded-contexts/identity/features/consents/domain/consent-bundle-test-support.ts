import type { EventStore } from "@chase-sets/event-core/event-store";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import {
  consentActivationAuthorityStreamId,
  type ConsentActivationAuthoritySnapshot,
  type ConsentActivationStatus,
} from "@chase-sets/platform-policy/consent-activation-authority";
import { consentBundleMemberActivationPolicyKey, type ConsentActivationAuthorityReader } from "./consent-bundle";
import type { IdentityConsentPolicyKey } from "./terms-of-service-policy";

/**
 * Test support for driving the REAL Consent recording and bundle-resolution
 * paths with a member's Consent Activation Authority in a chosen state.
 *
 * The publication half's corpus replacement lives in the zero-import sibling
 * `./consent-publication-test-support.ts`, because a `vi.mock` factory is
 * hoisted above every import and must not re-enter the module it is mocking.
 * Nothing in either module is reachable from production code.
 */

/**
 * Registers and activates one member's Consent Activation Authority by
 * appending real authority events, so a test exercises the same fold, guard,
 * and revision the production read does rather than a stubbed snapshot.
 */
export async function activateConsentPolicyForTest(
  eventStore: EventStore,
  policyKey: IdentityConsentPolicyKey,
  version: string,
  context: EventStoreContext,
  options: Readonly<{ documentId?: string; actorUserId?: string }> = {},
): Promise<void> {
  const activationPolicyKey = consentBundleMemberActivationPolicyKey(policyKey);
  const streamId = consentActivationAuthorityStreamId(activationPolicyKey);
  const existing = await eventStore.readStream({ streamId, fromVersion: 1, limit: 500 });

  await eventStore.appendToStream({
    streamId,
    expectedVersion: existing.length === 0 ? "no_stream" : existing.length,
    context,
    events: [
      {
        eventType: "platform-policy.consent-activation-authority.registered",
        payload: {
          policyKey: activationPolicyKey,
          registration: {
            contextName: "identity",
            schemaSummary: "{ version: string matching /^v[1-9][0-9]*$/ }",
            registeredAt: "2026-01-01T00:00:00.000Z",
          },
        },
      },
      {
        eventType: "platform-policy.consent-activation-authority.activated",
        payload: {
          policyKey: activationPolicyKey,
          activation: {
            version,
            documentId: options.documentId ?? `pol-${policyKey}`,
            activatedAt: "2026-01-02T00:00:00.000Z",
            actorUserId: options.actorUserId ?? "usr_policy_operator",
          },
        },
      },
    ],
  });
}

/** Deactivates an already-active authority -- the mid-flight activation change control. */
export async function deactivateConsentPolicyForTest(
  eventStore: EventStore,
  policyKey: IdentityConsentPolicyKey,
  activeVersion: string,
  context: EventStoreContext,
): Promise<void> {
  const activationPolicyKey = consentBundleMemberActivationPolicyKey(policyKey);
  const streamId = consentActivationAuthorityStreamId(activationPolicyKey);
  const existing = await eventStore.readStream({ streamId, fromVersion: 1, limit: 500 });

  await eventStore.appendToStream({
    streamId,
    expectedVersion: existing.length,
    context,
    events: [
      {
        eventType: "platform-policy.consent-activation-authority.deactivated",
        payload: {
          policyKey: activationPolicyKey,
          deactivation: {
            deactivatedVersion: activeVersion,
            deactivatedAt: "2026-01-03T00:00:00.000Z",
            actorUserId: "usr_policy_operator",
          },
        },
      },
    ],
  });
}

/**
 * One authority snapshot, in the exact shape `readConsentActivationAuthority`
 * returns, for suites that drive a reader rather than an event store. The state
 * and the guard revision are built together here for the same reason the
 * production read derives them together: a test must not be able to express a
 * pairing the production read cannot produce.
 */
export function consentActivationAuthoritySnapshotForTest(
  activationPolicyKey: string,
  state: Readonly<{ status: ConsentActivationStatus; activeVersion?: string | null; authorityVersion?: number }>,
): ConsentActivationAuthoritySnapshot {
  const streamId = consentActivationAuthorityStreamId(activationPolicyKey);
  const authorityVersion = state.authorityVersion ?? (state.status === "never-activated" ? 0 : 2);
  return {
    policyKey: activationPolicyKey,
    streamId,
    registered: state.status !== "never-activated",
    status: state.status,
    isActive: state.status === "active",
    activeVersion: state.status === "active" ? (state.activeVersion ?? "v1") : null,
    activeDocumentId: state.status === "active" ? "pol-test" : null,
    activationCount: state.status === "never-activated" ? 0 : 1,
    lastTransitionAt: state.status === "never-activated" ? null : "2026-01-02T00:00:00.000Z",
    authorityVersion,
    guard: {
      policyKey: activationPolicyKey,
      streamId,
      expectedVersion: authorityVersion === 0 ? "no_stream" : authorityVersion,
    },
  };
}

/**
 * A reader that answers from a per-activation-key map and reports every other
 * key as never-activated. Suites that need a failing or malformed read supply
 * their own reader instead -- this one only ever produces well-formed snapshots.
 */
export function consentActivationAuthorityReaderForTest(
  active: Readonly<Record<string, string>>,
): ConsentActivationAuthorityReader {
  return async (activationPolicyKey: string) =>
    Object.prototype.hasOwnProperty.call(active, activationPolicyKey)
      ? consentActivationAuthoritySnapshotForTest(activationPolicyKey, {
          status: "active",
          activeVersion: active[activationPolicyKey],
        })
      : consentActivationAuthoritySnapshotForTest(activationPolicyKey, { status: "never-activated" });
}

/** Replaces the active version -- the `v1 -> v2` mid-registration control. */
export async function replaceConsentPolicyVersionForTest(
  eventStore: EventStore,
  policyKey: IdentityConsentPolicyKey,
  previousVersion: string,
  nextVersion: string,
  context: EventStoreContext,
): Promise<void> {
  const activationPolicyKey = consentBundleMemberActivationPolicyKey(policyKey);
  const streamId = consentActivationAuthorityStreamId(activationPolicyKey);
  const existing = await eventStore.readStream({ streamId, fromVersion: 1, limit: 500 });

  await eventStore.appendToStream({
    streamId,
    expectedVersion: existing.length,
    context,
    events: [
      {
        eventType: "platform-policy.consent-activation-authority.replaced",
        payload: {
          policyKey: activationPolicyKey,
          previousVersion,
          activation: {
            version: nextVersion,
            documentId: `pol-${policyKey}-${nextVersion}`,
            activatedAt: "2026-01-04T00:00:00.000Z",
            actorUserId: "usr_policy_operator",
          },
        },
      },
    ],
  });
}
