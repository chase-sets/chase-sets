import { describe, expect, it, vi } from "vitest";
import { createId } from "@chase-sets/primitives/typed-ids";
import { listingAuthorityConformance } from "@chase-sets/platform-runtime/listing-authority-conformance";
import { IdentityAuthorityMutationPendingError } from "./listing-authority";
import { identityFixture } from "./listing-authority-test-support";

describe("actual Identity with distinct source and consumer stores", () => {
  listingAuthorityConformance(it, identityFixture);
});

describe("Identity authority writers", () => {
  for (const writer of [
    "membership-revoke",
    "role-change",
    "user-suspend",
    "account-suspend",
    "account-close",
    "badge",
    "founder-window",
    "key-revoke",
    "key-rotate",
    "key-secret",
    "key-delete",
    "direct-bulk",
  ] as const)
    it(`${writer} closes authority before the retained final append`, async () => {
      const f = await identityFixture();
      const operation = await f.fence.open(f.input, f.context);
      const grant = await f.source.prepare(operation, f.context);
      const terminal = await f.fence.prepareCommit(operation, [grant], { accepted: true });
      const effects = ["business", "request-success"].map((kind) => ({
        streamId: `marketplace.synthetic-${kind}`,
        expectedVersion: 0 as const,
        context: f.context,
        events: [{ eventType: `marketplace.synthetic-${kind}`, payload: {} }],
      }));
      if (writer === "membership-revoke") await f.invalidate();
      else if (writer === "role-change")
        await f.memberships.commandHandler({
          streamId: `identity.membership-${f.membershipId}`,
          context: f.audit,
          command: { type: "ChangeMembershipRole", roleKey: "viewer", assignmentAuthority: { type: "system" } },
        });
      else if (writer === "user-suspend")
        await f.users.commandHandler({
          streamId: `identity.user-${f.userId}`,
          context: f.audit,
          command: { type: "SuspendUser" },
        });
      else if (writer === "account-suspend" || writer === "account-close")
        await f.accounts.commandHandler({
          streamId: `identity.account-${f.accountId}`,
          context: f.audit,
          command: {
            type: writer === "account-close" ? "CloseAccount" : "SuspendAccount",
            enforcement: {
              version: 1,
              enforcementActionId: createId("enf"),
              reason: "policy-violation",
              reference: null,
            },
          },
        });
      else if (writer === "badge")
        await f.accounts.commandHandler({
          streamId: `identity.account-${f.accountId}`,
          context: f.audit,
          command: { type: "AssignAccountBadge", badgeKey: "trusted-seller" },
        });
      else if (writer === "founder-window")
        await f.accounts.commandHandler({
          streamId: `identity.account-${f.accountId}`,
          context: f.audit,
          command: {
            type: "OpenFoundersWindow",
            betaAccessStartedAt: new Date().toISOString(),
            foundersWindowEndsAt: "2099-01-01T00:00:00.000Z",
            recipientEmail: "synthetic@example.test",
          },
        });
      else if (writer === "key-revoke" || writer === "key-rotate")
        await f.apiKeys.commandHandler({
          streamId: `identity.api-key-${f.keyId}`,
          context: f.audit,
          command:
            writer === "key-revoke" ? { type: "RevokeApiKey" } : { type: "RotateApiKey", keyPrefix: "synthetic-new" },
        });
      else if (writer === "key-secret" || writer === "key-delete")
        await f.authority.mutateCredential({
          mutationId: "synthetic-key-change",
          context: f.audit,
          command:
            writer === "key-delete"
              ? { kind: "api-key-delete", apiKeyId: f.keyId }
              : {
                  kind: "api-key-upsert",
                  apiKeyId: f.keyId,
                  userId: f.userId,
                  keyPrefix: "synthetic",
                  secretHash: f.secrets.hashSecret("synthetic-other-secret"),
                },
        });
      else
        await f.authority.eventStore.appendToStreams!([
          {
            streamId: `identity.membership-${f.membershipId}`,
            context: f.audit,
            expectedVersion: 1,
            events: [{ eventType: "identity.membership.revoked", payload: {} }],
          },
        ]);
      expect((await f.fence.inspect(operation)).status).toBe("aborted");
      await expect(f.consumerStore.appendToStreams!([...terminal, ...effects])).rejects.toThrow();
      for (const effect of effects)
        expect(await f.consumerStore.readStream({ streamId: effect.streamId })).toHaveLength(0);
    });

  it("retains the same pending mutation, rejects new preparation and resumes after restart", async () => {
    const f = await identityFixture();
    const operation = await f.fence.open(f.input, f.context);
    await f.source.prepare(operation, f.context);
    f.blockInvalidation(true);
    const pending = await f.invalidate().catch((error: unknown) => error);
    expect(pending).toBeInstanceOf(IdentityAuthorityMutationPendingError);
    expect((await f.memberships.getMembershipState(f.membershipId))?.status).toBe("active");
    const next = await f.fence.open({ ...f.input, requestId: "synthetic-closed" }, f.context);
    await expect(f.source.prepare(next, f.context)).rejects.toThrow(/pending invalidation/);
    await expect(f.source.settle(operation)).rejects.toThrow();
    f.restart();
    f.blockInvalidation(false);
    await f.authority.resumeMutation((pending as IdentityAuthorityMutationPendingError).mutationId, f.audit);
    expect((await f.memberships.getMembershipState(f.membershipId))?.status).toBe("revoked");
    expect((await f.fence.inspect(operation)).status).toBe("aborted");
  });

  it("does not rotate a credential twice after a lost persistence reply", async () => {
    const f = await identityFixture();
    const operation = await f.fence.open(f.input, f.context);
    await f.source.prepare(operation, f.context);
    const apply = f.credentials.apply;
    const fault = vi.spyOn(f.credentials, "apply").mockImplementationOnce(async (id) => {
      await apply(id);
      throw new Error("Synthetic lost SQL commit reply");
    });
    const mutation = {
      mutationId: "synthetic-lost-credential",
      context: f.audit,
      command: {
        kind: "api-key-upsert" as const,
        apiKeyId: f.keyId,
        userId: f.userId,
        keyPrefix: "synthetic",
        secretHash: f.secrets.hashSecret("synthetic-rotated"),
      },
    };
    await expect(f.authority.mutateCredential(mutation)).rejects.toMatchObject({ mutationId: mutation.mutationId });
    fault.mockRestore();
    f.restart();
    await f.authority.resumeCredential(mutation.mutationId);
    await f.authority.mutateCredential({
      ...mutation,
      mutationId: "synthetic-next-credential",
      command: { ...mutation.command, secretHash: f.secrets.hashSecret("synthetic-newest") },
    });
    await f.authority.resumeCredential(mutation.mutationId);
    expect((await f.credentials.readApiKey(f.keyId))?.authority_revision).toBe("synthetic-next-credential");
  });

  for (const field of ["membershipId", "userId", "accountId", "tenantId"] as const)
    it(`audit collision cannot substitute ${field}`, async () => {
      const f = await identityFixture();
      const operation = await f.fence.open(f.input, f.context);
      await f.source.prepare(operation, f.context);
      const principal = { ...f.context.listingAuthorityPrincipal!, [field]: "synthetic-counterfeit" };
      const context = { ...f.context, listingAuthorityPrincipal: principal };
      await expect(f.source.prepare(operation, context)).rejects.toThrow();
      expect(await f.source.prepare(operation, f.context)).toEqual(await f.source.inspect(operation));
    });
});
