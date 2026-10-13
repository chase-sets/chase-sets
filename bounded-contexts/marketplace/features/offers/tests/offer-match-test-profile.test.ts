import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Offer Match DB proof routing", () => {
  it("excludes Postgres proof from non-DB CI and includes it in the DB profile", () => {
    const { scripts } = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8"));
    const test = "features/offers/tests/offer-match-open-market.db.test.ts";
    expect(scripts["test:unit"].split(/\s+/)).toEqual(expect.arrayContaining(["--exclude", test]));
    expect(scripts["test:unit"]).toContain(`--exclude ${test}`);
    expect(scripts["test:db"].split(/\s+/)).toContain(test);
  });
});
