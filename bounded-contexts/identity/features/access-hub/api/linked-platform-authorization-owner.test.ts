import { expect, it } from "vitest";
import { createId } from "@chase-sets/primitives/typed-ids";
import { identityFixture } from "./listing-authority-test-support";
import { createLinkedPlatformAuthorizationStore } from "./linked-platform-authorizations";

it("requires authentic user and account history before granting an OAuth credential", async () => {
  const f = await identityFixture();
  const userId = createId("usr");
  const accountId = createId("acc");
  const store = createLinkedPlatformAuthorizationStore(
    {
      query: async () => {
        throw new Error("Projection access prohibited");
      },
    },
    f.authority,
  );
  const params = {
    authorizationId: "synthetic-oauth-owner",
    platformProfileUrl: "https://synthetic.example.test",
    clientId: "synthetic-client",
    userId,
    accountId,
    scopes: ["checkout:write"],
    accessTokenHash: "synthetic-access-hash",
    accessTokenExpiresAt: "2099-01-01T00:00:00.000Z",
    grantedAt: new Date().toISOString(),
  };
  await expect(store.grant(params)).rejects.toThrow("Credential owner history is missing or mismatched.");
  expect(await f.credentials.readDelegation(params.authorizationId)).toBeNull();
  await f.accounts.commandHandler({
    streamId: `identity.account-${accountId}`,
    context: f.audit,
    command: { type: "CreateAccount", accountId, name: "Synthetic OAuth account", accountType: "personal" },
  });
  await expect(store.grant(params)).rejects.toThrow("Credential owner history is missing or mismatched.");
  await f.users.commandHandler({
    streamId: `identity.user-${userId}`,
    context: f.audit,
    command: { type: "CreateUser", userId, displayName: "Synthetic OAuth user", primaryEmail: "oauth@example.test" },
  });
  await expect(store.grant(params)).resolves.toMatchObject({
    user_id: userId,
    account_id: accountId,
    status: "active",
  });
  const receipt = await f.credentials.readDelegation(params.authorizationId);
  expect(receipt?.authority_revision).toBeTruthy();

  const foreignUserId = createId("usr");
  await f.users.commandHandler({
    streamId: `identity.user-${foreignUserId}`,
    context: { ...f.audit, tenantId: "tnt_synthetic_foreign" },
    command: {
      type: "CreateUser",
      userId: foreignUserId,
      displayName: "Foreign user",
      primaryEmail: "foreign@example.test",
    },
  });
  await expect(
    store.grant({ ...params, authorizationId: "synthetic-mismatched-owner", userId: foreignUserId }),
  ).rejects.toThrow("Credential owner history is missing or mismatched.");
  expect(await f.credentials.readDelegation("synthetic-mismatched-owner")).toBeNull();
});
