import { randomUUID } from "node:crypto";
import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import type { OwnerStreamSeal } from "@chase-sets/event-core/owner-stream-reservation";
import {
  createPostgresEventStore,
  lockOwnerStreamInvalidationsInTransaction,
  ownerPredicateKey,
  readOwnerPredicateSealInTransaction,
  withConfigurationEpochTransaction,
  type PgQueryable,
  type PgTransactionalPool,
} from "@chase-sets/event-core-postgres";
import { z } from "zod";
import type { EvaluationBinding } from "../domain/evaluation-authority";

export type EvaluationOwner = "pricing" | "marketplace" | "catalog" | "inventory";
export type EvaluationMember = Readonly<{ owner: EvaluationOwner; key: string; seal: OwnerStreamSeal }>;

export function evaluationOwnerIdentity(pool: PgTransactionalPool, owner: EvaluationOwner) {
  return withConfigurationEpochTransaction(pool, async (client: PgQueryable) => {
    await client.query(
      "INSERT INTO event_configuration_store_identity (singleton, store_id, incarnation) VALUES (true, $1, $2) ON CONFLICT DO NOTHING",
      [owner, randomUUID()],
    );
    const identity = await client.query<{ store_id: string; incarnation: string }>(
      "SELECT store_id, incarnation FROM event_configuration_store_identity WHERE singleton = true",
    );
    const row = identity.rows[0];
    if (identity.rows.length !== 1 || !row || row.store_id !== owner || !row.incarnation)
      throw new Error(`Exact Pricing requires the ${owner} incarnation.`);
    return { storeId: row.store_id, incarnation: row.incarnation };
  });
}

export async function captureEvaluationMembers(client: PgQueryable, owner: EvaluationOwner, keys: readonly string[]) {
  await lockOwnerStreamInvalidationsInTransaction(client, keys);
  const members: EvaluationMember[] = [];
  for (const key of [...new Set(keys)].sort()) {
    const seal = await readOwnerPredicateSealInTransaction(client, key);
    if (!seal || !Number.isSafeInteger(seal.version) || seal.version < 0)
      throw new Error("Owner predicate Seal is unavailable.");
    members.push({ owner, key, seal });
  }
  return members;
}

export async function captureOwnListingMember(pool: PgTransactionalPool, binding: EvaluationBinding) {
  return withConfigurationEpochTransaction(pool, async (client: PgQueryable) => {
    const members = await captureEvaluationMembers(client, "marketplace", [
      ownerPredicateKey("repricing-listing", binding.listingId),
    ]);
    const result = await client.query<{ current_version: string }>(
      "SELECT current_version::text FROM event_store_streams WHERE stream_id = $1",
      [`marketplace.listing-${binding.listingId}`],
    );
    if (Number(result.rows[0]?.current_version) !== binding.listingVersion)
      throw new Error("Listing changed during Pricing capture.");
    return members;
  });
}

const inventoryOrigin = z.object({
  itemId: z.string().min(1),
  accountId: z.string().min(1),
  catalogItemId: z.string().min(1),
  productId: z.string().min(1),
  acquisitionCostAmount: z
    .string()
    .regex(/^[0-9]+(?:\.[0-9]{1,2})?$/)
    .nullable(),
  acquisitionCostCurrencyCode: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .nullish(),
});

export async function captureOwnInventory(pool: PgTransactionalPool, binding: EvaluationBinding, itemId: string) {
  const store = createPostgresEventStore({ pool });
  return withConfigurationEpochTransaction(pool, async (client) => {
    const members = await captureEvaluationMembers(client, "inventory", [
      ownerPredicateKey("repricing-stock", binding.accountId, itemId),
    ]);
    const history = await readCompleteStream(
      { readStream: (request) => store.readStreamInTransaction(client, request) },
      { streamId: `inventory.item-${itemId}`, maxEvents: 10000 },
    );
    const event = history[0];
    if (!event || event.eventType !== "inventory.item.created")
      throw new Error("Inventory Item origin is unavailable.");
    const item = inventoryOrigin.parse(event.payload);
    if (
      item.itemId !== itemId ||
      item.accountId !== binding.accountId ||
      item.catalogItemId !== binding.catalogItemId ||
      item.productId !== binding.productId
    )
      throw new Error("Foreign Inventory Item.");
    return {
      members,
      itemVersion: history.length,
      origin: event.eventId,
      costBasisAmount: item.acquisitionCostAmount,
      costBasisCurrencyCode: item.acquisitionCostCurrencyCode ?? null,
    };
  });
}

export async function captureOwnCategories(
  pool: PgTransactionalPool,
  binding: EvaluationBinding,
  relevantCategoryIds: readonly string[],
) {
  return withConfigurationEpochTransaction(pool, async (client) => {
    const keys = relevantCategoryIds.map((id) =>
      ownerPredicateKey("repricing-catalog-category", binding.catalogItemId, id),
    );
    const members = await captureEvaluationMembers(client, "catalog", keys);
    return { members, ...(await readCommittedCategories(pool, binding.catalogItemId, client)) };
  });
}

export async function readCommittedCategories(pool: PgTransactionalPool, catalogItemId: string, db?: PgQueryable) {
  const store = createPostgresEventStore({ pool });
  const history = await readCompleteStream(
    db ? { readStream: (request) => store.readStreamInTransaction(db, request) } : store,
    { streamId: `catalog.item-${catalogItemId}`, maxEvents: 10000 },
  );
  if (history[0]?.eventType !== "catalog.catalog-item.created") throw new Error("Catalog Item origin is unavailable.");
  const categoryIds = new Set<string>();
  for (const event of history) {
    if (
      event.eventType !== "catalog.catalog-item.category-assigned" &&
      event.eventType !== "catalog.catalog-item.category-removed"
    )
      continue;
    const categoryId = z.string().min(1).parse(event.payload.categoryId);
    if (event.eventType === "catalog.catalog-item.category-assigned") categoryIds.add(categoryId);
    else categoryIds.delete(categoryId);
  }
  return { version: history.length, categoryIds: [...categoryIds].sort() };
}
