import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { AppendToStreamInput } from "@chase-sets/event-core/storage";
import { createTestEventStoreContext, createInternalSystemTestActor } from "@chase-sets/bounded-context-runtime/test-support";
import { buildIdentityApi, type IdentityApiEnv } from "../../../api";
import { createInMemoryEventStore } from "../../../tests/in-memory-event-store";
import { createInvitationRuntime } from "./runtime";
import { createMembershipRuntime } from "../../memberships/api/runtime";
import type { IdentityServices } from "../../../support/runtime-support/services";
import { invitationEmailFingerprint, type InvitationAcceptanceOperation } from "./acceptance-operation";

export const acceptanceContext = createTestEventStoreContext(createInternalSystemTestActor({ userId: "usr_recipient", accountId: "acc_invited" }));
export const acceptanceOperation: InvitationAcceptanceOperation = {
  version: 1, attemptId: "01c9f50d-cb3e-42ac-a0a8-8b5f887a01ea", invitationId: "ivt_invited",
  accountId: "acc_invited", userId: "usr_recipient", membershipId: "mbr_reserved", roleKey: "viewer",
  emailFingerprint: invitationEmailFingerprint("recipient@example.com"), bindingDigest: "b".repeat(64),
};

export async function seedAcceptance(store: EventStore) {
  const expiresAt = new Date(Date.now() + 86400_000).toISOString();
  const participants: readonly Pick<AppendToStreamInput, "streamId" | "events">[] = [
    { streamId: "identity.account-acc_invited", events: [{ eventType: "identity.account.created", payload: { accountId: "acc_invited", accountType: "business", name: "Invited", displayName: "Invited" } }] },
    { streamId: "identity.user-usr_recipient", events: [{ eventType: "identity.user.created", payload: { userId: "usr_recipient", displayName: "Recipient", primaryEmail: "recipient@example.com", primaryContactMethod: { contactMethodId: "ctm_recipient", type: "email", value: "recipient@example.com", verifiedAt: null } } }] },
    { streamId: "identity.invitation-ivt_invited", events: [
      { eventType: "identity.invitation.created", payload: { invitationId: "ivt_invited", accountId: "acc_invited", roleKey: "viewer", email: "recipient@example.com", expiresAt } },
      { eventType: "identity.invitation.acceptance-token-issued", payload: { tokenHash: "existing-store-token-hash", expiresAt } },
    ] },
  ];
  for (const input of participants) await store.appendToStream({ ...input, expectedVersion: "no_stream", context: acceptanceContext });
}

function servicesFor(store: EventStore): IdentityServices {
  const deps = { eventStore: store, db: { query: async () => ({ rows: [] }) }, checkpointStore: { loadCheckpoint: async () => "0", saveCheckpoint: async () => undefined } };
  return { eventStore: store, invitations: createInvitationRuntime(deps), memberships: createMembershipRuntime(deps), users: { getUser: async () => null } } as unknown as IdentityServices;
}

async function accept(store: EventStore, operation = acceptanceOperation) {
  const app = new Hono<IdentityApiEnv>();
  app.use("*", async (c, next) => { c.set("context", acceptanceContext); await next(); });
  app.route("/", buildIdentityApi(servicesFor(store)));
  return app.request("/internal/auth/invitations/ivt_invited/accept", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId: operation.userId, acceptanceTokenHash: "existing-store-token-hash", operation }),
  });
}

describe("invitation-acceptance-identity-atomicity", () => {
  it("uses the attempt reservation and exact replay without a second Membership", async () => {
    const store = createInMemoryEventStore();
    await seedAcceptance(store);
    const first = await accept(store);
    expect(first.status).toBe(200);
    expect((await first.json()).membershipId).toBe(acceptanceOperation.membershipId);
    const again = await accept(store);
    expect(again.status).toBe(200);
    expect((await again.json()).membershipId).toBe(acceptanceOperation.membershipId);
    expect(store.streamIdsWithPrefix("identity.membership-")).toEqual(["identity.membership-mbr_reserved"]);
    expect(await store.readStream({ streamId: "identity.invitation-acceptance-" + acceptanceOperation.attemptId })).toHaveLength(1);
  });
});
