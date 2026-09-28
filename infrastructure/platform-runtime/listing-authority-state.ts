import { createHash } from "node:crypto";
import type { JsonObject, JsonValue } from "@chase-sets/primitives/json";
import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { ListingAuthorityOperation } from "@chase-sets/event-core/listing-authority";

export function authorityCanonical(value: unknown): string {
  if (value === undefined) throw new Error("Undefined authority value.");
  if (Array.isArray(value)) return `[${value.map(authorityCanonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${authorityCanonical(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function authorityHash(value: unknown): string {
  return createHash("sha256").update(authorityCanonical(value)).digest("hex");
}

export function assertSameAuthority(left: unknown, right: unknown): void {
  if (authorityCanonical(left) !== authorityCanonical(right)) throw new Error("Listing authority binding conflict.");
}

export function authorityContext(operation: ListingAuthorityOperation): EventStoreContext {
  return {
    tenantId: operation.tenantId as EventStoreContext["tenantId"],
    audit: {
      forAccountId: operation.accountId as EventStoreContext["audit"]["forAccountId"],
      performedByUserId: operation.actor.userId as EventStoreContext["audit"]["performedByUserId"],
    },
  };
}

export async function authorityHistory(store: EventStore, streamId: string) {
  const events = await readCompleteStream(store, { streamId });
  return { events, version: events.at(-1)?.streamVersion ?? 0 };
}

export function authorityPayload(value: unknown): JsonObject {
  return JSON.parse(authorityCanonical(value)) as JsonObject;
}

export function authorityValue<T>(value: JsonValue | undefined): T {
  if (value === undefined) throw new Error("Corrupt Listing authority history.");
  return value as T;
}
