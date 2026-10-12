import type { ResolvedActor } from "@chase-sets/auth-context";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import { ZERO_GLOBAL_POSITION } from "@chase-sets/event-core/storage";
import { createId } from "@chase-sets/primitives/typed-ids";
import { buildIdentityApi, createBootstrapContext } from "../../../../../identity/api";
import { createAccountRuntime } from "../../../../../identity/features/accounts/api/runtime";
import { createUserRuntime } from "../../../../../identity/features/users/api/runtime";
import { createMembershipRuntime } from "../../../../../identity/features/memberships/api/runtime";
import type { IdentityServices } from "../../../../../identity/support/runtime-support/services";

export async function mintEvidenceActorThroughIdentity(): Promise<ResolvedActor> {
  const { eventStore } = createInMemoryEventStore();
  const deps = {
    eventStore,
    db: {
      query: async () => {
        throw new Error("Identity mint must not read a projection.");
      },
    } as never,
    checkpointStore: { loadCheckpoint: async () => ZERO_GLOBAL_POSITION, saveCheckpoint: async () => {} },
  };
  const accounts = createAccountRuntime(deps);
  const users = createUserRuntime(deps);
  const memberships = createMembershipRuntime(deps);
  const app = buildIdentityApi({ accounts, users, memberships, eventStore } as IdentityServices);
  async function post(path: string, body: Record<string, string>): Promise<Record<string, string>> {
    const response = await app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (response.status !== 201) throw new Error(`Identity mint failed: ${response.status}`);
    return response.json();
  }
  const input = { email: "support-evidence@example.test", displayName: "Support evidence actor" };
  const { accountId } = await post("/internal/auth/guest-accounts", input);
  const { userId } = await post("/internal/auth/users", input);
  const { membershipId } = await post(`/internal/auth/guest-accounts/${accountId}/claim`, { userId });
  const membership = await memberships.getMembershipState(membershipId);
  if (!membership || membership.accountId !== accountId || membership.userId !== userId)
    throw new Error("Identity membership did not persist the minted principals.");
  return {
    sessionId: createId("ses"),
    tenantId: createBootstrapContext().tenantId,
    userId,
    accountId,
    membershipId,
    roleKey: "owner",
    permissions: ["support.view", "support.manage"],
  };
}
