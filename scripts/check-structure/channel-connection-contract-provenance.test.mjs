import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  channelConnectionCanonicalContractPathBySymbol,
  findChannelConnectionContractProvenanceViolations,
  validateChannelConnectionContractProvenance,
} from "./channel-connection-contract-provenance.mjs";
import { repoRoot } from "../lib/repo.mjs";

const fixtureRoot = path.join(repoRoot, "scripts/check-structure/fixtures/channel-connection-contract");
const readFixture = (name) => readFileSync(path.join(fixtureRoot, name), "utf8");

describe("channel-connection-contract-provenance", () => {
  it("pins the canonical path for every governed symbol", () => {
    expect(Object.fromEntries(channelConnectionCanonicalContractPathBySymbol)).toEqual({
      ChannelEnvironment: "bounded-contexts/channels/features/connections/domain/contracts.ts",
      ChannelConnectionSetupResolver: "bounded-contexts/channels/features/connections/domain/contracts.ts",
      ChannelCredentialAuthorityResolver: "bounded-contexts/channels/features/connections/domain/contracts.ts",
      ChannelStorageLocationAuthorityResolver: "bounded-contexts/channels/features/connections/domain/contracts.ts",
      ChannelPolicyAuthorityResolver: "bounded-contexts/channels/features/connections/domain/contracts.ts",
      ChannelConnectionServices: "bounded-contexts/channels/features/connections/domain/contracts.ts",
      ChannelConnectionHostPorts: "bounded-contexts/channels/features/connections/domain/contracts.ts",
      ChannelsServices: "bounded-contexts/channels/support/runtime-support/services.ts",
    });
  });

  it("accepts the production callers and canonical-import fixture", async () => {
    expect((await validateChannelConnectionContractProvenance({ repoRoot })).violations).toEqual([]);
    expect(
      findChannelConnectionContractProvenanceViolations(
        readFixture("canonical.ts"),
        "scripts/check-structure/fixtures/channel-connection-contract/canonical.ts",
      ),
    ).toEqual([]);
    expect(
      findChannelConnectionContractProvenanceViolations(
        readFixture("economics-public-root.ts"),
        "bounded-contexts/pricing/features/economics/domain/fixture.ts",
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

  it("rejects a local ChannelsServices redeclaration", () => {
    expect(
      findChannelConnectionContractProvenanceViolations(
        readFixture("channels-services-redeclaration.ts"),
        "bounded-contexts/channels/features/connections/domain/contracts.ts",
      ),
    ).toEqual(expect.arrayContaining([expect.stringContaining("redeclares ChannelsServices")]));
  });

  it("rejects a ChannelsServices import from the former feature-owned path", () => {
    expect(
      findChannelConnectionContractProvenanceViolations(
        readFixture("channels-services-wrong-path.ts"),
        "bounded-contexts/channels/api.ts",
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "without importing it from bounded-contexts/channels/support/runtime-support/services.ts",
        ),
      ]),
    );
  });

  it("rejects a Pricing Economics deep import that bypasses the public Channels contract", () => {
    expect(
      findChannelConnectionContractProvenanceViolations(
        readFixture("economics-deep-import.ts"),
        "bounded-contexts/pricing/features/economics/domain/fixture.ts",
      ),
    ).toEqual(expect.arrayContaining([expect.stringContaining("without importing it from @chase-sets/channels")]));
  });

  it("rejects Pricing Economics aliases for either Channels-owned identity contract", () => {
    expect(
      findChannelConnectionContractProvenanceViolations(
        readFixture("economics-local-alias.ts"),
        "bounded-contexts/pricing/features/economics/domain/fixture.ts",
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining("redeclares ChannelEnvironment"),
        expect.stringContaining("redeclares ChannelProviderIdentity"),
      ]),
    );
  });

  it("rejects a structural resolver cast", () => {
    expect(findChannelConnectionContractProvenanceViolations(readFixture("cast.ts"), "cast.ts")).toEqual(
      expect.arrayContaining([expect.stringContaining("structural as/type assertion")]),
    );
  });
});
