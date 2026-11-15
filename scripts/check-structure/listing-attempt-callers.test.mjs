import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { enumerateListingAttemptCallers, unpartitionedListingAttemptCallers } from "./marketplace-attempt-callers.mjs";

describe("Listing caller guard fail-closed evidence", () => {
  it("rejects a key-removal form mutant rather than trusting a known path", () => {
    const path = "bounded-contexts/inventory/features/inventory-items/ui/list-from-inventory-drawer.tsx";
    const source = readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
    const check = (text) =>
      unpartitionedListingAttemptCallers(enumerateListingAttemptCallers([{ path, source: text }]));
    expect(check(source)).toEqual([]);
    expect(check(source.replace(/<HiddenInput name="idempotencyKey"[^>]+\/>/, ""))).toHaveLength(1);
  });
  it("rejects keyless non-null and aliased commands outside the planned directory inventory", () => {
    for (const source of ["api.createListing!({});", "const send = api.publishListing; send(id, {});"]) {
      expect(
        unpartitionedListingAttemptCallers(enumerateListingAttemptCallers([{ path: "unusual/a.ts", source }])),
      ).toHaveLength(1);
    }
  });
});
