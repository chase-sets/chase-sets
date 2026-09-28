import { expect, it, vi } from "vitest";
import type { ListingAuthorityOperation, ListingAuthorityReservation } from "@chase-sets/event-core/listing-authority";
import { createListingSourceHostPorts } from "../src/listing-authority-host-ports";

it("mounts real lazy owner APIs and Identity decoders under distinct context-qualified ports", async () => {
  const operation = {} as ListingAuthorityOperation;
  const reservation = {} as ListingAuthorityReservation;
  const sellerFacts = vi.fn(() => ({ badgeKeys: ["synthetic"] }));
  const accountFacts = vi.fn(() => ({ account_id: "acc_synthetic" }));
  const readFacts = vi.fn(async () => ({ catalogItemId: "cat_synthetic" }));
  const inspect = vi.fn(async () => reservation);
  const ports = createListingSourceHostPorts(
    () => ({
      identity: { listingAuthority: { sellerFacts, accountFacts } },
      catalog: { listingAuthority: { readFacts } },
      auth: {
        sessions: {
          listingAuthority: { port: { participant: { owner: "auth", purpose: "authenticated-session" }, inspect } },
        },
      },
    }),
    {},
  );
  expect(ports["marketplace.listingAuthority"].identity.sellerFacts(reservation)).toEqual({ badgeKeys: ["synthetic"] });
  expect(ports["commercial-terms.listingAuthority"].identity.accountFacts(reservation)).toEqual({
    account_id: "acc_synthetic",
  });
  expect(await ports["marketplace.listingAuthority"].catalog.readFacts(operation)).toEqual({
    catalogItemId: "cat_synthetic",
  });
  expect(await ports["identity.sessionAuthority"].inspect(operation)).toBe(reservation);
  expect(inspect).toHaveBeenCalledExactlyOnceWith(operation);
  expect(sellerFacts).toHaveBeenCalledExactlyOnceWith(reservation);
  expect(accountFacts).toHaveBeenCalledExactlyOnceWith(reservation);
  expect(ports["auth.listingAuthorityConsumer"]).not.toBe(ports["identity.listingAuthorityConsumer"]);
  const absent = createListingSourceHostPorts(() => undefined, {});
  expect(() => absent["identity.sessionAuthority"].inspect(operation)).toThrow("not mounted");
});
