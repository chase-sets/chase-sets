import { describe, expect, expectTypeOf, it } from "vitest";
import {
  createId,
  createInternalId,
  parseStrictTypedUlid,
  type EnforcementActionId,
  type ListingEnforcementActionId,
  type OrderGroupId,
  type OrderId,
  type ReportedContentActionId,
  type ShipmentGroupId,
  type ShipmentId,
} from "./typed-ids";

describe("createInternalId", () => {
  it("creates distinct, prefixed UUIDs", () => {
    const first = createInternalId("job");
    const second = createInternalId("job");

    expect(first).toMatch(/^job_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(second).toMatch(/^job_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(second).not.toBe(first);
  });
});

describe("group ids", () => {
  it.each(["ogr", "shg"] as const)("round-trips a generated %s_ id", (prefix) => {
    const id = createId(prefix);
    expect(parseStrictTypedUlid(id, prefix)).toBe(id);
  });

  it.each(["ogr", "shg"] as const)("rejects malformed %s_ ids", (prefix) => {
    for (const body of [
      "",
      "01ARYZ6S41TSV4RRFFQ69G5FA",
      "01ARYZ6S41TSV4RRFFQ69G5FAI",
      "81ARYZ6S41TSV4RRFFQ69G5FAV",
      "01aryz6s41tsv4rrffq69g5fav",
      "01ARYZ6S41TSV4RRFFQ69G5FAV0",
    ]) {
      expect(() => parseStrictTypedUlid(`${prefix}_${body}`, prefix)).toThrow();
    }
  });

  it.each([
    ["ogr", "shg"],
    ["shg", "ogr"],
    ["ogr", "ord"],
    ["shg", "shp"],
    ["ord", "ogr"],
    ["shp", "shg"],
  ] as const)("rejects %s_ ids at a %s_ boundary", (source, target) => {
    expect(() => parseStrictTypedUlid(createId(source), target)).toThrow();
  });

  it("keeps group and member types distinct", () => {
    expectTypeOf(createId("ogr")).toEqualTypeOf<OrderGroupId>();
    expectTypeOf(parseStrictTypedUlid(createId("ogr"), "ogr")).toEqualTypeOf<OrderGroupId>();
    expectTypeOf(createId("shg")).toEqualTypeOf<ShipmentGroupId>();
    expectTypeOf(parseStrictTypedUlid(createId("shg"), "shg")).toEqualTypeOf<ShipmentGroupId>();
    expectTypeOf<OrderGroupId>().not.toMatchTypeOf<ShipmentGroupId>();
    expectTypeOf<ShipmentGroupId>().not.toMatchTypeOf<OrderGroupId>();
    expectTypeOf<OrderGroupId>().not.toMatchTypeOf<OrderId>();
    expectTypeOf<OrderId>().not.toMatchTypeOf<OrderGroupId>();
    expectTypeOf<ShipmentGroupId>().not.toMatchTypeOf<ShipmentId>();
    expectTypeOf<ShipmentId>().not.toMatchTypeOf<ShipmentGroupId>();
  });
});

describe("parseStrictTypedUlid", () => {
  it.each(["enf", "sup"] as const)("round-trips a generated %s_ id", (prefix) => {
    const id = createId(prefix);
    expect(parseStrictTypedUlid(id, prefix)).toBe(id);
  });

  it.each([
    ["empty body", "enf_"],
    ["short body", "enf_01ARYZ6S41TSV4RRFFQ69G5FA"],
    ["invalid alphabet", "enf_01ARYZ6S41TSV4RRFFQ69G5FAI"],
    ["invalid timestamp range", "enf_81ARYZ6S41TSV4RRFFQ69G5FAV"],
    ["non-canonical lowercase", "enf_01aryz6s41tsv4rrffq69g5fav"],
    ["wrong prefix", "sup_01ARYZ6S41TSV4RRFFQ69G5FAV"],
  ])("rejects an enforcement id with %s", (_case, value) => {
    expect(() => parseStrictTypedUlid(value, "enf")).toThrow();
  });

  it.each([
    "sup_",
    "sup_01ARYZ6S41TSV4RRFFQ69G5FA",
    "sup_01ARYZ6S41TSV4RRFFQ69G5FAI",
    "sup_81ARYZ6S41TSV4RRFFQ69G5FAV",
    "enf_01ARYZ6S41TSV4RRFFQ69G5FAV",
  ])("rejects a malformed support-request id: %s", (value) => {
    expect(() => parseStrictTypedUlid(value, "sup")).toThrow();
  });
});

describe("listing enforcement ids", () => {
  it.each(["lea", "rca"] as const)("round-trips a generated %s_ id", (prefix) => {
    const id = createId(prefix);
    expect(parseStrictTypedUlid(id, prefix)).toBe(id);
  });

  it.each(["lea", "rca"] as const)("rejects malformed %s_ ids", (prefix) => {
    for (const body of [
      "",
      "01ARYZ6S41TSV4RRFFQ69G5FA",
      "01ARYZ6S41TSV4RRFFQ69G5FAI",
      "81ARYZ6S41TSV4RRFFQ69G5FAV",
      "01aryz6s41tsv4rrffq69g5fav",
      "01ARYZ6S41TSV4RRFFQ69G5FAV0",
    ]) {
      expect(() => parseStrictTypedUlid(`${prefix}_${body}`, prefix)).toThrow();
    }
  });

  it.each([
    ["lea", "enf"],
    ["enf", "lea"],
    ["lea", "rca"],
    ["rca", "lea"],
    ["rca", "rpt"],
    ["rpt", "rca"],
  ] as const)("rejects %s_ ids at a %s_ boundary", (source, target) => {
    expect(() => parseStrictTypedUlid(createId(source), target)).toThrow();
  });

  it("keeps listing and account enforcement identities distinct", () => {
    expectTypeOf(createId("lea")).toEqualTypeOf<ListingEnforcementActionId>();
    expectTypeOf(parseStrictTypedUlid(createId("rca"), "rca")).toEqualTypeOf<ReportedContentActionId>();
    expectTypeOf<ListingEnforcementActionId>().not.toMatchTypeOf<EnforcementActionId>();
    expectTypeOf<EnforcementActionId>().not.toMatchTypeOf<ListingEnforcementActionId>();
    expectTypeOf<ReportedContentActionId>().not.toMatchTypeOf<ListingEnforcementActionId>();
  });
});
