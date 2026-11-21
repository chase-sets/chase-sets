import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import { createHash } from "node:crypto";
import { listingCommandInput } from "../../../../support/request-support/listing-attempt";
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
          ...listingCommandInput("seller.availability", {
            status: "unavailable",
            accountId: data.accountId,
            idempotencyKey: createHash("sha256")
              .update(JSON.stringify(["negative-balance", event.id, data.accountId]))
              .digest("hex"),
            reasonCategory: "operations",
            availableAgainOn: null,
            availableAgainAt: null,
          }),
          preserveOtherSide: true,
        },
        marketplaceSystemContext(data.accountId),
      );
    },
  };
}
