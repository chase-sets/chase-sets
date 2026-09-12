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
  deriveImplementationBaseRootExports,
  repoRoot,
} from "./source-evidence";

const sliceAdditions = [
  "TCGPLAYER_CONNECTOR_EXTENSION_ID",
  "TCGPLAYER_CONNECTOR_EXTENSION_KEY",
  "TCGPLAYER_CONNECTOR_REDIRECT_URI",
  "channelExecutionModes",
  "ChannelExecutionMode",
  "ChannelEnvironment",
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
  "assertChannelListingDelistDirective",
  "buildChannelCategorySourceKeys",
  "buildChannelConditionSourceKeys",
  "buildChannelGradedAttributeSourceEntries",
  "channelCompositionProfileRegistry",
  "channelCompositionProgrammingErrors",
  "channelListingPublishStates",
  "channelMappingConfidenceTiers",
  "channelMappingDimensions",
  "channelMappingReviewStatuses",
  "channelPublicationBlockingReasons",
  "channelPublicationConfigurationBlockingReasons",
  "channelPublicationListingBlockingReasons",
  "composeChannelListingPublication",
  "createChannelCompositionProfileRegistry",
  "createChannelListingCompositionRuntime",
  "deriveChannelListingId",
  "deriveChannelSelectedOptionKey",
  "parseChannelListingCompositionInput",
  "ChannelListingCompositionServices",
  "ChannelMappingCandidate",
  "ChannelCommandRefusal",
  "ChannelCommandResult",
  "ChannelCompositionProfile",
  "ChannelCompositionProfileRegistry",
  "ChannelCompositionProgrammingError",
  "ChannelListingCompositionInput",
  "ChannelListingCompositionResult",
  "ChannelListingDelistDirective",
  "ChannelListingDesiredStateChangedData",
  "ChannelListingEvent",
  "ChannelListingLinkState",
  "ChannelMappingConfidenceTier",
  "ChannelMappingDimension",
  "ChannelMappingResolution",
  "ChannelMappingReviewPage",
  "ChannelMappingReviewStatus",
  "ChannelPublicationAdoption",
  "ChannelPublicationBlockingReason",
  "ChannelPublicationConnectionDetail",
  "ChannelPublicationConnectionSummary",
  "ChannelPublicationOutcome",
  "ChannelPublicationSettings",
  "ChannelReferenceRead",
  "ChannelReferenceResolution",
  "ParseChannelListingCompositionInputResult",
  "ChannelListingReconciliationScope",
  "createTcgplayerCsvRuntime",
  "ComposeTcgplayerSyncRunInput",
  "IngestTcgplayerExportSnapshotInput",
  "RunFenceInput",
  "TcgplayerCsvRuntimeDependencies",
  "TcgplayerCsvServices",
  "composeTcgplayerReservation",
  "planStagedImportBatches",
  "ComposedTcgplayerReservation",
  "ComposeTcgplayerReservationInput",
  "parseTcgplayerFullExport",
  "channelExportCompletenessStates",
  "channelExportSurfaces",
  "channelSyncRunMemberKinds",
  "channelSyncRunStates",
  "channelSyncRunTriggers",
  "tcgplayerLocalRefusalReasons",
  "tcgplayerRowRefusalReasons",
  "ChannelExportCompleteness",
  "ChannelExportSchemaDescriptor",
  "ChannelExportSchemaPin",
  "ChannelExportSurface",
  "ChannelInventorySnapshot",
  "ChannelInventorySnapshotRow",
  "ChannelSyncRun",
  "ChannelSyncRunComposedEvent",
  "ChannelSyncRunEvent",
  "ChannelSyncRunMember",
  "ChannelSyncRunMemberKind",
  "ChannelSyncRunState",
  "ChannelSyncRunTransitionedEvent",
  "ChannelSyncRunTrigger",
  "ManualClaimLeasePolicySnapshot",
  "StagedImportBatch",
  "TcgplayerExportIngestLimits",
  "TcgplayerExportParseResult",
  "TcgplayerImportSummary",
  "TcgplayerLocalRefusalReason",
  "TcgplayerRowRefusalReason",
  "channelSyncRunTransitions",
  "decideChannelSyncRunTransition",
  "tcgplayerStagedImportPolicy",
  "tcgplayerExportSchemaDescriptors",
  "readLatestSnapshotRows",
  "readRun",
] as const;

describe("channel-publication-port-contract", () => {
  it("derives the implementation-base root baseline and preserves the publication-port and desired-state deltas", () => {
    const candidateSource = readFileSync(path.join(repoRoot, channelsIndexPath), "utf8");
    const derivation = deriveImplementationBaseRootExports();
    const derivedBaseline = derivation.exports;

    expect({ implementationBase: derivation.revision, blobSha: derivation.blobSha, derivedBaseline }).toEqual({
      implementationBase: "d0abeb97b46e8aafc16628e24e0cf6e56b41b01b",
      blobSha: "4d4cb0a0f2453fc64804d9bee1de9487dc7f65ce",
      derivedBaseline: ["contextManifest", "module"],
    });
    expect(collectRootExportViolations(derivedBaseline, candidateSource, sliceAdditions)).toEqual([]);
    expect(collectRootExports(candidateSource)).toHaveLength(derivedBaseline.length + sliceAdditions.length);

    expect(
      collectRootExportViolations(
        derivedBaseline,
        candidateSource.replace("export const module", "const module"),
        sliceAdditions,
      ),
    ).toContain("dropped-baseline:module");
    expect(
      collectRootExportViolations(
        derivedBaseline,
        candidateSource.replace("  type UpdatePriceQuantityInput,\n", ""),
        sliceAdditions,
      ),
    ).toContain("missing-addition:UpdatePriceQuantityInput");
    expect(
      collectRootExportViolations(
        derivedBaseline,
        `${candidateSource}\nexport const undeclaredFixture = true;\n`,
        sliceAdditions,
      ),
    ).toContain("undeclared-addition:undeclaredFixture");
    expect(
      collectRootExportViolations(
        derivedBaseline,
        `${candidateSource}\nexport { assertPublishListingInput } from "./features/publication-port/domain/validation";\n`,
        sliceAdditions,
      ),
    ).toContain("exported-validator:assertPublishListingInput");
    expect(
      collectRootExportViolations(
        derivedBaseline,
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
