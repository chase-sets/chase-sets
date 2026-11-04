import { describe, expect, it } from "vitest";
import type { ResolvedActor } from "@chase-sets/auth-context";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { createPostgresProjectionStore } from "@chase-sets/event-core-postgres";
import type { AccountId, MembershipId, UserId } from "@chase-sets/primitives/typed-ids";
import type { MembershipCommand } from "../domain/domain";
import { createMembershipRuntime } from "./runtime";
import { createIdentityOperatorAuthority } from "./operator-authority";

const context = {
  tenantId: "tnt_identity",
  audit: { performedByUserId: "usr_identity_system", forAccountId: "acc_identity_system" },
} as EventStoreContext;

const projectionPermissions = [
  "projection-operations.operate",
  "projection-operations.rebuild",
  "projection-operations.view",
] as const;

function createFixture() {
  const memory = createInMemoryEventStore();
  const db = { query: async () => ({ rows: [] }) };
  const memberships = createMembershipRuntime({
    eventStore: memory.eventStore,
    checkpointStore: createPostgresProjectionStore({ db }),
    db,
  });
  const run = (membershipId: string, command: MembershipCommand) =>
    memberships.commandHandler({ streamId: `identity.membership-${membershipId}`, command, context });
  const grant = (membershipId: string, roleKey: "platform-admin" | "owner", userId = "usr_op", accountId = "acc_op") =>
    run(membershipId, {
      type: "GrantMembership",
      membershipId: membershipId as MembershipId,
      userId: userId as UserId,
      accountId: accountId as AccountId,
      roleKey,
      assignmentAuthority: roleKey === "platform-admin" ? { type: "platform-bootstrap" } : { type: "system" },
    });
  const actor = (membershipId: string, overrides: Partial<ResolvedActor> = {}): ResolvedActor => ({
    sessionId: "ses_op",
    tenantId: "tnt_identity",
    userId: "usr_op",
    accountId: "acc_op",
    membershipId,
    // A stale projection may still say platform-admin; the authority must ignore it.
    roleKey: "platform-admin",
    permissions: [],
    ...overrides,
  });
  return { authority: createIdentityOperatorAuthority(memberships), run, grant, actor };
}

describe("Identity operator authority", () => {
  it("checks a grant creator against the live Membership aggregate and catalog permission", async () => {
    const { authority, grant, run } = createFixture();
    await grant("mem_creator", "platform-admin");

    await expect(authority.forGrantCreator({ userId: "usr_op", membershipId: "mem_creator" })).resolves.toMatchObject({
      kind: "granted",
      membershipId: "mem_creator",
    });
    await expect(authority.forGrantCreator({ userId: "usr_other", membershipId: "mem_creator" })).resolves.toEqual({
      kind: "denied",
      reason: "membership-mismatch",
    });

    await run("mem_creator", {
      type: "ChangeMembershipRole",
      roleKey: "owner",
      assignmentAuthority: { type: "system" },
    });
    await expect(authority.forGrantCreator({ userId: "usr_op", membershipId: "mem_creator" })).resolves.toEqual({
      kind: "denied",
      reason: "not-platform-admin",
    });
  });

  it("grants an active platform-admin aggregate with the Identity role permissions, including projection operations", async () => {
    const { authority, grant, actor } = createFixture();
    await grant("mem_admin", "platform-admin");

    const decision = await authority(actor("mem_admin"));

    expect(decision).toMatchObject({ kind: "granted", membershipId: "mem_admin", roleKey: "platform-admin" });
    expect(decision.kind === "granted" ? decision.rolePermissions : []).toEqual(
      expect.arrayContaining([...projectionPermissions, "insights-dashboards.view", "catalog.manage"]),
    );
  });

  it("denies an owner aggregate even when the actor's projected role says platform-admin", async () => {
    const { authority, grant, actor } = createFixture();
    await grant("mem_owner", "owner");

    await expect(authority(actor("mem_owner"))).resolves.toEqual({ kind: "denied", reason: "not-platform-admin" });
  });

  it("denies a demoted platform-admin on the next evaluation", async () => {
    const { authority, grant, run, actor } = createFixture();
    await grant("mem_demoted", "platform-admin");
    await expect(authority(actor("mem_demoted"))).resolves.toMatchObject({ kind: "granted" });

    await run("mem_demoted", {
      type: "ChangeMembershipRole",
      roleKey: "owner",
      assignmentAuthority: { type: "system" },
    });

    await expect(authority(actor("mem_demoted"))).resolves.toEqual({ kind: "denied", reason: "not-platform-admin" });
  });

  it("denies an inactive platform-admin membership", async () => {
    const { authority, grant, run, actor } = createFixture();
    await grant("mem_revoked", "platform-admin");
    await run("mem_revoked", { type: "RevokeMembership" });

    await expect(authority.forGrantCreator({ userId: "usr_op", membershipId: "mem_revoked" })).resolves.toEqual({
      kind: "denied",
      reason: "inactive",
    });
    await expect(authority(actor("mem_revoked"))).resolves.toEqual({ kind: "denied", reason: "inactive" });
  });

  it("denies a missing membership aggregate", async () => {
    const { authority, actor } = createFixture();

    await expect(authority.forGrantCreator({ userId: "usr_op", membershipId: "mem_missing" })).resolves.toEqual({
      kind: "denied",
      reason: "authority-unavailable",
    });
    await expect(authority(actor("mem_missing"))).resolves.toEqual({
      kind: "denied",
      reason: "authority-unavailable",
    });
  });

  it.each([
    { label: "user", overrides: { userId: "usr_other" } },
    { label: "account", overrides: { accountId: "acc_other" } },
  ])("denies a platform-admin aggregate whose $label differs from the actor", async ({ overrides }) => {
    const { authority, grant, actor } = createFixture();
    await grant("mem_mismatch", "platform-admin");

    await expect(authority(actor("mem_mismatch", overrides))).resolves.toEqual({
      kind: "denied",
      reason: "membership-mismatch",
    });
  });

  it("denies an actor without a membership", async () => {
    const { authority, actor } = createFixture();

    await expect(authority(actor(""))).resolves.toEqual({ kind: "denied", reason: "no-membership" });
  });
});
