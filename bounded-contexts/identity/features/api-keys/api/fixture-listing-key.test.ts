import { afterEach, expect, it, vi } from "vitest";
import { identitySeedIds } from "@chase-sets/identity-seed";
import { identityFixture } from "../../access-hub/api/listing-authority-test-support";
import { withFixtureListingApiKey } from "./fixture-listing-key";

afterEach(() => vi.unstubAllEnvs());

it.each(["production", "staging", " Production ", "STAGING", undefined])(
  "refuses minting in %s before any credential or aggregate write",
  async (environmentName) => {
    const f = await identityFixture();
    const before = structuredClone([...f.memory.streams]);
    const use = vi.fn();
    await expect(
      withFixtureListingApiKey(
        { ...f, listingAuthority: f.authority, auth: f.secrets, eventStore: f.authority.eventStore },
        {
          accountId: identitySeedIds.demo.accountId,
          seedRunStartedAt: new Date().toISOString(),
          options: { environmentName, enabledDataProfiles: ["scenario-seed"] },
        },
        use,
      ),
    ).rejects.toThrow("non-production scenario-seed");
    expect(use).not.toHaveBeenCalled();
    expect([...f.memory.streams]).toEqual(before);
  },
);

it.each(["production", "staging"])("refuses a conflicting process environment %s", async (environment) => {
  vi.stubEnv("DEPLOYMENT_ENVIRONMENT", environment);
  const f = await identityFixture();
  await expect(
    withFixtureListingApiKey(
      { ...f, listingAuthority: f.authority, auth: f.secrets, eventStore: f.authority.eventStore },
      {
        accountId: identitySeedIds.demo.accountId,
        seedRunStartedAt: new Date().toISOString(),
        options: { environmentName: "test", enabledDataProfiles: ["scenario-seed"] },
      },
      vi.fn(),
    ),
  ).rejects.toThrow("non-production scenario-seed");
});

it("requires an explicit profile, current run start and authentic seeded history", async () => {
  const f = await identityFixture();
  const services = { ...f, listingAuthority: f.authority, auth: f.secrets, eventStore: f.authority.eventStore };
  const input = {
    accountId: identitySeedIds.demo.accountId,
    seedRunStartedAt: new Date().toISOString(),
    options: { environmentName: "test", enabledDataProfiles: ["scenario-seed"] as const },
  };
  const use = vi.fn();
  await expect(
    withFixtureListingApiKey(services, { ...input, options: { ...input.options, enabledDataProfiles: [] } }, use),
  ).rejects.toThrow("scenario-seed");
  for (const seedRunStartedAt of [
    "invalid",
    new Date(Date.now() + 60_000).toISOString(),
    new Date(Date.now() - 3_600_000).toISOString(),
  ])
    await expect(withFixtureListingApiKey(services, { ...input, seedRunStartedAt }, use)).rejects.toThrow(
      "current seed-run start",
    );
  await expect(withFixtureListingApiKey(services, { ...input, accountId: f.accountId }, use)).rejects.toThrow(
    "seeded Identity account",
  );
  await expect(withFixtureListingApiKey(services, input, use)).rejects.toThrow("owner history");
  expect(use).not.toHaveBeenCalled();
});
