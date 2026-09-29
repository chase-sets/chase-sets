import { describe, expect, it } from "vitest";
import { identityFixture } from "./listing-authority-test-support";
import { createFoundersCohortRuntime } from "../../founders-cohort/api/runtime";
import { createId } from "@chase-sets/primitives/typed-ids";
import { IdentityAuthorityMutationPendingError } from "./listing-authority";

describe("Identity canonical writer inventory", () => {
  for (const name of [
    "user-profile",
    "contact",
    "auth-enable",
    "auth-disable",
    "password",
    "passkey",
    "social-link",
    "account-profile",
    "badge-remove",
    "founder-claim",
    "key-use",
  ] as const)
    it(`${name} participates even without the route adapter`, async () => {
      const f = await identityFixture();
      const user = (command: Parameters<typeof f.users.commandHandler>[0]["command"]) =>
        f.users.commandHandler({ streamId: `identity.user-${f.userId}`, context: f.audit, command });
      const account = (command: Parameters<typeof f.accounts.commandHandler>[0]["command"]) =>
        f.accounts.commandHandler({ streamId: `identity.account-${f.accountId}`, context: f.audit, command });
      if (name === "auth-disable") await user({ type: "EnableAuthMethod", authMethod: "magic-link" });
      if (name === "badge-remove") await account({ type: "AssignAccountBadge", badgeKey: "trusted-seller" });
      if (name === "founder-claim")
        await account({
          type: "OpenFoundersWindow",
          betaAccessStartedAt: new Date().toISOString(),
          foundersWindowEndsAt: "2099-01-01T00:00:00.000Z",
          recipientEmail: "synthetic@example.test",
        });
      const operation = await f.fence.open(f.input, f.context);
      const grant = await f.source.prepare(operation, f.context);
      const terminal = await f.fence.prepareCommit(operation, [grant], {});
      if (name === "user-profile") await user({ type: "UpdateUserProfile", displayName: "Synthetic changed user" });
      if (name === "contact")
        await user({
          type: "AddContactMethod",
          contactMethodId: "synthetic-phone",
          contactMethodType: "phone",
          value: "+15555550101",
        });
      if (name === "auth-enable") await user({ type: "EnableAuthMethod", authMethod: "magic-link" });
      if (name === "auth-disable") await user({ type: "DisableAuthMethod", authMethod: "magic-link" });
      if (name === "password") await user({ type: "AttachPasswordCredential", credentialId: "synthetic-password" });
      if (name === "passkey") await user({ type: "RegisterPasskeyCredential", credentialId: "synthetic-passkey" });
      if (name === "social-link")
        await user({
          type: "LinkSocialLogin",
          providerName: "google",
          providerSubject: "synthetic-social-subject",
          email: "synthetic@example.test",
          linkedAt: new Date().toISOString(),
        });
      if (name === "account-profile")
        await account({ type: "UpdateAccountProfile", name: "Synthetic changed account" });
      if (name === "badge-remove") await account({ type: "RemoveAccountBadge", badgeKey: "trusted-seller" });
      if (name === "key-use")
        await f.apiKeys.commandHandler({
          streamId: `identity.api-key-${f.keyId}`,
          context: f.audit,
          command: { type: "RecordApiKeyUse", usedAt: new Date().toISOString() },
        });
      if (name === "founder-claim") {
        const founders = createFoundersCohortRuntime(
          {
            eventStore: f.authority.eventStore,
            db: {
              query: async () => {
                throw new Error("No projections");
              },
            },
            checkpointStore: {} as never,
          },
          f.accounts,
        );
        await founders.claimFounderNumber(
          {
            accountId: f.accountId,
            qualifyingActType: "listing-created",
            qualifyingActId: "synthetic-listing",
            claimedAt: new Date().toISOString(),
          },
          f.audit,
        );
        expect((await f.accounts.getAccountState(f.accountId))?.founderNumber).toBe(1);
      }
      expect((await f.fence.inspect(operation)).status).toBe("aborted");
      await expect(f.consumerStore.appendToStreams!(terminal)).rejects.toThrow();
    });

  it("a blocked selected membership does not stop an unrelated account's canonical writer", async () => {
    const f = await identityFixture();
    const operation = await f.fence.open(f.input, f.context);
    await f.source.prepare(operation, f.context);
    f.blockInvalidation(true);
    await expect(f.invalidate()).rejects.toBeInstanceOf(IdentityAuthorityMutationPendingError);
    const accountId = createId("acc");
    const created = await f.accounts.commandHandler({
      streamId: `identity.account-${accountId}`,
      context: f.audit,
      command: { type: "CreateAccount", accountId, name: "Synthetic independent account", accountType: "personal" },
    });
    expect(created.state.id).toBe(accountId);
    expect((await f.fence.inspect(operation)).status).toBe("pending");
  });

  it("never stores credential hashes in protocol or owner event journals", async () => {
    const f = await identityFixture();
    const operation = await f.fence.open(f.input, f.context);
    await f.source.prepare(operation, f.context);
    expect(JSON.stringify([...f.memory.streams.values()])).not.toContain(f.secrets.hashSecret("synthetic-secret"));
  });
});
