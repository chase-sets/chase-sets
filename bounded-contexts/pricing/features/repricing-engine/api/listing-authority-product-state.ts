import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { ListingAuthoritySource } from "@chase-sets/platform-runtime/listing-authority-participant";
import { toJsonValue } from "@chase-sets/primitives/json";
import { reserveProductRoundCooldown, recordProductRoundDirection } from "../read-model/product-round-state";
import { createPricingAuthoritySqlWriter } from "./listing-authority-sql";
import { pricingAuthorityDigest, pricingAuthorityResources } from "./listing-authority-resources";

export function createPricingProductRoundAuthority(pool: PgTransactionalPool, source: ListingAuthoritySource) {
  type Reserve = Parameters<typeof reserveProductRoundCooldown>[1];
  type Product = Parameters<typeof recordProductRoundDirection>[1];
  type Direction = Parameters<typeof recordProductRoundDirection>[2];
  type Policy = Parameters<typeof recordProductRoundDirection>[3];
  const resources = async (body: { product?: unknown; input?: unknown }) => {
    const product = (body.product ?? body.input) as Product;
    if (!product?.catalogItemId || !product.productId) throw new Error("Pricing Product mutation identity missing.");
    return [pricingAuthorityResources.product(product.catalogItemId, product.productId)];
  };
  const writer = createPricingAuthoritySqlWriter({
    pool,
    source,
    handlers: {
      "reserve-product-cooldown": {
        resources,
        apply: async (db, body) => reserveProductRoundCooldown(db, body.input as unknown as Reserve, String(body.at)),
      },
      "record-product-direction": {
        resources,
        apply: async (db, body) =>
          toJsonValue(
            await recordProductRoundDirection(
              db,
              body.product as unknown as Product,
              body.direction as Direction,
              body.policy as unknown as Policy,
              String(body.at),
            ),
          ),
      },
    },
  });
  return {
    resume: writer.resume,
    async reserve(input: Reserve, at: string, context: EventStoreContext): Promise<boolean> {
      const mutationId = `cooldown-${pricingAuthorityDigest([input.catalogItemId, input.productId, input.triggerEventId])}`;
      const prior = await source.inspectInvalidation(context.tenantId, mutationId);
      return (
        prior
          ? await writer.resume(mutationId, context)
          : await writer.run(mutationId, {
              kind: "reserve-product-cooldown",
              context,
              body: { input: toJsonValue(input), at },
            })
      ) as boolean;
    },
    async record(
      product: Product,
      direction: Direction,
      policy: Policy,
      at: string,
      roundId: string,
      context: EventStoreContext,
    ) {
      const mutationId = `direction-${pricingAuthorityDigest([product.catalogItemId, product.productId, roundId])}`;
      const prior = await source.inspectInvalidation(context.tenantId, mutationId);
      return (
        prior
          ? await writer.resume(mutationId, context)
          : await writer.run(mutationId, {
              kind: "record-product-direction",
              context,
              body: { product: toJsonValue(product), direction, policy: toJsonValue(policy), at, roundId },
            })
      ) as Awaited<ReturnType<typeof recordProductRoundDirection>>;
    },
  };
}
