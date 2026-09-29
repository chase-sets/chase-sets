import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { TenantId, UserId, AccountId } from "@chase-sets/primitives/typed-ids";
import { createListingRequestPrincipalResolver } from "../../access-hub/api/listing-request-principal";
import { withFixtureListingApiKey } from "./fixture-listing-key";

export function createFixtureListingSeedContext(services: Parameters<typeof withFixtureListingApiKey>[0]) {
  const resolve = createListingRequestPrincipalResolver(services.listingAuthority, async () => null);
  return async (
    input: Parameters<typeof withFixtureListingApiKey>[1],
    use: (context: EventStoreContext) => Promise<void>,
  ): Promise<void> =>
    withFixtureListingApiKey(services, input, async (key) => {
      const principal = await resolve(
        new Request("https://fixture.invalid/listings", {
          headers: { authorization: `ApiKey ${key.secret}` },
        }),
        { membershipId: key.membershipId, validBefore: key.expiresAt },
      );
      if (!principal || principal.accountId !== input.accountId)
        throw new Error("Fixture Listing request authentication failed.");
      await use({
        tenantId: principal.tenantId as TenantId,
        audit: { performedByUserId: principal.userId as UserId, forAccountId: principal.accountId as AccountId },
        listingAuthorityPrincipal: principal,
      });
    });
}
