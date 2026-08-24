import { describe, expect, it } from "vitest";
import { createId, createInternalId, parseStrictTypedUlid } from "./typed-ids";

describe("createInternalId", () => {
  it("creates distinct, prefixed UUIDs", () => {
    const first = createInternalId("job");
    const second = createInternalId("job");

    expect(first).toMatch(/^job_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(second).toMatch(/^job_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(second).not.toBe(first);
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
