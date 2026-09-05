import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  findChannelConnectionContractProvenanceViolations,
  validateChannelConnectionContractProvenance,
} from "./channel-connection-contract-provenance.mjs";
import { repoRoot } from "../lib/repo.mjs";

const fixtureRoot = path.join(repoRoot, "scripts/check-structure/fixtures/channel-connection-contract");
const readFixture = (name) => readFileSync(path.join(fixtureRoot, name), "utf8");

describe("channel-connection-contract-provenance", () => {
  it("accepts the production callers and canonical-import fixture", async () => {
    expect((await validateChannelConnectionContractProvenance({ repoRoot })).violations).toEqual([]);
    expect(
      findChannelConnectionContractProvenanceViolations(
        readFixture("canonical.ts"),
        "scripts/check-structure/fixtures/channel-connection-contract/canonical.ts",
      ),
    ).toEqual([]);
  });

  it("rejects a structurally identical local environment alias", () => {
    expect(
      findChannelConnectionContractProvenanceViolations(
        readFixture("local-redeclaration.ts"),
        "local-redeclaration.ts",
      ),
    ).toEqual(expect.arrayContaining([expect.stringContaining("redeclares ChannelEnvironment")]));
  });

  it("rejects a structural resolver cast", () => {
    expect(findChannelConnectionContractProvenanceViolations(readFixture("cast.ts"), "cast.ts")).toEqual(
      expect.arrayContaining([expect.stringContaining("structural as/type assertion")]),
    );
  });
});
