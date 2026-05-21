import { describe, expect, it } from "vitest";
import { decideShippingAddressBook, evolveShippingAddressBook, initialShippingAddressBookState } from "./domain";

const homeAddress = {
  name: "Jane Smith",
  company: null,
  line1: "100 Market Street",
  line2: null,
  city: "Chicago",
  state: "il",
  postalCode: "60601",
  country: "us",
  phone: null,
  email: null,
};

const officeAddress = {
  ...homeAddress,
  name: "Jane Smith",
  line1: "200 Office Way",
  city: "Evanston",
  postalCode: "60201",
};

describe("shipping address book domain", () => {
  it("keeps exactly one active default and promotes a fallback when archiving the default", () => {
    const firstEvents = decideShippingAddressBook(initialShippingAddressBookState, {
      type: "AddShippingAddress",
      accountId: "acc_buyer" as never,
      shippingAddressId: "adr_home" as never,
      label: "Home",
      address: homeAddress,
      addedAt: "2026-05-13T10:00:00.000Z",
    });
    const firstState = firstEvents.reduce(evolveShippingAddressBook, initialShippingAddressBookState);

    expect(firstState.addresses[0]?.isDefault).toBe(true);

    const secondEvents = decideShippingAddressBook(firstState, {
      type: "AddShippingAddress",
      accountId: "acc_buyer" as never,
      shippingAddressId: "adr_office" as never,
      label: "Office",
      address: officeAddress,
      makeDefault: true,
      addedAt: "2026-05-13T10:01:00.000Z",
    });
    const secondState = secondEvents.reduce(evolveShippingAddressBook, firstState);

    expect(secondState.addresses.filter((address) => address.isDefault)).toMatchObject([
      { shippingAddressId: "adr_office" },
    ]);

    const archivedEvents = decideShippingAddressBook(secondState, {
      type: "ArchiveShippingAddress",
      shippingAddressId: "adr_office" as never,
      archivedAt: "2026-05-13T10:02:00.000Z",
    });
    const archivedState = archivedEvents.reduce(evolveShippingAddressBook, secondState);

    expect(archivedState.addresses.filter((address) => address.isDefault)).toMatchObject([
      { shippingAddressId: "adr_home" },
    ]);
    expect(archivedState.addresses.find((address) => address.shippingAddressId === "adr_office")?.isArchived).toBe(
      true,
    );
  });

  it("normalizes address fields when adding", () => {
    const events = decideShippingAddressBook(initialShippingAddressBookState, {
      type: "AddShippingAddress",
      accountId: "acc_buyer" as never,
      shippingAddressId: "adr_home" as never,
      label: "  Home  ",
      address: homeAddress,
      addedAt: "2026-05-13T10:00:00.000Z",
    });

    expect(events[0]).toMatchObject({
      data: {
        label: "Home",
        address: {
          state: "IL",
          country: "US",
        },
        isDefault: true,
      },
    });
  });
});
