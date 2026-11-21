import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { identitySeedIds } from "@chase-sets/identity-seed";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { inspectIdentitySeedState } from "./seed";

const legacyInvitationId = "ivt_seed_support_accept";
const legacyTokenHash = "seeded-support-invitation-token";

function acceptedSupportInvitationRows(invitationId: string, tokenHash: string) {
  return [
    {
      event_type: "identity.invitation.created",
      payload: {
        invitationId,
        accountId: "acc_seed_demo_account",
        email: "support@chasesets.test",
        roleKey: "manager",
        expiresAt: "2026-05-01T00:00:00.000Z",
      },
    },
    {
      event_type: "identity.invitation.acceptance-token-issued",
      payload: { tokenHash, expiresAt: "2026-04-01T00:00:00.000Z" },
    },
    {
      event_type: "identity.invitation.accepted",
      payload: { userId: "usr_seed_support_user", acceptedAt: "2026-03-03T12:00:00.000Z" },
    },
  ].map((row, index) => ({ ...row, stream_id: `identity.invitation-${invitationId}`, stream_version: index + 1 }));
}

it("plans the scenario support invitation with legacy acceptance history retained", async () => {
  const streams = new Map([
    [`identity.invitation-${legacyInvitationId}`, acceptedSupportInvitationRows(legacyInvitationId, legacyTokenHash)],
  ]);
  const pool: PgTransactionalPool = {
    async query<Row>(sql: string, values?: readonly unknown[]) {
      expect(sql).toContain("FROM event_store_events");
      return { rows: (streams.get(String(values?.[0])) ?? []) as Row[] };
    },
    async connect() {
      throw new Error("Seed inspection must not open a transaction.");
    },
  };
  const inspect = async () =>
    (await inspectIdentitySeedState(pool, { enabledDataProfiles: ["scenario-seed"] })).find(
      (report) => report.aggregateName === "Invitation" && report.key === "support@chasesets.test",
    );

  const { invitationId } = identitySeedIds.support;
  const streamId = `identity.invitation-${invitationId}`;
  expect(await inspect()).toMatchObject({ streamId, kind: "absent", status: "0/3 steps", eventCount: 0 });

  const digest = createHash("sha256").update(legacyTokenHash).digest("hex");
  streams.set(streamId, acceptedSupportInvitationRows(invitationId, digest));
  expect(await inspect()).toMatchObject({ streamId, kind: "active", status: "3/3 steps", eventCount: 3 });
});
