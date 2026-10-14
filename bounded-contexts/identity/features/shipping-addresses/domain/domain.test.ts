import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import ts from "@chase-sets/typescript-compiler-api";
import {
  decideShippingAddressBook,
  evolveShippingAddressBook,
  initialShippingAddressBookState,
  normalizeShippingAddressSnapshot,
  type ShippingAddressSnapshot,
} from "./domain";
import { SHIPPING_ADDRESS_REQUIRED_MESSAGES } from "./errors";

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
  it("preserves rejection parity and no write for source-derived fields and seed snapshots", () => {
    const domain = ts.createSourceFile(
      "domain.ts",
      readFileSync(new URL("./domain.ts", import.meta.url), "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const fields: string[] = [];
    function visitDomain(node: ts.Node) {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "normalizeRequiredText" &&
        node.arguments[2] &&
        ts.isStringLiteral(node.arguments[2])
      )
        fields.push(node.arguments[2].text);
      ts.forEachChild(node, visitDomain);
    }
    visitDomain(domain);
    expect(fields.sort()).toEqual(Object.keys(SHIPPING_ADDRESS_REQUIRED_MESSAGES).sort());
    for (const field of fields) {
      expect(() => normalizeShippingAddressSnapshot({ ...homeAddress, [field]: "  " })).toThrow(
        expect.objectContaining({ field, code: "required" }),
      );
    }
    const seed = ts.createSourceFile(
      "seed.ts",
      readFileSync(new URL("../../../support/runtime-support/seed.ts", import.meta.url), "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const snapshots: ShippingAddressSnapshot[] = [];
    function visitSeed(node: ts.Node) {
      if (
        ts.isPropertyAssignment(node) &&
        ["address", "shippingAddress"].includes(node.name.getText(seed)) &&
        ts.isObjectLiteralExpression(node.initializer)
      ) {
        const values: Record<string, string | null> = {};
        for (const property of node.initializer.properties) {
          if (!ts.isPropertyAssignment(property)) continue;
          if (ts.isStringLiteral(property.initializer)) values[property.name.getText(seed)] = property.initializer.text;
          else if (property.initializer.kind === ts.SyntaxKind.NullKeyword) values[property.name.getText(seed)] = null;
        }
        expect(fields.every((field) => typeof values[field] === "string")).toBe(true);
        snapshots.push(values as ShippingAddressSnapshot);
      }
      ts.forEachChild(node, visitSeed);
    }
    visitSeed(seed);
    expect(snapshots.length).toBeGreaterThan(0);
    for (const address of snapshots) {
      const normalized = normalizeShippingAddressSnapshot(address);
      const events = decideShippingAddressBook(initialShippingAddressBookState, {
        type: "AddShippingAddress",
        accountId: "acc_seed" as never,
        shippingAddressId: "adr_seed" as never,
        address,
        addedAt: "2026-05-13T10:00:00.000Z",
      });
      expect(events[0]).toMatchObject({ data: { address: normalized } });
    }
  });

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
