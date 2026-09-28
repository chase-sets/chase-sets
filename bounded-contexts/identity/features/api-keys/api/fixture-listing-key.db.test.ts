import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { createId } from "@chase-sets/primitives/typed-ids";
import { identitySeedIds } from "@chase-sets/identity-seed";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { createIdentityServices } from "../../../support/runtime-support/services";
import { identitySchemaSql } from "../../../support/runtime-support/schema";
import { createIdentityListingPolicy } from "../../access-hub/api/listing-authority-policy";
import { createIdentityCredentialStore } from "../../access-hub/api/listing-credentials";
import { IdentityAuthorityMutationPendingError } from "../../access-hub/api/listing-authority";
import { withFixtureListingApiKey } from "./fixture-listing-key";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required for fixture API key DB proof.");

describe("Identity fixture Listing API key", () => {
  let pools: Readonly<Record<"identity", PgTransactionalPool>>;
  let services: ReturnType<typeof createIdentityServices>;
  const fixture = identitySeedIds.demo;
  const context: EventStoreContext = {
    tenantId: "tnt_identity",
    audit: {
      performedByUserId: fixture.userId,
      forAccountId: fixture.accountId,
    },
  };
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseUrl, ["identity"], "identity_fixture_listing_key");
    await ensureMultiContextTestDatabases(databaseUrl, urls);
    pools = createMultiContextTestPools(urls);
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await pools.identity.query(identitySchemaSql);
    services = createIdentityServices(pools.identity);
    await services.accounts.commandHandler({
      streamId: `identity.account-${fixture.accountId}`,
      context,
      command: { type: "CreateAccount", accountId: fixture.accountId, name: "Demo fixture", accountType: "personal" },
    });
    await services.users.commandHandler({
      streamId: `identity.user-${fixture.userId}`,
      context,
      command: {
        type: "CreateUser",
        userId: fixture.userId,
        displayName: "Demo fixture",
        primaryEmail: "demo@example.test",
      },
    });
    await services.memberships.commandHandler({
      streamId: `identity.membership-${fixture.membershipId}`,
      context,
      command: { type: "GrantMembership", ...fixture, roleKey: "owner", assignmentAuthority: { type: "system" } },
    });
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    if (pools) await closeMultiContextTestPools(pools);
  });

  it("preserves both the seed failure and a pending revocation identity", async () => {
    const original = services.apiKeys.commandHandler;
    const pending = new IdentityAuthorityMutationPendingError("synthetic-retained-revocation", new Error("offline"));
    vi.spyOn(services.apiKeys, "commandHandler").mockImplementation((input) => {
      if (input.command.type === "RevokeApiKey") return Promise.reject(pending);
      return original(input);
    });
    const failure = new Error("Synthetic retained seed outcome");
    const run = withFixtureListingApiKey(
      services,
      {
        accountId: fixture.accountId,
        seedRunStartedAt: new Date().toISOString(),
        options: { environmentName: "test", enabledDataProfiles: ["scenario-seed"] },
      },
      async () => {
        throw failure;
      },
    );
    await expect(run).rejects.toMatchObject({ errors: [failure, pending] });
  });

  it.each([false, true])("mints a real bounded key and revokes it when callback failure is %s", async (fail) => {
    const start = new Date(Date.now() - 1000).toISOString();
    let apiKeyId = "";
    let handedSecret = "";
    const run = withFixtureListingApiKey(
      services,
      {
        accountId: fixture.accountId,
        seedRunStartedAt: start,
        options: { environmentName: "test", enabledDataProfiles: ["scenario-seed"] },
      },
      async (key) => {
        apiKeyId = key.apiKeyId;
        handedSecret = key.secret;
        expect(Date.parse(key.expiresAt)).toBeLessThanOrEqual(Date.parse(start) + 3_600_000);
        const policy = createIdentityListingPolicy(services.eventStore!);
        const aggregate = await policy.apiKey(key.apiKeyId);
        expect(aggregate.state).toMatchObject({
          status: "active",
          userId: fixture.userId,
          listingScope: {
            accountId: fixture.accountId,
            membershipId: fixture.membershipId,
            permissions: ["listings.manage"],
            expiresAt: key.expiresAt,
          },
        });
        const credentials = createIdentityCredentialStore(pools.identity);
        const credential = await credentials.readApiKey(key.apiKeyId);
        expect(credential?.authority_revision).toBeTruthy();
        expect(credential?.secret_hash === services.auth.hashSecret(key.secret)).toBe(true);
        const mutation = await credentials.readMutation(credential!.authority_revision!);
        expect(mutation?.applied).toBe(true);
        expect(await credentials.pending(10)).not.toContain(credential!.authority_revision!);
        const authenticate = () =>
          services.listingAuthority.authenticateApiKey(key.secret, fixture.membershipId, "2099-01-01T00:00:00.000Z");
        await expect(authenticate()).resolves.toMatchObject({
          accountId: fixture.accountId,
          validBefore: key.expiresAt,
          authentication: {
            kind: "api-key",
            keyId: key.apiKeyId,
            revision: `${aggregate.revision}:${credential!.authority_revision}`,
          },
        });
        // The unscoped resolve endpoint must never promote this key to the full owner role.
        await expect(
          services.apiKeys.commandHandler({
            streamId: `identity.api-key-${key.apiKeyId}`,
            context,
            command: { type: "RecordApiKeyUse", usedAt: new Date().toISOString() },
          }),
        ).rejects.toThrow("scoped principal resolution");
        const foreignAccountId = createId("acc"),
          foreignMembershipId = createId("mbr");
        await services.accounts.commandHandler({
          streamId: `identity.account-${foreignAccountId}`,
          context,
          command: {
            type: "CreateAccount",
            accountId: foreignAccountId,
            name: "Other account",
            accountType: "personal",
          },
        });
        await services.memberships.commandHandler({
          streamId: `identity.membership-${foreignMembershipId}`,
          context,
          command: {
            type: "GrantMembership",
            accountId: foreignAccountId,
            userId: fixture.userId,
            membershipId: foreignMembershipId,
            roleKey: "owner",
            assignmentAuthority: { type: "system" },
          },
        });
        await expect(
          services.listingAuthority.authenticateApiKey(key.secret, foreignMembershipId, key.expiresAt),
        ).resolves.toBeNull();
        const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse(key.expiresAt));
        try {
          await expect(authenticate()).resolves.toBeNull();
        } finally {
          clock.mockRestore();
        }
        if (fail) throw new Error("Synthetic seed failure");
      },
    );
    if (fail) await expect(run).rejects.toThrow("Synthetic seed failure");
    else await run;
    const history = await readCompleteStream(services.eventStore!, { streamId: `identity.api-key-${apiKeyId}` });
    expect(history.map((event) => event.eventType)).toEqual(["identity.api-key.created", "identity.api-key.revoked"]);
    expect(await createIdentityCredentialStore(pools.identity).readApiKey(apiKeyId)).toBeNull();
    await expect(
      services.listingAuthority.authenticateApiKey(handedSecret, fixture.membershipId, "2099-01-01T00:00:00.000Z"),
    ).resolves.toBeNull();
    const durable = await pools.identity.query<{ value: string }>(`SELECT payload::text AS value FROM event_store_events
      UNION ALL SELECT command::text FROM identity_listing_credential_mutations`);
    expect(durable.rows.some((row) => row.value.includes(handedSecret))).toBe(false);
  });
});
