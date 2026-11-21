import {
  createCheckpointKey,
  loadSubscriptionCheckpoint,
  waitForProjectionFreshness,
  type ReadConsistencyProjectionGroup,
  type ReadConsistencyWorkSignalGateway,
} from "@chase-sets/bounded-context-runtime";
import { ZERO_GLOBAL_POSITION } from "@chase-sets/event-core";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { FreshWriteReceipt } from "@chase-sets/http/responses";

// Auth projects Identity invitation facts into its own read model through this
// projection group. The recipient acceptance-link step reads that read model to
// issue the email, so a forwarded fresh-write receipt from the Identity
// invitation command must be allowed to settle before that read.
export const AUTH_IDENTITY_INVITATION_PROJECTION = "auth-identity-invitation-projection";
const AUTH_IDENTITY_INVITATION_SOURCE_CONTEXT = "identity";
// Matches the subscriptionVersion declared for this projection in
// bounded-contexts/auth/context.json; bumping the subscription version must
// update this checkpoint identity together.
const AUTH_IDENTITY_INVITATION_SUBSCRIPTION_VERSION = 1;
const AUTH_CONTEXT_NAME = "auth";

/**
 * Whether Auth's invitation projection reached the forwarded receipt: `fresh` when it did,
 * `behind` when the bounded wait ended first or the checkpoint could not be read.
 */
export type InvitationProjectionFreshness = "fresh" | "behind";

export type InvitationProjectionFreshnessWaiter = (
  receipt: FreshWriteReceipt,
) => Promise<InvitationProjectionFreshness>;

export type InvitationProjectionPositionReader = () => Promise<string>;

const AUTH_IDENTITY_INVITATION_CHECKPOINT_KEY = createCheckpointKey({
  projectionName: AUTH_IDENTITY_INVITATION_PROJECTION,
  sourceContextName: AUTH_IDENTITY_INVITATION_SOURCE_CONTEXT,
  subscriptionVersion: AUTH_IDENTITY_INVITATION_SUBSCRIPTION_VERSION,
});

/**
 * Reads the durable last-applied global position of Auth's invitation
 * projection checkpoint (sourced from Identity) from Auth's own database.
 */
export function createAuthIdentityInvitationProjectionPositionReader(
  db: PgQueryable,
): InvitationProjectionPositionReader {
  return async () =>
    String((await loadSubscriptionCheckpoint(db, AUTH_IDENTITY_INVITATION_CHECKPOINT_KEY)) ?? ZERO_GLOBAL_POSITION);
}

/**
 * Builds a strictly bounded waiter that lets Auth's invitation projection catch
 * up to a forwarded fresh-write receipt before the acceptance-link handler reads
 * the invitation. Reuses the shared `waitForProjectionFreshness` mechanism, and
 * with the host's work-signal gateway it wakes the projection rather than only
 * polling, as the shared read-after-write middleware does. It never throws: a
 * timeout or a failed checkpoint read answers `behind`, so the handler can tell
 * an invitation the projection has not reached yet from one that is unavailable.
 */
export function createInvitationProjectionFreshnessWaiter(
  input: Readonly<{
    readInvitationProjectionPosition: InvitationProjectionPositionReader;
    workSignalGateway?: ReadConsistencyWorkSignalGateway;
    timeoutMs?: number;
    pollIntervalMs?: number;
    nowMs?: () => number;
  }>,
): InvitationProjectionFreshnessWaiter {
  const projectionGroups: readonly ReadConsistencyProjectionGroup[] = [
    {
      targetContextName: AUTH_CONTEXT_NAME,
      projectionName: AUTH_IDENTITY_INVITATION_PROJECTION,
      subscriptionRunners: [
        {
          sourceContextName: AUTH_IDENTITY_INVITATION_SOURCE_CONTEXT,
          checkpointKey: AUTH_IDENTITY_INVITATION_CHECKPOINT_KEY,
          refreshStatus: async () => ({
            lastGlobalPosition: await input.readInvitationProjectionPosition(),
            state: "unknown",
            lastError: null,
          }),
        },
      ],
    },
  ];

  return async (receipt) => {
    try {
      await waitForProjectionFreshness({
        projectionGroups,
        targetContextNames: [AUTH_CONTEXT_NAME],
        dependencies: [{ targetContextName: AUTH_CONTEXT_NAME, projectionName: AUTH_IDENTITY_INVITATION_PROJECTION }],
        receipt,
        timeoutMs: input.timeoutMs,
        pollIntervalMs: input.pollIntervalMs,
        workSignalGateway: input.workSignalGateway,
        workSignalMetadata: { routePaths: ["/api/auth/invitations/acceptance-link/request"] },
        nowMs: input.nowMs,
      });
      return "fresh";
    } catch {
      // A timeout or a failed checkpoint read: the projection may not show the
      // write yet. The handler decides what that means for its read.
      return "behind";
    }
  };
}
