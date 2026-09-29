import { expect, it, vi } from "vitest";
import { createId } from "@chase-sets/primitives/typed-ids";
import { identityFixture } from "./listing-authority-test-support";
import { upsertApiKeySecret } from "../../api-keys/api/secret-store";

async function scopedFixture() {
  const f = await identityFixture();
  const keyId = createId("key");
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  await f.apiKeys.commandHandler({
    streamId: `identity.api-key-${keyId}`,
    context: f.audit,
    command: {
      type: "CreateApiKey",
      apiKeyId: keyId,
      userId: f.userId,
      name: "Synthetic scoped key",
      keyPrefix: "synthetic-scoped",
      listingScope: {
        accountId: f.accountId,
        membershipId: f.membershipId,
        permissions: ["listings.manage"],
        expiresAt,
      },
    },
  });
  await upsertApiKeySecret(f.authority, {
    apiKeyId: keyId,
    userId: f.userId,
    keyPrefix: "synthetic-scoped",
    secretHash: f.secrets.hashSecret("synthetic-scoped-secret"),
    context: f.audit,
  });
  const principal = await f.authority.authenticateApiKey(
    "synthetic-scoped-secret",
    f.membershipId,
    "2099-01-01T00:00:00.000Z",
  );
  if (!principal) throw new Error("Synthetic scoped authentication failed");
  const context = { ...f.audit, listingAuthorityPrincipal: principal };
  return { ...f, keyId, expiresAt, context };
}

it("bounds reservations by canonical key expiry even if a caller extends the principal deadline", async () => {
  const f = await scopedFixture();
  const context = {
    ...f.context,
    listingAuthorityPrincipal: {
      ...f.context.listingAuthorityPrincipal,
      validBefore: "2099-01-01T00:00:00.000Z",
    },
  };
  const operation = await f.fence.open(f.input, context);
  const grant = await f.source.prepare(operation, context);
  expect(Date.parse(grant.validBefore)).toBeLessThanOrEqual(Date.parse(f.expiresAt));
  const terminal = await f.fence.prepareCommit(operation, [grant], {});
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse(f.expiresAt));
  try {
    await expect(f.consumerStore.appendToStreams!(terminal)).rejects.toThrow();
    expect((await f.source.inspect(operation))?.status).toBe("reserved");
    const later = await f.fence.open({ ...f.input, requestId: "synthetic-expired-key" }, context);
    await expect(f.source.prepare(later, context)).rejects.toThrow("expired");
  } finally {
    clock.mockRestore();
  }
});

it("cannot substitute another authentic membership into a scoped key principal", async () => {
  const f = await scopedFixture();
  const membershipId = createId("mbr");
  await f.memberships.commandHandler({
    streamId: `identity.membership-${membershipId}`,
    context: f.audit,
    command: {
      type: "GrantMembership",
      membershipId,
      accountId: f.accountId,
      userId: f.userId,
      roleKey: "owner",
      assignmentAuthority: { type: "system" },
    },
  });
  const principal = f.context.listingAuthorityPrincipal;
  if (principal.kind !== "user") throw new Error("Expected user");
  const context = { ...f.audit, listingAuthorityPrincipal: { ...principal, membershipId } };
  const operation = await f.fence.open(f.input, context);
  await expect(f.source.prepare(operation, context)).rejects.toThrow("account or membership");
});

it("retains an unknown consumer until ordinary key revocation wins its terminal", async () => {
  const f = await scopedFixture();
  const operation = await f.fence.open(f.input, f.context);
  const grant = await f.source.prepare(operation, f.context);
  const terminal = await f.fence.prepareCommit(operation, [grant], {});
  f.blockInvalidation(true);
  let mutationId = "";
  try {
    await f.apiKeys.commandHandler({
      streamId: `identity.api-key-${f.keyId}`,
      context: f.audit,
      command: { type: "RevokeApiKey" },
    });
    throw new Error("Expected pending revocation");
  } catch (error) {
    expect(error).toMatchObject({ code: "identity_authority_mutation_pending" });
    mutationId = (error as { mutationId: string }).mutationId;
  }
  expect(f.memory.streams.get(`identity.api-key-${f.keyId}`)?.at(-1)?.eventType).toBe("identity.api-key.created");
  expect((await f.source.inspect(operation))?.status).toBe("reserved");
  f.blockInvalidation(false);
  await f.authority.resumeMutation(mutationId, f.audit);
  expect((await f.fence.inspect(operation)).status).toBe("aborted");
  expect(f.memory.streams.get(`identity.api-key-${f.keyId}`)?.at(-1)?.eventType).toBe("identity.api-key.revoked");
  await expect(f.consumerStore.appendToStreams!(terminal)).rejects.toThrow();
});
