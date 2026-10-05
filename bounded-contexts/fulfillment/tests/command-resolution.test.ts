import { describe, expect, it } from "vitest";
import path from "node:path";
import { discoverDbProfile } from "../../../scripts/check-structure/db-profile-script-canonical-form.mjs";

describe("issue-7171-command-resolution-and-fail-forward", () => {
  it("selects the Shipment runtime DB matrix explicitly and excludes it from unit tests", () => {
    const inventory = discoverDbProfile(path.resolve(import.meta.dirname, ".."));
    expect(inventory.violations).toEqual([]);
    for (const file of ["features/shipments/api/runtime.db.test.ts", "tests/schema-upgrade.db.test.ts"]) {
      expect(inventory.aggregate.files).toContain(file);
      expect(inventory.unit.files).not.toContain(file);
    }
  });
});
