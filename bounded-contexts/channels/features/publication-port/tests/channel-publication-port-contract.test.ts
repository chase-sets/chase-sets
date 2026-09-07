import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  channelExecutionModes,
  channelPublicationRejectionCodes,
  type ChannelExecutionMode,
  type ChannelProviderDescriptor,
  type ChannelProviderRegistry,
  type ChannelPublicationCapability,
  type ChannelPublicationResult,
  type DelistListingInput,
  type PublishListingInput,
  type ResolvedChannelProvider,
  type UpdatePriceQuantityInput,
} from "../../../index";
import type { DeploymentEnvironment } from "@chase-sets/platform-runtime/config-schema";
import {
  channelsIndexPath,
  collectRootExportViolations,
  collectRootExports,
  readImplementationBaseFile,
  repoRoot,
} from "./source-evidence";

const sliceAdditions = [
  "channelExecutionModes",
  "ChannelExecutionMode",
  "channelPublicationRejectionCodes",
  "ChannelPublicationRejectionCode",
  "ChannelProviderIdentity",
  "ChannelPublicationPrice",
  "ChannelPublicationAttribute",
  "ChannelPublicationDraft",
  "PublishListingInput",
  "UpdatePriceQuantityInput",
  "DelistListingInput",
  "ChannelPublicationSuccess",
  "ChannelPublicationRejection",
  "ChannelPublicationResult",
  "ChannelPublicationCapability",
  "ChannelProviderDescriptor",
  "ResolvedChannelPublication",
  "ResolvedChannelProvider",
  "ChannelProviderRegistry",
  "createChannelProviderRegistry",
  "channelProviderRegistry",
] as const;

describe("channel-publication-port-contract", () => {
  it("derives the implementation-base root baseline and preserves it plus exactly the 21-name delta", () => {
    const baseSource = readImplementationBaseFile(channelsIndexPath);
    const candidateSource = readFileSync(path.join(repoRoot, channelsIndexPath), "utf8");
    const derivedBaseline = collectRootExports(baseSource);

    expect({ implementationBase: "d0abeb97b46e8aafc16628e24e0cf6e56b41b01b", derivedBaseline }).toEqual({
      implementationBase: "d0abeb97b46e8aafc16628e24e0cf6e56b41b01b",
      derivedBaseline: ["contextManifest", "module"],
    });
    expect(collectRootExportViolations(baseSource, candidateSource, sliceAdditions)).toEqual([]);
    expect(collectRootExports(candidateSource)).toHaveLength(derivedBaseline.length + sliceAdditions.length);

    expect(
      collectRootExportViolations(
        baseSource,
        candidateSource.replace("export const module", "const module"),
        sliceAdditions,
      ),
    ).toContain("dropped-baseline:module");
    expect(
      collectRootExportViolations(
        baseSource,
        candidateSource.replace("  type UpdatePriceQuantityInput,\n", ""),
        sliceAdditions,
      ),
    ).toContain("missing-addition:UpdatePriceQuantityInput");
    expect(
      collectRootExportViolations(
        baseSource,
        `${candidateSource}\nexport const undeclaredFixture = true;\n`,
        sliceAdditions,
      ),
    ).toContain("undeclared-addition:undeclaredFixture");
    expect(
      collectRootExportViolations(
        baseSource,
        `${candidateSource}\nexport { assertPublishListingInput } from "./features/publication-port/domain/validation";\n`,
        sliceAdditions,
      ),
    ).toContain("exported-validator:assertPublishListingInput");
    expect(
      collectRootExportViolations(
        baseSource,
        `${candidateSource}\nexport { productionChannelProviderDescriptors } from "./features/publication-port/api/registry";\n`,
        sliceAdditions,
      ),
    ).toContain("exported-production-descriptor-table:productionChannelProviderDescriptors");
  });

  it("keeps both grammars derived from their exported arrays and fail-closed dispatches", () => {
    expect(channelExecutionModes.map(handleExecutionMode)).toEqual(["inline", "claimed"]);
    expect(channelPublicationRejectionCodes.map(handleRejectionCode)).toEqual([
      "validation",
      "authorization",
      "rate-limited",
      "provider-unavailable",
      "conflict",
      "not-found",
    ]);
  });

  it("exposes the exact claimed, inline, lookup, and result signatures", () => {
    type Inline = Extract<ChannelPublicationCapability, { execution: "inline" }>;
    type Claimed = Extract<ChannelPublicationCapability, { execution: "claimed" }>;
    expectTypeOf<keyof Inline>().toEqualTypeOf<
      "execution" | "publishListing" | "updatePriceQuantity" | "delistListing"
    >();
    expectTypeOf<keyof Claimed>().toEqualTypeOf<"execution">();
    expectTypeOf<Parameters<Inline["publishListing"]>[0]>().toEqualTypeOf<PublishListingInput>();
    expectTypeOf<Parameters<Inline["updatePriceQuantity"]>[0]>().toEqualTypeOf<UpdatePriceQuantityInput>();
    expectTypeOf<Parameters<Inline["delistListing"]>[0]>().toEqualTypeOf<DelistListingInput>();
    expectTypeOf<ReturnType<Inline["publishListing"]>>().toEqualTypeOf<Promise<ChannelPublicationResult>>();
    expectTypeOf<ResolvedChannelProvider["publication"]>().not.toEqualTypeOf<undefined>();
    expectTypeOf<Parameters<ChannelProviderRegistry["get"]>[0]["environment"]>().toEqualTypeOf<
      "sandbox" | "production"
    >();
  });
});

function compileNegativeContracts(registry: ChannelProviderRegistry): void {
  const asyncResult = async (): Promise<ChannelPublicationResult> => ({
    kind: "succeeded",
    externalListingId: "fixture-external-listing",
  });
  const claimedWithMethod: ChannelPublicationCapability = {
    execution: "claimed",
    // @ts-expect-error claimed capabilities expose no inline methods
    publishListing: asyncResult,
  };
  const inlineWithFourthKey: ChannelPublicationCapability = {
    execution: "inline",
    publishListing: asyncResult,
    updatePriceQuantity: asyncResult,
    delistListing: asyncResult,
    // @ts-expect-error inline capabilities expose exactly three methods
    fourthMethod: asyncResult,
  };
  const descriptorWithFourthKey: ChannelProviderDescriptor = {
    identity: { providerKey: "fixture-provider", environment: "sandbox" },
    setup: {
      providerKey: "fixture-provider",
      environment: "sandbox",
      requirements: { credential: "not-required", requiredPolicyKeys: [], binding: "one-or-more-current" },
    },
    // @ts-expect-error descriptors expose exactly identity, setup, and optional publication
    fourthKey: true,
  };
  const resultWithMessage: ChannelPublicationResult = {
    kind: "rejected",
    code: "validation",
    // @ts-expect-error provider text is not part of the result contract
    message: "fixture provider text",
  };
  // @ts-expect-error publication is a required nullable key
  const missingPublication: ResolvedChannelProvider = {
    identity: { providerKey: "fixture-provider", environment: "sandbox" },
    setup: descriptorWithFourthKey.setup,
  };
  // @ts-expect-error raw provider strings are not registry identities
  registry.get("fixture-provider");
  const deploymentEnvironment: DeploymentEnvironment = "staging";
  // @ts-expect-error deployment environments cannot select registry identity
  registry.get({ providerKey: "fixture-provider", environment: deploymentEnvironment });
  void claimedWithMethod;
  void inlineWithFourthKey;
  void resultWithMessage;
  void missingPublication;
}

void compileNegativeContracts;

function handleExecutionMode(mode: ChannelExecutionMode): string {
  switch (mode) {
    case "inline":
      return "inline";
    case "claimed":
      return "claimed";
    default:
      return assertNever(mode);
  }
}

function handleRejectionCode(code: (typeof channelPublicationRejectionCodes)[number]): string {
  switch (code) {
    case "validation":
    case "authorization":
    case "rate-limited":
    case "provider-unavailable":
    case "conflict":
    case "not-found":
      return code;
    default:
      return assertNever(code);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled closed-union member: ${String(value)}`);
}
