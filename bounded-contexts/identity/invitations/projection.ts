import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { extractIdFromStreamId } from "../projection-support/extract-id-from-stream";

const STREAM_PREFIX = "identity.invitation-";

export function buildInvitationProjectionHandlers(
  db: PgQueryable,
): ProjectorHandlerMap {
  return {
    "identity.invitation.created": async (event) => {
      const { invitationId, accountId, email, roleKey, expiresAt } = event.data as {
        invitationId: string;
        accountId: string;
        email: string;
        roleKey: string;
        expiresAt: string;
      };
      await db.query(
        `INSERT INTO identity_invitations (
           invitation_id,
           account_id,
           email,
           role_key,
           status,
           expires_at,
           accepted_by_user_id,
           updated_at
         )
         VALUES ($1, $2, $3, $4, 'pending', $5, NULL, $6)
         ON CONFLICT (invitation_id) DO UPDATE
         SET account_id = $2,
             email = $3,
             role_key = $4,
             status = 'pending',
             expires_at = $5,
             accepted_by_user_id = NULL,
             updated_at = $6`,
        [invitationId, accountId, email, roleKey, expiresAt, event.timing.recordedAt],
      );
    },
    "identity.invitation.resent": async (event) => {
      const invitationId = extractIdFromStreamId(event.streamId, STREAM_PREFIX);
      await db.query(
        `UPDATE identity_invitations
         SET expires_at = $2,
             updated_at = $3
         WHERE invitation_id = $1`,
        [
          invitationId,
          (event.data as { expiresAt: string }).expiresAt,
          event.timing.recordedAt,
        ],
      );
    },
    "identity.invitation.cancelled": async (event) => {
      const invitationId = extractIdFromStreamId(event.streamId, STREAM_PREFIX);
      await db.query(
        `UPDATE identity_invitations
         SET status = 'cancelled',
             updated_at = $2
         WHERE invitation_id = $1`,
        [invitationId, event.timing.recordedAt],
      );
    },
    "identity.invitation.accepted": async (event) => {
      const invitationId = extractIdFromStreamId(event.streamId, STREAM_PREFIX);
      await db.query(
        `UPDATE identity_invitations
         SET status = 'accepted',
             accepted_by_user_id = $2,
             updated_at = $3
         WHERE invitation_id = $1`,
        [
          invitationId,
          (event.data as { userId: string }).userId,
          event.timing.recordedAt,
        ],
      );
    },
    "identity.invitation.declined": async (event) => {
      const invitationId = extractIdFromStreamId(event.streamId, STREAM_PREFIX);
      await db.query(
        `UPDATE identity_invitations
         SET status = 'declined',
             updated_at = $2
         WHERE invitation_id = $1`,
        [invitationId, event.timing.recordedAt],
      );
    },
    "identity.invitation.expired": async (event) => {
      const invitationId = extractIdFromStreamId(event.streamId, STREAM_PREFIX);
      await db.query(
        `UPDATE identity_invitations
         SET status = 'expired',
             updated_at = $2
         WHERE invitation_id = $1`,
        [invitationId, event.timing.recordedAt],
      );
    },
  };
}
