import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { AccountId, TenantId, UserId } from "@chase-sets/primitives/typed-ids";
import type { MarketplaceListingServices } from "../../api/runtime";

const MARKETPLACE_SYSTEM_TENANT_ID = "tnt_marketplace_system" as TenantId;
const MARKETPLACE_SYSTEM_USER_ID = "usr_marketplace_system" as UserId;

function marketplaceSystemContext(accountId: string): EventStoreContext {
  return {
    tenantId: MARKETPLACE_SYSTEM_TENANT_ID,
    audit: {
      performedByUserId: MARKETPLACE_SYSTEM_USER_ID,
      forAccountId: accountId as AccountId,
    },
  };
}

export function buildMarketplaceSettlementNegativeBalanceProjectionHandlers(
  listings: Pick<MarketplaceListingServices, "disableSellerListingAvailability">,
): ProjectorHandlerMap {
  return {
    "settlement.wallet.negative-balance-collections-opened": async (event) => {
      const data = event.data as {
        accountId: string;
      };

      await listings.disableSellerListingAvailability(
        {
          accountId: data.accountId,
          reasonCategory: "operations",
          availableAgainOn: null,
          availableAgainAt: null,
        },
        marketplaceSystemContext(data.accountId),
      );
    },
  };
}
