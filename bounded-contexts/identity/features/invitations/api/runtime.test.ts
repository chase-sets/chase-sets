import { describe, expect, it } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { ProjectionCheckpointStore } from "@chase-sets/event-core/projector";
import type {
  AppendToStreamInput,
  GlobalPosition,
  ReadAllInput,
  ReadStreamInput,
  StoredEvent,
} from "@chase-sets/event-core/storage";
import { ZERO_GLOBAL_POSITION } from "@chase-sets/event-core/storage";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { AccountId, InvitationId } from "@chase-sets/primitives/typed-ids";
import { createInvitationRuntime } from "./runtime";

function createCheckpointStore(): ProjectionCheckpointStore {
  return {
    loadCheckpoint: async () => ZERO_GLOBAL_POSITION,
    saveCheckpoint: async () => undefined,
  };
}

function createStaleInvitationDb(): PgQueryable {
  return {
    async query<Row>(sql: string, params: readonly unknown[] = []) {
      if (sql.includes("FROM identity_invitations")) {
        return {
          rows: [
            {
              invitation_id: params[0],
              account_id: "acc_identity",
              account_display_name: "Card Vault",
              account_name: "Card Vault LLC",
              email: "invitee@example.com",
              role_key: "viewer",
              status: "pending",
              expires_at: "2026-07-01T00:00:00.000Z",
              accepted_by_user_id: null,
              accepted_by_user_display_name: null,
              accepted_by_user_primary_email: null,
              updated_at: "2026-06-29T00:00:00.000Z",
            },
          ] as Row[],
          rowCount: 1,
        };
      }

      throw new Error(`Unexpected query: ${sql}`);
    },
  };
}

const context = {
  tenantId: "tnt_identity" as never,
  audit: {
    performedByUserId: "usr_identity" as never,
    forAccountId: "acc_identity" as never,
  },
};

describe("invitation runtime", () => {
  it("serves committed cancelled state when the invitation projection is stale", async () => {
    const invitationId = "ivt_identity" as InvitationId;
    const runtime = createInvitationRuntime({
      eventStore: createInMemoryEventStore().eventStore,
      checkpointStore: createCheckpointStore(),
      db: createStaleInvitationDb(),
    });

    await runtime.commandHandler({
      streamId: `identity.invitation-${invitationId}`,
      command: {
        type: "CreateInvitation",
        invitationId,
        accountId: "acc_identity" as AccountId,
        email: "invitee@example.com",
        roleKey: "viewer",
        expiresAt: "2026-07-01T00:00:00.000Z",
        assignmentAuthority: { type: "system" },
      },
      context,
    });
    await runtime.commandHandler({
      streamId: `identity.invitation-${invitationId}`,
      command: { type: "CancelInvitation" },
      context,
    });

    await expect(runtime.getInvitationForRead(invitationId)).resolves.toMatchObject({
      invitation_id: invitationId,
      account_display_name: "Card Vault",
      status: "cancelled",
    });
  });
});
