import {
  createCheckpointKey,
  loadSubscriptionCheckpoint,
  waitForProjectionFreshness,
  type ReadConsistencyProjectionGroup,
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

export type InvitationProjectionFreshnessWaiter = (receipt: FreshWriteReceipt) => Promise<void>;

export type InvitationProjectionPositionReader = () => Promise<string>;

/**
 * Reads the durable last-applied global position of Auth's invitation
 * projection checkpoint (sourced from Identity) from Auth's own database.
 */
export function createAuthIdentityInvitationProjectionPositionReader(
  db: PgQueryable,
): InvitationProjectionPositionReader {
  const checkpointKey = createCheckpointKey({
    projectionName: AUTH_IDENTITY_INVITATION_PROJECTION,
    sourceContextName: AUTH_IDENTITY_INVITATION_SOURCE_CONTEXT,
    subscriptionVersion: AUTH_IDENTITY_INVITATION_SUBSCRIPTION_VERSION,
  });

  return async () => String((await loadSubscriptionCheckpoint(db, checkpointKey)) ?? ZERO_GLOBAL_POSITION);
}

/**
 * Builds a best-effort, strictly bounded waiter that lets Auth's invitation
 * projection catch up to a forwarded fresh-write receipt before the
 * acceptance-link handler reads the invitation. Reuses the shared
 * `waitForProjectionFreshness` mechanism (bounded by its timeout). On timeout
 * -- or any wait failure -- it resolves without throwing so the caller falls
 * back to reading the projection as it stands today; the wait never blocks
 * unboundedly and never introduces a new failure mode for the email path.
 */
export function createInvitationProjectionFreshnessWaiter(
  input: Readonly<{
    readInvitationProjectionPosition: InvitationProjectionPositionReader;
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
        nowMs: input.nowMs,
      });
    } catch {
      // Bounded fallback: a freshness timeout (or any wait failure) proceeds to
      // read the projection as it stands today rather than blocking or failing.
    }
  };
}
