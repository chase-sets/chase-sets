import { describe, expect, it } from "vitest";
import {
  listingAuthorityConformance,
  listingAuthorityHistoryConformance,
  type ListingAuthorityHistoryFixture,
} from "@chase-sets/platform-runtime/listing-authority-conformance";
import { fixture } from "../tests/listing-authority-fixture";

describe("Actual Pricing source shared conformance", () => listingAuthorityConformance(it, fixture));

async function historyFixture(): Promise<ListingAuthorityHistoryFixture> {
  const f = await fixture();
  // The shared one-resource matrix targets the account predicate changed by Halt.
  // All other real Pricing resources stay in the underlying store and are read normally.
  // Only the fault-injection key census is scoped; get/set/delete operate on the real store.
  const sourceHistories = new Proxy(f.sourceMemory.streams, {
    get(target, property) {
      if (property === "keys")
        return function* () {
          let accountResource = false;
          for (const key of target.keys()) {
            if (key.startsWith("pricing.listing-authority-resource-")) {
              if (accountResource) continue;
              accountResource = true;
            }
            yield key;
          }
        };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const wrap = (current: ReturnType<typeof f.restart>): ListingAuthorityHistoryFixture => ({
    ...current,
    sourceHistories,
    consumerHistories: f.consumerMemory.streams,
    sourceEffectStream: `pricing.repricing-halt-${f.context.audit.forAccountId}`,
    blockInvalidation: f.blockInvalidation,
    restart: () => wrap(f.restart()),
  });
  return wrap(f);
}

it("targets the real account resource closed by the actual Halt writer", async () => {
  const f = await historyFixture();
  const operation = await f.fence.open(f.input, f.context);
  await f.source.prepare(operation, f.context);
  const selected = [...f.sourceHistories.keys()].filter((key) => key.startsWith("pricing.listing-authority-resource-"));
  expect(selected).toHaveLength(1);
  await f.invalidate();
  expect(
    f.sourceHistories
      .get(selected[0]!)!
      .some((event) => event.eventType === "pricing.listing-authority.invalidation-started"),
  ).toBe(true);
});

describe("Actual Pricing Halt retained-history footprint", () =>
  listingAuthorityHistoryConformance(it, historyFixture));
