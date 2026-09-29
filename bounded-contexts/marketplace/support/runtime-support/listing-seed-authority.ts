import type { BcSeedOptions } from "@chase-sets/bounded-context-module";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { TenantId, UserId, AccountId } from "@chase-sets/primitives/typed-ids";
import type {
  ListingAuthorityOperation,
  ListingAuthorityParticipantPort,
  ListingAuthorityReservation,
} from "@chase-sets/event-core/listing-authority";
import type { CatalogListingAuthorityFacts } from "@chase-sets/product-measures";
import type { ListingInventoryAuthority, ListingTargetAuthority } from "../../features/listings/api/target-contracts";
import type { createMarketplaceListingAuthority } from "../../features/listings/api/listing-authority";
import { createFeeQuoteFingerprint } from "./fee-quotes";

export type MarketplaceListingSeedPorts = Readonly<{
  withContext(
    input: Readonly<{ accountId: string; seedRunStartedAt: string; options: BcSeedOptions }>,
    use: (context: EventStoreContext) => Promise<void>,
  ): Promise<void>;
  identity: ListingAuthorityParticipantPort;
  inventory: ListingAuthorityParticipantPort;
  catalog: ListingAuthorityParticipantPort;
  fee: ListingAuthorityParticipantPort;
  prepareIdentity(
    operation: ListingAuthorityOperation,
    context: EventStoreContext,
  ): Promise<readonly ListingAuthorityReservation[]>;
  catalogFacts(operation: ListingAuthorityOperation): Promise<CatalogListingAuthorityFacts>;
}>;

/** Fixture-only composition of real owners; ordinary granting consumers remain unmounted. */
export function createMarketplaceListingSeedAuthority(
  ports: MarketplaceListingSeedPorts,
  marketplace: ReturnType<typeof createMarketplaceListingAuthority>,
): ListingTargetAuthority {
  function context(operation: ListingAuthorityOperation): EventStoreContext {
    if (operation.principal?.kind !== "user" || operation.principal.authentication.kind !== "api-key")
      throw new Error("Listing seed requires its original authenticated API key.");
    return {
      tenantId: operation.tenantId as TenantId,
      audit: {
        forAccountId: operation.accountId as AccountId,
        performedByUserId: operation.principal.userId as UserId,
      },
      listingAuthorityPrincipal: operation.principal,
    };
  }
  const unavailable = async (): Promise<never> => {
    throw new Error("Listing seed does not admit price decisions, channel activation or resume.");
  };
  return {
    participants: [
      ports.identity,
      ports.inventory,
      ports.catalog,
      ports.fee,
      marketplace.readiness,
      marketplace.commitment,
    ],
    resolveActor: async ({ principal }) => {
      if (principal.kind !== "user" || principal.authentication.kind !== "api-key")
        throw new Error("Listing seed requires an authenticated API key.");
      return { kind: principal.kind, userId: principal.userId };
    },
    authorizeManage: async (_input, original, operation) => ({
      value: true,
      reservations: await ports.prepareIdentity(operation, original),
    }),
    readInventory: async (_input, operation) => {
      const grant = await ports.inventory.prepare(operation, context(operation));
      return [{ value: grant.value as unknown as ListingInventoryAuthority, reservations: [grant] }];
    },
    readCatalogProduct: async (operation, original) => {
      const reservation = await ports.catalog.prepare(operation, original);
      return { value: await ports.catalogFacts(operation), reservations: [reservation] };
    },
    verifyNativeFeeQuote: async ({ quote }, operation) => {
      const grant = await ports.fee.prepare(operation, context(operation));
      const terms = grant.value.terms as unknown as {
        basisAmount: string;
        marketplaceSalesFeeUnitAmount: string;
        sellerNetUnitAmount: string;
        shippingAllowancePercentageBps: number;
        scheduleId: string | null;
        agreementId: string | null;
      };
      const fingerprint = createFeeQuoteFingerprint({
        basis_amount: terms.basisAmount,
        marketplace_sales_fee_unit_amount: terms.marketplaceSalesFeeUnitAmount,
        seller_net_unit_amount: terms.sellerNetUnitAmount,
        shipping_allowance_percentage_bps: terms.shippingAllowancePercentageBps,
        schedule_id: terms.scheduleId,
        agreement_id: terms.agreementId,
      });
      return { value: fingerprint === quote.fee_quote_fingerprint, reservations: [grant] };
    },
    readNativeReadiness: async (_input, operation) => [await marketplace.readReadiness(operation, context(operation))],
    resolveConnection: unavailable,
    resolveAllocation: unavailable,
    verifyDecision: unavailable,
    authorizeResume: unavailable,
  };
}
