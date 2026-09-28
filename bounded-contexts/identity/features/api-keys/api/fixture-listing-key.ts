import type { BcSeedOptions } from "@chase-sets/bounded-context-module";
import { identitySeedIds } from "@chase-sets/identity-seed";
import { createId } from "@chase-sets/primitives/typed-ids";
import type { IdentityServices } from "../../../support/runtime-support/services";
import { createIdentityListingPolicy } from "../../access-hub/api/listing-authority-policy";
import { ROLE_PERMISSIONS } from "../../memberships/read-model/constants";
import { deleteApiKeySecret, upsertApiKeySecret } from "./secret-store";

export type FixtureListingApiKey = Readonly<{
  apiKeyId: string;
  secret: string;
  accountId: string;
  membershipId: string;
  expiresAt: string;
}>;

/** The callback owns only an in-process secret, never a fabricated principal. */
export async function withFixtureListingApiKey(
  services: Pick<IdentityServices, "apiKeys" | "listingAuthority" | "eventStore" | "auth">,
  input: Readonly<{ accountId: string; seedRunStartedAt: string; options: BcSeedOptions }>,
  use: (key: FixtureListingApiKey) => Promise<void>,
): Promise<void> {
  const environment = input.options.environmentName?.trim().toLowerCase();
  const processEnvironment = process.env.DEPLOYMENT_ENVIRONMENT?.trim().toLowerCase();
  if (
    !environment ||
    environment === "production" ||
    environment === "staging" ||
    processEnvironment === "production" ||
    processEnvironment === "staging" ||
    !input.options.enabledDataProfiles.includes("scenario-seed")
  )
    throw new Error("Fixture Listing API keys require a non-production scenario-seed profile.");
  const start = Date.parse(input.seedRunStartedAt);
  const now = Date.now();
  const deadline = start + 60 * 60 * 1000;
  if (!Number.isFinite(start) || start > now || !(now < deadline))
    throw new Error("Fixture Listing API keys require a current seed-run start.");
  const fixture = Object.values(identitySeedIds).find(
    (entry) => "accountId" in entry && entry.accountId === input.accountId,
  );
  if (!fixture || !("membershipId" in fixture) || !services.eventStore)
    throw new Error("Fixture Listing API keys require a seeded Identity account.");
  const policy = createIdentityListingPolicy(services.eventStore);
  const [account, user, membership] = await Promise.all([
    policy.account(fixture.accountId),
    policy.user(fixture.userId),
    policy.membership(fixture.membershipId),
  ]);
  const permissions: readonly string[] = membership.state.roleKey ? ROLE_PERMISSIONS[membership.state.roleKey] : [];
  if (
    account.tenantId !== "tnt_identity" ||
    user.tenantId !== account.tenantId ||
    membership.tenantId !== account.tenantId ||
    account.state.id !== fixture.accountId ||
    user.state.id !== fixture.userId ||
    membership.state.id !== fixture.membershipId ||
    membership.state.accountId !== fixture.accountId ||
    membership.state.userId !== fixture.userId ||
    account.state.status !== "active" ||
    user.state.status !== "active" ||
    membership.state.status !== "active" ||
    !membership.state.roleKey ||
    !permissions.includes("listings.manage")
  )
    throw new Error("Fixture Listing API key owner history is missing, inactive or mismatched.");
  const context = await services.listingAuthority.credentialContext(fixture.userId, fixture.accountId);
  const apiKeyId = createId("key");
  const secret = services.auth.issueOpaqueToken("key");
  const keyPrefix = secret.slice(0, 12);
  const expiresAt = new Date(deadline).toISOString();
  await services.apiKeys.commandHandler({
    streamId: `identity.api-key-${apiKeyId}`,
    context,
    command: {
      type: "CreateApiKey",
      apiKeyId,
      userId: fixture.userId,
      name: "Scenario Listing seed",
      keyPrefix,
      listingScope: {
        accountId: fixture.accountId,
        membershipId: fixture.membershipId,
        permissions: ["listings.manage"],
        expiresAt,
      },
    },
  });
  let failed = false;
  let failure: unknown;
  try {
    await upsertApiKeySecret(services.listingAuthority, {
      apiKeyId,
      userId: fixture.userId,
      keyPrefix,
      secretHash: services.auth.hashSecret(secret),
      context,
    });
    if (!(Date.now() < deadline)) throw new Error("Fixture Listing API key expired before handoff.");
    await use({ apiKeyId, secret, accountId: fixture.accountId, membershipId: fixture.membershipId, expiresAt });
  } catch (error) {
    failed = true;
    failure = error;
    throw error;
  } finally {
    // Closure-before-abort stays in the ordinary Identity writer, including unknown outcomes.
    try {
      await services.apiKeys.commandHandler({
        streamId: `identity.api-key-${apiKeyId}`,
        context,
        command: { type: "RevokeApiKey" },
      });
      await deleteApiKeySecret(services.listingAuthority, apiKeyId, context);
    } catch (cleanupError) {
      if (failed) throw new AggregateError([failure, cleanupError], "Fixture Listing work and key revocation failed.");
      throw cleanupError;
    }
  }
}
