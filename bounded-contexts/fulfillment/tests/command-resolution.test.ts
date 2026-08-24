import { describe, expect, it } from "vitest";
import packageJson from "../package.json" with { type: "json" };

describe("issue-7171-command-resolution-and-fail-forward", () => {
  it("selects the Shipment runtime DB matrix explicitly and excludes it from unit tests", () => {
    expect(packageJson.scripts["test:db"]).toContain("features/shipments/api/runtime.db.test.ts");
    expect(packageJson.scripts["test:db"]).toContain("tests/schema-upgrade.db.test.ts");
    expect(packageJson.scripts["test:unit"]).toContain("--exclude features/shipments/api/runtime.db.test.ts");
    expect(packageJson.scripts["test:unit"]).toContain("--exclude tests/schema-upgrade.db.test.ts");
  });
});
